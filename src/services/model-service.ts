import { App, Notice } from 'obsidian';
import { PluginSettings, ProviderConfig } from '../mcp/types';
import { MemoryManager } from '../memory/memory-manager';
import { MemoryMutationResult, MemoryView, MemoryViewRequest, UserProfile } from '../memory/types';
import { logger } from '../utils/logger';
import { GenerationOptions, ModelOption, ToolDefinition, StreamEvent } from '../models/interfaces';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { SkillCommandEntry, SkillSummary } from '../skills/types';
import { createChatRuntime } from '../runtime/runtime-factory';
import { buildGeminiModel, buildOpenAICompatModel, createNativeCompleteFn, NativeCompleteFn } from '../runtime/pi/pi-native-model';
import { createHarnessExecutionEnv } from '../runtime/pi/harness-env';
import { ProviderCapabilities } from '../runtime/provider-capabilities';
import * as modelCatalog from './model-catalog-service';
import { ActiveRunController } from '../runtime/active-run-controller';
import { PromptTemplateService } from '../runtime/pi/prompt-template-service';
import { HarnessSessionManager, type PersistedSessionRef } from '../runtime/pi/harness-session-manager';
import { projectBranchToMessages } from '../runtime/pi/session-branch-projector';
import type { ChatMessage } from '../ui/types';
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
     * Harness 会话生命周期管理器。仅当 vault.adapter 可用时启用(桌面与移动端均有,测试 mock 可能缺失)。
     * 持有长生命持久化 session,交给每轮 Harness 复用;提供跨轮上下文、跨重启恢复与自动压缩。
     * 不可用时退化为每轮全新内存会话(无持久化、无压缩)。
     */
    private sessionManager: HarnessSessionManager | null = null;
    /**
     * pi AgentHarness 所需的完整 ExecutionEnv(FileSystem + NoopShell)。
     * 与 sessionManager 同源(同一 vault adapter),vault 不可用时为 null。
     */
    private harnessEnv: unknown = null;
    /**
     * 用户自定义 slash 命令服务(基于 pi prompt-template)。与 harnessEnv 同源;
     * 从 .obsidian/baizer-commands/*.md 加载,vault 不可用时为 null。
     */
    private promptTemplateService: PromptTemplateService | null = null;
    /**
     * 运行中 run 控制器。持有当前活跃的 AgentHarness,使「补话」与「动态工具集」
     * 直接走 Harness 原生 steer()/setActiveTools()。跨轮复用同一实例:runtime 在每次
     * queryStream 启动时 register 新 harness、结束时 clear,故 steer 窗口对齐当前流。
     */
    private readonly activeRunController = new ActiveRunController();

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
        this.initializeSessionManager();
        // 预热用户命令缓存(异步,不阻塞构造),使 / 补全的同步路径尽快有值。
        void this.reloadUserCommands();
    }

    /**
     * 构造 Harness 会话管理器 + ExecutionEnv(同源,同一 vault adapter)。
     * 会话引用存进插件 data(settings.sessionRef),实现跨重启恢复。
     * vault.adapter 不可用时静默跳过(退化为每轮全新内存会话)。
     *
     * 自动压缩阈值取当前模型上下文窗口(settings 可运行期改动,用 getter 取最新值);
     * 摘要不再自己生成——pi 的 compact() 复用 Harness 的 provider(getApiKeyAndHeaders)。
     */
    private initializeSessionManager() {
        const adapter = (this.app?.vault as any)?.adapter;
        if (!adapter || typeof adapter.read !== 'function' || typeof adapter.append !== 'function') {
            this.sessionManager = null;
            this.harnessEnv = null;
            this.promptTemplateService = null;
            return;
        }
        try {
            const vaultAdapter = createVaultFileAdapter(adapter);
            this.sessionManager = new HarnessSessionManager(vaultAdapter, {
                loadRef: (conversationId) => this.loadSessionRef(conversationId),
                saveRef: (conversationId, ref) => this.saveSessionRef(conversationId, ref),
                contextWindow: () => this.settings.contextWindow ?? 0,
            });
            this.harnessEnv = createHarnessExecutionEnv(vaultAdapter);
            // 用户自定义命令服务与 harnessEnv 同源;懒加载模板(首次列命令/执行时读盘)。
            this.promptTemplateService = new PromptTemplateService(this.harnessEnv);
        } catch (error) {
            logger.warn('Failed to initialize HarnessSessionManager; falling back to in-memory sessions.', 'ModelService');
            this.sessionManager = null;
            this.harnessEnv = null;
            this.promptTemplateService = null;
        }
    }

    private loadSessionRef(conversationId: string): PersistedSessionRef | null {
        const refs = this.settings.sessionRefs;
        if (refs && refs[conversationId]) return refs[conversationId];
        // 迁移兜底:旧版全局单例 sessionRef 归属到第一个来取的会话,取后清空避免重复认领。
        if (this.settings.sessionRef) {
            const legacy = this.settings.sessionRef;
            this.settings.sessionRef = null;
            (this.settings.sessionRefs ??= {})[conversationId] = legacy;
            return legacy;
        }
        return null;
    }

    private saveSessionRef(conversationId: string, ref: PersistedSessionRef | null): void {
        const refs = (this.settings.sessionRefs ??= {});
        if (ref) {
            refs[conversationId] = ref;
        } else {
            delete refs[conversationId];
        }
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
            // 注入无状态生成回调,供记忆沉淀/合成走 LLM 提炼(避免 MemoryManager 反向依赖 ModelService)。
            // 用箭头函数捕获 this,并显式跳过 generationPlan(记忆提炼是纯文本任务,不需要写作策略装饰)。
            generate: (prompt: string, systemPrompt?: string) =>
                this.generate(prompt, systemPrompt, 'shell', undefined, null, { skipGenerationPlan: true }),
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
        // 排空在途后台沉淀并确保 memories.json 落盘,避免设置变更重建实例时丢在途写。
        await this.memoryManager.flush();
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

        const models = await this.fetchModelsForProvider(providerId, config, forceRefresh);
        return this.ensureModelInList(models, config.model || '');
    }

    /**
     * 列出所有「已配置(有 apiKey)」provider 的模型,按 settings.providers 顺序分组返回。
     * 供底部合并下拉(provider 作 optgroup 标题)使用。并发抓取,单个 provider 失败不影响其余。
     */
    async getAllProviderModels(forceRefresh: boolean = false): Promise<
        Array<{ providerId: string; providerLabel: string; models: ModelOption[] }>
    > {
        const entries = Object.entries(this.settings.providers)
            .filter(([, config]) => config.apiKey?.trim());

        const groups = await Promise.all(
            entries.map(async ([providerId, config]) => {
                let models = await this.fetchModelsForProvider(providerId, config, forceRefresh);
                // 当前选中的模型置顶保证一定可选中(即便该 provider 抓取失败只剩 fallback)。
                if (providerId === this.settings.activeProvider) {
                    models = this.ensureModelInList(models, config.model || '');
                }
                return { providerId, providerLabel: config.label, models };
            })
        );

        return groups.filter(group => group.models.length > 0);
    }

    /** 抓取单个 provider 的模型列表(带缓存 + fallback 兜底),不做「当前模型置顶」——由调用方按需处理。 */
    private async fetchModelsForProvider(
        providerId: string,
        config: ProviderConfig,
        forceRefresh: boolean,
    ): Promise<ModelOption[]> {
        const cacheKey = `${providerId}:${config.baseUrl}:${(config.apiKey || '').slice(0, 8)}`;
        const now = Date.now();

        if (!forceRefresh) {
            const cached = this.modelListCache.get(cacheKey);
            if (cached && now - cached.timestamp < this.modelListCacheTtlMs) {
                return cached.models;
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

        const normalized = this.normalizeModelOptions(models);
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

    /** 确保指定模型 id 出现在列表里(不在则以「(Current)」标注置顶),避免下拉选不中已保存的模型。 */
    private ensureModelInList(options: ModelOption[], modelId: string): ModelOption[] {
        if (!modelId) return options;

        const exists = options.some(option => option.value === modelId);
        if (exists) return options;

        return [{ value: modelId, label: `${modelId} (Current)` }, ...options];
    }

    async chat(
        userMessage: string,
        contextItems: any[],
        selection: string = '',
        source: GenerationSource = 'shell',
        obsidianContext?: ObsidianContextSnapshot,
        userProfile?: UserProfile | null,
        systemPromptOverride?: string,
        conversationId?: string,
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
            const preparedTurn = await runtime.prepareTurn({
                userMessage,
                contextItems,
                selection,
                source,
                obsidianContext,
                userProfile: userProfile ?? this.getUserProfile(),
                systemPromptOverride,
                conversationId,
                ...(this.sessionManager ? { hasPriorContext: await this.sessionManager.hasHistory(conversationId) } : {}),
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
        conversationId?: string,
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
            const preparedTurn = await runtime.prepareTurn({
                userMessage,
                contextItems,
                selection,
                source: resolvedSource,
                obsidianContext,
                userProfile: userProfile ?? this.getUserProfile(),
                conversationId,
                ...(this.sessionManager ? { hasPriorContext: await this.sessionManager.hasHistory(conversationId) } : {}),
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

    async clearSession(conversationId?: string) {
        if (this.memoryManager) {
            await this.memoryManager.clearSession();
        }
        // /clear 时为该会话开一个新的持久会话文件(旧文件保留),使 Harness 跨轮上下文从零开始。
        // conversationId 缺省时无持久会话可清(临时会话本就每轮新建)。
        if (this.sessionManager && conversationId) {
            try {
                await this.sessionManager.clear(conversationId);
            } catch (error) {
                logger.warn('Failed to start a fresh persistent session on clear.', 'ModelService.clearSession');
            }
        }
    }

    /** 释放某会话的内存态(关闭 tab 时调)。不删磁盘,持久 ref 保留,下次可恢复。 */
    releaseSession(conversationId: string): void {
        this.sessionManager?.release(conversationId);
    }

    // ---- 阶段C:会话分支操作(投影 / 切换 / 重跑定位)----

    /**
     * 取该会话当前活跃分支的投影(ChatMessage[])。无持久会话时返回 null(调用方用 UI 内存历史)。
     * 供切换分支/重跑后重建 tab.state 与重渲。
     */
    async getBranchProjection(conversationId?: string): Promise<ChatMessage[] | null> {
        if (!this.sessionManager || !conversationId) return null;
        try {
            const { branch, all } = await this.sessionManager.getBranchEntries(conversationId);
            if (branch.length === 0) return null;
            return projectBranchToMessages(branch as any, all as any);
        } catch (e) {
            logger.warn('Failed to project session branch.', 'ModelService.getBranchProjection');
            return null;
        }
    }

    /**
     * 切换到某兄弟分支(其子树叶子为 targetLeafEntryId),返回切换后的新投影。
     * 不发起生成,仅移动活跃 leaf + 重投影。失败(无会话/目标不存在)返回 null。
     */
    async switchBranch(conversationId: string, targetLeafEntryId: string): Promise<ChatMessage[] | null> {
        if (!this.sessionManager) return null;
        try {
            const ok = await this.sessionManager.moveToBranch(conversationId, targetLeafEntryId);
            if (!ok) return null;
            return this.getBranchProjection(conversationId);
        } catch (e) {
            logger.warn('Failed to switch session branch.', 'ModelService.switchBranch');
            return null;
        }
    }

    /**
     * 为「从某 user 消息重跑/编辑」定位:把活跃 leaf 移到该 user 消息之前。
     * 之后调用方走正常 chatStream(带新文本或原文),新回复与原 user 成为兄弟分支,原分支保留。
     * 返回是否定位成功;失败时调用方应放弃重跑。
     */
    async prepareRetryFromUser(
        conversationId: string,
        userEntryId: string,
        options?: { supersede?: boolean },
    ): Promise<boolean> {
        if (!this.sessionManager) return false;
        try {
            // 重试语义(supersede=true):先给旧问答分支打作废标记,再定位到该 user 之前重跑。
            // projector 会过滤掉作废分支,于是重试后有效兄弟只剩新的一条(旧答案被换掉,不留分支)。
            // 分叉/编辑(supersede 缺省):不打标记,新回复与原分支成兄弟、可 < n/m > 切换。
            if (options?.supersede) {
                await this.sessionManager.supersedeUserEntry(conversationId, userEntryId);
            }
            return await this.sessionManager.prepareForkAtUser(conversationId, userEntryId);
        } catch (e) {
            logger.warn('Failed to prepare retry/fork position.', 'ModelService.prepareRetryFromUser');
            return false;
        }
    }

    getUserProfile(): UserProfile | null {
        return this.memoryManager ? this.memoryManager.getProfile() : null;
    }

    async getMemoryView(request: MemoryViewRequest = {}): Promise<MemoryView | null> {
        return this.memoryManager ? await this.memoryManager.getMemoryView(request) : null;
    }

    /**
     * 为 Guardian 深补召回相关个人记忆(observation/world,不含 experience 闲聊)。
     * 走 Hindsight BM25 召回,与知识 wiki 节选互补:wiki 提供「笔记连接」,记忆提供「个人事实连接」。
     * 无 memoryManager 或无命中时返回空串,调用方据此不注入。
     */
    async recallGuardianMemory(query: string, maxChars = 500): Promise<string> {
        if (!this.memoryManager) return '';
        if (!query.trim()) return '';
        return await this.memoryManager.recallForPrompt({ query, source: 'guardian', maxChars });
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

    /**
     * 用户自定义 slash 命令列表(来自 .obsidian/baizer-commands/*.md)。
     * 供 / 补全与 slash 契约合并。vault 不可用时返回空。
     */
    async getUserCommands() {
        if (!this.promptTemplateService) return [];
        return this.promptTemplateService.listCommands();
    }

    /** 同步返回已加载的用户命令快照(供 / 补全等同步 UI 路径)。启动预热后有值。 */
    getUserCommandsSync() {
        return this.promptTemplateService ? this.promptTemplateService.listCommandsSync() : [];
    }

    /** 重新加载用户命令模板(用户新增/修改后调用)。 */
    async reloadUserCommands(): Promise<void> {
        if (this.promptTemplateService) await this.promptTemplateService.load();
    }

    /**
     * 执行用户自定义命令:把模板按参数展开成 prompt,当作普通对话轮发送。
     * 未找到模板返回 { success:false }(调用方回退到未知命令处理)。
     */
    async executeUserCommand(command: string, argsString: string): Promise<{ handled: boolean; message?: string }> {
        if (!this.promptTemplateService) return { handled: false };
        const prompt = await this.promptTemplateService.resolve(command, argsString);
        if (prompt === null) return { handled: false };
        const message = await this.chat(prompt, [], '');
        return { handled: true, message };
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
            sessionManager: this.sessionManager,
            harnessEnv: this.harnessEnv,
            contextWindow: this.settings.contextWindow,
            thinkingLevel: this.settings.thinkingLevel,
            activeRunController: this.activeRunController,
            getUserCommandEntries: () => this.getUserCommandsSync().map(c => ({ command: c.command, description: c.description })),
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
            // AgentHarness 通过 getApiKeyAndHeaders 按需取 key;取当前 provider 的最新 apiKey。
            // (不再提供 streamFn:Harness 内部按 model.api 路由到 pi api-registry,不消费注入的 streamFn。)
            getApiKey: () => this.getActiveProviderConfig()?.apiKey ?? '',
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
     * 运行中补话入口:把一条用户指令转发给当前活跃 harness 的原生 steer(),
     * 不打断当前流,由 Harness 在下一轮纳入。无活跃 run 或空白文本时忽略。
     */
    public steerActiveRun(text: string): void {
        this.activeRunController.steer(text);
    }

    /**
     * 运行时调整可用工具集:转发给当前活跃 harness 的原生 setActiveTools()
     * (read_skill 由控制器兜底保留)。无活跃 run 时忽略。
     */
    public setActiveTools(toolNames: string[]): void {
        this.activeRunController.setActiveTools(toolNames);
    }

    /** 当前是否有正在运行、可被补话的 run。供 UI 决定补话入口可用态。 */
    public hasPendingSteering(): boolean {
        return this.activeRunController.isActive();
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
