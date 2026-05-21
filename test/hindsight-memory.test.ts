import { App } from 'obsidian';
import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
} from '../src/memory/hindsight-types';
import { HindsightStore } from '../src/memory/hindsight-store';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
    toContain: (expected: string) => {
      if (!String(actual).includes(expected)) throw new Error(`Expected "${actual}" to contain "${expected}"`);
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (error: any) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
}

function createApp(existing: Record<string, string> = {}) {
  const writes: Record<string, string> = {};
  const files = { ...existing };
  const adapter = {
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
    read: async (path: string) => files[path],
    write: async (path: string, content: string) => {
      files[path] = content;
      writes[path] = content;
    },
    mkdir: async (path: string) => {
      files[path] = '';
    },
  };
  return { app: { vault: { adapter } } as unknown as App, files, writes };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1000;
  return {
    id: overrides.id || 'mem_test',
    bankId: overrides.bankId || DEFAULT_MEMORY_BANK_ID,
    type: overrides.type || 'world',
    text: overrides.text || 'User prefers local-first memory.',
    normalizedText: overrides.normalizedText || 'user prefers local-first memory.',
    entities: overrides.entities || ['local-first'],
    tags: overrides.tags || ['preference'],
    source: overrides.source || { kind: 'manual' },
    confidence: overrides.confidence ?? 0.8,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    mentionedAt: overrides.mentionedAt || now,
    accessCount: overrides.accessCount ?? 0,
    ...overrides,
  };
}

async function runTests() {
  console.log('=== Hindsight Memory Tests ===');

  await test('store initializes a default bank and persists memories', async () => {
    const { app, writes } = createApp();
    const store = new HindsightStore(app);
    await store.ready();

    await store.upsertMemory(makeMemory());

    const memories = await store.listMemories();
    const banks = await store.listBanks();

    expect(banks[0].id).toBe(DEFAULT_MEMORY_BANK_ID);
    expect(memories.length).toBe(1);
    expect(memories[0].normalizedText).toBe('user prefers local-first memory.');
    expect(writes['.obsidian/obsidian-cli-memory/memories.json']).toContain('local-first');
  });

  await test('store treats duplicate ids as updates instead of duplicate rows', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();

    await store.upsertMemory(makeMemory({ id: 'mem_same', text: 'First value' }));
    await store.upsertMemory(makeMemory({ id: 'mem_same', text: 'Second value' }));

    const memories = await store.listMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].text).toBe('Second value');
  });

  await test('retriever ranks entity and keyword matches above unrelated records', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_obsidian',
        type: 'world',
        text: 'User is working on the Obsidian CLI memory layer.',
        normalizedText: 'user is working on the obsidian cli memory layer.',
        entities: ['obsidian-cli', 'memory'],
        tags: ['project'],
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_food',
        type: 'experience',
        text: 'User discussed lunch plans.',
        normalizedText: 'user discussed lunch plans.',
        entities: ['lunch'],
        tags: ['chat'],
        mentionedAt: 2000,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({
      query: 'How should we improve Obsidian CLI memory?',
      maxRecords: 2,
      now: 3000,
    });

    expect(result.records[0].id).toBe('mem_obsidian');
    expect(result.promptBlock).toContain('Obsidian CLI memory layer');
  });

  await test('retriever respects max character budget', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({ id: 'mem_one', text: 'Short memory about local storage.', normalizedText: 'short memory about local storage.' }),
      makeMemory({ id: 'mem_two', text: 'Another short memory about local recall.', normalizedText: 'another short memory about local recall.' }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({ query: 'local memory', maxChars: 90, now: 3000 });

    expect(result.promptBlock.length <= 90).toBe(true);
    expect(result.records.length).toBe(1);
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
