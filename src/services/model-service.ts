import { App, Notice } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import { ToolManager } from '../mcp/tools';
import { MemoryManager } from '../memory/memory-manager';
import { UserProfile } from '../memory/types';
import { logger } from '../utils/logger';
import { IModelProvider, ModelOption } from '../models/interfaces';
import { GeminiProvider } from '../models/gemini';
import { OpenAIProvider } from '../models/openai';

type ProviderType = PluginSettings['provider'];

export class ModelService {
    private provider: IModelProvider;
    private memoryManager: MemoryManager | null = null;
    private readonly modelListCache = new Map<string, { timestamp: number; models: ModelOption[] }>();
    private readonly modelListCacheTtlMs = 10 * 60 * 1000;

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

    constructor(private app: App, private settings: PluginSettings, private toolManager: ToolManager) {
        this.initializeProvider();
        this.setupErrorHandlers();
    }

    private initializeProvider() {
        const providerType = this.settings.provider;

        switch (providerType) {
            case 'gemini':
                this.provider = new GeminiProvider();
                this.provider.configure({
                    apiKey: this.settings.apiKey,
                    modelName: this.settings.primaryModel,
                    systemPrompt: this.settings.systemPrompt,
                    contextWindow: this.settings.contextWindow
                });
                break;
            case 'openai':
                this.provider = new OpenAIProvider();
                this.provider.configure({
                    apiKey: this.settings.openaiApiKey,
                    baseUrl: this.settings.openaiBaseUrl,
                    modelName: this.settings.openaiModel,
                    systemPrompt: this.settings.systemPrompt
                });
                break;
            case 'deepseek':
                this.provider = new OpenAIProvider();
                // Override ID and Name for clarity if needed, but logic is same
                this.provider.id = 'deepseek';
                this.provider.name = 'DeepSeek';
                this.provider.configure({
                    apiKey: this.settings.deepseekApiKey,
                    baseUrl: this.settings.deepseekBaseUrl,
                    modelName: this.settings.deepseekModel,
                    systemPrompt: this.settings.systemPrompt
                });
                break;
            case 'qwen':
                this.provider = new OpenAIProvider();
                this.provider.id = 'qwen';
                this.provider.name = 'Qwen';
                this.provider.configure({
                    apiKey: this.settings.qwenApiKey,
                    baseUrl: this.settings.qwenBaseUrl,
                    modelName: this.settings.qwenModel,
                    systemPrompt: this.settings.systemPrompt
                });
                break;
            default:
                logger.error(`Unknown provider: ${providerType}`, null, 'ModelService');
                this.provider = new GeminiProvider(); // Fallback
        }

        // Initialize MemoryManager with the selected provider
        if (this.hasValidConfig()) {
            this.memoryManager = new MemoryManager(this.app, this.provider);
        }
    }

    private hasValidConfig(): boolean {
        switch (this.settings.provider) {
            case 'gemini': return !!this.settings.apiKey;
            case 'openai': return !!this.settings.openaiApiKey;
            case 'deepseek': return !!this.settings.deepseekApiKey;
            case 'qwen': return !!this.settings.qwenApiKey;
            default: return false;
        }
    }

    public reloadProvider() {
        this.cleanup();
        this.initializeProvider();
        this.modelListCache.clear();
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
        const providerType = this.settings.provider;
        const cacheKey = this.buildModelListCacheKey(providerType);
        const now = Date.now();

        if (!forceRefresh) {
            const cached = this.modelListCache.get(cacheKey);
            if (cached && now - cached.timestamp < this.modelListCacheTtlMs) {
                return this.ensureCurrentModelInList(cached.models, providerType);
            }
        }

        let models: ModelOption[] = [];
        if (typeof this.provider.listModels === 'function') {
            try {
                models = await this.provider.listModels();
            } catch (error: any) {
                logger.warn(
                    `Failed to fetch model list for provider ${providerType}: ${error?.message || 'Unknown error'}`,
                    'ModelService.getAvailableModels'
                );
            }
        }

        if (!models.length) {
            models = this.getFallbackModels(providerType);
        }

        const normalized = this.ensureCurrentModelInList(this.normalizeModelOptions(models), providerType);
        this.modelListCache.set(cacheKey, {
            timestamp: now,
            models: normalized
        });
        return normalized;
    }

