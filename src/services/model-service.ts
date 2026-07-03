import { App, Notice } from 'obsidian';
import { PluginSettings, ProviderConfig } from '../mcp/types';
import { MemoryManager } from '../memory/memory-manager';
import { MemoryMutationResult, MemoryView, MemoryViewRequest, UserProfile } from '../memory/types';
import { logger } from '../utils/logger';
import { GenerationOptions, ModelOption, PriorChatMessage, ToolDefinition, StreamEvent } from '../models/interfaces';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { SkillCommandEntry, SkillSummary } from '../skills/types';
import { createChatRuntime } from '../runtime/runtime-factory';
import { buildGeminiModel, buildOpenAICompatModel, createNativeStreamFn, createNativeCompleteFn, NativeCompleteFn } from '../runtime/pi/pi-native-model';
import { ProviderCapabilities } from '../runtime/provider-capabilities';
import * as modelCatalog from './model-catalog-service';
import { SteeringController } from '../runtime/steering-controller';
import { SessionStore, type PersistedSessionRef } from '../runtime/pi/session-store';
import { createVaultFileAdapter } from '../runtime/pi/vault-session-fs';
import { computeContentHash } from '../knowledge/compiler';
import { getFileWriteResultPath } from '../utils/file-operation-contract';
import {
    formatGenerationPlanBlock,
    GenerationSource,
    GenerationStrategyService,
} from './generation-strategy-service';
import { ObsidianContextSnapshot } from './obsidian-context-service';
import { OperationAuditLog } from './operation-audit-log';
import { WorkspaceEditService } from './workspace-edit-service';

export class ModelService {
    private memoryManager: MemoryManager | null = null;
    private readonly modelListCache = new Map<string, { timestamp: number; models: ModelOption[] }>();
    private readonly modelListCacheTtlMs = 10 * 60 * 1000;
    private readonly generationStrategyService = new GenerationStrategyService();
    private providerChangedCallbacks: Array<() => void> = [];
    private suppressProviderChangedNotification = false;
    private skillRegistry: SkillRegistry;
    private toolRegistry: ToolRegistry;
    private operationAuditLog: OperationAuditLog;
    private workspaceEditService: WorkspaceEditService;
    /**
     * Session 持久化层。仅当 vault.adapter 可用时启用（桌面与移动端均有，测试 mock 可能缺失）。
     * 提供跨轮上下文与跨重启恢复；不可用时退化为旧的 UI 内存回灌行为。
     */
    private sessionStore: SessionStore | null = null;
    /**
     * 运行中 steering 控制器。承载长任务运行时的「补话」与「动态工具集」。
     * 跨轮复用同一实例：每次 queryStream 启动时由 runtime 调用 reset() 清空遗留状态，
     * 故运行期间 UI 调用 steer() 的窗口对齐当前流。
     */
    private readonly steeringController = new SteeringController();

    constructor(
        private app: App,
        private settings: PluginSettings,
        toolRegistry: ToolRegistry,
        skillRegistry: SkillRegistry,
    ) {
        this.toolRegistry = toolRegistry;
        this.skillRegistry = skillRegistry;
        this.operationAuditLog = new OperationAuditLog(this.app);
        this.workspaceEditService = new WorkspaceEditService(this.app, this.toolRegistry, {
            onEditApplied: async ({ edit, previousContent }) => {
                await this.recordOperationAudit({
                    action: edit.action,
                    target: edit.path,
                    approvalSource: 'direct-write',
                    previousContent,
                    undoable: true,
                });
            },
        });
        this.initializeProvider();
        this.setupErrorHandlers();
        this.initializeSessionStore();
    }

