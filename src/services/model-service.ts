import { App, Notice } from 'obsidian';
import { PluginSettings, ProviderConfig } from '../mcp/types';
import { MemoryManager } from '../memory/memory-manager';
import { UserProfile } from '../memory/types';
import { logger } from '../utils/logger';
import { IModelProvider, ModelOption, ToolDefinition, StreamEvent } from '../models/interfaces';
import { GeminiProvider } from '../models/gemini';
import { OpenAIProvider } from '../models/openai';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';

export class ModelService {
    private provider: IModelProvider;
    private memoryManager: MemoryManager | null = null;
    private readonly modelListCache = new Map<string, { timestamp: number; models: ModelOption[] }>();
    private readonly modelListCacheTtlMs = 10 * 60 * 1000;
    private providerChangedCallbacks: Array<() => void> = [];

    // Skill 架构
    private skillRegistry: SkillRegistry;
    private toolRegistry: ToolRegistry;

    // 创建超时工具函数，使用 AbortController 确保定时器被清理
    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        errorMessage: string
    ): Promise<T> {
        const controller = new AbortController();

        const timeoutPromise = new Promise<never>((_, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(errorMessage));
            }, timeoutMs);

            // 如果控制器被中止，清理定时器
            controller.signal.addEventListener('abort', () => {
                clearTimeout(timeoutId);
            });
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            // 清理定时器
            controller.abort();
        }
    }

    constructor(private app: App, private settings: PluginSettings, toolRegistry: ToolRegistry, skillRegistry: SkillRegistry) {
        this.toolRegistry = toolRegistry;
        this.skillRegistry = skillRegistry;
        this.initializeProvider();
        this.setupErrorHandlers();
    }

    private initializeProvider() {
        const config = this.getActiveProviderConfig();
        if (!config) {
            logger.error(`Unknown provider: ${this.settings.activeProvider}`, null, 'ModelService');
            this.provider = new GeminiProvider();
            return;
        }

        switch (config.type) {
            case 'gemini':
                this.provider = new GeminiProvider();
                break;
            case 'openai-compatible':
                this.provider = new OpenAIProvider();
                break;
            default:
                logger.error(`Unknown provider type: ${config.type}`, null, 'ModelService');
                this.provider = new GeminiProvider();
        }

        this.provider.configure({
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            modelName: config.model,
            systemPrompt: this.settings.systemPrompt,
            contextWindow: this.settings.contextWindow
        });

        // Initialize MemoryManager with the selected provider
        if (this.hasValidConfig()) {
            this.memoryManager = new MemoryManager(this.app, this.provider);
        }
    }

    private hasValidConfig(): boolean {
        const config = this.getActiveProviderConfig();
        return !!config?.apiKey;
    }

    /** 获取当前激活的 provider 配置 */
    getActiveProviderConfig(): ProviderConfig | undefined {
        return this.settings.providers[this.settings.activeProvider];
    }

    /** 唯一的 provider 切换入口，设置页和边栏都走这里 */
    public async switchProvider(providerId: string, saveFn?: () => Promise<void>): Promise<void> {
        const config = this.settings.providers[providerId];
        if (!config) return;

        this.settings.activeProvider = providerId;
        if (saveFn) await saveFn();

        // 清理旧状态
        this.cleanup();
        this.modelListCache.clear();

        // 重建 provider
        this.initializeProvider();

        // 通知所有监听者
        this.providerChangedCallbacks.forEach(cb => cb());
    }

    /** 更新 model 选择 */
    public async switchModel(modelId: string, saveFn?: () => Promise<void>): Promise<void> {
        const config = this.getActiveProviderConfig();
        if (!config) return;

        config.model = modelId;
        if (saveFn) await saveFn();

        // 重建 provider 以使用新 model
        this.cleanup();
        this.initializeProvider();
    }

    /** 注册 provider 变更监听，返回取消注册函数 */
    public onProviderChanged(callback: () => void): () => void {
        this.providerChangedCallbacks.push(callback);
        return () => {
            this.providerChangedCallbacks = this.providerChangedCallbacks.filter(cb => cb !== callback);
        };
    }

    public updateSettings(settings: PluginSettings) {
        this.settings = settings;
        this.cleanup();
        this.initializeProvider();
        this.modelListCache.clear();
    }

    private unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
        logger.error('Unhandled Promise Rejection', event.reason, 'GlobalErrorHandler');
    };

    private setupErrorHandlers() {
        // 先移除已存在的监听器，避免重复注册
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        // 再添加新的监听器
        window.addEventListener('unhandledrejection', this.unhandledRejectionHandler);
    }

    private cleanup() {
        // 移除事件监听器
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        // 清理MemoryManager引用，让垃圾回收器可以回收
        this.memoryManager = null;
    }

    async checkAvailability(): Promise<boolean> {
        return await this.provider.checkAvailability();
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
        if (typeof this.provider.listModels === 'function') {
            try {
                models = await this.provider.listModels();
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
            'gemini': [
                { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
                { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
                { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
                { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
            ],
            'openai': [
                { value: 'gpt-4o', label: 'GPT-4o' },
                { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
                { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
                { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
            ],
            'deepseek': [
                { value: 'deepseek-chat', label: 'DeepSeek Chat' },
                { value: 'deepseek-coder', label: 'DeepSeek Coder' }
            ],
            'qwen': [
                { value: 'qwen-turbo', label: 'Qwen Turbo' },
                { value: 'qwen-plus', label: 'Qwen Plus' },
                { value: 'qwen-max', label: 'Qwen Max' }
            ]
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

    async chat(userMessage: string, contextItems: any[], selection: string = ""): Promise<string> {
        logger.info(`Processing chat message: ${userMessage.substring(0, 50)}...`, 'ModelService.chat');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            const error = `${providerLabel} API Key not configured!`;
            logger.error(error, new Error(error), 'ModelService.chat');
            new Notice(error);
            return "Error: API Key missing.";
        }

        try {
            // 1. Build Context
            let memoryContext = '';
            if (this.memoryManager) {
                memoryContext = this.memoryManager.buildContext();
            }

            let fullPrompt = '';
            if (memoryContext) {
                fullPrompt += `${memoryContext}\n\n`;
            }
            fullPrompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;
            // Format context items
            let contextStr = '';
            if (contextItems && contextItems.length > 0) {
                contextStr = contextItems.map(item => {
                    if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`; // Placeholder for now, real image handling later
                    return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
                }).join('\n\n');
            }

            fullPrompt += `[Context: ${contextStr}]\n`;
            if (selection) {
                fullPrompt += `[Selected Text: ${selection}]\n`;
            }
            fullPrompt += `User Request: ${userMessage}`;

            // 2. Get or Create Session — Skill 模式
            const tools = this.buildSkillModeTools();
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession(tools)
                : this.provider.startChat(tools);

            // 3. Send Message
            let result = await chat.sendMessage(fullPrompt);

            // 4. Handle Function Calls (Loop)
            let loopCount = 0;
            const MAX_LOOPS = 10;

            while (result.functionCalls && result.functionCalls.length > 0) {
                loopCount++;
                if (loopCount > MAX_LOOPS) {
                    logger.warn(`Function call loop limit reached (${MAX_LOOPS})`, 'ModelService.chat');
                    break;
                }

                logger.info(`Processing function calls (Loop ${loopCount}): ${result.functionCalls.map(c => c.name).join(', ')}`, 'ModelService.chat');

                // 使用超时控制执行工具调用
                const toolResults = await Promise.all(result.functionCalls.map(async (call) => {
                    try {
                        let toolResult: any;

                        if (call.name === 'use_skill') {
                            toolResult = await this.executeSkill(call.args);
                        } else {
                            toolResult = await this.withTimeout(
                                this.toolRegistry.execute(call.name, call.args),
                                30000,
                                `Tool ${call.name} execution timed out`
                            );
                        }
                        return {
                            name: call.name,
                            response: toolResult
                        };
                    } catch (error: any) {
                        logger.error(`Tool execution failed: ${call.name}`, error, 'ModelService.chat');
                        return {
                            name: call.name,
                            response: { error: error.message || "Unknown error" }
                        };
                    }
                }));

                result = await chat.sendMessage(toolResults);
            }

            const responseText = result.text;

            // 5. Record Message
            if (this.memoryManager) {
                await this.memoryManager.recordMessage('user', userMessage);
                await this.memoryManager.recordMessage('model', responseText);
            }

            return responseText;

        } catch (e: any) {
            logger.error('Chat processing failed', e, 'ModelService.chat');
            return `Error: ${e.message}`;
        }
    }

    async *chatStream(userMessage: string, contextItems: any[], selection: string = ""): AsyncGenerator<StreamEvent, void, unknown> {
        logger.info(`Processing streaming chat: ${userMessage.substring(0, 50)}...`, 'ModelService.chatStream');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            yield { type: 'error' as const, message: `${providerLabel} API Key not configured!` };
            return;
        }

        try {
            // 1. Build prompt (same as chat())
            let memoryContext = '';
            if (this.memoryManager) {
                memoryContext = this.memoryManager.buildContext();
            }

            let fullPrompt = '';
            if (memoryContext) fullPrompt += `${memoryContext}\n\n`;
            fullPrompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;

            let contextStr = '';
            if (contextItems && contextItems.length > 0) {
                contextStr = contextItems.map(item => {
                    if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`;
                    return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
                }).join('\n\n');
            }
            fullPrompt += `[Context: ${contextStr}]\n`;
            if (selection) fullPrompt += `[Selected Text: ${selection}]\n`;
            fullPrompt += `User Request: ${userMessage}`;

            // 2. Get or Create Session
            const tools = this.buildSkillModeTools();
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession(tools)
                : this.provider.startChat(tools);

            // 3. Stream with function call loop
            let loopCount = 0;
            const MAX_LOOPS = 10;
            let input: string | { name: string; response: any }[] = fullPrompt;
            let fullResponseText = '';

            while (loopCount <= MAX_LOOPS) {
                const pendingCalls: { name: string; args: any }[] = [];

                for await (const event of chat.sendMessageStream(input)) {
                    if (event.type === 'tool_call') {
                        pendingCalls.push({ name: event.name, args: event.args });
                        yield event;
                    } else if (event.type === 'text_delta') {
                        fullResponseText += event.content;
                        yield event;
                    } else if (event.type === 'thinking') {
                        yield event;
                    } else if (event.type === 'done') {
                        // don't yield done yet — check for tool calls first
                    }
                }

                if (pendingCalls.length === 0) break;

                loopCount++;
                if (loopCount > MAX_LOOPS) {
                    logger.warn(`Stream function call loop limit reached (${MAX_LOOPS})`, 'ModelService.chatStream');
                    break;
                }

                // Execute tools sequentially (yield requires generator context)
                const toolResults: { name: string; response: any }[] = [];
                for (const call of pendingCalls) {
                    try {
                        let toolResult: any;
                        if (call.name === 'use_skill') {
                            toolResult = await this.executeSkill(call.args);
                        } else {
                            toolResult = await this.withTimeout(
                                this.toolRegistry.execute(call.name, call.args),
                                30000,
                                `Tool ${call.name} execution timed out`
                            );
                        }
                        yield { type: 'tool_result' as const, name: call.name, result: toolResult };
                        toolResults.push({ name: call.name, response: toolResult });
                    } catch (error: any) {
                        logger.error(`Tool execution failed: ${call.name}`, error, 'ModelService.chatStream');
                        yield { type: 'tool_result' as const, name: call.name, result: null, error: error.message };
                        toolResults.push({ name: call.name, response: { error: error.message || "Unknown error" } });
                    }
                }

                input = toolResults;
                fullResponseText = '';
            }

            // 4. Record to memory
            if (this.memoryManager) {
                await this.memoryManager.recordMessage('user', userMessage);
                await this.memoryManager.recordMessage('model', fullResponseText);
            }

            yield { type: 'done' as const, text: fullResponseText };

        } catch (e: any) {
            logger.error('Stream chat failed', e, 'ModelService.chatStream');
            yield { type: 'error' as const, message: e.message };
        }
    }

    /**
     * 无状态单次生成：不走 MemoryManager，不走 function calling
     * 用于 Knowledge Compiler 等需要独立 AI 调用的场景
     */
    async generate(prompt: string, systemPrompt?: string): Promise<string> {
        if (!this.hasValidConfig()) {
            throw new Error(`${this.getActiveProviderConfig()?.label || 'AI'} API Key not configured`);
        }

        try {
            const result = await this.provider.generateContent(prompt, systemPrompt);
            return result.text;
        } catch (e: any) {
            logger.error('Stateless generation failed', e, 'ModelService.generate');
            throw e;
        }
    }

    // ==================== Memory Management Methods ====================

    // ==================== Skill Architecture Methods ====================

    /**
     * 构建 Skill 模式的工具列表：
     * - 所有原子工具（始终暴露）
     * - use_skill 元工具（获取场景化 instructions）
     */
    private buildSkillModeTools(): ToolDefinition[] {
        const tools: ToolDefinition[] = [];

        // 所有原子工具始终暴露，模型可直接调用
        tools.push(...this.toolRegistry.getAllDefinitions());

        // use_skill 元工具：返回 skill 的详细 instructions，指导模型如何组合使用工具
        const skillSummary = this.skillRegistry.getSkillSummaryText();
        const useSkillDesc = skillSummary
            ? `获取特定场景的详细工作指引（引用规则、输出格式、工作流程等）。调用后会返回 instructions，按照 instructions 使用已有工具完成任务。\n\n${skillSummary}`
            : '获取特定场景的详细工作指引。';
        tools.push({
            name: 'use_skill',
            description: useSkillDesc,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill 名称' },
                },
                required: ['name'],
            },
        });

        return tools;
    }

    /**
     * 执行 use_skill 调用：只返回 instructions + 工具提示
     * 不执行业务逻辑，模型根据 instructions 自行调用原子工具
     */
    private async executeSkill(args: any): Promise<any> {
        const skillName = args?.name;
        if (!skillName) return { error: 'Missing skill name' };

        const activated = this.skillRegistry.activateSkill(skillName);
        if (!activated) return { error: `Skill "${skillName}" not found or disabled` };

        const { instructions, tools } = activated;

        return {
            action_required: '根据以下 instructions 立即使用工具完成用户的请求。不要只是描述步骤，直接调用工具执行。',
            instructions,
            available_tools: tools.map(t => t.name),
        };
    }

    // ==================== Original Memory Methods ====================

    async clearSession() {
        if (this.memoryManager) {
            await this.memoryManager.clearSession();
        }
    }

    getUserProfile(): UserProfile | null {
        return this.memoryManager ? this.memoryManager.getProfile() : null;
    }

    async updateProfile(updates: Partial<UserProfile>) {
        if (this.memoryManager) {
            await this.memoryManager.updateProfile(updates);
        }
    }

    async learnFromMessages(messages: string[]): Promise<any> {
        if (this.memoryManager) {
            return await this.memoryManager.learnFromRecentMessages(messages);
        }
        return null;
    }

    getAvailableTools() {
        return this.buildSkillModeTools();
    }

    async shutdown() {
        // 移除事件监听器
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);

        // 保存内存数据
        if (this.memoryManager) {
            await this.memoryManager.save();
        }
    }
}
