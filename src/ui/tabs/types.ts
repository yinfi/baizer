import { ChatState } from '../state/chat-state';

export type TabId = string;

export interface TabData {
    id: TabId;
    index: number;
    title: string;
    createdAt?: number;
    updatedAt?: number;
    pinnedAt?: number;
    isActive: boolean;
    isStreaming: boolean;
    needsAttention: boolean;
    state: ChatState;
    providerId?: string;
    modelId?: string;
    currentNote?: string;
}

export interface TabBarItem {
    id: TabId;
    index: number;
    title: string;
    isActive: boolean;
    isStreaming: boolean;
    needsAttention: boolean;
    canClose: boolean;
    providerId?: string;
}