    /**
     * 构造 Session 持久化层。把会话引用存进插件 data（通过 settings.sessionRef），
     * 实现跨重启恢复。vault.adapter 不可用时静默跳过（保持旧行为）。
     */
    private initializeSessionStore() {
        const adapter = (this.app?.vault as any)?.adapter;
        if (!adapter || typeof adapter.read !== 'function' || typeof adapter.append !== 'function') {
            this.sessionStore = null;
            return;
        }
        try {
            this.sessionStore = new SessionStore(createVaultFileAdapter(adapter), {
                loadRef: () => this.loadSessionRef(),
                saveRef: (ref) => this.saveSessionRef(ref),
                // 自动压缩阈值取当前模型的上下文窗口（settings 可运行期改动，故用 getter 取最新值）。
                contextWindow: () => this.settings.contextWindow ?? 0,
                // 摘要用上层自己的 provider 生成（pi 的 compact() 会绕过 bridge，不复用）。
                summarize: (prompt, systemPrompt) => this.summarizeForCompaction(prompt, systemPrompt),
            });
        } catch (error) {
            logger.warn('Failed to initialize SessionStore; falling back to in-memory history.', 'ModelService');
            this.sessionStore = null;
        }
    }

    /**
     * 为自动压缩生成摘要：用无状态 generate 直连当前 provider，
     * 跳过生成计划装饰（摘要是纯文本压缩任务，不需要写作风格/上下文注入）。
     */
    private async summarizeForCompaction(prompt: string, systemPrompt?: string): Promise<string> {
        return this.generate(prompt, systemPrompt, 'shell', undefined, null, {
            skipGenerationPlan: true,
        });
    }

    private loadSessionRef(): PersistedSessionRef | null {
        return this.settings.sessionRef ?? null;
    }

    private saveSessionRef(ref: PersistedSessionRef | null): void {
        this.settings.sessionRef = ref;
    }

    /**
     * 初始化 provider 相关状态。迁移到 pi runtime 后不再持有 provider 实例——
     * LLM 推理（会话 + 无状态）全部经 pi，provider 元数据（列模型/探活/能力）经
     * model-catalog-service。此处仅按当前 config 是否有效重建 memoryManager。
     */
    private initializeProvider() {
        const config = this.getActiveProviderConfig();
        if (!config) {
            logger.error(`Unknown provider: ${this.settings.activeProvider}`, null, 'ModelService');
            return;
        }

        if (this.hasValidConfig()) {
            this.memoryManager = new MemoryManager(this.app, this.buildMemoryOptions());
        }
    }

    private buildMemoryOptions() {
        return {
            privacyMode: this.settings.privacyMode === true,
        };
    }

    private hasValidConfig(): boolean {
        const config = this.getActiveProviderConfig();
        return !!config?.apiKey?.trim();
    }

    isGenerationConfigured(): boolean {
        return this.hasValidConfig();
    }

    getActiveProviderConfig(): ProviderConfig | undefined {
        return this.settings.providers[this.settings.activeProvider];
    }

    public async switchProvider(providerId: string, saveFn?: () => Promise<void>): Promise<void> {
        const config = this.settings.providers[providerId];
        if (!config) return;

        this.settings.activeProvider = providerId;
        if (saveFn) {
            this.suppressProviderChangedNotification = true;
            try {
                await saveFn();
            } finally {
                this.suppressProviderChangedNotification = false;
            }
        }
        await this.flushMemorySession();

        this.cleanup();
        this.modelListCache.clear();
        this.initializeProvider();
        this.notifyProviderChanged();
    }

    public async switchModel(modelId: string, saveFn?: () => Promise<void>): Promise<void> {
        const config = this.getActiveProviderConfig();
        if (!config) return;

        config.model = modelId;
        if (saveFn) await saveFn();
        await this.flushMemorySession();

        this.cleanup();
        this.initializeProvider();
    }

    public onProviderChanged(callback: () => void): () => void {
        this.providerChangedCallbacks.push(callback);
        return () => {
            this.providerChangedCallbacks = this.providerChangedCallbacks.filter(cb => cb !== callback);
        };
    }

