import { App } from 'obsidian';
import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  tokenizeForRetrieval,
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
    remove: async (path: string) => { delete files[path]; },
    rename: async (from: string, to: string) => {
      files[to] = files[from];
      writes[to] = files[from];
      delete files[from];
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

  await test('migration imports the previous plugin memory directory', async () => {
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
      [`${previousMemoryDir}/memories.json`]: JSON.stringify([
        makeMemory({
          id: 'mem_previous_plugin',
          text: 'Previous plugin memory fact.',
          normalizedText: 'previous plugin memory fact.',
          mentionedAt: 20,
        }),
      ]),
    });
    const store = new HindsightStore(app);
    await store.ready();

    const { migrateLegacyMemory } = await import('../src/memory/hindsight-migration');
    await migrateLegacyMemory(app, store, 5000);

    const memories = await store.listMemories();
    expect(memories.some((memory) => memory.text.includes('Previous plugin engineer'))).toBe(true);
    expect(memories.some((memory) => memory.text.includes('Old summary.'))).toBe(true);
    expect(memories.some((memory) => memory.id === 'mem_previous_plugin')).toBe(true);
  });

  // ── tokenizeForRetrieval unit tests ──────────────────────────────────────

  await test('tokenizeForRetrieval expands CJK runs into overlapping bigrams', async () => {
    const tokens = tokenizeForRetrieval('记忆语义召回升级');
    // Expected bigrams: 记忆, 忆语, 语义, 义召, 召回, 回升, 升级
    expect(tokens).toContain('记忆');
    expect(tokens).toContain('召回');
    expect(tokens).toContain('语义');
    // Should NOT contain the full run as a single token
    expect(tokens.includes('记忆语义召回升级')).toBe(false);
  });

  await test('tokenizeForRetrieval keeps latin tokens and mixes with CJK bigrams', async () => {
    const tokens = tokenizeForRetrieval('记忆召回升级 baizer memory');
    expect(tokens).toContain('记忆');
    expect(tokens).toContain('召回');
    expect(tokens).toContain('baizer');
    expect(tokens).toContain('memory');
  });

  await test('tokenizeForRetrieval emits unigram for single CJK character', async () => {
    const tokens = tokenizeForRetrieval('我');
    expect(tokens.includes('我')).toBe(true);
    expect(tokens.length).toBe(1);
  });

  await test('tokenizeForRetrieval deduplicates repeated bigrams', async () => {
    const tokens = tokenizeForRetrieval('记忆记忆');
    const count = tokens.filter((t) => t === '记忆').length;
    expect(count).toBe(1);
  });

  // ── BM25 / Chinese multi-word recall tests ────────────────────────────────

  await test('retriever recalls CN memory via shared CJK bigrams (multi-word query)', async () => {
    // Document contains 「记忆语义召回升级」; query is 「记忆召回」.
    // Old tokenizer: doc token = ["记忆语义召回升级"], query token = ["记忆召回"] → 0 overlap → miss.
    // New bigram tokenizer: doc bigrams include 记忆, 召回; query bigrams include 记忆, 召回 → 2 overlaps → hit.
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_cn_recall',
        type: 'world',
        text: '用户正在开发记忆语义召回升级功能。',
        normalizedText: '用户正在开发记忆语义召回升级功能。',
        entities: ['记忆语义召回升级', 'baizer'],
        tags: ['项目'],
        confidence: 0.9,
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_cn_unrelated',
        type: 'experience',
        text: '用户今天讨论了午饭计划。',
        normalizedText: '用户今天讨论了午饭计划。',
        entities: ['午饭'],
        tags: ['聊天'],
        confidence: 0.7,
        mentionedAt: 2000,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({
      query: '记忆召回',
      maxRecords: 2,
      now: 3000,
    });

    // mem_cn_recall must be retrieved and ranked first
    expect(result.records.length >= 1).toBe(true);
    expect(result.records[0].id).toBe('mem_cn_recall');
    expect(result.promptBlock).toContain('记忆语义召回升级');
  });

  await test('retriever ranks CN memory with more bigram overlaps above less-relevant one', async () => {
    // Two CN memories; query shares more bigrams with the first.
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_cn_high',
        type: 'world',
        text: 'Baizer 的记忆召回模块使用 BM25 算法。',
        normalizedText: 'baizer 的记忆召回模块使用 bm25 算法。',
        entities: ['记忆召回', 'bm25'],
        tags: ['架构'],
        confidence: 0.85,
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_cn_low',
        type: 'world',
        text: '用户偏好简洁的回答风格。',
        normalizedText: '用户偏好简洁的回答风格。',
        entities: ['回答风格'],
        tags: ['偏好'],
        confidence: 0.85,
        mentionedAt: 1500,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({
      query: '记忆召回 BM25',
      maxRecords: 2,
      now: 3000,
    });

    expect(result.records[0].id).toBe('mem_cn_high');
  });

  await test('retriever BM25 scores unrelated CN record as 0 and excludes it', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_match',
        type: 'world',
        text: '项目采用本地优先的存储架构。',
        normalizedText: '项目采用本地优先的存储架构。',
        entities: ['本地优先', '存储架构'],
        tags: ['架构'],
        confidence: 0.9,
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_nomatch',
        type: 'world',
        text: '用户在周五参加了团队会议。',
        normalizedText: '用户在周五参加了团队会议。',
        entities: ['团队会议'],
        tags: ['日程'],
        confidence: 0.9,
        mentionedAt: 2000,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({
      query: '本地优先存储',
      maxRecords: 5,
      now: 3000,
    });

    // Only the matching record should survive the score > 0 filter
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('mem_match');
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

  await test('retriever renders negative memories as avoid lines', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemory(makeMemory({
      id: 'mem_lesson',
      type: 'observation',
      polarity: 'negative',
      text: '回答关于「部署流程」一类问题时,应避免:太啰嗦,要直接给结论',
      normalizedText: '回答关于「部署流程」一类问题时,应避免:太啰嗦,要直接给结论',
      entities: ['部署流程'],
      tags: ['feedback-lesson', '部署'],
      mentionedAt: 1000,
    }));

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({ query: '部署流程怎么做', now: 3000 });

    // 负面教训以「avoid:」前缀注入,直接约束模型生成。
    expect(result.promptBlock).toContain('avoid:');
    expect(result.promptBlock).toContain('要直接给结论');
  });

  await test('retriever boosts a negative lesson above a neutral record of equal relevance', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    // 两条文本相关度相当,仅极性不同:负面教训应因加权排在前面。
    await store.upsertMemories([
      makeMemory({
        id: 'mem_neutral',
        type: 'observation',
        text: '部署流程相关的中性记录内容',
        normalizedText: '部署流程相关的中性记录内容',
        entities: ['部署流程'],
        tags: ['部署'],
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_neg',
        type: 'observation',
        polarity: 'negative',
        text: '部署流程相关的应避免做法内容',
        normalizedText: '部署流程相关的应避免做法内容',
        entities: ['部署流程'],
        tags: ['部署'],
        mentionedAt: 1000,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({ query: '部署流程', maxRecords: 2, now: 3000 });

    expect(result.records[0].id).toBe('mem_neg');
  });

  // ---- 持久化健壮性(第1项)----

  await test('store writes atomically via tmp+rename (no direct write to main file)', async () => {
    const { app, files } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemory(makeMemory({ id: 'mem_atomic', text: 'Atomic write memory.' }));
    await store.flush();

    // 主文件存在且内容有效,tmp 已被 rename 消费掉(不残留)。
    const main = files['.obsidian/baizer-memory/memories.json'];
    expect(typeof main === 'string' && main.includes('Atomic write memory.')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(files, '.obsidian/baizer-memory/memories.json.tmp')).toBe(false);
  });

  await test('corrupted main file falls back to .bak instead of clearing', async () => {
    const memPath = '.obsidian/baizer-memory/memories.json';
    const bakPath = '.obsidian/baizer-memory/memories.json.bak';
    const goodRecord = makeMemory({ id: 'mem_bak', text: 'Backed up memory.' });
    const { app } = createApp({});
    // 预置:损坏的主文件 + 完好的 .bak。
    (app.vault.adapter as any).write(memPath, '{ this is corrupted json');
    (app.vault.adapter as any).write(bakPath, JSON.stringify([goodRecord]));

    const store = new HindsightStore(app);
    await store.ready();
    const memories = await store.listMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].id).toBe('mem_bak');
  });

  await test('corrupted main file with no backup enters read-only mode (does not overwrite)', async () => {
    const memPath = '.obsidian/baizer-memory/memories.json';
    const { app, files } = createApp({});
    (app.vault.adapter as any).write(memPath, '{ broken');

    const store = new HindsightStore(app);
    await store.ready();
    // 只读降级:写入被拒,损坏的原文件字节保持不变。
    await store.upsertMemory(makeMemory({ id: 'mem_x', text: 'should not persist' }));
    await store.flush();
    expect(files[memPath]).toBe('{ broken');
  });

  await test('bumpConsolidateCounter persists across store reloads', async () => {
    const { app, files } = createApp();
    const store1 = new HindsightStore(app);
    await store1.ready();
    await store1.bumpConsolidateCounter();
    await store1.bumpConsolidateCounter();

    // 用同一份磁盘(files)重建 store,计数应从 2 继续而非归零。
    const store2 = new HindsightStore(app);
    await store2.ready();
    const next = await store2.bumpConsolidateCounter();
    expect(next).toBe(3);
    expect(files['.obsidian/baizer-memory/migration-state.json'].includes('"consolidateTurnCounter": 3')).toBe(true);
  });

  await test('consolidator prefers LLM summary when generate is provided', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({ id: 'm1', type: 'world', text: 'User writes Obsidian plugins.', normalizedText: 'user writes obsidian plugins.', mentionedAt: 1000 }),
      makeMemory({ id: 'm2', type: 'experience', text: 'User debugged the memory layer today.', normalizedText: 'user debugged the memory layer today.', mentionedAt: 2000 }),
    ]);

    const { HindsightConsolidator } = await import('../src/memory/hindsight-consolidator');
    const generate = async () => 'User is a long-term Obsidian plugin developer focused on memory.';
    const consolidator = new HindsightConsolidator(store, generate);
    const created = await consolidator.consolidate({ now: 7000 });

    expect(created.length).toBe(1);
    expect(created[0].text).toContain('long-term Obsidian plugin developer');
  });

  // ---- 4b:一跳实体图检索 ----

  await test('graph recall surfaces an entity-sharing neighbor with zero lexical overlap', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      // 种子:命中查询 "TypeScript",共享实体 LaunchPad。
      makeMemory({
        id: 'mem_seed', type: 'world',
        text: 'Project LaunchPad uses TypeScript for config.',
        normalizedText: 'project launchpad uses typescript for config.',
        entities: ['LaunchPad', 'TypeScript'], tags: ['project'], mentionedAt: 2000,
      }),
      // 邻居:与查询零词法重叠,但共享实体 LaunchPad,应被图检索带出。
      makeMemory({
        id: 'mem_neighbor', type: 'experience',
        text: 'Deployment runs through GitHub Actions.',
        normalizedText: 'deployment runs through github actions.',
        entities: ['LaunchPad', 'GitHub Actions'], tags: ['chat'], mentionedAt: 1000,
      }),
      // 无关记录:不共享实体,不应被带出。
      makeMemory({
        id: 'mem_unrelated', type: 'experience',
        text: 'User discussed lunch plans.',
        normalizedText: 'user discussed lunch plans.',
        entities: ['lunch'], tags: ['chat'], mentionedAt: 1500,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);

    // 不开图检索:查询 TypeScript 只命中种子。
    const off = await retriever.recall({ query: 'TypeScript', maxRecords: 6, now: 3000 });
    const offIds = off.records.map((r) => r.id);
    expect(offIds.includes('mem_seed')).toBe(true);
    expect(offIds.includes('mem_neighbor')).toBe(false);

    // 开图检索:共享 LaunchPad 的邻居被带出,无关记录仍不出现。
    const on = await retriever.recall({ query: 'TypeScript', maxRecords: 6, now: 3000, graphRecall: true });
    const onIds = on.records.map((r) => r.id);
    expect(onIds.includes('mem_seed')).toBe(true);
    expect(onIds.includes('mem_neighbor')).toBe(true);
    expect(onIds.includes('mem_unrelated')).toBe(false);
    // 邻居排在种子之后(种子相关度更高)。
    expect(onIds.indexOf('mem_neighbor') > onIds.indexOf('mem_seed')).toBe(true);
  });

  await test('graph recall skips stop-entities shared by too many records', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    // 10 条记录都含实体 "Common";查询只命中 1 条种子。Common 命中率 100% > 30% → 停用,不带邻居。
    const records = [];
    for (let i = 0; i < 10; i += 1) {
      records.push(makeMemory({
        id: `mem_${i}`, type: 'experience',
        text: i === 0 ? 'Seed about zebra topic with Common.' : `Filler ${i} with Common.`,
        normalizedText: i === 0 ? 'seed about zebra topic with common.' : `filler ${i} with common.`,
        entities: ['Common'], tags: ['chat'], mentionedAt: 1000 + i,
      }));
    }
    await store.upsertMemories(records);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({ query: 'zebra', maxRecords: 6, now: 3000, graphRecall: true });
    // 只应有种子(zebra 命中),Common 是停用实体不带出任何邻居。
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('mem_0');
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
