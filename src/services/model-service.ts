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

            controller.signal.addEventListener('abort', () => {
                clearTimeout(timeoutId);
            });
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            controller.abort();
        }
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
            let memoryContext = '';
            if (this.memoryManager) {
                await this.memoryManager.ready();
                memoryContext = this.memoryManager.buildContext();
            }

            let fullPrompt = '';
            if (memoryContext) {
                fullPrompt += `${memoryContext}\n\n`;
            }
            fullPrompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;

            let contextStr = '';
            if (contextItems && contextItems.length > 0) {
                contextStr = contextItems.map(item => {
                    if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`;
                    return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
                }).join('\n\n');
            }

            fullPrompt += `[Context: ${contextStr}]\n`;
            if (selection) {
                fullPrompt += `[Selected Text: ${selection}]\n`;
            }
            fullPrompt += `User Request: ${userMessage}`;

            const tools = this.buildSkillModeTools();
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession(tools)
                : this.provider.startChat(tools);

            let result = await chat.sendMessage(fullPrompt);
            let loopCount = 0;
            const MAX_LOOPS = 10;

            while (result.functionCalls && result.functionCalls.length > 0) {
                loopCount++;
                if (loopCount > MAX_LOOPS) {
                    logger.warn(`Function call loop limit reached (${MAX_LOOPS})`, 'ModelService.chat');
                    break;
                }

                logger.info(
                    `Processing function calls (Loop ${loopCount}): ${result.functionCalls.map(c => c.name).join(', ')}`,
                    'ModelService.chat'
                );

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
                            response: toolResult,
                        };
                    } catch (error: any) {
                        logger.error(`Tool execution failed: ${call.name}`, error, 'ModelService.chat');
                        return {
                            name: call.name,
                            response: { error: error.message || 'Unknown error' },
                        };
                    }
                }));

                result = await chat.sendMessage(toolResults);
            }

            const responseText = result.text;

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

    async *chatStream(userMessage: string, contextItems: any[], selection: string = ''): AsyncGenerator<StreamEvent, void, unknown> {
        logger.info(`Processing streaming chat: ${userMessage.substring(0, 50)}...`, 'ModelService.chatStream');

        if (!this.hasValidConfig()) {
            const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
            yield { type: 'error' as const, message: `${providerLabel} API Key not configured!` };
            return;
        }

        try {
            let memoryContext = '';
            if (this.memoryManager) {
                await this.memoryManager.ready();
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

            const tools = this.buildSkillModeTools();
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession(tools)
                : this.provider.startChat(tools);

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
                    }
                }

                if (pendingCalls.length === 0) break;

                loopCount++;
                if (loopCount > MAX_LOOPS) {
                    logger.warn(`Stream function call loop limit reached (${MAX_LOOPS})`, 'ModelService.chatStream');
                    break;
                }

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
                        toolResults.push({ name: call.name, response: { error: error.message || 'Unknown error' } });
                    }
                }

                input = toolResults;
                fullResponseText = '';
            }

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

    private buildSkillModeTools(): ToolDefinition[] {
        const tools: ToolDefinition[] = [];
        tools.push(...this.toolRegistry.getAllDefinitions());

        const skillSummary = this.skillRegistry.getSkillSummaryText();
        const useSkillDesc = skillSummary
            ? `Get detailed instructions for a specific workflow, then use the returned instructions with the existing tools.\n\n${skillSummary}`
            : 'Get detailed instructions for a specific workflow.';

        tools.push({
            name: 'use_skill',
            description: useSkillDesc,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                },
                required: ['name'],
            },
        });

        return tools;
    }

    private async executeSkill(args: any): Promise<any> {
        const skillName = args?.name;
        if (!skillName) return { error: 'Missing skill name' };

        const activated = this.skillRegistry.activateSkill(skillName);
        if (!activated) return { error: `Skill "${skillName}" not found or disabled` };

        const { instructions, tools } = activated;

        return {
            action_required: 'Use the returned instructions immediately with the available tools to complete the user request.',
            instructions,
            available_tools: tools.map(t => t.name),
        };
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
        return this.buildSkillModeTools();
    }

    getSkillCommands(): SkillCommandEntry[] {
        return this.skillRegistry.listCommandEntries();
    }

    async executeSlashSkillCommand(command: string, input: string): Promise<any> {
        const skill = this.skillRegistry.resolveByCommand(command);
        if (!skill) {
            return { success: false, error: `Unknown command: ${command}` };
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

    async shutdown() {
        window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
        await this.flushMemorySession();
    }
}
