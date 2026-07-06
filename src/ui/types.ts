import { ApprovalRequest } from './approval-card';
import type { WorkspaceEditSummary } from '../services/workspace-edit-service';

export type ShellMessageRole = 'user' | 'ai' | 'system';

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
    metadata?: {
        providerId?: string;
        modelId?: string;
        durationMs?: number;
        interrupted?: boolean;
        workspaceEdit?: WorkspaceEditSummary;
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
