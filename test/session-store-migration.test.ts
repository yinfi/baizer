function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new Error(`Expected ${b} but got ${a}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

/** 内存 VaultFileAdapter(不碰真实磁盘)。 */
function createMemoryVault() {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const files = new Map<string, string>();
  return {
    files,
    adapter: {
      read: async (p: string) => { const n = norm(p); if (!files.has(n)) throw new Error('ENOENT ' + n); return files.get(n)!; },
      write: async (p: string, d: string) => { files.set(norm(p), d); },
      append: async (p: string, d: string) => { const n = norm(p); files.set(n, (files.get(n) || '') + d); },
      exists: async (p: string) => files.has(norm(p)),
      mkdir: async () => {},
      list: async () => ({ files: [], folders: [] }),
      remove: async (p: string) => { files.delete(norm(p)); },
    },
  };
}

const SESSIONS_ROOT = '.obsidian/baizer-sessions';
const SESSION_PATH = `${SESSIONS_ROOT}/tab-1.jsonl`;

/**
 * 旧格式（pi 0.75.5 JsonlSessionRepo，session version 3）的测试固件。
 * 结构依据该版本 dist/harness/session/jsonl-storage.js + session.js 的真实字节布局：
 * 首行 session header，其余每行一个 entry。
 *
 * 构造出的会话树：
 *   m1(user) ─ a1(assistant) ─ tlc(thinking_level_change) ─ m2(user) ─ a2(assistant)
 *                                     └ 元数据条目，迁移后不产生 Entry（用于验证重定父）
 *   另有：label 把 m2 标为 superseded、custom_message 审批回灌、leaf 指针回指 a1。
 */
function buildOldFormatSession(): string {
  const header = { type: 'session', version: 3, id: 'tab-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/' };
  const entries = [
    { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'first question' } },
    { type: 'message', id: 'a1', parentId: 'm1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'first answer' } },
    { type: 'thinking_level_change', id: 'tlc', parentId: 'a1', timestamp: '2026-01-01T00:00:03.000Z', thinkingLevel: 'medium' },
    { type: 'message', id: 'm2', parentId: 'tlc', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: 'second question' } },
    { type: 'message', id: 'm2b', parentId: 'tlc', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user', content: 'second question (retry)' } },
    { type: 'message', id: 'a2', parentId: 'm2b', timestamp: '2026-01-01T00:00:06.000Z', message: { role: 'assistant', content: 'second answer' } },
    { type: 'label', id: 'l1', parentId: 'a2', timestamp: '2026-01-01T00:00:07.000Z', targetId: 'm2', label: 'baizer:superseded' },
    { type: 'custom_message', id: 'c1', parentId: 'l1', timestamp: '2026-01-01T00:00:08.000Z', customType: 'approval_outcome', content: 'Approved: created Assets/a.canvas', display: false },
    { type: 'leaf', id: 'lf1', parentId: 'c1', timestamp: '2026-01-01T00:00:09.000Z', targetId: 'a1' },
  ];
  return [header, ...entries].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function runTests() {
  console.log('=== Session Store Migration Tests ===');
  const { SessionStore } = await import('../src/runtime/pi/session-store/store');
  const { detectFormat } = await import('../src/runtime/pi/session-store/migrate');

  await test('detectFormat() recognizes the new format by its structural feature', () => {
    const lines = [JSON.stringify({
      record: 'session_meta',
      session: { conversationId: 'tab-1', formatVersion: 1, createdAt: 'x', lastActivityAt: 'x', activeLeafEntryId: null, compactionState: null, availability: 'active' },
    })];
    expect(detectFormat(lines)).toBe('new');
  });

  await test('detectFormat() recognizes the old format by its structural feature', () => {
    expect(detectFormat(buildOldFormatSession().split('\n').filter((l) => l.trim()))).toBe('old');
  });

  await test('detectFormat() treats a corrupt file as unknown rather than guessing', () => {
    expect(detectFormat(['{ not json'])).toBe('unknown');
    expect(detectFormat(['{"some":"other"}'])).toBe('unknown');
    // 形状像旧 header 但 version 不符:既非新格式也非已知旧格式。
    expect(detectFormat([JSON.stringify({ type: 'session', version: 99, id: 'a', timestamp: 't', cwd: '/' })])).toBe('unknown');
  });

  await test('open() on a missing file creates a fresh active session', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const opened = await store.open('tab-1');

    expect(opened.session.availability).toBe('active');
    expect(opened.migrated).toBe(false);
    expect(opened.entries.length).toBe(0);
  });

  await test('open() on a new-format file parses it without migrating', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);
    await store.create('tab-1');
    await store.appendEntry('tab-1', { kind: 'user_message', parentEntryId: null, payload: { role: 'user', content: 'hi' } });

    const opened = await store.open('tab-1');

    expect(opened.migrated).toBe(false);
    expect(opened.session.availability).toBe('active');
    expect(opened.entries.length).toBe(1);
  });

  await test('open() migrates an old-format file in place and stays active', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const opened = await store.open('tab-1');

    expect(opened.migrated).toBe(true);
    expect(opened.session.availability).toBe('active');
    expect(opened.session.formatVersion).toBe(1);
    // 迁移后的文件必须自身通过新格式判定(否则下次打开会再次迁移)。
    const rewritten = vault.files.get(SESSION_PATH)!;
    const lines = rewritten.split('\n').filter((l) => l.trim());
    expect(detectFormat(lines)).toBe('new');
  });

  await test('migration preserves the message tree and re-parents around dropped metadata entries', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const { entries } = await store.open('tab-1');
    const byId = new Map(entries.map((e) => [e.id, e]));

    // 元数据条目(tlc / label / leaf)不产生 Entry。
    expect(byId.has('tlc')).toBe(false);
    expect(byId.has('l1')).toBe(false);
    expect(byId.has('lf1')).toBe(false);
    // 消息条目保留旧 id。
    expect(byId.has('m1')).toBe(true);
    expect(byId.has('m2b')).toBe(true);
    // m2 的旧 parentId 是 tlc(被丢弃) → 重定父到最近的存活祖先 a1。
    expect(byId.get('m2')?.parentEntryId).toBe('a1');
    expect(byId.get('m2b')?.parentEntryId).toBe('a1');
    expect(byId.get('a1')?.parentEntryId).toBe('m1');
    expect(byId.get('m1')?.parentEntryId).toBe(null);
    // 条目种类按 role 映射。
    expect(byId.get('m1')?.kind).toBe('user_message');
    expect(byId.get('a1')?.kind).toBe('assistant_message');
  });

  await test('migration folds the superseded label into supersededByEntryId', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const { entries } = await store.open('tab-1');
    const byId = new Map(entries.map((e) => [e.id, e]));

    // m2 被 label 标记作废,取代者是同 parentId 下时间更晚的 m2b。
    expect(byId.get('m2')?.supersededByEntryId).toBe('m2b');
    expect(byId.get('m2b')?.supersededByEntryId).toBe(null);
  });

  await test('migration rebuilds approval custom_message entries as approval_outcome with fixed visibility', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const { entries } = await store.open('tab-1');
    const approval = entries.find((e) => e.id === 'c1');

    expect(approval?.kind).toBe('approval_outcome');
    expect(approval?.visibleToModel).toBe(true);
    expect(approval?.visibleToUiProjection).toBe(false);
  });

  await test('migration folds the leaf entry into activeLeafEntryId', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const { session } = await store.open('tab-1');

    // 旧格式的 leaf 指针指向 a1。
    expect(session.activeLeafEntryId).toBe('a1');
  });

  await test('migrated session is writable and continues as a normal new-format session', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, buildOldFormatSession());
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);
    await store.open('tab-1');

    const appended = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: 'a1',
      payload: { role: 'user', content: 'after migration' },
    });
    const reopened = await store.open('tab-1');

    expect(reopened.migrated).toBe(false);
    expect(reopened.entries.some((e) => e.id === appended.id)).toBe(true);
  });

  await test('a corrupt file degrades to read-only instead of silently rebuilding an empty session', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, '{ this is not json at all');
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const opened = await store.open('tab-1');

    expect(opened.session.availability).toBe('read_only_degraded');
    // 原文件一个字节都没动。
    expect(vault.files.get(SESSION_PATH)).toBe('{ this is not json at all');
  });

  await test('a read-only degraded session rejects new entries', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, '{ this is not json at all');
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);
    await store.open('tab-1');

    let threw = false;
    try {
      await store.appendEntry('tab-1', { kind: 'user_message', parentEntryId: null, payload: {} });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(vault.files.get(SESSION_PATH)).toBe('{ this is not json at all');
  });

  await test('a migration failure in one session does not affect other sessions', async () => {
    const vault = createMemoryVault();
    vault.files.set(SESSION_PATH, '{ this is not json at all');
    vault.files.set(`${SESSIONS_ROOT}/tab-2.jsonl`, buildOldFormatSession().split('\n').map((l) => l.replace(/"tab-1"/g, '"tab-2"')).join('\n'));
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const broken = await store.open('tab-1');
    const healthy = await store.open('tab-2');

    expect(broken.session.availability).toBe('read_only_degraded');
    expect(healthy.session.availability).toBe('active');
    expect(healthy.migrated).toBe(true);
    expect(healthy.entries.length).toBe(6);
  });

  await test('an old-format file with an unknown entry type degrades to read-only and keeps the original bytes', async () => {
    const vault = createMemoryVault();
    const original = buildOldFormatSession() + JSON.stringify({
      type: 'something_new_and_unknown', id: 'x1', parentId: 'a1', timestamp: '2026-01-01T00:00:10.000Z',
    }) + '\n';
    vault.files.set(SESSION_PATH, original);
    const store = new SessionStore(vault.adapter as any, SESSIONS_ROOT);

    const opened = await store.open('tab-1');

    expect(opened.session.availability).toBe('read_only_degraded');
    expect(vault.files.get(SESSION_PATH)).toBe(original);
    // 只读降级仍允许查看历史:可映射的条目尽力读出。
    expect(opened.entries.length > 0).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