    public async updateSettings(settings: PluginSettings) {
        await this.flushMemorySession();
        this.settings = settings;
        this.cleanup();
        this.initializeProvider();
        this.modelListCache.clear();
        if (!this.suppressProviderChangedNotification) {
            this.notifyProviderChanged();
        }
    }

    private notifyProviderChanged(): void {
        this.providerChangedCallbacks.forEach(cb => cb());
    }

    private unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
        logger.error('Unhandled Promise Rejection', event.reason, 'GlobalErrorHandler');
    };

    private setupErrorHandlers() {
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        window.addEventListener('unhandledrejection', this.unhandledRejectionHandler);
    }

    private cleanup() {
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        this.memoryManager = null;
    }

    private async flushMemorySession() {
        if (!this.memoryManager) return;
        await this.memoryManager.ready();
        await this.memoryManager.clearSession();
        await this.memoryManager.save();
    }

    async checkAvailability(): Promise<boolean> {
        const config = this.getActiveProviderConfig();
        if (!config) return false;
        return await modelCatalog.checkAvailability(config);
    }

    async getAvailableModels(forceRefresh: boolean = false): Promise<ModelOption[]> {
        const providerId = this.settings.activeProvider;
        const config = this.getActiveProviderConfig();
        if (!config) return [];

        const cacheKey = `${providerId}:${config.baseUrl}:${(config.apiKey || '').slice(0, 8)}`;
        const now = Date.now();

        if (!forceRefresh) {
            const cached = this.modelListCache.get(cacheKey);
            if (cached && now - cached.timestamp < this.modelListCacheTtlMs) {
                return this.ensureCurrentModelInList(cached.models);
            }
        }

        let models: ModelOption[] = [];
        if (config.apiKey?.trim()) {
            try {
                models = await modelCatalog.listModels(config);
            } catch (error: any) {
                logger.warn(
                    `Failed to fetch model list for provider ${providerId}: ${error?.message || 'Unknown error'}`,
                    'ModelService.getAvailableModels'
                );
            }
        }

        if (!models.length) {
            models = this.getFallbackModels(providerId);
        }

        const normalized = this.ensureCurrentModelInList(this.normalizeModelOptions(models));
        this.modelListCache.set(cacheKey, { timestamp: now, models: normalized });
        return normalized;
    }

    private getFallbackModels(providerId: string): ModelOption[] {
        const fallbacks: Record<string, ModelOption[]> = {
            gemini: [
                { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
                { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
                { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
                { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
            ],
            openai: [
                { value: 'gpt-4o', label: 'GPT-4o' },
                { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
                { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
                { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
            ],
            deepseek: [
                { value: 'deepseek-chat', label: 'DeepSeek Chat' },
                { value: 'deepseek-coder', label: 'DeepSeek Coder' },
            ],
            qwen: [
                { value: 'qwen-turbo', label: 'Qwen Turbo' },
                { value: 'qwen-plus', label: 'Qwen Plus' },
                { value: 'qwen-max', label: 'Qwen Max' },
            ],
        };
        return fallbacks[providerId] || [];
    }

    private normalizeModelOptions(options: ModelOption[]): ModelOption[] {
        const deduped = new Map<string, ModelOption>();

        options.forEach((option: ModelOption) => {
            if (!option || typeof option.value !== 'string') return;
            const value = option.value.trim();
            if (!value) return;

            const label = typeof option.label === 'string' && option.label.trim().length > 0
                ? option.label.trim()
                : value;

            if (!deduped.has(value)) {
                deduped.set(value, { value, label });
            }
        });

        return Array.from(deduped.values());
    }

    private ensureCurrentModelInList(options: ModelOption[]): ModelOption[] {
        const currentModel = this.getActiveProviderConfig()?.model || '';
        if (!currentModel) return options;

        const exists = options.some(option => option.value === currentModel);
        if (exists) return options;

        return [{ value: currentModel, label: `${currentModel} (Current)` }, ...options];
    }

    async chat(
        userMessage: string,
        contextItems: any[],
        selection: string = '',
        source: GenerationSource = 'shell',
        obsidianContext?: ObsidianContextSnapshot,
        userProfile?: UserProfile | null,
        systemPromptOverride?: string,
        priorMessages?: PriorChatMessage[],
    ): Promise<string> {
        logger.info(`Processing chat message: ${userMessage.substring(0, 50)}...`, 'ModelService.chat');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            const error = `${providerLabel} API Key not configured!`;
            logger.error(error, new Error(error), 'ModelService.chat');
            new Notice(error);
            return 'Error: API Key missing.';
        }

        try {
            const runtime = this.createChatRuntime();
            const resolvedPrior = await this.resolvePriorMessages(priorMessages);
            const preparedTurn = await runtime.prepareTurn({
                userMessage,
                contextItems,
                selection,
                source,
                obsidianContext,
                userProfile: userProfile ?? this.getUserProfile(),
                systemPromptOverride,
                priorMessages: resolvedPrior,
            });
            return await runtime.query(preparedTurn);
        } catch (e: any) {
            logger.error('Chat processing failed', e, 'ModelService.chat');
            return `Error: ${e.message}`;
        }
    }

    async *chatStream(
        userMessage: string,
        contextItems: any[],
        selection: string = '',
        source: GenerationSource | AbortSignal = 'shell',
        obsidianContext?: ObsidianContextSnapshot,
        userProfile?: UserProfile | null,
        signal?: AbortSignal,
        priorMessages?: PriorChatMessage[],
    ): AsyncGenerator<StreamEvent, void, unknown> {
        logger.info(`Processing streaming chat: ${userMessage.substring(0, 50)}...`, 'ModelService.chatStream');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            yield { type: 'error' as const, message: `${providerLabel} API Key not configured!` };
            return;
        }

        try {
            const resolvedSource = this.isAbortSignalValue(source) ? 'shell' : source;
            const resolvedSignal = this.isAbortSignalValue(source) ? source : signal;
            const runtime = this.createChatRuntime();
            const resolvedPrior = await this.resolvePriorMessages(priorMessages);
            const preparedTurn = await runtime.prepareTurn({
                userMessage,
                contextItems,
                selection,
                source: resolvedSource,
                obsidianContext,
                userProfile: userProfile ?? this.getUserProfile(),
                priorMessages: resolvedPrior,
            });
            for await (const event of runtime.queryStream(preparedTurn, resolvedSignal)) {
                yield event;
            }
        } catch (e: any) {
            if (this.isAbortError(e)) {
                throw e;
            }
            logger.error('Stream chat failed', e, 'ModelService.chatStream');
            yield { type: 'error' as const, message: e.message };
        }
    }

    async generate(
        prompt: string,
        systemPrompt?: string,
        source: GenerationSource = 'shell',
        obsidianContext?: ObsidianContextSnapshot,
        userProfile?: UserProfile | null,
        options?: GenerationOptions,
    ): Promise<string> {
        if (!this.hasValidConfig()) {
            throw new Error(`${this.getActiveProviderConfig()?.label || 'AI'} API Key not configured`);
        }

        try {
            // timeoutMs 不再单独消费：pi 的无状态生成走原生 signal 硬中断，
            // 旧的 requestUrl 超时语义由调用方用 AbortSignal 表达（见下）。
            const { skipGenerationPlan, signal, timeoutMs, ...providerOptions } = options ?? {};
            if (signal?.aborted) {
                throw new DOMException('Generation aborted', 'AbortError');
            }
            const shouldApplyGenerationPlan = !skipGenerationPlan && (source !== 'shell' || !!obsidianContext || !!userProfile);
            const finalPrompt = shouldApplyGenerationPlan
                ? this.buildPlannedGenerationPrompt(
                    prompt,
                    source,
                    obsidianContext,
                    userProfile ?? this.getUserProfile(),
                )
                : prompt;
            // 无状态生成走 pi 原生 completeSimple（取代旧 provider.generateContent）。
            // signal 直接透传给 pi 做硬中断，不再需要 raceWithAbort 软取消。
            const complete = this.buildNativeCompleteFn();
            const text = await complete(finalPrompt, systemPrompt, {
                ...(typeof providerOptions.temperature === 'number' ? { temperature: providerOptions.temperature } : {}),
                ...(typeof providerOptions.maxTokens === 'number' ? { maxTokens: providerOptions.maxTokens } : {}),
                ...(signal ? { signal } : {}),
            });
            if (!text?.trim()) {
                const config = this.getActiveProviderConfig();
                logger.warn('Stateless generation returned empty text', 'ModelService.generate', {
                    source,
                    provider: this.settings.activeProvider,
                    providerType: config?.type,
                    model: config?.model,
                    promptLength: finalPrompt.length,
                    hasSystemPrompt: !!systemPrompt,
                    maxTokens: providerOptions.maxTokens,
                });
            }
            return text;
        } catch (e: any) {
            // 软取消是正常流程，不当错误记录，避免日志噪音。
            if (e?.name === 'AbortError') throw e;
            logger.error('Stateless generation failed', e, 'ModelService.generate');
            throw e;
        }
    }

    async clearSession() {
        if (this.memoryManager) {
            await this.memoryManager.clearSession();
        }
        // 与内存历史协调：/clear 时开一个新的持久会话文件（旧文件保留），
        // 使跨轮上下文与内存会话保持一致。
        if (this.sessionStore) {
            try {
                await this.sessionStore.clearSession();
            } catch (error) {
                logger.warn('Failed to start a fresh persistent session on clear.', 'ModelService.clearSession');
            }
        }
    }

    getUserProfile(): UserProfile | null {
        return this.memoryManager ? this.memoryManager.getProfile() : null;
    }

    async getMemoryView(request: MemoryViewRequest = {}): Promise<MemoryView | null> {
        return this.memoryManager ? await this.memoryManager.getMemoryView(request) : null;
    }

    async updateProfile(updates: Partial<UserProfile>) {
        if (this.memoryManager) {
            await this.memoryManager.updateProfile(updates);
        }
    }

    async forgetMemory(field: string): Promise<MemoryMutationResult | null> {
        return this.memoryManager ? await this.memoryManager.forgetMemory(field) : null;
    }

    async deleteMemoryById(id: string): Promise<MemoryMutationResult | null> {
        return this.memoryManager ? await this.memoryManager.deleteMemoryById(id) : null;
    }

    /**
     * 用户点踩时透传:把「被否定的回答 + 原因」提炼成一条「应避免」教训写入记忆。
     * 返回写入的教训文本(供调用方做即时 steering),无记忆管理器时返回 null。
     */
    async retainLesson(input: {
        userInput: string;
        rejectedOutput: string;
        reason: string;
        source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
    }): Promise<string | null> {
        if (!this.memoryManager) return null;
        const retainLesson = (this.memoryManager as any).retainLesson;
        if (typeof retainLesson !== 'function') return null;
        return await retainLesson.call(this.memoryManager, input);
    }

    getAvailableTools() {
        return this.createChatRuntime().getTools();
    }

    getSkillCommands(): SkillCommandEntry[] {
        return this.skillRegistry.listCommandEntries();
    }

    /** 返回所有 skill 摘要（含被禁用的），供设置页 🧩 Skills 区块列出并逐个开关。 */
    getSkillList(): SkillSummary[] {
        return this.skillRegistry.getAllSkillSummaries();
    }

    getProviderCapabilities(): ProviderCapabilities {
        return modelCatalog.getProviderCapabilities(this.getActiveProviderConfig());
    }

    async executeSlashSkillCommand(command: string, input: string): Promise<any> {
        const skill = this.skillRegistry.resolveByCommand(command);
        if (!skill) {
            return { success: false, error: `Unknown command: ${command}` };
        }

        if (skill.executionMode === 'instructions') {
            const runtime = this.createChatRuntime();
            const preparedTurn = await runtime.prepareTurn({
                userMessage: input,
                contextItems: [],
                forcedSkillName: skill.name,
            });
            const message = await runtime.query(preparedTurn);
            return { success: true, message };
        }

        return skill.execute({
            command,
            input,
            query: input,
            url: input,
        }, {
            app: this.app,
            settings: this.settings,
        });
    }

    async executeApprovedAction(action: string, args: Record<string, any>): Promise<any> {
        const result = await this.toolRegistry.execute(action, {
            ...args,
            approved: true,
        });
        await this.recordOperationAudit({
            action,
            target: getFileWriteResultPath(action, result, args) || action,
            approvalSource: 'user-click',
            undoable: this.isUndoableApprovedAction(action),
        });
        return result;
    }

    async executeWorkspaceTool(action: string, args: Record<string, any>): Promise<any> {
        return this.workspaceEditService.executeWorkspaceTool(action, args);
    }

    async undoWorkspaceEdit(editId: string) {
        return this.workspaceEditService.undoWorkspaceEdit(editId);
    }

    async undoAllWorkspaceEdits() {
        return this.workspaceEditService.undoAllWorkspaceEdits();
    }

    listWorkspaceEdits() {
        return this.workspaceEditService.listWorkspaceEdits();
    }

    async recordDirectWrite(input: {
        action: string;
        target: string;
        previousContent?: string;
        undoable?: boolean;
    }): Promise<void> {
        await this.recordOperationAudit({
            action: input.action,
            target: input.target,
            approvalSource: 'direct-write',
            previousContent: input.previousContent,
            undoable: input.undoable ?? true,
        });
    }

    createChatRuntime() {
        return createChatRuntime({
            nativeChatFactory: () => this.buildNativeChatHandle(),
            memoryManager: this.memoryManager,
            toolRegistry: this.toolRegistry,
            skillRegistry: this.skillRegistry,
            workspaceEditService: this.workspaceEditService,
            sessionStore: this.sessionStore,
            contextWindow: this.settings.contextWindow,
            thinkingLevel: this.settings.thinkingLevel,
            steeringController: this.steeringController,
        });
    }

    /**
     * 构造本轮的原生 LLM 直连句柄（Phase 2）。
     * 依当前 ProviderConfig.type 选择 model 构造器，并用同一 apiKey 造 streamFn。
     * 每轮 queryStream 启动时调用一次，故 settings 运行期改动（切换 provider/model/key/
     * contextWindow/thinkingLevel）都会在下一轮自动生效。
     */
    private buildNativeChatHandle() {
        const config = this.getActiveProviderConfig();
        if (!config) {
            throw new Error(`Unknown provider: ${this.settings.activeProvider}`);
        }
        const model = config.type === 'gemini'
            ? buildGeminiModel(config, this.settings.contextWindow, this.settings.thinkingLevel)
            : buildOpenAICompatModel(config, this.settings.contextWindow, this.settings.thinkingLevel);
        return {
            model,
            streamFn: createNativeStreamFn(config.apiKey),
        };
    }

    /**
     * 构造无状态生成函数（Phase 1）。与 buildNativeChatHandle 同源：依当前 ProviderConfig.type
     * 造 model，用同一 apiKey 造 completeFn（底层 pi completeSimple）。
     * 每次 generate() 调用一次，故 settings 运行期改动（切 provider/model/key）下次即生效。
     */
    private buildNativeCompleteFn(): NativeCompleteFn {
        const config = this.getActiveProviderConfig();
        if (!config) {
            throw new Error(`Unknown provider: ${this.settings.activeProvider}`);
        }
        const model = config.type === 'gemini'
            ? buildGeminiModel(config, this.settings.contextWindow, this.settings.thinkingLevel)
            : buildOpenAICompatModel(config, this.settings.contextWindow, this.settings.thinkingLevel);
        return createNativeCompleteFn(model, config.apiKey);
    }

    /**
     * 运行中补话入口：长任务运行时往 steering 队列追加一条用户指令，
     * 不打断当前流，由正在运行的 agentLoop 在下一轮纳入。空白文本忽略。
     */
    public steerActiveRun(text: string): void {
        this.steeringController.steer(text);
    }

    /**
     * 运行时调整可用工具集：下一轮起 pi 只在这些工具内执行调用（read_skill 由 runtime 兜底保留）。
     */
    public setActiveTools(toolNames: string[]): void {
        this.steeringController.setActiveTools(toolNames);
    }

    /** 当前是否有尚未纳入的补话。供 UI 显示「补话已排队」状态。 */
    public hasPendingSteering(): boolean {
        return this.steeringController.hasPendingSteering();
    }

    /**
     * 解析本轮的 priorMessages 来源：
     * - 有 SessionStore 时，从持久会话派生（含压缩视图），作为跨轮上下文的唯一真相源；
     *   UI 传入的 priorMessages 被忽略（UI 退化为纯渲染）。
     * - 无 SessionStore 时，沿用 UI 回灌的 priorMessages（旧行为）。
     */
    private async resolvePriorMessages(
        fallback?: PriorChatMessage[],
    ): Promise<PriorChatMessage[] | undefined> {
        if (!this.sessionStore) return fallback;
        try {
            return await this.sessionStore.buildPriorMessages();
        } catch (error) {
            logger.warn('Failed to derive prior messages from session; using UI fallback.', 'ModelService');
            return fallback;
        }
    }

    private isAbortError(error: any): boolean {
        return error?.name === 'AbortError';
    }

    private isAbortSignalValue(value: unknown): value is AbortSignal {
        return !!value
            && typeof value === 'object'
            && 'aborted' in value
            && typeof (value as AbortSignal).addEventListener === 'function';
    }

    private async recordOperationAudit(input: {
        action: string;
        target: string;
        approvalSource: 'user-click' | 'direct-write';
        previousContent?: string;
        undoable: boolean;
    }): Promise<void> {
        if (!input.target) return;

        const config = this.getActiveProviderConfig();
        await this.operationAuditLog.record({
            action: input.action,
            target: input.target,
            provider: this.settings?.activeProvider,
            model: config?.model,
            approvalSource: input.approvalSource,
            previousContentHash: input.previousContent ? computeContentHash(input.previousContent) : undefined,
            undoable: input.undoable,
        });
    }

    private isUndoableApprovedAction(action: string): boolean {
        return !['delete_note', 'rename_note'].includes(action);
    }

    private buildPlannedGenerationPrompt(
        prompt: string,
        source: GenerationSource,
        obsidianContext?: ObsidianContextSnapshot,
        userProfile?: UserProfile | null,
    ): string {
        const generationStrategyService = this.generationStrategyService ?? new GenerationStrategyService();
        const context = obsidianContext ?? {
            activeNote: null,
            selection: null,
            activeHeading: null,
            frontmatter: {},
            tags: [],
            outgoingLinks: [],
            backlinks: [],
            recentNotes: [],
            explicitScopes: [],
            contextItems: [],
        };
        const plan = generationStrategyService.resolvePlan({
            userMessage: prompt,
            source,
            context,
            profile: userProfile,
        });
        const writingProfile = generationStrategyService.buildWritingProfile(
            context,
            userProfile,
        );
        return `${formatGenerationPlanBlock(plan, writingProfile)}User Request: ${prompt}`;
    }

    async shutdown() {
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        await this.flushMemorySession();
    }
}
