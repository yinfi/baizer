"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiAPI = void 0;
const generative_ai_1 = require("@google/generative-ai");
const obsidian_1 = require("obsidian");
const memory_manager_1 = require("./memory/memory-manager");
class GeminiAPI {
    constructor(app, settings, toolManager, mockModel) {
        this.app = app;
        this.settings = settings;
        this.toolManager = toolManager;
        this.mockModel = mockModel;
        this.memoryManager = null;
        if (settings.apiKey || mockModel) {
            this.init();
        }
    }
    init() {
        if (this.mockModel) {
            this.model = this.mockModel;
            return;
        }
        this.genAI = new generative_ai_1.GoogleGenerativeAI(this.settings.apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: this.settings.primaryModel,
            systemInstruction: this.settings.systemPrompt,
            tools: [{ functionDeclarations: this.toolManager.getToolsDefinitions() }]
        });
        // Initialize MemoryManager
        this.memoryManager = new memory_manager_1.MemoryManager(this.app, this.model);
    }
    async testConnection() {
        try {
            this.init();
            const result = await this.model.generateContent("Hello");
            return !!result.response.text();
        }
        catch (e) {
            console.error(e);
            return false;
        }
    }
    async chat(userMessage, contextContext, selection = "") {
        if (!this.genAI && !this.mockModel) {
            new obsidian_1.Notice("Gemini API Key not configured!");
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
        }
        catch (e) {
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
    getUserProfile() {
        return this.memoryManager ? this.memoryManager.getProfile() : null;
    }
    async updateProfile(updates) {
        if (this.memoryManager) {
            await this.memoryManager.updateProfile(updates);
        }
    }
    async learnFromMessages(messages) {
        if (this.memoryManager) {
            return await this.memoryManager.learnFromRecentMessages(messages);
        }
        return null;
    }
}
exports.GeminiAPI = GeminiAPI;
