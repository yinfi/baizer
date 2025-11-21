import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { Notice, App } from 'obsidian';
import { GeminiSettings } from './mcp/types';
import { ToolManager } from './mcp/tools';
import { MemoryManager } from './memory/memory-manager';
import { UserProfile } from './memory/types';
import { logger } from './utils/logger';

export class GeminiAPI {
    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private memoryManager: MemoryManager | null = null;
    private lastResponseTime: number = Date.now();
    private requestTimeout: number = 30000; // 30秒超时
    private maxRetries: number = 3;
    private retryDelay: number = 2000;

    constructor(private app: App, private settings: GeminiSettings, private toolManager: ToolManager, private mockModel?: any) {
        if (settings.apiKey || mockModel) {
            this.init();
        }
        this.setupErrorHandlers();
    }

    init() {
        if (this.mockModel) {
            this.model = this.mockModel;
            return;
        }
        this.genAI = new GoogleGenerativeAI(this.settings.apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: this.settings.primaryModel,
            systemInstruction: this.settings.systemPrompt,
            tools: [{ functionDeclarations: this.toolManager.getToolsDefinitions() }]
        });

        // Initialize MemoryManager
        this.memoryManager = new MemoryManager(this.app, this.model);
    }

    private setupErrorHandlers() {
        // 设置全局错误处理
        window.addEventListener('unhandledrejection', (event) => {
            logger.error('未处理的Promise拒绝', event.reason, 'GlobalErrorHandler');
        });

        window.addEventListener('error', (event) => {
            logger.error('全局错误', event.error, 'GlobalErrorHandler');
        });
    }

    async checkAvailability(): Promise<boolean> {
        try {
            logger.info('开始检查API可用性', 'GeminiAPI.checkAvailability');
            this.init();

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

            const result = await this.retryOperationWithTimeout(() =>
                this.model.generateContent("Hello"), controller.signal);

            clearTimeout(timeoutId);
            this.lastResponseTime = Date.now();

            const isAvailable = !!result.response.text();
            logger.info(`API可用性检查结果: ${isAvailable}`, 'GeminiAPI.checkAvailability');
            return isAvailable;
        } catch (e) {
            logger.error('API可用性检查失败', e, 'GeminiAPI.checkAvailability');
            throw e;
        }
    }

    async chat(userMessage: string, contextContext: string, selection: string = ""): Promise<string> {
        logger.info(`开始处理聊天消息: ${userMessage.substring(0, 50)}...`, 'GeminiAPI.chat');

        if (!this.genAI && !this.mockModel) {
            const error = "Gemini API Key not configured!";
            logger.error(error, new Error(error), 'GeminiAPI.chat');
            new Notice(error);
            return "Error: API Key missing.";
        }

        try {
            // 1. 构建包含记忆的上下文
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

            logger.debug(`构建的提示: ${fullPrompt.substring(0, 200)}...`, 'GeminiAPI.chat');

            // 2. 获取或创建会话
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession()
                : this.model.startChat();

            let result = await this.retryOperationWithTimeout(() => chat.sendMessage(fullPrompt));
            let response = result.response;

            // 3. 处理 Function Calls (支持多轮/链式调用)
            let functionCalls = response.functionCalls();
            let loopCount = 0;
            const MAX_LOOPS = 10; // 防止死循环

            while (functionCalls && functionCalls.length > 0) {
                loopCount++;
                if (loopCount > MAX_LOOPS) {
                    logger.warn(`Function call loop limit reached (${MAX_LOOPS})`, 'GeminiAPI.chat');
                    break;
                }

                logger.info(`Processing function calls (Loop ${loopCount}): ${functionCalls.map(c => c.name).join(', ')}`, 'GeminiAPI.chat');

                // 并行执行所有工具调用
                const toolResults = await Promise.all(functionCalls.map(async (call) => {
                    try {
                        const toolResult = await this.toolManager.execute(call.name, call.args);
                        return {
                            functionResponse: {
                                name: call.name,
                                response: toolResult
                            }
                        };
                    } catch (error: any) {
                        logger.error(`Tool execution failed: ${call.name}`, error, 'GeminiAPI.chat');
                        return {
                            functionResponse: {
                                name: call.name,
                                response: { error: error.message || "Unknown error" }
                            }
                        };
                    }
                }));

                // 将所有结果一次性发送回模型
                result = await this.retryOperationWithTimeout(() => chat.sendMessage(toolResults));
                response = result.response;
                functionCalls = response.functionCalls();
            }

            let responseText = "";
            try {
                responseText = response.text();
            } catch (e) {
                // 如果被阻止或其他原因导致没有文本，可能只有 function call 但循环结束了
                logger.warn("Failed to get text from response, possibly blocked or empty.", e, 'GeminiAPI.chat');
            }

            if (!responseText && loopCount > 0) {
                if (loopCount > MAX_LOOPS) {
                    responseText = "I've finished the requested tasks, but I cannot generate a text summary right now (loop limit reached).";
                } else {
                    responseText = "Task completed.";
                }
            }

            // 4. 记录消息（用于画像更新）
            if (this.memoryManager) {
                await this.memoryManager.recordMessage('user', userMessage);
                await this.memoryManager.recordMessage('model', responseText);
            }

            this.lastResponseTime = Date.now();
            logger.info(`成功处理聊天消息，回复长度: ${responseText.length}`, 'GeminiAPI.chat');
            return responseText;
        } catch (e: any) {
            logger.error('聊天处理失败', e, 'GeminiAPI.chat');

            if (e.name === 'AbortError') {
                return "Error: 请求超时，请稍后重试。";
            }
            if (e.message?.includes('503') || e.message?.includes('overloaded')) {
                return "Error: The AI model is currently overloaded (503). Please try again in a moment.";
            }
            return `Error: ${e.message}`;
        }
    }

    private async retryOperation<T>(operation: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
        try {
            return await operation();
        } catch (error: any) {
            if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded'))) {
                logger.warn(`模型过载，正在重试... (${retries} 次尝试剩余)`, 'GeminiAPI.retryOperation');
                new Notice(`⚠️ Model overloaded. Retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.retryOperation(operation, retries - 1, delay * 2);
            }
            throw error;
        }
    }

    private async retryOperationWithTimeout<T>(operation: () => Promise<T>, signal?: AbortSignal, retries = 3): Promise<T> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        // 如果传入了signal，将两个signal合并
        const combinedSignal = signal ? this.combineSignals(controller.signal, signal) : controller.signal;

        try {
            return await this.executeWithTimeout(operation, combinedSignal);
        } catch (error: any) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error('请求超时，请稍后重试');
            }

            if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded'))) {
                logger.warn(`模型过载，正在重试... (${retries} 次尝试剩余)`, 'GeminiAPI.retryOperationWithTimeout');
                new Notice(`⚠️ Model overloaded. Retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                return this.retryOperationWithTimeout(operation, signal, retries - 1);
            }

            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async executeWithTimeout<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
        return new Promise(async (resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('请求已被取消'));
                return;
            }

            const handleAbort = () => {
                reject(new Error('请求超时'));
            };

            signal.addEventListener('abort', handleAbort);

            try {
                const result = await operation();
                signal.removeEventListener('abort', handleAbort);
                resolve(result);
            } catch (error) {
                signal.removeEventListener('abort', handleAbort);
                reject(error);
            }
        });
    }

    private combineSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
        const controller = new AbortController();

        const onAbort = () => controller.abort();
        signal1.addEventListener('abort', onAbort);
        signal2.addEventListener('abort', onAbort);

        // 清理监听器
        controller.signal.addEventListener('abort', () => {
            signal1.removeEventListener('abort', onAbort);
            signal2.removeEventListener('abort', onAbort);
        });

        return controller.signal;
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
}