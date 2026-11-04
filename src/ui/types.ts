import type { ApprovalRequest } from './approval-card';
import type { ApprovalState } from '../services/approval-execution';
import type { WorkspaceEditSummary } from '../services/workspace-edit-service';
import type { RetryDraft } from './chat-controller';

export type ShellMessageRole = 'user' | 'ai' | 'system';

/**
 * 一轮生成的终态(issue #65):completed/failed/cancelled 必须真实可辨,
 * 而不是像过去那样全部收尾进同一个 finalizeStream 分支、看起来都「完成」了。
 * 缺省(旧数据/未流式的轮次)等价于 completed。
 */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

export interface ChatMessage {
    id: string;
    role: ShellMessageRole;
    content: string;
    timestamp: number;
    /**
     * 该消息在 pi 会话树中对应的 entry id(阶段B:entryId 锚定)。
     * user 与 ai 消息各自锚定本轮落盘的 user/assistant entry。
     * 是阶段C 分叉/重试(从某消息对应的 entry 用 navigateTree 派生新分支)的定位依据。
     * 无持久会话/历史消息/未锚定时缺省。
     */
    sessionEntryId?: string;
    /**
     * 分支导航信息(阶段C):仅投影历史分支时,给「有兄弟分支的 user 消息」附上,
     * 供 UI 渲染 `< index/count >` 并切换。leafIds[k] 是切到第 k 个兄弟时要 moveTo 的目标 leaf entry。
     * count<=1 或非分叉点时缺省。
     */
    branch?: { index: number; count: number; leafIds: string[] };
    /**
     * 分叉源问题文本(阶段C):ai 消息上携带其对应的 user 提问原文,
     * 供底部「分叉」输入预填。由 shell-view 在渲染 ai 操作栏前就近填充。
     */
    forkSourceText?: string;
    feedback?: 'up' | 'down' | null;
    approval?: ApprovalRequest;
    /**
     * 审批生命周期快照。请求(presentation)与结果分开持久化：
     * 切换 tab / 销毁视图后重新挂载时，卡片仍能从消息投影恢复成
     * pending / running / succeeded / failed / rejected / unknown。
     */
    approvalState?: ApprovalState;
    metadata?: {
        providerId?: string;
        modelId?: string;
        durationMs?: number;
        interrupted?: boolean;
        workspaceEdit?: WorkspaceEditSummary;
        /** 本轮终态(issue #65)。仅在该气泡承载一整轮生成结果时有意义。 */
        outcome?: TurnOutcome;
        /** outcome === 'failed' 时的失败原因,供失败态横幅显示 + 持久化回放。 */
        errorMessage?: string;
        /**
         * outcome === 'failed' 时的原始请求快照,供「一键重试」原样重发——
         * 首 token 前失败没有 sessionEntryId 可锚定,只能靠这份快照重跑(不走分支 fork)。
         */
        retryDraft?: RetryDraft;
    };
}

export interface ToolRunState {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'error' | 'approval_required';
    input: Record<string, unknown>;
    result?: unknown;
    error?: string;
    startedAt: number;
    finishedAt?: number;
}

export interface ConversationSnapshot {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    providerId: string;
    modelId: string;
    messages: ChatMessage[];
    currentNote?: string;
    pinnedAt?: number;
}
