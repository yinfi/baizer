import { ConversationSnapshot } from '../src/ui/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

class FakeStore {
  conversations: ConversationSnapshot[] = [];

  async list() {
    return this.conversations.map(item => ({
      ...item,
      messages: item.messages.map(message => ({ ...message })),
    }));
  }

  async save(snapshot: ConversationSnapshot) {
    this.conversations = this.conversations
      .filter(item => item.id !== snapshot.id)
      .concat({
        ...snapshot,
        messages: snapshot.messages.map(message => ({ ...message })),
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string) {
    this.conversations = this.conversations.filter(item => item.id !== id);
  }
}

function seedSnapshot(id: string, updatedAt: number): ConversationSnapshot {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: updatedAt - 20,
    updatedAt,
    providerId: 'gemini',
    modelId: 'gemini-2.5-flash',
    currentNote: 'Notes/seed.md',
    messages: [{ id: `m-${id}`, role: 'user', content: `seed ${id}`, timestamp: updatedAt - 10 }],
  };
}

async function runTests() {
  console.log('=== Conversation Controller Tests ===');
  const { ConversationController } = await import('../src/ui/history/conversation-controller');
  const { TabManager } = await import('../src/ui/tabs/tab-manager');

  await test('saveActiveTab persists a snapshot with generated fallback title and marks the tab clean', async () => {
    const store = new FakeStore();
    const controller = new ConversationController({
      store: store as any,
      getProviderId: () => 'gemini',
      getModelId: () => 'gemini-2.5-flash',
      getCurrentNotePath: () => 'Notes/active.md',
      now: () => 100,
    });
    const tab = new TabManager({ createId: () => 'tab-1' }).createTab();
    tab.state.addMessage({
      id: 'm1',
      role: 'user',
      content: 'Discuss long term roadmap for team collaboration and knowledge workflows inside Baizer',
      timestamp: 10,
    });
    tab.state.addMessage({ id: 'm2', role: 'ai', content: 'draft', timestamp: 20 });

    const snapshot = await controller.saveActiveTab(tab);

    expect(snapshot).toEqual({
      id: 'tab-1',
      title: 'Discuss long term roadmap for team collaboration and know...',
      createdAt: 100,
      updatedAt: 100,
      providerId: 'gemini',
      modelId: 'gemini-2.5-flash',
      currentNote: 'Notes/active.md',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Discuss long term roadmap for team collaboration and knowledge workflows inside Baizer',
          timestamp: 10,
        },
        { id: 'm2', role: 'ai', content: 'draft', timestamp: 20 },
      ],
    });
    expect(tab.title).toBe('Discuss long term roadmap for team collaboration and know...');
    expect(tab.state.isDirty()).toBe(false);
    expect(store.conversations.map(item => item.id)).toEqual(['tab-1']);
  });

  await test('restoreConversation creates a hydrated active tab from a snapshot', async () => {
    const store = new FakeStore();
    const controller = new ConversationController({
      store: store as any,
      getProviderId: () => 'gemini',
      getModelId: () => 'gemini-2.5-flash',
      now: () => 200,
    });
    const manager = new TabManager({ createId: () => 'new-tab' });
    manager.createTab();

    const restored = controller.restoreConversation(seedSnapshot('saved-1', 80), manager);

    expect(restored.id).toBe('saved-1');
    expect(restored.title).toBe('Conversation saved-1');
    expect(restored.isActive).toBe(true);
    expect(restored.state.getMessages()).toEqual([
      { id: 'm-saved-1', role: 'user', content: 'seed saved-1', timestamp: 70 },
    ]);
    expect(manager.getActiveTab()?.id).toBe('saved-1');
  });

  await test('deleteConversation removes a saved snapshot and listHistory preserves store ordering', async () => {
    const store = new FakeStore();
    store.conversations = [seedSnapshot('new', 50), seedSnapshot('old', 20)];
    const controller = new ConversationController({
      store: store as any,
      getProviderId: () => 'gemini',
      getModelId: () => 'gemini-2.5-flash',
      now: () => 200,
    });

    expect((await controller.listHistory()).map(item => item.id)).toEqual(['new', 'old']);

    await controller.deleteConversation('new');

    expect((await controller.listHistory()).map(item => item.id)).toEqual(['old']);
  });

  await test('togglePinned updates saved snapshot metadata without changing message history', async () => {
    const store = new FakeStore();
    store.conversations = [seedSnapshot('saved-1', 80)];
    const controller = new ConversationController({
      store: store as any,
      getProviderId: () => 'gemini',
      getModelId: () => 'gemini-2.5-flash',
      now: () => 200,
    });

    const pinned = await controller.togglePinned('saved-1', true);
    const unpinned = await controller.togglePinned('saved-1', false);

    expect(pinned).toEqual({
      ...seedSnapshot('saved-1', 80),
      pinnedAt: 200,
    });
    expect(unpinned).toEqual(seedSnapshot('saved-1', 80));
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
