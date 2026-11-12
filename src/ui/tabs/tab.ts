import { ConversationSnapshot } from '../types';
import { ChatState } from '../state/chat-state';
import { TabData, TabId, TabKind } from './types';

interface CreateTabDataOptions {
    id: TabId;
    index: number;
    title: string;
    isActive: boolean;
    snapshot?: ConversationSnapshot;
    /** 新建 tab 时的会话种类；快照存在时以快照为准（恢复点，BR1.6）。 */
    kind?: TabKind;
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
        kind: options.snapshot?.kind ?? options.kind ?? 'chat',
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
