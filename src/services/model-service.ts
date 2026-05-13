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
import { SkillCommandEntry } from '../skills/types';
import { createChatRuntime } from '../runtime/runtime-factory';
import { ProviderCapabilities } from '../runtime/provider-capabilities';

export class ModelService {
    private provider: IModelProvider;
    private memoryManager: MemoryManager | null = null;
    private readonly modelListCache = new Map<string, { timestamp: number; models: ModelOption[] }>();
    private readonly modelListCacheTtlMs = 10 * 60 * 1000;
    private providerChangedCallbacks: Array<() => void> = [];
    private skillRegistry: SkillRegistry;
    private toolRegistry: ToolRegistry;

    constructor(
        private app: App,
        private settings: PluginSettings,
        toolRegistry: ToolRegistry,
        skillRegistry: SkillRegistry,
    ) {
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
            contextWindow: this.settings.contextWindow,
        });

        if (this.hasValidConfig()) {
            this.memoryManager = new MemoryManager(this.app, this.provider);
        }
    }

    private hasValidConfig(): boolean {
        const config = this.getActiveProviderConfig();
        return !!config?.apiKey;
    }

    getActiveProviderConfig(): ProviderConfig | undefined {
        return this.settings.providers[this.settings.activeProvider];
    }

    public async switchProvider(providerId: string, saveFn?: () => Promise<void>): Promise<void> {
        const config = this.settings.providers[providerId];
        if (!config) return;

        this.settings.activeProvider = providerId;
        if (saveFn) await saveFn();
        await this.flushMemorySession();

        this.cleanup();
        this.modelListCache.clear();
        this.initializeProvider();
        this.providerChangedCallbacks.forEach(cb => cb());
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

    async chat(userMessage: string, contextItems: any[], selection: string = ''): Promise<string> {
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
            });
            return await runtime.query(preparedTurn);
        } catch (e: any) {
            logger.error('Chat processing failed', e, 'ModelService.chat');
            return `Error: ${e.message}`;
        }
    }

    async *chatStream(userMessage: string, contextItems: any[], selection: string = '', signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
        logger.info(`Processing streaming chat: ${userMessage.substring(0, 50)}...`, 'ModelService.chatStream');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            yield { type: 'error' as const, message: `${providerLabel} API Key not configured!` };
            return;
        }

        try {
            const runtime = this.createChatRuntime();
            const preparedTurn = await runtime.prepareTurn({
                userMessage,
                contextItems,
                selection,
            });
            for await (const event of runtime.queryStream(preparedTurn, signal)) {
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
        return this.createChatRuntime().getTools();
    }

    getSkillCommands(): SkillCommandEntry[] {
        return this.skillRegistry.listCommandEntries();
    }

    getProviderCapabilities(): ProviderCapabilities {
        return this.provider.getCapabilities();
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
        return this.toolRegistry.execute(action, {
            ...args,
            approved: true,
        });
    }

    createChatRuntime() {
        return createChatRuntime({
            provider: this.provider,
            memoryManager: this.memoryManager,
            toolRegistry: this.toolRegistry,
            skillRegistry: this.skillRegistry,
        });
    }

    private isAbortError(error: any): boolean {
        return error?.name === 'AbortError';
    }

    async shutdown() {
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        await this.flushMemorySession();
    }
}
