// Session 持久化测试：用内存版 Vault adapter 驱动真实的 pi JsonlSessionStorage（经 JsonlSessionRepo），
// 断言多轮 append、buildPriorMessages、跨重启恢复、clear 开新会话、压缩摘要注入。

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
    toBeGreaterThan: (expected: number) => {
      if (!(actual > expected)) throw new Error(`Expected ${actual} > ${expected}`);
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

/** 内存版 Vault adapter：模拟 app.vault.adapter 的 read/write/append/exists/mkdir/list/remove。 */
function createMemoryAdapter() {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['']);
  return {
    files,
    dirs,
    async read(path: string): Promise<string> {
      if (!files.has(path)) throw new Error(`ENOENT: no such file ${path}`);
      return files.get(path)!;
    },
    async write(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async append(path: string, data: string): Promise<void> {
      files.set(path, (files.get(path) ?? '') + data);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path) || dirs.has(path);
    },
    async mkdir(path: string): Promise<void> {
      dirs.add(path);
    },
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
      const f: string[] = [];
      const folders: string[] = [];
      for (const key of files.keys()) {
        if (key.slice(0, key.lastIndexOf('/')) === path) f.push(key);
      }
      for (const d of dirs) {
        if (d && d.slice(0, d.lastIndexOf('/')) === path) folders.push(d);
      }
      return { files: f, folders };
    },
    async remove(path: string): Promise<void> {
      files.delete(path);
      dirs.delete(path);
    },
  };
}

