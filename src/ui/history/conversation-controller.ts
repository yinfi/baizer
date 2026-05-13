import { ConversationSnapshot } from '../types';
import { ConversationStore } from './conversation-store';
import { TabData } from '../tabs/types';
import { TabManager } from '../tabs/tab-manager';

interface ConversationControllerDeps {
  store: ConversationStore;
  getProviderId: () => string;
  getModelId: () => string;
  getCurrentNotePath?: () => string | undefined;
  now?: () => number;
}

export class ConversationController {
  private readonly now: () => number;

  constructor(private readonly deps: ConversationControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async listHistory(): Promise<ConversationSnapshot[]> {
    return this.deps.store.list();
  }

  async saveActiveTab(tab: TabData | null): Promise<ConversationSnapshot | null> {
    if (!tab) return null;

    const messages = tab.state.getMessages();
    if (messages.length === 0) return null;

    const timestamp = this.now();
    const snapshot: ConversationSnapshot = {
      id: tab.id,
      title: this.resolveTitle(tab, messages),
      createdAt: tab.createdAt ?? timestamp,
      updatedAt: timestamp,
      providerId: tab.providerId || this.deps.getProviderId(),
      modelId: tab.modelId || this.deps.getModelId(),
      currentNote: tab.currentNote || this.deps.getCurrentNotePath?.(),
      pinnedAt: tab.pinnedAt,
      messages,
    };

    await this.deps.store.save(snapshot);

    tab.title = snapshot.title;
    tab.createdAt = snapshot.createdAt;
    tab.updatedAt = snapshot.updatedAt;
    tab.providerId = snapshot.providerId;
    tab.modelId = snapshot.modelId;
    tab.currentNote = snapshot.currentNote;
    tab.pinnedAt = snapshot.pinnedAt;
    tab.state.markClean();

    return snapshot;
  }

  restoreConversation(snapshot: ConversationSnapshot, tabManager: TabManager): TabData {
    return tabManager.createTab(snapshot);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.deps.store.delete(id);
  }

  async togglePinned(id: string, pinned: boolean): Promise<ConversationSnapshot | null> {
    const snapshot = (await this.deps.store.list()).find(item => item.id === id);
    if (!snapshot) return null;

    const next: ConversationSnapshot = {
      ...snapshot,
      pinnedAt: pinned ? this.now() : undefined,
    };

    await this.deps.store.save(next);
    return next;
  }

  private resolveTitle(tab: TabData, messages: ConversationSnapshot['messages']): string {
    if (tab.title && !/^Chat \d+$/.test(tab.title)) {
      return tab.title;
    }

    const firstUserMessage = messages.find(message => message.role === 'user' && message.content.trim().length > 0);
    if (!firstUserMessage) {
      return tab.title || 'New chat';
    }

    const normalized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 60) {
      return normalized;
    }

    return `${normalized.slice(0, 57)}...`;
  }
}
