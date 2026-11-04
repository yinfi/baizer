
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

/**
 * 一轮对话的终态。成功 / 失败 / 取消必须是同一个显式来源，供 UI、会话状态、
 * 持久化与回放共同消费——不能靠「有没有正文」「有没有 interrupted 标记」各自推断。
 */
export type ChatTurnOutcome = 'completed' | 'failed' | 'cancelled';

export type StreamEvent =
    | { type: 'thinking'; content: string }
    | { type: 'text_delta'; content: string }
    | { type: 'tool_call'; name: string; args: any; id?: string }
    | { type: 'tool_result'; name: string; result: any; error?: string }
    // 智能体一个工具循环回合的开始,用于把过程按「回合」分组展示(Step N)。
    | { type: 'step_boundary' }
    // 本轮结束后触发了自动压缩(functional-spec.md §4 决策表):pi 1.3.0 本身不发压缩事件,
    // 压缩完全由本项目的 maybeCompact 驱动,故这里是该动作对 UI 的唯一可感知信号,
    // 使压缩不再是纯内部副作用。只在真的折叠了旧消息时才产出。
    | { type: 'compaction'; foldedEntryCount: number }
    | {
        type: 'done';
        text: string;
        /**
         * 本轮终态。生产者必须显式给出:正常收尾 completed,用户中止 cancelled。
         * failed 只经 error 事件表达(失败没有「完成文本」语义)。
         * interrupted 为兼容旧消费方保留,语义等同于 outcome === 'cancelled'。
         */
        outcome: ChatTurnOutcome;
        interrupted?: boolean;
        /**
         * 本轮落盘进 pi session 的 entry 标识(阶段B:entryId 锚定)。
         * 供 UI 把 ChatMessage 锚定到会话树 entry,是阶段C 分叉/重试(navigateTree)的前提。
         * 仅在持久会话(有 sessionManager + conversationId)且正常完成时出现;
         * 临时会话、审批终止、中断等路径可能缺省。
         */
        entryIds?: { userEntryId?: string; assistantEntryId?: string };
      }
    | { type: 'error'; message: string; outcome: ChatTurnOutcome };

