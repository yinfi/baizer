import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';
import { requestUrl } from 'obsidian';
import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage, ModelOption, StreamEvent } from './interfaces';
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

    async listModels(): Promise<ModelOption[]> {
        if (!this.config?.apiKey) {
            throw new Error('Gemini API Key not configured');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.config.apiKey)}`;
        const response = await requestUrl({ url, method: 'GET' });

        if (response.status !== 200) {
            throw new Error(`Gemini models API error: ${response.status}`);
        }

        const data = JSON.parse(response.text || '{}');
        const models = Array.isArray(data?.models) ? data.models : [];

        const options: ModelOption[] = models
            .filter((model: any) => {
                const methods = Array.isArray(model?.supportedGenerationMethods)
                    ? model.supportedGenerationMethods
                    : [];
                const name = typeof model?.name === 'string' ? model.name : '';
                return name.startsWith('models/') && methods.includes('generateContent');
            })
            .map((model: any) => {
                const value = String(model.name).replace(/^models\//, '');
                const displayName = typeof model?.displayName === 'string' && model.displayName.trim().length > 0
                    ? model.displayName.trim()
                    : value;
                const label = displayName === value ? value : `${displayName} (${value})`;
                return { value, label };
            })
            .sort((a, b) => a.value.localeCompare(b.value));

        const deduped = new Map<string, ModelOption>();
        options.forEach(option => {
            if (!deduped.has(option.value)) {
                deduped.set(option.value, option);
            }
        });

        return Array.from(deduped.values());
    }

    async generateContent(prompt: string, systemPrompt?: string): Promise<GenerationResult> {
        // 如果指定了 systemPrompt，临时创建独立 model 实例，避免污染全局状态
        const model = systemPrompt
            ? this.genAI.getGenerativeModel({
                model: this.config.modelName,
                systemInstruction: systemPrompt
            })
            : this.model;
        const result = await model.generateContent(prompt);
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

    async *sendMessageStream(text: string | ToolResult[]): AsyncGenerator<StreamEvent, void, unknown> {
        let streamResult;
        if (typeof text === 'string') {
            streamResult = await this.chat.sendMessageStream(text);
        } else {
            const toolResponse = text.map(t => ({
                functionResponse: {
                    name: t.name,
                    response: t.response
                }
            }));
            streamResult = await this.chat.sendMessageStream(toolResponse);
        }

        let fullText = '';
        const collectedFunctionCalls: { name: string; args: any }[] = [];

        for await (const chunk of streamResult.stream) {
            const candidate = chunk.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
                if ((part as any).thought === true && (part as any).text) {
                    yield { type: 'thinking' as const, content: (part as any).text };
                } else if ((part as any).functionCall) {
                    const fc = (part as any).functionCall;
                    collectedFunctionCalls.push({ name: fc.name, args: fc.args });
                } else if (part.text) {
                    fullText += part.text;
                    yield { type: 'text_delta' as const, content: part.text };
                }
            }
        }

        // 优先用 stream 中收集的 function calls，fallback 到 response.functionCalls()
        let functionCalls = collectedFunctionCalls;
        if (functionCalls.length === 0) {
            try {
                const response = await streamResult.response;
                const responseFCs = response.functionCalls();
                if (responseFCs && responseFCs.length > 0) {
                    functionCalls = responseFCs.map(fc => ({ name: fc.name, args: fc.args }));
                }
            } catch {
                // response 可能在流式消费后不可用
            }
        }

        for (const fc of functionCalls) {
            yield { type: 'tool_call' as const, name: fc.name, args: fc.args };
        }

        yield { type: 'done' as const, text: fullText };
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
