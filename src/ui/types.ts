import { ApprovalRequest } from './approval-card';
import type { WorkspaceEditSummary } from '../services/workspace-edit-service';

export type ShellMessageRole = 'user' | 'ai' | 'system';

export interface ChatMessage {
    id: string;
    role: ShellMessageRole;
    content: string;
    timestamp: number;
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
