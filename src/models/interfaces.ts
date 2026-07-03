
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

export interface GenerationOptions {
    temperature?: number;
    maxTokens?: number;
    /**
     * @deprecated 保留字段以兼容调用方旧签名，但已不再消费。
     * 无状态生成迁移到 pi completeSimple 后走原生 signal 硬中断；
     * 超时应由调用方用 AbortSignal 表达，而非此毫秒数。
     */
    timeoutMs?: number;
    skipGenerationPlan?: boolean;
    /**
     * 取消信号。无状态生成走 pi completeSimple，signal 直接透传给 pi 做原生硬中断
     * （不再是旧的软取消——底层请求会真正被中止）。
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

