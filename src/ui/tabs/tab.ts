import { ConversationSnapshot } from '../types';
import { ChatState } from '../state/chat-state';
import { TabData, TabId } from './types';

interface CreateTabDataOptions {
    id: TabId;
    index: number;
    title: string;
    isActive: boolean;
    snapshot?: ConversationSnapshot;
}

export function createTabData(options: CreateTabDataOptions): TabData {
    const state = new ChatState(options.id);

    if (options.snapshot) {
        for (const message of options.snapshot.messages) {
            state.addMessage(message);
        }
        state.markClean();
    }

    return {
        id: options.id,
        index: options.index,
        title: options.title,
        createdAt: options.snapshot?.createdAt,
        updatedAt: options.snapshot?.updatedAt,
        pinnedAt: options.snapshot?.pinnedAt,
        isActive: options.isActive,
        isStreaming: false,
        needsAttention: false,
        state,
        providerId: options.snapshot?.providerId,
        modelId: options.snapshot?.modelId,
        currentNote: options.snapshot?.currentNote,
    };
}
