import { ConversationSnapshot } from '../types';
import { createTabData } from './tab';
import { TabBarItem, TabData, TabId } from './types';

interface TabManagerOptions {
    createId?: () => TabId;
    onChanged?: () => void;
}

export class TabManager {
    private tabs: TabData[] = [];
    private nextUntitledNumber = 1;
    private readonly createId: () => TabId;
    private readonly onChanged?: () => void;

    constructor(options: TabManagerOptions = {}) {
        this.createId = options.createId ?? (() => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        this.onChanged = options.onChanged;
    }

    createTab(snapshot?: ConversationSnapshot): TabData {
        for (const tab of this.tabs) {
            tab.isActive = false;
        }

        const tab = createTabData({
            id: snapshot?.id ?? this.createId(),
            index: this.tabs.length + 1,
            title: snapshot?.title || `Chat ${this.nextUntitledNumber++}`,
            isActive: true,
            snapshot,
        });
        this.tabs.push(tab);
        this.reindex();
        this.emitChanged();
        return tab;
    }

    getActiveTab(): TabData | null {
        return this.tabs.find(tab => tab.isActive) ?? null;
    }

    getAllTabs(): TabData[] {
        return [...this.tabs];
    }

    switchTab(id: TabId): boolean {
        const target = this.tabs.find(tab => tab.id === id);
        if (!target) return false;

        for (const tab of this.tabs) {
            tab.isActive = tab.id === id;
        }
        target.needsAttention = false;
        this.emitChanged();
        return true;
    }

    closeTab(id: TabId): boolean {
        if (this.tabs.length <= 1) return false;

        const index = this.tabs.findIndex(tab => tab.id === id);
        if (index < 0) return false;

        const wasActive = this.tabs[index].isActive;
        this.tabs.splice(index, 1);

        if (wasActive && !this.tabs.some(tab => tab.isActive)) {
            const nextIndex = Math.min(index, this.tabs.length - 1);
            this.tabs[nextIndex].isActive = true;
        }

        this.reindex();
        this.emitChanged();
        return true;
    }

    markStreaming(id: TabId, streaming: boolean): void {
        const tab = this.tabs.find(item => item.id === id);
        if (!tab || tab.isStreaming === streaming) return;

        tab.isStreaming = streaming;
        this.emitChanged();
    }

    markAttention(id: TabId, attention: boolean): void {
        const tab = this.tabs.find(item => item.id === id);
        if (!tab || tab.needsAttention === attention) return;

        tab.needsAttention = attention;
        this.emitChanged();
    }

    updateTab(id: TabId, patch: Partial<Pick<TabData, 'title' | 'providerId' | 'modelId' | 'currentNote' | 'createdAt' | 'updatedAt' | 'pinnedAt'>>): boolean {
        const tab = this.tabs.find(item => item.id === id);
        if (!tab) return false;

        Object.assign(tab, patch);
        this.emitChanged();
        return true;
    }

    toTabBarItems(): TabBarItem[] {
        return this.tabs.map(tab => ({
            id: tab.id,
            index: tab.index,
            title: tab.title,
            isActive: tab.isActive,
            isStreaming: tab.isStreaming,
            needsAttention: tab.needsAttention,
            canClose: this.tabs.length > 1,
            providerId: tab.providerId,
        }));
    }

    private reindex(): void {
        this.tabs.forEach((tab, index) => {
            tab.index = index + 1;
        });
    }

    private emitChanged(): void {
        this.onChanged?.();
    }
}
