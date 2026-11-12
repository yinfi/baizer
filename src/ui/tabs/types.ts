import { ChatState } from '../state/chat-state';

export type TabId = string;

/**
 * 会话种类。「这个会话是不是反馈会话」这**一个**事实由它承载——工具的可见范围
 * （四个反馈工具只在反馈会话里出现）与上下文隔离都从它派生，不靠 UI 调用点自觉。
 *
 * 它随会话快照一起持久化与恢复（写入点 ConversationController.saveActiveTab、
 * 恢复点 createTabData）：只靠内存里的 tab 集合，重启后恢复的反馈会话就不再是
 * 反馈会话——工具集变回全量，隔离随之失效。缺失即 'chat'。
 */
export type TabKind = 'chat' | 'feedback';

export interface TabData {
    id: TabId;
    index: number;
    title: string;
    kind: TabKind;
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
    kind: TabKind;
    isActive: boolean;
    isStreaming: boolean;
    needsAttention: boolean;
    canClose: boolean;
    providerId?: string;
    /**
     * 已提交反馈的终态标识。**派生自草稿存储**（sourceConversationId === tabId 且
     * status === 'submitted'），由 shell 在构建 tab bar items 时读一次填入。
     * TabBarItem 不是持久化结构，因此这里不构成第二处真相。
     */
    feedbackOutcome?: { issueNumber: number };
}