    private buildModelListCacheKey(providerType: ProviderType): string {
        switch (providerType) {
            case 'gemini':
                return `gemini:${this.settings.apiKey.slice(0, 8)}`;
            case 'openai':
                return `openai:${this.settings.openaiBaseUrl}:${this.settings.openaiApiKey.slice(0, 8)}`;
            case 'deepseek':
                return `deepseek:${this.settings.deepseekBaseUrl}:${this.settings.deepseekApiKey.slice(0, 8)}`;
            case 'qwen':
                return `qwen:${this.settings.qwenBaseUrl}:${this.settings.qwenApiKey.slice(0, 8)}`;
            default:
                return providerType;
        }
    }

    private getFallbackModels(providerType: ProviderType): ModelOption[] {
        switch (providerType) {
            case 'gemini':
                return [
                    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
                    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
                    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
                    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
                ];
            case 'openai':
                return [
                    { value: 'gpt-4o', label: 'GPT-4o' },
                    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
                    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
                    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
                ];
            case 'deepseek':
                return [
                    { value: 'deepseek-chat', label: 'DeepSeek Chat' },
                    { value: 'deepseek-coder', label: 'DeepSeek Coder' }
                ];
            case 'qwen':
                return [
                    { value: 'qwen-turbo', label: 'Qwen Turbo' },
                    { value: 'qwen-plus', label: 'Qwen Plus' },
                    { value: 'qwen-max', label: 'Qwen Max' }
                ];
            default:
                return [];
        }
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

    private ensureCurrentModelInList(options: ModelOption[], providerType: ProviderType): ModelOption[] {
        const currentModel = this.getCurrentModel(providerType);
        if (!currentModel) return options;

        const exists = options.some(option => option.value === currentModel);
        if (exists) return options;

        return [{ value: currentModel, label: `${currentModel} (Current)` }, ...options];
    }

    private getCurrentModel(providerType: ProviderType): string {
        switch (providerType) {
            case 'gemini':
                return this.settings.primaryModel || '';
            case 'openai':
                return this.settings.openaiModel || '';
            case 'deepseek':
                return this.settings.deepseekModel || '';
            case 'qwen':
                return this.settings.qwenModel || '';
            default:
                return '';
        }
    }

    async chat(userMessage: string, contextItems: any[], selection: string = ""): Promise<string> {
        logger.info(`Processing chat message: ${userMessage.substring(0, 50)}...`, 'ModelService.chat');

        if (!this.hasValidConfig()) {
            const error = `${this.provider.name} API Key not configured!`;
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

            // 2. Get or Create Session
            const tools = this.toolManager.getToolsDefinitions();
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
                        const toolResult = await this.withTimeout(
                            this.toolManager.execute(call.name, call.args),
                            30000,  // 30秒超时
                            `Tool ${call.name} execution timed out`
                        );
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

    /**
     * 无状态单次生成：不走 MemoryManager，不走 function calling
     * 用于 Knowledge Compiler 等需要独立 AI 调用的场景
     */
    async generate(prompt: string, systemPrompt?: string): Promise<string> {
        if (!this.hasValidConfig()) {
            throw new Error(`${this.provider.name} API Key not configured`);
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
        return this.toolManager.getToolsDefinitions();
    }

    async shutdown() {
        // 移除事件监听器
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);

        // 保存内存数据
        if (this.memoryManager) {
            await this.memoryManager.save();
        }

        // 清理 MCP 客户端（这将断开所有 MCP 连接）
        if (this.toolManager) {
            await this.toolManager.cleanupMcpClients();
        }
    }
}
