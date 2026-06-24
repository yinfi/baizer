
import { ProviderCapabilities } from '../runtime/provider-capabilities';

export interface ModelConfig {
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    systemPrompt?: string;
    contextWindow?: number;
}

export interface ModelOption {
    value: string;
    label: string;
}

export interface ChatMessage {
    role: 'user' | 'model' | 'system';
    content: string;
}

export interface ChatContextItem {
    id?: string;
    type: string;
    data: string;
    summary?: string;
    content?: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any;
}

export interface ToolCall {
    id?: string;
    name: string;
    args: any;
}

export interface ToolResult {
    id?: string;
    name: string;
    response: any;
}

export interface GenerationResult {
    text: string;
    functionCalls?: ToolCall[];
}

export interface GenerationOptions {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    skipGenerationPlan?: boolean;
}

export type StreamEvent =
    | { type: 'thinking'; content: string }
    | { type: 'text_delta'; content: string }
    | { type: 'tool_call'; name: string; args: any; id?: string }
    | { type: 'tool_result'; name: string; result: any; error?: string }
    | { type: 'done'; text: string; interrupted?: boolean }
    | { type: 'error'; message: string };

export interface IChatSession {
    sendMessage(text: string | ToolResult[]): Promise<GenerationResult>;
    sendMessageStream(text: string | ToolResult[], signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
    getHistory(): Promise<ChatMessage[]>;
    clearHistory(): Promise<void>;
}

export interface IModelProvider {
    id: string;
    name: string;

    configure(config: ModelConfig): void;
    getCapabilities(): ProviderCapabilities;
    checkAvailability(): Promise<boolean>;
    listModels?(): Promise<ModelOption[]>;

    generateContent(prompt: string, systemPrompt?: string, options?: GenerationOptions): Promise<GenerationResult>;
    startChat(tools?: ToolDefinition[]): IChatSession;
}
