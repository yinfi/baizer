
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

/**
 * 跨轮注入到新会话的历史消息。
 * 只携带干净的对话原文（用户提问 + AI 回答），不包含 system 装饰、
 * 工具调用细节或审批提示——这些每轮由 prepareTurn 重新挂在最新一条消息上。
 */
export interface PriorChatMessage {
    role: 'user' | 'model';
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
    /**
     * 软取消信号。当前非流式 provider 走 requestUrl/SDK，无法硬中断网络请求；
     * 该 signal 仅用于让调用方在 abort 后立即解脱、丢弃结果（底层请求后台自然结束）。
     * 由 ModelService.generate 消费，不会透传给 provider。
     */
    signal?: AbortSignal;
}

export type StreamEvent =
    | { type: 'thinking'; content: string }
    | { type: 'text_delta'; content: string }
    | { type: 'tool_call'; name: string; args: any; id?: string }
    | { type: 'tool_result'; name: string; result: any; error?: string }
    // 智能体一个工具循环回合的开始,用于把过程按「回合」分组展示(Step N)。
    | { type: 'step_boundary' }
    | { type: 'done'; text: string; interrupted?: boolean }
    | { type: 'error'; message: string };

export interface IModelProvider {
    id: string;
    name: string;

    configure(config: ModelConfig): void;
    getCapabilities(): ProviderCapabilities;
    checkAvailability(): Promise<boolean>;
    listModels?(): Promise<ModelOption[]>;

    generateContent(prompt: string, systemPrompt?: string, options?: GenerationOptions): Promise<GenerationResult>;
}
