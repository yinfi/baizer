import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { Notice, App } from 'obsidian';
import { GeminiSettings } from './mcp/types';
import { ToolManager } from './mcp/tools';
import { MemoryManager } from './memory/memory-manager';
import { UserProfile } from './memory/types';

export class GeminiAPI {
    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private memoryManager: MemoryManager | null = null;

    constructor(private app: App, private settings: GeminiSettings, private toolManager: ToolManager, private mockModel?: any) {
        if (settings.apiKey || mockModel) {
            this.init();
        }
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

    async checkAvailability(): Promise<boolean> {
        try {
            this.init();
            const result = await this.model.generateContent("Hello");
            return !!result.response.text();
        } catch (e) {
            console.error(e);
            throw e;
        }
    }

    async chat(userMessage: string, contextContext: string, selection: string = ""): Promise<string> {
        if (!this.genAI && !this.mockModel) {
            new Notice("Gemini API Key not configured!");
            return "Error: API Key missing.";
        }

        // 1. 构建包含记忆的上下文
        let memoryContext = '';
        if (this.memoryManager) {
            memoryContext = this.memoryManager.buildContext();
        }

        let fullPrompt = '';
        if (memoryContext) {
            fullPrompt += `${memoryContext}\n\n`;
        }
        fullPrompt += `[Context: ${contextContext}]\n`;
        if (selection) {
            fullPrompt += `[Selected Text: ${selection}]\n`;
        }
        fullPrompt += `User Request: ${userMessage}`;

        try {
            // 2. 获取或创建会话
            const chat = this.memoryManager
                ? this.memoryManager.getOrCreateSession()
                : this.model.startChat();

            let result = await chat.sendMessage(fullPrompt);
            let response = result.response;
            let functionCalls = response.functionCalls();

            // 3. 处理 Function Calls
            if (functionCalls && functionCalls.length > 0) {
                for (const call of functionCalls) {
                    const toolResult = await this.toolManager.execute(call.name, call.args);
                    result = await chat.sendMessage([
                        {
                            functionResponse: {
                                name: call.name,
                                response: toolResult
                            }
                        }
                    ]);
                }
                response = result.response;
            }

            const responseText = response.text();

            // 4. 记录消息（用于画像更新）
            if (this.memoryManager) {
                await this.memoryManager.recordMessage('user', userMessage);
                await this.memoryManager.recordMessage('model', responseText);
            }

            return responseText;
        } catch (e: any) {
            console.error("Gemini Error:", e);
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
}