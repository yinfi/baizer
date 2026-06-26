import { IModelProvider, ModelConfig, IChatSession, GenerationOptions, GenerationResult, ToolDefinition, ToolResult, ChatMessage, ModelOption, StreamEvent, PriorChatMessage } from './interfaces';
import { requestUrl, RequestUrlParam } from 'obsidian';
import { logger } from '../utils/logger';
import { ProviderCapabilities } from '../runtime/provider-capabilities';

export class OpenAIProvider implements IModelProvider {
    id = 'openai';
    name = 'OpenAI Compatible';

    private config: ModelConfig;

    getCapabilities(): ProviderCapabilities {
        return {
            supportsThinking: true,
            supportsModelListing: true,
            supportsImageInput: false,
            supportsToolCalling: true,
            supportsCustomBaseUrl: true,
        };
    }

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

    async generateContent(prompt: string, systemPrompt?: string, options?: GenerationOptions): Promise<GenerationResult> {
        const messages = [
            { role: 'system', content: systemPrompt ?? this.config.systemPrompt ?? '' },
            { role: 'user', content: prompt }
        ];
        return this.chatCompletion(messages, undefined, options);
    }

    startChat(tools?: ToolDefinition[], priorMessages?: PriorChatMessage[]): IChatSession {
        return new OpenAIChatSession(this.config, tools, this, priorMessages);
    }

    async chatCompletion(messages: any[], tools?: ToolDefinition[], options?: GenerationOptions): Promise<GenerationResult> {
        const raw = await this.chatCompletionRaw(messages, tools, options);
        return OpenAIProvider.toGenerationResult(raw);
    }

    /** 返回原始 assistant message（含 tool_call id），供 ChatSession 维护 history */
    async chatCompletionRaw(messages: any[], tools?: ToolDefinition[], options?: GenerationOptions): Promise<any> {
        const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;

        const body: any = {
            model: this.config.modelName,
            messages: messages,
            temperature: options?.temperature ?? 0.7
        };

        if (typeof options?.maxTokens === 'number') {
            body.max_tokens = options.maxTokens;
        }

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

        const response = await withTimeout(
            requestUrl(params),
            options?.timeoutMs,
            'OpenAI generation timed out',
        );

        if (response.status !== 200) {
            throw new Error(`OpenAI API Error: ${response.status} - ${response.text}`);
        }

        const data = JSON.parse(response.text);
        const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
        const message = choice?.message || {};
        if (!message.content && !message.tool_calls?.length) {
            logger.warn('OpenAI response returned empty assistant content', 'OpenAIProvider.chatCompletionRaw', {
                model: this.config.modelName,
                finishReason: choice?.finish_reason,
                messageKeys: Object.keys(message),
                hasReasoningContent: !!message.reasoning_content,
                responseId: data?.id,
            });
        }
        return message;
    }

