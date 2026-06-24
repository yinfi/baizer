import { ChatSession, GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { requestUrl } from 'obsidian';
import {
  ChatMessage,
  GenerationOptions,
  GenerationResult,
  IChatSession,
  IModelProvider,
  ModelConfig,
  ModelOption,
  StreamEvent,
  ToolDefinition,
  ToolResult,
} from './interfaces';
import { mergeStreamThoughtSignatures } from './gemini-thought-signatures';
import { logger } from '../utils/logger';
import { ProviderCapabilities } from '../runtime/provider-capabilities';

export class GeminiProvider implements IModelProvider {
    id = 'gemini';
    name = 'Google Gemini';

    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private config: ModelConfig;

    getCapabilities(): ProviderCapabilities {
        return {
            supportsThinking: true,
            supportsModelListing: true,
            supportsImageInput: true,
            supportsToolCalling: true,
            supportsCustomBaseUrl: false,
        };
    }

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

    async generateContent(prompt: string, systemPrompt?: string, options?: GenerationOptions): Promise<GenerationResult> {
        const generationConfig = {
            ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
            ...(typeof options?.maxTokens === 'number' ? { maxOutputTokens: options.maxTokens } : {}),
        };
        const hasGenerationConfig = Object.keys(generationConfig).length > 0;
        const model = systemPrompt || hasGenerationConfig
            ? this.genAI.getGenerativeModel({
                model: this.config.modelName,
                ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
                ...(hasGenerationConfig ? { generationConfig } : {}),
            })
            : this.model;
        const result = await withTimeout(
            model.generateContent(prompt),
            options?.timeoutMs,
            'Gemini generation timed out',
        );
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

    private async patchHistoryWithThoughtSignatures(streamedParts: any[]): Promise<void> {
        if (streamedParts.length === 0) return;

        const history = await this.chat.getHistory();
        const lastMessage = history[history.length - 1];
        if (!lastMessage?.parts?.length || lastMessage.role !== 'model') return;

        lastMessage.parts = mergeStreamThoughtSignatures(
            lastMessage.parts as any[],
            streamedParts as any[],
        ) as any[];
    }

    async sendMessage(text: string | ToolResult[]): Promise<GenerationResult> {
        let result;
        if (typeof text === 'string') {
            result = await this.chat.sendMessage(text);
        } else {
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

    async *sendMessageStream(text: string | ToolResult[], signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
        this.throwIfAborted(signal);
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
        const streamedParts: any[] = [];
        const collectedFunctionCalls: { name: string; args: any }[] = [];

        for await (const chunk of streamResult.stream) {
            if (signal?.aborted) {
                await (streamResult.stream as AsyncGenerator<any, void, unknown>).return?.(undefined);
                this.throwIfAborted(signal);
            }
            const candidate = chunk.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
                streamedParts.push(JSON.parse(JSON.stringify(part)));

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

        let functionCalls = collectedFunctionCalls;
        try {
            this.throwIfAborted(signal);
            const response = await streamResult.response;
            await this.patchHistoryWithThoughtSignatures(streamedParts);
            const responseFCs = response.functionCalls();
            if (responseFCs && responseFCs.length > 0) {
                functionCalls = responseFCs.map(fc => ({ name: fc.name, args: fc.args }));
            }
        } catch {
            // Keep streamed function calls if the aggregated response is unavailable.
        }

        for (const fc of functionCalls) {
            yield { type: 'tool_call' as const, name: fc.name, args: fc.args };
        }

        yield { type: 'done' as const, text: fullText };
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (signal?.aborted) {
            const error = new Error('Stream aborted');
            error.name = 'AbortError';
            throw error;
        }
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
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
