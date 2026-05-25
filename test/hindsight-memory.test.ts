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
    expect(writes['.obsidian/baizer-memory/memories.json']).toContain('local-first');
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
        text: 'User is working on the Baizer memory layer.',
        normalizedText: 'user is working on the baizer memory layer.',
        entities: ['baizer', 'memory'],
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
      query: 'How should we improve Baizer memory?',
      maxRecords: 2,
      now: 3000,
    });

    expect(result.records[0].id).toBe('mem_obsidian');
    expect(result.promptBlock).toContain('Baizer memory layer');
  });

  await test('retriever writes access metadata for selected memories', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemory(makeMemory({
      id: 'mem_accessed',
      text: 'User prefers access-aware memory ranking.',
      normalizedText: 'user prefers access-aware memory ranking.',
      entities: ['access-aware'],
      tags: ['preference'],
      mentionedAt: 1000,
    }));

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    await retriever.recall({ query: 'access-aware memory', now: 3000 });

    const memories = await store.listMemories();
    expect(memories[0].accessCount).toBe(1);
    expect(memories[0].lastAccessedAt).toBe(3000);
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

  await test('migration converts legacy profile and summaries exactly once', async () => {
    const profilePath = '.obsidian/baizer-memory/user-profile.json';
    const summariesPath = '.obsidian/baizer-memory/session-summaries.json';
    const { app } = createApp({
      [profilePath]: JSON.stringify({
        profession: 'Product engineer',
        expertise: ['Obsidian plugins'],
        preferences: { responseStyle: 'concise', language: 'zh-CN', topics: [] },
        context: { currentProjects: ['Baizer memory'], goals: ['local-first recall'], challenges: [] },
        workflows: [],
        metadata: { totalInteractions: 4, createdAt: 1, updatedAt: 2, lastProfileUpdate: 2 },
      }),
      [summariesPath]: JSON.stringify([
        { timestamp: 10, messageCount: 2, summary: 'Discussed Hindsight-lite memory.' },
      ]),
    });
    const store = new HindsightStore(app);
    await store.ready();

    const { migrateLegacyMemory } = await import('../src/memory/hindsight-migration');
    await migrateLegacyMemory(app, store, 5000);
    await migrateLegacyMemory(app, store, 6000);

    const memories = await store.listMemories();
    expect(memories.filter((memory) => memory.source.kind === 'profile-migration').length).toBe(5);
    expect(memories.filter((memory) => memory.source.kind === 'summary-migration').length).toBe(1);
    expect(memories.some((memory) => memory.text.includes('Product engineer'))).toBe(true);
  });

  await test('migration ignores the previous plugin memory directory', async () => {
    const previousMemoryDir = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');
    const { app } = createApp({
      [`${previousMemoryDir}/user-profile.json`]: JSON.stringify({
        profession: 'Previous plugin engineer',
        expertise: ['old plugin'],
        preferences: { responseStyle: 'verbose' },
        context: { currentProjects: ['Old memory'], goals: [], challenges: [] },
      }),
      [`${previousMemoryDir}/session-summaries.json`]: JSON.stringify([
        { timestamp: 10, messageCount: 2, summary: 'Old summary.' },
      ]),
    });
    const store = new HindsightStore(app);
    await store.ready();

    const { migrateLegacyMemory } = await import('../src/memory/hindsight-migration');
    await migrateLegacyMemory(app, store, 5000);

    expect(await store.listMemories()).toEqual([]);
  });

  await test('consolidator creates observations with evidence ids', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_local',
        type: 'world',
        text: 'User prefers local-first implementations.',
        normalizedText: 'user prefers local-first implementations.',
        entities: ['local-first'],
        tags: ['preference'],
      }),
      makeMemory({
        id: 'mem_tests',
        type: 'experience',
        text: 'User confirmed a TDD implementation plan for memory.',
        normalizedText: 'user confirmed a tdd implementation plan for memory.',
        entities: ['tdd', 'memory'],
        tags: ['plan'],
      }),
    ]);

    const { HindsightConsolidator } = await import('../src/memory/hindsight-consolidator');
    const consolidator = new HindsightConsolidator(store);
    const created = await consolidator.consolidate({ now: 7000 });

    expect(created.length).toBe(1);
    expect(created[0].type).toBe('observation');
    expect(created[0].evidenceIds).toEqual(['mem_local', 'mem_tests']);
    expect(created[0].text).toContain('local-first');
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
