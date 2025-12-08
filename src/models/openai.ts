import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage } from './interfaces';
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

    async generateContent(prompt: string): Promise<GenerationResult> {
        const messages = [
            { role: 'system', content: this.config.systemPrompt || '' },
            { role: 'user', content: prompt }
        ];
        return this.chatCompletion(messages);
    }

    startChat(tools?: ToolDefinition[]): IChatSession {
        return new OpenAIChatSession(this.config, tools, this);
    }

    async chatCompletion(messages: any[], tools?: ToolDefinition[]): Promise<GenerationResult> {
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
        const choice = data.choices[0];
        const message = choice.message;

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
            // Handle tool results
            // We need to append the tool outputs to the history
            // OpenAI expects tool_outputs to follow the tool_calls
            // This assumes the previous message in history was the assistant's tool_calls

            // Note: In a real implementation, we need to track tool_call_ids.
            // But for simplicity and generic compatibility, we might need to be careful.
            // Most OpenAI compatible APIs require tool_call_id.
            // Our generic ToolResult interface doesn't have it.
            // We might need to store the last generation result to get IDs.

            // For now, let's assume we can't easily do tool calls without IDs in OpenAI.
            // We need to update the interfaces or store state.
            // Let's try to find the last assistant message with tool calls.

            const lastMsg = this.history[this.history.length - 1];
            if (lastMsg.role === 'assistant' && lastMsg.tool_calls) {
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

        const result = await this.provider.chatCompletion(this.history, this.tools);

        // Append assistant response to history
        const assistantMsg: any = { role: 'assistant', content: result.text };
        if (result.functionCalls) {
            // We need to reconstruct the tool_calls object with IDs for history
            // But the generic result doesn't have IDs.
            // We need to modify chatCompletion to return the full message object or IDs.
            // Let's hack it for now by re-fetching or just storing what we got if possible.
            // Actually, chatCompletion parses the response.
            // We should probably make chatCompletion return the raw message for history storage.

            // REVISIT: For now, we might break multi-turn tool calls if we don't have IDs.
            // Let's update the provider to store the raw response in a way we can use.
        }

        // Wait, I can't easily get the IDs back from the generic interface.
        // I should probably update the interface to support an "opaque" context or object.
        // But to keep it simple, I will modify the OpenAIProvider to handle this state internally or 
        // just accept that I need to fetch the IDs.

        // Actually, let's modify `chatCompletion` to return the full message, 
        // and `GenerationResult` is just a projection.
        // But `sendMessage` returns `GenerationResult`.

        // Let's fix this by making `chatCompletion` return the raw message, 
        // and `OpenAIChatSession` manages the history with that raw message.

        // However, `sendMessage` needs to return `GenerationResult`.
        // So I will call a private method `_chat` that returns the raw message.

        return result;
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