async function runTests() {
  console.log('=== Session Persistence (JSONL via Vault API) Tests ===');
  const { SessionStore, mapContextToPriorMessages } = await import('../src/runtime/pi/session-store');

  await test('appends multiple turns and derives prior messages in order', async () => {
    const adapter = createMemoryAdapter();
    const store = new SessionStore(adapter);

    await store.appendTurn('first question', 'first answer');
    await store.appendTurn('second question', 'second answer');

    const prior = await store.buildPriorMessages();
    expect(prior).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'model', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'model', content: 'second answer' },
    ]);
  });

  await test('persists to a single JSONL file under the hidden sessions dir', async () => {
    const adapter = createMemoryAdapter();
    const store = new SessionStore(adapter);
    await store.appendTurn('q', 'a');

    const ref = store.getRef();
    expect(ref !== null).toBe(true);
    expect(ref!.path).toContain('.obsidian/baizer-sessions/');
    // header + user + assistant = 3 行非空 JSONL
    const content = adapter.files.get(ref!.path)!;
    const lines = content.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(3);
    // 首行是 session 头
    expect(JSON.parse(lines[0]).type).toBe('session');
  });

  await test('restores history across restart from persisted ref', async () => {
    const adapter = createMemoryAdapter();
    let savedRef: any = null;

    const store1 = new SessionStore(adapter, {
      loadRef: () => savedRef,
      saveRef: (ref) => {
        savedRef = ref;
      },
    });
    await store1.appendTurn('remembered question', 'remembered answer');
    expect(savedRef !== null).toBe(true);

    // 模拟重启：新 SessionStore 复用同一 adapter（=磁盘）与持久化的 ref。
    const store2 = new SessionStore(adapter, {
      loadRef: () => savedRef,
      saveRef: (ref) => {
        savedRef = ref;
      },
    });
    const prior = await store2.buildPriorMessages();
    expect(prior).toEqual([
      { role: 'user', content: 'remembered question' },
      { role: 'model', content: 'remembered answer' },
    ]);

    // 续写一轮，确认恢复后仍是同一文件累积。
    await store2.appendTurn('follow up', 'follow answer');
    const prior2 = await store2.buildPriorMessages();
    expect(prior2.length).toBe(4);
  });

  await test('clearSession starts a fresh empty session, keeping the old file on disk', async () => {
    const adapter = createMemoryAdapter();
    let savedRef: any = null;
    const store = new SessionStore(adapter, {
      loadRef: () => savedRef,
      saveRef: (ref) => {
        savedRef = ref;
      },
    });

    await store.appendTurn('old question', 'old answer');
    const oldRef = store.getRef()!;

    await store.clearSession();
    const newRef = store.getRef()!;

    expect(newRef.path === oldRef.path).toBe(false);
    // 旧文件仍在磁盘上（历史保留）
    expect(adapter.files.has(oldRef.path)).toBe(true);
    // 新会话历史为空
    const prior = await store.buildPriorMessages();
    expect(prior.length).toBe(0);
  });

  await test('falls back to a fresh session when the persisted ref points to a missing file', async () => {
    const adapter = createMemoryAdapter();
    // ref 指向不存在的文件 → ready 应降级新建而非抛错。
    const store = new SessionStore(adapter, {
      loadRef: () => ({
        id: 'ghost',
        path: '.obsidian/baizer-sessions/--/missing.jsonl',
        createdAt: new Date().toISOString(),
        cwd: '/',
      }),
      saveRef: () => undefined,
    });
    const prior = await store.buildPriorMessages();
    expect(prior.length).toBe(0);
    expect(store.getRef() !== null).toBe(true);
  });

  await test('serializes concurrent appends without corrupting JSONL', async () => {
    const adapter = createMemoryAdapter();
    const store = new SessionStore(adapter);
    await store.appendUserMessage('seed'); // 确保会话已建立

    // 并发发起多次 append，验证写入串行化、行数正确。
    await Promise.all([
      store.appendAssistantMessage('a1'),
      store.appendUserMessage('u2'),
      store.appendAssistantMessage('a2'),
      store.appendUserMessage('u3'),
    ]);

    const ref = store.getRef()!;
    const content = adapter.files.get(ref.path)!;
    const lines = content.split('\n').filter((l) => l.trim());
    // header + 5 条消息
    expect(lines.length).toBe(6);
    // 每一行都是合法 JSON（无交错损坏）
    for (const line of lines) {
      JSON.parse(line);
    }
  });

  await test('mapContextToPriorMessages folds compaction/branch summaries into user text', () => {
    const mapped = mapContextToPriorMessages([
      { role: 'compactionSummary', summary: 'earlier summary' } as any,
      { role: 'user', content: 'live question' } as any,
      { role: 'assistant', content: [{ type: 'text', text: 'live answer' }] } as any,
      { role: 'toolResult', content: [{ type: 'text', text: 'ignored tool' }] } as any,
      { role: 'branchSummary', summary: 'branch note' } as any,
    ]);
    expect(mapped).toEqual([
      { role: 'user', content: 'earlier summary' },
      { role: 'user', content: 'live question' },
      { role: 'model', content: 'live answer' },
      { role: 'user', content: 'branch note' },
    ]);
  });

  await test('appendCompaction persists a compaction view through buildContext', async () => {
    const adapter = createMemoryAdapter();
    const store = new SessionStore(adapter);
    await store.appendTurn('q1', 'a1');
    await store.appendTurn('q2', 'a2');

    // 取分支首个 entry 作为保留起点，写入压缩摘要。
    const branch = (await store.getBranchEntries()) as Array<{ id: string }>;
    const firstKept = branch[branch.length - 1].id;
    await store.appendCompaction('history summary', firstKept, 1234);

    const prior = await store.buildPriorMessages();
    // 压缩后：摘要作为前导 user 文本出现。
    expect(prior[0]).toEqual({ role: 'user', content: 'history summary' });
    expect(prior.length).toBeGreaterThan(0);
  });

  await test('appendTurn auto-compacts when context exceeds the window budget', async () => {
    const adapter = createMemoryAdapter();
    let summarizeCalls = 0;
    let lastPrompt = '';
    const store = new SessionStore(adapter, {
      // 极小的窗口确保第二轮后就越过 (window - reserveTokens) 阈值。
      contextWindow: () => 100,
      compactionSettings: { reserveTokens: 10, keepRecentTokens: 20 },
      summarize: async (prompt: string) => {
        summarizeCalls += 1;
        lastPrompt = prompt;
        return 'COMPACTED SUMMARY';
      },
    });

    // 写入足够长的几轮，累积上下文超过预算，触发自动压缩。
    const big = 'x'.repeat(2000);
    await store.appendTurn(`q1 ${big}`, `a1 ${big}`);
    await store.appendTurn(`q2 ${big}`, `a2 ${big}`);
    await store.appendTurn(`q3 ${big}`, `a3 ${big}`);

    // 真实一轮对话流程中，summarize 被调用（=压缩真正触发，而非占位能力）。
    expect(summarizeCalls).toBeGreaterThan(0);
    // 摘要 prompt 携带了被压缩的早期对话。
    expect(lastPrompt).toContain('<conversation>');

    // 派生历史里出现压缩摘要前导，证明压缩条目已落盘并经 buildContext 注入。
    const prior = await store.buildPriorMessages();
    const summaryInjected = prior.some(
      (m: { role: string; content: string }) => m.content.includes('COMPACTED SUMMARY'),
    );
    expect(summaryInjected).toBe(true);

    // 压缩条目已写入磁盘 JSONL（type: "compaction"）。
    const ref = store.getRef()!;
    const lines = adapter.files.get(ref.path)!.split('\n').filter((l) => l.trim());
    const hasCompactionEntry = lines.some((l) => {
      try {
        return JSON.parse(l).type === 'compaction';
      } catch {
        return false;
      }
    });
    expect(hasCompactionEntry).toBe(true);
  });

  await test('appendTurn never compacts when no contextWindow/summarize is wired', async () => {
    const adapter = createMemoryAdapter();
    // 没有 contextWindow/summarize：自动压缩关闭，行为与旧版一致。
    const store = new SessionStore(adapter);
    const big = 'y'.repeat(4000);
    await store.appendTurn(`q1 ${big}`, `a1 ${big}`);
    await store.appendTurn(`q2 ${big}`, `a2 ${big}`);

    const ref = store.getRef()!;
    const lines = adapter.files.get(ref.path)!.split('\n').filter((l) => l.trim());
    const hasCompactionEntry = lines.some((l) => {
      try {
        return JSON.parse(l).type === 'compaction';
      } catch {
        return false;
      }
    });
    expect(hasCompactionEntry).toBe(false);
  });

  console.log('All session-store tests passed.');
}

runTests();

