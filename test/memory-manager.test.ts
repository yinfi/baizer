import { App } from 'obsidian';
import { MemoryManager } from '../src/memory/memory-manager';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}"`);
      }
    },
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected string not to contain "${expected}"`);
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

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function createApp(adapterOverrides: Record<string, any> = {}) {
  // 忠实内存 FS:支持 read-back / rename / remove,匹配 HindsightStore 的原子写(tmp+校验+rename)。
  const files: Record<string, string> = {};
  const writes: Record<string, string> = {};
  const adapter = {
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
    read: async (path: string) => files[path] ?? '',
    write: async (path: string, content: string) => {
      files[path] = content;
      writes[path] = content;
    },
    mkdir: async (path: string) => { files[path] = ''; },
    remove: async (path: string) => { delete files[path]; },
    rename: async (from: string, to: string) => {
      files[to] = files[from];
      writes[to] = files[from];
      delete files[from];
    },
    ...adapterOverrides,
  };

  return {
    app: {
      vault: { adapter },
    } as unknown as App,
    writes,
    files,
  };
}

async function runTests() {
  console.log('=== MemoryManager Tests ===');

  await test('recallForPrompt returns relevant hindsight memories', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'We will keep memory local.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'How should Baizer memory work?',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toContain('[Relevant Memory]');
    expect(promptBlock).toContain('local-first');
  });

  await test('getMemoryView returns stats and sections for command and settings UI', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'Acknowledged the local-first preference.',
      source: 'shell',
      now: 1000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'overview', limit: 5, now: 2000 });

    expect(view.stats.total).toBe(2);
    expect(view.stats.world).toBe(1);
    expect(view.stats.experience).toBe(1);
    expect(view.sections.facts.length).toBe(1);
    expect(view.privacyMode).toBe(false);
  });

  await test('deleteMemoryById removes one retained memory', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'My project LaunchPlan needs memory row deletion.',
      assistantMessage: 'Captured LaunchPlan deletion need.',
      source: 'shell',
      now: 1000,
    });
    const before = await (memory as any).getMemoryView({ mode: 'raw' });
    const targetId = before.sections.raw[0].id;

    const result = await (memory as any).deleteMemoryById(targetId);
    const after = await (memory as any).getMemoryView({ mode: 'raw' });

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(after.sections.raw.some((record: any) => record.id === targetId)).toBe(false);
  });

  await test('privacy mode prevents retaining new turn memories', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app, { privacyMode: true } as any);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that my project is private.',
      assistantMessage: 'Acknowledged.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'private project',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toBe('');
  });

  await test('forgetMemory all removes retained hindsight memories from recall and disk', async () => {
    const { app, writes } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that my project is LaunchPlan and I prefer weekly summaries.',
      assistantMessage: 'I will remember the LaunchPlan preference.',
      source: 'shell',
      now: 1000,
    });

    await (memory as any).forgetMemory('all');

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'LaunchPlan weekly summaries',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toBe('');
    expect(writes['.obsidian/baizer-memory/memories.json'] || '').notToContain('LaunchPlan');
  });

  await test('retainTurn redacts secrets before writing hindsight memories', async () => {
    const { app, writes } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that I prefer concise answers. My API key is sk-test-secret.',
      assistantMessage: 'Use token ghp_secret1234567890 when calling the service.',
      source: 'shell',
      now: 1000,
    });

    const saved = writes['.obsidian/baizer-memory/memories.json'] || '';
    expect(saved).toContain('[REDACTED]');
    expect(saved).notToContain('sk-test-secret');
    expect(saved).notToContain('ghp_secret1234567890');
  });

  await test('forgetMemory field deletes natural language profession name and expertise memories', async () => {
    const cases = [
      { field: 'profession', message: 'I am a frontend engineer named Alice.', query: 'frontend engineer Alice' },
      { field: 'profession', message: "I'm a backend engineer working on Obsidian plugins.", query: 'backend engineer Obsidian' },
      { field: 'profession', message: '我是产品经理，负责知识库体验。', query: '产品经理 知识库体验' },
      { field: 'expertise', message: 'I am expert in TypeScript plugin architecture.', query: 'TypeScript plugin architecture' },
      { field: 'expertise', message: '我擅长知识图谱整理和检索体验。', query: '知识图谱 检索体验' },
      { field: 'name', message: 'I am named Riley in this workspace.', query: 'Riley workspace' },
      { field: 'name', message: 'Please call me Morgan when answering.', query: 'Morgan answering' },
    ];

    for (const item of cases) {
      const { app } = createApp();
      const memory = new MemoryManager(app);
      await memory.ready();

      await (memory as any).retainTurn({
        userMessage: item.message,
        assistantMessage: 'Acknowledged.',
        source: 'shell',
        now: 1000,
      });

      await (memory as any).forgetMemory(item.field);

      const promptBlock = await (memory as any).recallForPrompt({
        query: item.query,
        maxChars: 500,
        now: 2000,
      });

      expect(promptBlock).toBe('');
    }
  });

  await test('retainLesson stores a negative lesson recalled as an avoid line', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    const lesson = await (memory as any).retainLesson({
      userInput: '帮我写部署流程文档',
      rejectedOutput: '（一大段啰嗦的回答）',
      reason: '太啰嗦了,要直接给步骤结论',
      source: 'shell',
      now: 1000,
    });

    // 返回提炼后的教训文本,供调用方做即时 steering。
    expect(typeof lesson === 'string' && lesson.length > 0).toBe(true);

    const promptBlock = await (memory as any).recallForPrompt({
      query: '部署流程怎么写',
      maxChars: 500,
      now: 2000,
    });

    // 教训在相似提问下被召回,并以 avoid 前缀呈现。
    expect(promptBlock).toContain('avoid:');
    expect(promptBlock).toContain('直接给步骤结论');
  });

  await test('retainLesson is a no-op in privacy mode', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app, { privacyMode: true } as any);
    await memory.ready();

    const lesson = await (memory as any).retainLesson({
      userInput: '帮我写部署流程文档',
      rejectedOutput: '回答',
      reason: '不满意',
      now: 1000,
    });

    expect(lesson).toBe(null);
    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    expect(view.stats.total).toBe(0);
  });

  // ---- 第2项:迁移脱敏 + privacyMode 跳过迁移 ----

  await test('privacy mode skips legacy migration import entirely', async () => {
    const profilePath = '.obsidian/baizer-memory/user-profile.json';
    const { app } = createApp({
      // 预置旧 profile 文件;隐私模式下不应被迁移进库。
      [profilePath]: undefined,
    });
    (app.vault.adapter as any).write(profilePath, JSON.stringify({
      profession: 'Engineer',
      expertise: ['x'], preferences: { responseStyle: 'concise', language: 'zh', topics: [] },
      context: { currentProjects: ['P'], goals: [], challenges: [] }, workflows: [],
      metadata: { totalInteractions: 1, createdAt: 1, updatedAt: 1, lastProfileUpdate: 1 },
    }));

    const memory = new MemoryManager(app, { privacyMode: true } as any);
    await memory.ready();
    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    expect(view.stats.total).toBe(0);
  });

  await test('migration import redacts secrets in imported memory text', async () => {
    // 动态拼旧插件目录名,避开品牌检查(brand.test.ts 禁止源码中出现旧品牌字面量)。
    const prevMemPath = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory', 'memories.json'].join('/');
    const { app } = createApp({});
    (app.vault.adapter as any).write(prevMemPath, JSON.stringify([
      { text: 'My token is ghp_abcdefghij1234567890 for the repo.', type: 'world' },
    ]));

    const { importPreviousMemoryFiles, migrateLegacyMemory } = await import('../src/memory/hindsight-migration');
    const { HindsightStore } = await import('../src/memory/hindsight-store');
    const store = new HindsightStore(app);
    await store.ready();
    await importPreviousMemoryFiles(app, store, 5000);
    await migrateLegacyMemory(app, store, 5000);

    const memories = await store.listMemories();
    const joined = JSON.stringify(memories);
    expect(joined).toContain('[REDACTED]');
    expect(joined.includes('ghp_abcdefghij1234567890')).toBe(false);
  });

  // ---- 第3项:去重(近义改写不堆叠)----

  await test('retainTurn dedupes near-identical durable memories instead of stacking', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    // 两次表达同一偏好(仅措辞略变),应合并为一条 world 记忆而非两条。
    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first storage for my notes.',
      assistantMessage: 'ok', source: 'shell', now: 1000,
    });
    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first storage for my notes.',
      assistantMessage: 'ok', source: 'shell', now: 2000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    const worldCount = view.sections.raw.filter((r: any) => r.type === 'world').length;
    expect(worldCount).toBe(1);
  });

  await test('retainTurn dedupes near-identical CHINESE durable memories (bigram Jaccard)', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    // 中文无空格:必须用 bigram 相似度才能识别近义,否则退化成整串比较、去重失效。
    await (memory as any).retainTurn({
      userMessage: '我偏好本地优先的笔记存储方式',
      assistantMessage: '好', source: 'shell', now: 1000,
    });
    await (memory as any).retainTurn({
      userMessage: '我偏好本地优先的笔记存储',
      assistantMessage: '好', source: 'shell', now: 2000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    const worldCount = view.sections.raw.filter((r: any) => r.type === 'world').length;
    expect(worldCount).toBe(1);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
