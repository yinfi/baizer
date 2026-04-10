import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage, ModelOption } from './interfaces';
import { requestUrl, RequestUrlParam } from 'obsidian';
import { logger } from '../utils/logger';

export class OpenAIProvider implements IModelProvider {
    id = 'openai';
    name = 'OpenAI Compatible';

    private config: ModelConfig;

    configure(config: ModelConfig) {
        this.config = config;
    }

    async checkAvailability(): Promise<boolean> {
        try {
            await this.generateContent("Hello");
            return true;
        } catch (e) {
            logger.error('OpenAI availability check failed', e, 'OpenAIProvider');
            return false;
        }
    }

    async listModels(): Promise<ModelOption[]> {
        const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/models`;
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.config.apiKey}`
        };

        const response = await requestUrl({
            url,
            method: 'GET',
            headers
        });

        if (response.status !== 200) {
            throw new Error(`OpenAI models API error: ${response.status}`);
        }

        const data = JSON.parse(response.text || '{}');
        const rows = Array.isArray(data?.data) ? data.data : [];

        const excludedKeywords = [
            'embedding',
            'whisper',
            'tts',
            'transcribe',
            'moderation',
            'dall-e',
            'image',
            'audio-preview',
            'omni-moderation'
        ];

        const options = rows
            .map((row: any) => (typeof row?.id === 'string' ? row.id.trim() : ''))
            .filter((id: string) => {
                if (!id) return false;
                const lower = id.toLowerCase();
                return !excludedKeywords.some(keyword => lower.includes(keyword));
            })
            .map((id: string) => ({ value: id, label: id }))
            .sort((a: ModelOption, b: ModelOption) => a.value.localeCompare(b.value));

        const deduped = new Map<string, ModelOption>();
        options.forEach((option: ModelOption) => {
            if (!deduped.has(option.value)) {
                deduped.set(option.value, option);
            }
        });

        return Array.from(deduped.values());
    }

    async generateContent(prompt: string, systemPrompt?: string): Promise<GenerationResult> {
        const messages = [
            { role: 'system', content: systemPrompt ?? this.config.systemPrompt ?? '' },
            { role: 'user', content: prompt }
        ];
        return this.chatCompletion(messages);
    }

    startChat(tools?: ToolDefinition[]): IChatSession {
        return new OpenAIChatSession(this.config, tools, this);
    }

    async chatCompletion(messages: any[], tools?: ToolDefinition[]): Promise<GenerationResult> {
        const raw = await this.chatCompletionRaw(messages, tools);
        return OpenAIProvider.toGenerationResult(raw);
    }

    /** 返回原始 assistant message（含 tool_call id），供 ChatSession 维护 history */
    async chatCompletionRaw(messages: any[], tools?: ToolDefinition[]): Promise<any> {
        const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;

        const body: any = {
            model: this.config.modelName,
            messages: messages,
            temperature: 0.7
        };

        if (tools && tools.length > 0) {
            body.tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));
        }

        const headers: any = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        };

        const params: RequestUrlParam = {
            url,
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        };

        const response = await requestUrl(params);

        if (response.status !== 200) {
            throw new Error(`OpenAI API Error: ${response.status} - ${response.text}`);
        }

        const data = JSON.parse(response.text);
        return data.choices[0].message;
    }

    static toGenerationResult(message: any): GenerationResult {
        const result: GenerationResult = {
            text: message.content || ''
        };

        if (message.tool_calls) {
            result.functionCalls = message.tool_calls.map((tc: any) => ({
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments)
            }));
        }

        return result;
    }
}

class OpenAIChatSession implements IChatSession {
    private history: any[] = [];

    constructor(
        private config: ModelConfig,
        private tools: ToolDefinition[] | undefined,
        private provider: OpenAIProvider
    ) {
        if (config.systemPrompt) {
            this.history.push({ role: 'system', content: config.systemPrompt });
        }
    }

    async sendMessage(text: string | ToolResult[]): Promise<GenerationResult> {
        if (typeof text === 'string') {
            this.history.push({ role: 'user', content: text });
        } else {
            // 将 tool results 追加到 history，匹配上一条 assistant message 中的 tool_call_id
            const lastMsg = this.history[this.history.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
                text.forEach(t => {
                    const call = lastMsg.tool_calls.find((tc: any) => tc.function.name === t.name);
                    if (call) {
                        this.history.push({
                            role: 'tool',
                            tool_call_id: call.id,
                            name: t.name,
                            content: JSON.stringify(t.response)
                        });
                    }
                });
            }
        }

        // 使用 chatCompletionRaw 获取原始 message（含 tool_call id）
        const rawMessage = await this.provider.chatCompletionRaw(this.history, this.tools);

        // 将完整的 assistant message（含 tool_calls + id）push 到 history
        this.history.push(rawMessage);

        return OpenAIProvider.toGenerationResult(rawMessage);
    }

    async getHistory(): Promise<ChatMessage[]> {
        return this.history.filter(h => h.role !== 'system' && h.role !== 'tool').map(h => ({
            role: h.role,
            content: h.content || ''
        }));
    }

    async clearHistory(): Promise<void> {
        this.history = [];
        if (this.config.systemPrompt) {
            this.history.push({ role: 'system', content: this.config.systemPrompt });
        }
    }
}
