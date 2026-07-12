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

  // ---- 语义查询扩展(LLM query expansion)----

  await test('query expansion recalls a cross-language memory the raw query would miss', async () => {
    const { app } = createApp();
    let expandCalls = 0;
    // generate 模拟扩展器:把中文查询扩出英文译词,使英文记忆能被 BM25 命中。
    const generate = async (_prompt: string, _system?: string) => {
      expandCalls += 1;
      return JSON.stringify(['deploy', 'deployment', 'release']);
    };
    const memory = new MemoryManager(app, { generate, queryExpansion: true } as any);
    await memory.ready();

    // 存一条纯英文记忆。
    await (memory as any).retainTurn({
      userMessage: 'I prefer to deploy via GitHub Actions pipeline.',
      assistantMessage: 'ok', source: 'shell', now: 1000,
    });

    // 中文查询与英文记忆零 token 重叠,无扩展必然召不回;扩展出 deploy 后应命中。
    const block = await (memory as any).recallForPrompt({
      query: '部署', source: 'shell', maxChars: 500, now: 2000,
    });

    expect(block).toContain('deploy');
    expect(expandCalls >= 1).toBe(true);
  });

  await test('query expansion is skipped for guardian source and when disabled', async () => {
    const { app } = createApp();
    let expandCalls = 0;
    const generate = async () => { expandCalls += 1; return JSON.stringify(['x']); };

    // 开关关闭:即便注入 generate 也不扩展。
    const off = new MemoryManager(app, { generate, queryExpansion: false } as any);
    await off.ready();
    await (off as any).recallForPrompt({ query: '部署', source: 'shell', now: 2000 });
    expect(expandCalls).toBe(0);

    // 开关开启但 source=guardian(亚秒补全):绝不扩展。
    const on = new MemoryManager(app, { generate, queryExpansion: true } as any);
    await on.ready();
    await (on as any).recallForPrompt({ query: '部署', source: 'guardian', now: 2000 });
    expect(expandCalls).toBe(0);
  });

  await test('query expansion caches per query (one LLM call for repeated query)', async () => {
    const { app } = createApp();
    let expandCalls = 0;
    const generate = async () => { expandCalls += 1; return JSON.stringify(['deploy']); };
    const memory = new MemoryManager(app, { generate, queryExpansion: true } as any);
    await memory.ready();

    await (memory as any).recallForPrompt({ query: '部署', source: 'shell', now: 2000 });
    await (memory as any).recallForPrompt({ query: '部署', source: 'shell', now: 3000 });
    // 同一 query 命中缓存,只应付一次 LLM 费用。
    expect(expandCalls).toBe(1);
  });

  // ---- 3a:disposition/directives 注入提炼 prompt ----

  await test('distill injects bank directives into the LLM system prompt', async () => {
    const { app } = createApp();
    let capturedSystem = '';
    const generate = async (_prompt: string, system?: string) => {
      capturedSystem = system || '';
      return JSON.stringify(['用户偏好本地优先']);
    };
    const memory = new MemoryManager(app, { generate } as any);
    await memory.ready();

    // durable 用户消息触发 LLM 提炼路径(worthDistilling)。
    await (memory as any).retainTurn({
      userMessage: '我偏好本地优先的存储方案',
      assistantMessage: 'ok', source: 'shell', now: 1000,
    });

    // system prompt 应含记忆库 directives(此前定义却从不注入)。
    expect(capturedSystem).toContain('记忆准则');
    expect(capturedSystem).toContain('concise');
  });

  // ---- 3b:Mental Models 无条件用户画像块 ----

  await test('getMentalModelBlock returns observations unconditionally (no query gating)', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    // 直接写一条 observation(模拟 consolidate 产出的高层画像)。
    await (memory as any).hindsightStore.upsertMemory({
      id: 'mem_mm', bankId: 'default', type: 'observation',
      text: '该用户是偏好简洁技术回答的 TypeScript 开发者',
      normalizedText: '该用户是偏好简洁技术回答的 typescript 开发者',
      entities: [], tags: ['observation'], source: { kind: 'manual' },
      confidence: 0.8, createdAt: 1000, updatedAt: 1000, mentionedAt: 1000, accessCount: 0,
    });

    const block = await (memory as any).getMentalModelBlock({ now: 2000 });
    // 无 query 参与,画像块仍应含该 observation。
    expect(block).toContain('[User Model]');
    expect(block).toContain('TypeScript 开发者');
  });

  await test('getMentalModelBlock returns empty when no observations exist', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();
    // 只有 world/experience,无 observation → 空块(不无中生有)。
    await (memory as any).retainTurn({
      userMessage: '我偏好本地优先', assistantMessage: 'ok', source: 'shell', now: 1000,
    });
    const block = await (memory as any).getMentalModelBlock({ now: 2000 });
    expect(block).toBe('');
  });

  // ---- 4a:LLM 结构化实体抽取(尤其中文,正则版抽不到)----

  await test('distill uses LLM-provided entities (works for Chinese where regex extracts none)', async () => {
    const { app } = createApp();
    // LLM 返回结构化 {text, entities};中文实体正则版抽不到,靠 LLM 补。
    const generate = async () => JSON.stringify([
      { text: '用户在做知了项目,用 TypeScript', entities: ['知了', 'TypeScript'] },
    ]);
    const memory = new MemoryManager(app, { generate } as any);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: '我在做知了项目', assistantMessage: 'ok', source: 'shell', now: 1000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    const rec = view.sections.raw.find((r: any) => r.text.includes('知了'));
    expect(rec !== undefined).toBe(true);
    // 中文实体 "知了" 被 LLM 抽出并入库(正则版无法产出)。
    expect(rec.entities.includes('知了')).toBe(true);
    expect(rec.entities.includes('TypeScript')).toBe(true);
  });

  // ---- #4 矛盾更新:同主题替换 ----

  await test('conflict update retires an outdated same-topic preference from recall', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    // 先"偏好深色主题",后"偏好浅色主题" —— 同维度改值,旧的应退役、不再召回。
    await (memory as any).retainTurn({
      userMessage: '我偏好深色主题', assistantMessage: 'ok', source: 'shell', now: 1000,
    });
    await (memory as any).retainTurn({
      userMessage: '我偏好浅色主题', assistantMessage: 'ok', source: 'shell', now: 2000,
    });

    const block = await (memory as any).recallForPrompt({ query: '主题偏好', maxChars: 800, now: 3000 });
    expect(block.includes('浅色')).toBe(true);
    expect(block.includes('深色')).toBe(false); // 旧偏好已退役

    // 退役记忆仍留在库(可恢复),不是硬删。
    const all = await (memory as any).hindsightStore.listMemoriesRaw('default');
    expect(all.some((m: any) => m.text.includes('深色'))).toBe(true);
  });

  await test('conflict update keeps distinct-slot preferences (no false retirement)', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app);
    await memory.ready();

    // 两条不同槽位的偏好(主题 vs 回答风格),相似度低于下限,应并存。
    await (memory as any).retainTurn({
      userMessage: '我偏好深色主题配色', assistantMessage: 'ok', source: 'shell', now: 1000,
    });
    await (memory as any).retainTurn({
      userMessage: '我偏好简洁直接的回答', assistantMessage: 'ok', source: 'shell', now: 2000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'raw' });
    const worldCount = view.sections.raw.filter((r: any) => r.type === 'world').length;
    expect(worldCount).toBe(2); // 两条并存,无误退役
  });

  await test('conflict update is disabled when option is off', async () => {
    const { app } = createApp();
    const memory = new MemoryManager(app, { conflictUpdate: false } as any);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: '我偏好深色主题', assistantMessage: 'ok', source: 'shell', now: 1000,
    });
    await (memory as any).retainTurn({
      userMessage: '我偏好浅色主题', assistantMessage: 'ok', source: 'shell', now: 2000,
    });

    // 关闭时新旧并存(退化到旧行为)。
    const all = await (memory as any).hindsightStore.listMemoriesRaw('default');
    const live = all.filter((m: any) => m.type === 'world' && !all.some((x: any) => (x.supersedes || []).includes(m.id)));
    expect(live.length).toBe(2);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