    static toGenerationResult(message: any): GenerationResult {
        const result: GenerationResult = {
            text: message.content || ''
        };

        if (message.tool_calls) {
            result.functionCalls = message.tool_calls.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments)
            }));
        }

        return result;
    }

    async *chatCompletionStream(messages: any[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
        const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;

        const body: any = {
            model: this.config.modelName,
            messages,
            temperature: 0.7,
            stream: true
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

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            let detail = '';
            try {
                detail = await response.text();
            } catch {
                detail = '';
            }
            throw new Error(`OpenAI API Error: ${response.status}${detail ? ` - ${detail}` : ''}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        const pendingToolCalls = new Map<number, { id?: string; name: string; arguments: string }>();

        while (true) {
            this.throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.reasoning_content) {
                        yield { type: 'thinking' as const, content: delta.reasoning_content };
                    }

                    if (delta.content) {
                        fullText += delta.content;
                        yield { type: 'text_delta' as const, content: delta.content };
                    }

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!pendingToolCalls.has(idx)) {
                                pendingToolCalls.set(idx, { name: '', arguments: '' });
                            }
                            const pending = pendingToolCalls.get(idx)!;
                            if (tc.id) pending.id = tc.id;
                            if (tc.function?.name) pending.name += tc.function.name;
                            if (tc.function?.arguments) pending.arguments += tc.function.arguments;
                        }
                    }
                } catch {
                    // 忽略解析错误的行
                }
            }
        }

        for (const [, tc] of pendingToolCalls) {
            if (tc.name) {
                try {
                    const args = tc.arguments ? JSON.parse(tc.arguments) : {};
                    yield { type: 'tool_call' as const, id: tc.id, name: tc.name, args };
                } catch {
                    yield { type: 'tool_call' as const, id: tc.id, name: tc.name, args: {} };
                }
            }
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
}

class OpenAIChatSession implements IChatSession {
    private history: any[] = [];

    constructor(
        private config: ModelConfig,
        private tools: ToolDefinition[] | undefined,
        private provider: OpenAIProvider,
        priorMessages?: PriorChatMessage[]
    ) {
        if (config.systemPrompt) {
            this.history.push({ role: 'system', content: config.systemPrompt });
        }
        // 注入上一轮起的干净对话原文，OpenAI 的 model 角色对应内部 assistant。
        for (const message of priorMessages ?? []) {
            this.history.push({
                role: message.role === 'model' ? 'assistant' : 'user',
                content: message.content,
            });
        }
    }

    async sendMessage(text: string | ToolResult[]): Promise<GenerationResult> {
        if (typeof text === 'string') {
            this.dropUnresolvedToolCalls();
            this.history.push({ role: 'user', content: text });
        } else {
            // 将 tool results 追加到 history，匹配上一条 assistant message 中的 tool_call_id
            const lastMsg = this.history[this.history.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
                const usedCallIds = new Set<string>();
                text.forEach(t => {
                    const call = this.findToolCall(lastMsg.tool_calls, t, usedCallIds);
                    if (call) {
                        usedCallIds.add(call.id);
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

    async *sendMessageStream(text: string | ToolResult[], signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
        if (typeof text === 'string') {
            this.dropUnresolvedToolCalls();
            this.history.push({ role: 'user', content: text });
        } else {
            const lastMsg = this.history[this.history.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
                const usedCallIds = new Set<string>();
                text.forEach(t => {
                    const call = this.findToolCall(lastMsg.tool_calls, t, usedCallIds);
                    if (call) {
                        usedCallIds.add(call.id);
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

        let fullText = '';
        let reasoningContent = '';
        const toolCalls: any[] = [];

        for await (const event of this.provider.chatCompletionStream(this.history, this.tools, signal)) {
            if (event.type === 'text_delta') {
                fullText += event.content;
            } else if (event.type === 'thinking') {
                reasoningContent += event.content;
            } else if (event.type === 'tool_call') {
                toolCalls.push({
                    id: event.id || `call_${Date.now()}_${toolCalls.length}`,
                    type: 'function',
                    function: { name: event.name, arguments: JSON.stringify(event.args) }
                });
            }
            if (event.type !== 'done') {
                yield event;
            }
        }

        const assistantMsg: any = { role: 'assistant', content: fullText || null };
        if (reasoningContent) {
            assistantMsg.reasoning_content = reasoningContent;
        }
        if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
        }
        this.history.push(assistantMsg);

        yield { type: 'done' as const, text: fullText };
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

    private dropUnresolvedToolCalls(): void {
        const lastMsg = this.history[this.history.length - 1];
        if (lastMsg?.role === 'assistant' && lastMsg.tool_calls?.length) {
            this.history.pop();
        }
    }

    private findToolCall(toolCalls: any[], result: ToolResult, usedCallIds: Set<string>): any | undefined {
        if (result.id) {
            const directMatch = toolCalls.find((tc: any) => tc.id === result.id && !usedCallIds.has(tc.id));
            if (directMatch) return directMatch;
        }

        return toolCalls.find((tc: any) => tc.function.name === result.name && !usedCallIds.has(tc.id));
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
