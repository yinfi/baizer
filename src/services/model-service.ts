import { App, Notice } from 'obsidian';
import { GeminiSettings } from '../mcp/types';
import { ToolManager } from '../mcp/tools';
import { MemoryManager } from '../memory/memory-manager';
import { UserProfile } from '../memory/types';
import { logger } from '../utils/logger';
import { IModelProvider, IChatSession, ModelConfig, ToolDefinition } from '../models/interfaces';
import { GeminiProvider } from '../models/gemini';
import { OpenAIProvider } from '../models/openai';

export class ModelService {
    private provider: IModelProvider;
    private memoryManager: MemoryManager | null = null;
    private lastResponseTime: number = Date.now();
    private requestTimeout: number = 30000; // 30s timeout
    private maxRetries: number = 3;
    private retryDelay: number = 2000;

    constructor(private app: App, private settings: GeminiSettings, private toolManager: ToolManager) {
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
        this.initializeProvider();
    }

    public updateSettings(settings: GeminiSettings) {
        this.settings = settings;
        this.initializeProvider();
    }

    private setupErrorHandlers() {
        window.addEventListener('unhandledrejection', (event) => {
            logger.error('Unhandled Promise Rejection', event.reason, 'GlobalErrorHandler');
        });
    }

    async checkAvailability(): Promise<boolean> {
        return await this.provider.checkAvailability();
    }

    async chat(userMessage: string, contextContext: string, selection: string = ""): Promise<string> {
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
            fullPrompt += `[Context: ${contextContext}]\n`;
            if (selection) {
                fullPrompt += `[Selected Text: ${selection}]\n`;
            }
            fullPrompt += `User Request: ${userMessage}`;

            // 2. Get or Create Session
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession()
                : this.provider.startChat(this.toolManager.getToolsDefinitions());

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

                const toolResults = await Promise.all(result.functionCalls.map(async (call) => {
                    try {
                        const toolResult = await this.toolManager.execute(call.name, call.args);
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

            this.lastResponseTime = Date.now();
            return responseText;

        } catch (e: any) {
            logger.error('Chat processing failed', e, 'ModelService.chat');
            return `Error: ${e.message}`;
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
        if (this.memoryManager) {
            await this.memoryManager.save();
        }
    }
}
