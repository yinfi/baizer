import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';
import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage } from './interfaces';
import { logger } from '../utils/logger';

export class GeminiProvider implements IModelProvider {
    id = 'gemini';
    name = 'Google Gemini';

    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private config: ModelConfig;

    configure(config: ModelConfig) {
        this.config = config;
        this.genAI = new GoogleGenerativeAI(config.apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: config.modelName,
            systemInstruction: config.systemPrompt
        });
    }

    async checkAvailability(): Promise<boolean> {
        try {
            const result = await this.model.generateContent("Hello");
            return !!result.response.text();
        } catch (e) {
            logger.error('Gemini availability check failed', e, 'GeminiProvider');
            return false;
        }
    }

    async generateContent(prompt: string): Promise<GenerationResult> {
        const result = await this.model.generateContent(prompt);
        return {
            text: result.response.text()
        };
    }

    startChat(tools?: ToolDefinition[]): IChatSession {
        const modelWithTools = tools ? this.genAI.getGenerativeModel({
            model: this.config.modelName,
            systemInstruction: this.config.systemPrompt,
            tools: [{ functionDeclarations: tools }]
        }) : this.model;

        const chat = modelWithTools.startChat();
        return new GeminiChatSession(chat);
    }
}

class GeminiChatSession implements IChatSession {
    constructor(private chat: ChatSession) { }

    async sendMessage(text: string | ToolResult[]): Promise<GenerationResult> {
        let result;
        if (typeof text === 'string') {
            result = await this.chat.sendMessage(text);
        } else {
            // Convert ToolResult to Gemini format
            const toolResponse = text.map(t => ({
                functionResponse: {
                    name: t.name,
                    response: t.response
                }
            }));
            result = await this.chat.sendMessage(toolResponse);
        }

        const response = result.response;
        const functionCalls = response.functionCalls();

        return {
            text: response.text ? response.text() : '',
            functionCalls: functionCalls ? functionCalls.map(fc => ({
                name: fc.name,
                args: fc.args
            })) : undefined
        };
    }

    async getHistory(): Promise<ChatMessage[]> {
        const history = await this.chat.getHistory();
        return history.map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            content: h.parts.map(p => p.text).join('')
        }));
    }

    async clearHistory(): Promise<void> {
        // Gemini ChatSession doesn't support clearing history directly without creating a new session.
        // The consumer of this interface should create a new session if they want to clear history.
        // Or we can hack it by accessing private history if needed, but better to just restart.
        // For now, we'll do nothing and rely on the manager to create a new session.
    }
}
