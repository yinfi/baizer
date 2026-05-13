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

class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();

  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, content: string) {
    this.files.set(path, content);
  }

  async mkdir(path: string) {
    this.folders.add(path);
  }
}

function createStore(ConversationStore: any, adapter = new FakeAdapter(), maxConversations = 100) {
  return {
    adapter,
    store: new ConversationStore({ vault: { adapter } } as any, { maxConversations }),
  };
}

function snapshot(id: string, updatedAt: number): ConversationSnapshot {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: updatedAt - 10,
    updatedAt,
    providerId: 'gemini',
    modelId: 'gemini-2.5-flash',
    messages: [{ id: `m-${id}`, role: 'user', content: id, timestamp: updatedAt }],
  };
}

async function runTests() {
  console.log('=== ConversationStore Tests ===');
  const { ConversationStore, CONVERSATION_STORE_PATH } = await import('../src/ui/history/conversation-store');

  await test('returns an empty list when the store file does not exist', async () => {
    const { store } = createStore(ConversationStore);

    expect(await store.list()).toEqual([]);
  });

  await test('saves conversations and lists them newest first', async () => {
    const { adapter, store } = createStore(ConversationStore);

    await store.save(snapshot('old', 10));
    await store.save(snapshot('new', 30));
    await store.save(snapshot('middle', 20));

    expect(adapter.folders.has('.obsidian')).toBe(true);
    expect(adapter.folders.has('.obsidian/obsidian-cli')).toBe(true);
    expect((await store.list()).map(item => item.id)).toEqual(['new', 'middle', 'old']);

    const stored = JSON.parse(adapter.files.get(CONVERSATION_STORE_PATH) || '{}');
    expect(stored.version).toBe(1);
    expect(stored.conversations.length).toBe(3);
  });

  await test('replaces an existing conversation with the same id', async () => {
    const { store } = createStore(ConversationStore);

    await store.save(snapshot('same', 10));
    await store.save({
      ...snapshot('same', 40),
      title: 'Updated',
      messages: [{ id: 'm2', role: 'ai', content: 'updated', timestamp: 40 }],
    });

    expect(await store.list()).toEqual([{
      ...snapshot('same', 40),
      title: 'Updated',
      messages: [{ id: 'm2', role: 'ai', content: 'updated', timestamp: 40 }],
    }]);
  });

  await test('deletes conversations by id', async () => {
    const { store } = createStore(ConversationStore);

    await store.save(snapshot('keep', 20));
    await store.save(snapshot('delete', 30));
    await store.delete('delete');

    expect((await store.list()).map(item => item.id)).toEqual(['keep']);
  });

  await test('falls back to an empty list when the store file is corrupted', async () => {
    const adapter = new FakeAdapter();
    adapter.folders.add('.obsidian');
    adapter.folders.add('.obsidian/obsidian-cli');
    adapter.files.set(CONVERSATION_STORE_PATH, '{bad json');
    const { store } = createStore(ConversationStore, adapter);

    expect(await store.list()).toEqual([]);

    await store.save(snapshot('fresh', 50));
    expect((await store.list()).map(item => item.id)).toEqual(['fresh']);
  });

  await test('caps retained conversations to the configured maximum', async () => {
    const { store } = createStore(ConversationStore, new FakeAdapter(), 2);

    await store.save(snapshot('one', 10));
    await store.save(snapshot('two', 20));
    await store.save(snapshot('three', 30));

    expect((await store.list()).map(item => item.id)).toEqual(['three', 'two']);
  });

  await test('preserves optional pinned metadata in storage', async () => {
    const { store } = createStore(ConversationStore);

    await store.save({
      ...snapshot('pinned', 40),
      pinnedAt: 35,
    } as any);

    expect(await store.list()).toEqual([{
      ...snapshot('pinned', 40),
      pinnedAt: 35,
    }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
