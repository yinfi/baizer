import { App } from 'obsidian';
import { HindsightStore } from '../src/memory/hindsight-store';
import { MemoryManager } from '../src/memory/memory-manager';
import { importPreviousMemoryFiles, migrateLegacyMemory } from '../src/memory/hindsight-migration';

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toEqual: (expected: unknown) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: unknown) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const PROFILE = '.obsidian/baizer-memory/user-profile.json';
const SUMMARIES = '.obsidian/baizer-memory/session-summaries.json';
const PREV_DIR = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');

function createApp(existing: Record<string, string> = {}) {
  const files: Record<string, string> = { ...existing };
  const adapter = {
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
    read: async (path: string) => files[path] ?? '',
    write: async (path: string, content: string) => { files[path] = content; },
    mkdir: async (path: string) => { files[path] = ''; },
    remove: async (path: string) => { delete files[path]; },
    rename: async (from: string, to: string) => {
      files[to] = files[from];
      delete files[from];
    },
  };
  return { app: { vault: { adapter, configDir: '.obsidian' } } as unknown as App, files };
}

async function run() {
  console.log('=== narrow-g1 memory tests ===');

  await test('migration tolerates malformed legacy profile fields', async () => {
    const { app } = createApp({
      [PROFILE]: JSON.stringify({
        profession: 42,
        expertise: ['TS', 7, '', null],
        preferences: 'not-an-object',
        context: { currentProjects: 'nope', goals: ['ship it'] },
      }),
    });
    const store = new HindsightStore(app);
    await store.ready();
    await migrateLegacyMemory(app, store, 5000);
    const texts = (await store.listMemories()).map((m) => m.text).sort();
    expect(texts).toEqual(['User expertise: TS', 'User goal: ship it', 'User profession: 42']);
  });

  await test('migration ignores non-array summaries and non-object entries', async () => {
    const { app } = createApp({
      [SUMMARIES]: JSON.stringify([null, 'str', 3, { summary: '  ' }, { summary: 9 }, { summary: ' kept ', timestamp: 77 }]),
      [`${PREV_DIR}/session-summaries.json`]: JSON.stringify({ not: 'an array' }),
      [`${PREV_DIR}/memories.json`]: JSON.stringify({ not: 'an array' }),
    });
    const store = new HindsightStore(app);
    await store.ready();
    await migrateLegacyMemory(app, store, 5000);
    const memories = await store.listMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].text).toBe('Previous session: kept');
    expect(memories[0].createdAt).toBe(77);
  });

  await test('imported memories fall back per field and are re-sanitized', async () => {
    const { app } = createApp({
      [`${PREV_DIR}/memories.json`]: JSON.stringify([
        null,
        'str',
        { text: '   ' },
        { text: 5 },
        {
          text: ' Prefers dark mode ',
          type: 'bogus',
          bankId: '  ',
          source: { kind: 'nope', messageId: 'm1', action: 3 },
          entities: ['dark', 1],
          confidence: 'high',
          mentionedAt: 123,
          lastAccessedAt: 'x',
        },
      ]),
    });
    const store = new HindsightStore(app);
    await store.ready();
    await migrateLegacyMemory(app, store, 5000);
    const memories = await store.listMemories();
    expect(memories.length).toBe(1);
    const m = memories[0];
    expect(m.type).toBe('world');
    expect(m.bankId).toBe('default');
    expect(m.text).toBe('Prefers dark mode');
    expect(m.source).toEqual({ kind: 'manual', messageId: 'm1' });
    expect(m.entities).toEqual(['dark']);
    expect(m.confidence).toBe(0.7);
    expect(m.mentionedAt).toBe(123);
    expect(m.createdAt).toBe(5000);
    expect(m.lastAccessedAt).toBe(undefined);
  });

  await test('importPreviousMemoryFiles merges profiles and summaries without losing data', async () => {
    const { app, files } = createApp({
      [`${PREV_DIR}/user-profile.json`]: JSON.stringify({
        profession: 'Old job',
        expertise: ['Go'],
        workflows: [{ name: 'a', description: 'd', frequency: 1 }, { name: 'bad' }, null],
        metadata: { createdAt: 10, totalInteractions: 3 },
      }),
      [PROFILE]: JSON.stringify({ profession: 'New job', expertise: ['go', 'Rust'] }),
      [`${PREV_DIR}/session-summaries.json`]: JSON.stringify([
        null,
        { summary: 'old', timestamp: 1, extra: 'keep-me' },
        { summary: 'dup', timestamp: 5 },
      ]),
      [SUMMARIES]: JSON.stringify([{ summary: 'dup', timestamp: 5 }, { summary: 'new', timestamp: 9 }]),
    });
    const store = new HindsightStore(app);
    await store.ready();
    await importPreviousMemoryFiles(app, store, 5000);

    const profile = JSON.parse(files[PROFILE]) as Record<string, unknown>;
    expect(profile.profession).toBe('New job');
    expect(profile.expertise).toEqual(['Go', 'Rust']);
    expect(profile.workflows).toEqual([{ name: 'a', description: 'd', frequency: 1 }]);
    expect((profile.metadata as Record<string, unknown>).createdAt).toBe(10);

    const summaries = JSON.parse(files[SUMMARIES]) as Array<Record<string, unknown>>;
    expect(summaries.map((s) => s.summary)).toEqual(['new', 'dup', 'old']);
    expect(summaries[2].extra).toBe('keep-me');
  });

  await test('distill parsing keeps valid items and skips malformed array elements', async () => {
    const { app } = createApp();
    const generate = async () => JSON.stringify([
      { text: '用户偏好本地优先', entities: ['Baizer', 42] },
      '- 用户喜欢简洁回答',
      null,
      5,
      { text: 3 },
      { entities: ['x'] },
      { text: '用户的项目是 Baizer', entities: 'nope' },
    ]);
    const memory = new MemoryManager(app, { generate });
    await memory.ready();
    await memory.retainTurn({
      userMessage: '我偏好本地优先的存储方案',
      assistantMessage: 'ok',
      source: 'shell',
      now: 1000,
    });
    const store = new HindsightStore(app);
    await store.ready();
    const records = await store.listMemories();
    const first = records.find((r) => r.text === '用户偏好本地优先');
    expect(first?.entities).toEqual(['Baizer', '42']);
    expect(records.some((r) => r.text === '用户喜欢简洁回答')).toBe(true);
    const third = records.find((r) => r.text === '用户的项目是 Baizer');
    expect(Array.isArray(third?.entities)).toBe(true);
    expect(records.filter((r) => r.source.kind === 'chat').length).toBe(3);
  });

  await test('distill falls back to line parsing for non-JSON output', async () => {
    const { app } = createApp();
    const generate = async () => '- 用户偏好深色主题\n- a\n3. 用户的目标是发布';
    const memory = new MemoryManager(app, { generate });
    await memory.ready();
    await memory.retainTurn({
      userMessage: '我偏好深色主题',
      assistantMessage: 'ok',
      source: 'shell',
      now: 1000,
    });
    const store = new HindsightStore(app);
    await store.ready();
    const texts = (await store.listMemories()).map((r) => r.text);
    expect(texts.includes('用户偏好深色主题')).toBe(true);
    expect(texts.includes('用户的目标是发布')).toBe(true);
    expect(texts.includes('a')).toBe(false);
  });
}

void run();
