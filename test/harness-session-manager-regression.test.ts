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

const SESSIONS_ROOT = '.obsidian/baizer-sessions';

/**
 * 旧格式（pi 0.75.5 JsonlSessionRepo，session version 3）固件，与
 * session-store-migration.test.ts 同源。会话树：
 *   m1(user) ─ a1(assistant) ─ tlc(元数据) ─ m2(user, 被 label 作废) ─ a2(assistant)
 *                                            └ m2b(user, 重试的新兄弟)
 *   custom_message(审批回灌) / leaf(回指 a1)
 */
function buildOldFormatSession(sessionId: string): string {
  const header = { type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/' };
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

/**
 * 构造一套「插件运行环境」：内存 vault + 持久化 ref 表（模拟 settings.sessionRefs）。
 * 换一个 manager 实例但复用同一 vault 与 ref 表，即等价于「插件重启」。
 */
async function buildEnv(seed: Record<string, string> = {}) {
  const { createInMemoryVaultAdapter } = await import('../src/runtime/pi/session-store/memory-adapter');
  const { HarnessSessionManager } = await import('../src/runtime/pi/harness-session-manager');
  const adapter = createInMemoryVaultAdapter(seed);
  const refs = new Map<string, any>();
  const build = (options: {
    contextWindow?: () => number;
    compactionSettings?: any;
    summarize?: (prompt: string) => Promise<string>;
  } = {}) =>
    new HarnessSessionManager(adapter as any, {
      sessionsRoot: SESSIONS_ROOT,
      loadRef: (cid: string) => refs.get(cid) ?? null,
      saveRef: (cid: string, ref: any) => { if (ref) refs.set(cid, ref); else refs.delete(cid); },
      contextWindow: options.contextWindow,
      compactionSettings: options.compactionSettings,
      summarize: options.summarize,
    });
  return { adapter, refs, build };
}

/**
 * 追加一条 user 消息 + 一条 assistant 回复（可带真实 usage，供压缩判定用）。
 * payload 按生产路径的真实形态构造：落盘的就是 pi 消息对象本身,assistant/toolResult 的
 * content 是 block 数组(pi 的 AssistantMessage 类型要求),user 的 content 允许纯字符串。
 */
async function appendTurn(
  session: any,
  question: string,
  answer: string,
  usage?: { totalTokens: number },
) {
  const user = await session.append({
    kind: 'user_message',
    parentEntryId: session.getActiveLeafEntryId(),
    payload: { role: 'user', content: question },
  });
  const assistant = await session.append({
    kind: 'assistant_message',
    parentEntryId: user.id,
    payload: { role: 'assistant', content: [{ type: 'text', text: answer }], usage, stopReason: 'stop' },
  });
  return { user, assistant };
}

/** 把一条消息的 content 折叠成纯文本,供断言用(content 可能是字符串或 block 数组)。 */
function textOf(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('');
  }
  return '';
}

async function runTests() {
  console.log('=== Harness Session Manager Regression Tests ===');

  await test('per-conversation isolation: each tab gets its own file and its own context', async () => {
    const env = await buildEnv();
    const manager = env.build();

    const a = await manager.getSession('tab-a');
    await appendTurn(a, 'ALPHA question', 'alpha answer');
    const b = await manager.getSession('tab-b');
    await appendTurn(b, 'BETA question', 'beta answer');

    // 两个会话各自的跨轮上下文互不可见。
    const aMessages = await a.buildModelMessages();
    const bMessages = await b.buildModelMessages();
    expect(aMessages.map(textOf).join('|')).toBe('ALPHA question|alpha answer');
    expect(bMessages.map(textOf).join('|')).toBe('BETA question|beta answer');

    // 各自独立落盘、路径不同。
    const refA = manager.getRef('tab-a')!;
    const refB = manager.getRef('tab-b')!;
    expect(refA.path).toBe(`${SESSIONS_ROOT}/tab-a.jsonl`);
    expect(refB.path).toBe(`${SESSIONS_ROOT}/tab-b.jsonl`);
    expect(await env.adapter.exists(refA.path)).toBe(true);
    expect(await env.adapter.exists(refB.path)).toBe(true);
    // 临时会话不落盘、不留 ref。
    expect(manager.getRef()).toBe(null);
  });

  await test('cross-restart recovery: a new manager instance reopens the persisted branch', async () => {
    const env = await buildEnv();
    const first = env.build();
    const session = await first.getSession('tab-1');
    const { user, assistant } = await appendTurn(session, 'persisted question', 'persisted answer');
    const leafBefore = session.getActiveLeafEntryId();

    // 模拟插件重启：同一 vault + 同一 ref 表，全新的 manager。
    const second = env.build();
    const reopened = await second.getSession('tab-1');
    const branch = await reopened.getBranch();

    expect(branch.map((e) => e.id)).toEqual([user.id, assistant.id]);
    expect(reopened.getActiveLeafEntryId()).toBe(leafBefore);
    expect(await second.hasHistory('tab-1')).toBe(true);
    expect(await reopened.hasHistory()).toBe(true);
  });

  await test('hasHistory is false for a fresh conversation and for ephemeral sessions', async () => {
    const env = await buildEnv();
    const manager = env.build();

    expect(await manager.hasHistory('brand-new')).toBe(false);
    expect(await manager.hasHistory(undefined)).toBe(false);
    // 临时会话每次全新（无跨轮上下文）。
    const ephemeral = await manager.getSession(undefined);
    await appendTurn(ephemeral, 'ephemeral question', 'ephemeral answer');
    const anotherEphemeral = await manager.getSession(undefined);
    expect(await anotherEphemeral.hasHistory()).toBe(false);
  });

  await test('approval outcome is visible to the model but not to the UI projection (BR2.1)', async () => {
    const { projectBranchToMessages } = await import('../src/runtime/pi/session-branch-projector');
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    await appendTurn(session, 'create a canvas', 'needs approval');

    await manager.appendApprovalOutcome('tab-1', 'Approved: created Assets/a.canvas');

    // 模型可见：计入发往模型的消息序列。
    const messages = await session.buildModelMessages();
    expect(messages.length).toBe(3);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('Approved: created Assets/a.canvas');

    // UI 不可见：不出现在分支投影里（不会多出一个假气泡）。
    const { branch, all } = await manager.getBranchEntries('tab-1');
    const projected = projectBranchToMessages(branch as any, all as any);
    expect(projected.map((m) => m.content).join('|')).toBe('create a canvas|needs approval');
    // 但 Entry 本身在会话里，且可见性组合是固定值。
    const outcome = all.find((e) => e.kind === 'approval_outcome')!;
    expect(outcome.visibleToModel).toBe(true);
    expect(outcome.visibleToUiProjection).toBe(false);
  });

  await test('maybeCompact skips when the window is unset, disabled, or not larger than the reserve', async () => {
    const cases: Array<{ label: string; contextWindow?: () => number; compactionSettings?: any }> = [
      { label: 'no window', contextWindow: undefined },
      { label: 'zero window', contextWindow: () => 0 },
      { label: 'window <= reserve', contextWindow: () => 50 },
      { label: 'compaction disabled', contextWindow: () => 100000, compactionSettings: { enabled: false } },
    ];
    for (const c of cases) {
      const env = await buildEnv();
      let calls = 0;
      const manager = env.build({
        contextWindow: c.contextWindow,
        compactionSettings: c.compactionSettings,
        summarize: async () => { calls++; return 'summary'; },
      });
      const session = await manager.getSession('tab-1');
      await appendTurn(session, 'q', 'a', { totalTokens: 999999 });

      await manager.maybeCompact('tab-1');
      expect(calls).toBe(0);
    }
  });

  await test('maybeCompact folds the old turn into a summary exactly when the real usage crosses the threshold', async () => {
    // 阈值 = window - reserveTokens(16384)；取 window = 16384 + 300 → 阈值 300。
    const contextWindow = 16384 + 300;

    // 未越阈值：真实 usage 100 < 300 → 不压缩。
    const below = await buildEnv();
    let belowCalls = 0;
    const belowManager = below.build({ contextWindow: () => contextWindow, summarize: async () => { belowCalls++; return 's'; } });
    const belowSession = await belowManager.getSession('tab-1');
    await appendTurn(belowSession, 'q', 'a', { totalTokens: 100 });
    await belowManager.maybeCompact('tab-1');
    expect(belowCalls).toBe(0);

    // 越过阈值：真实 usage 500 > 300 → 折叠一次,原 Entry 保留、只是不再发往模型。
    const above = await buildEnv();
    let aboveCalls = 0;
    const aboveManager = above.build({
      contextWindow: () => contextWindow,
      // keepRecentTokens 设小一点,确保本轮(问+答)落在「可折叠的旧内容」里,便于断言。
      compactionSettings: { keepRecentTokens: 1 },
      summarize: async (prompt) => { aboveCalls++; expect(prompt.includes('old question')).toBe(true); return 'SUMMARY_TEXT'; },
    });
    const aboveSession = await aboveManager.getSession('tab-1');
    const oldTurn = await appendTurn(aboveSession, 'old question', 'old answer', { totalTokens: 500 });
    await aboveManager.maybeCompact('tab-1');
    expect(aboveCalls).toBe(1);

    // 原 Entry 还在存储里(UI 历史不受影响),只是 visibleToModel 被翻成 false。
    const { all } = await aboveManager.getBranchEntries('tab-1');
    const oldUser = all.find((e) => e.id === oldTurn.user.id)!;
    expect(oldUser.visibleToModel).toBe(false);
    expect(oldUser.payload).toEqual({ role: 'user', content: 'old question' });
    // 模型可见消息 = 摘要 + 保留的最新一条。
    // pickCompactionCutoff 的 `kept > 0` 守卫保证**至少保留最新一条消息**逐字可见
    // (对齐 pi 0.75.5 的 compact():摘要之后必须仍有真实上下文,否则模型只剩一段摘要)。
    // 故 keepRecentTokens=1 时被折叠的是较旧的 user 消息,最新的 assistant 回答原样保留。
    const messages = await aboveSession.buildModelMessages();
    expect(textOf(messages[0])).toBe('old answer');
    expect(messages[1].content).toBe('SUMMARY_TEXT');
    expect(messages.length).toBe(2);

    // 临时会话与未建立的会话都不压缩。
    let strayCalls = 0;
    const strayManager = above.build({ contextWindow: () => contextWindow, summarize: async () => { strayCalls++; return 's'; } });
    await strayManager.maybeCompact(undefined);
    await strayManager.maybeCompact('never-opened');
    expect(strayCalls).toBe(0);
  });

  await test('maybeCompact degrades loudly, not silently, when no summarize() is configured', async () => {
    // 能力缺口的兜底:判定逻辑仍须自洽——越阈值时不得抛错,也不得静默当作已压缩。
    const env = await buildEnv();
    const manager = env.build({ contextWindow: () => 16384 + 300 }); // 未提供 summarize
    const session = await manager.getSession('tab-1');
    await appendTurn(session, 'q', 'a', { totalTokens: 500 });

    await manager.maybeCompact('tab-1'); // 不应抛错
    // 未执行动作:Entry 可见性不变。
    const { all } = await manager.getBranchEntries('tab-1');
    expect(all.every((e) => e.visibleToModel)).toBe(true);
  });

  await test('a legacy pi-format file referenced by a saved ref is migrated on first open (BR1.2)', async () => {
    const legacyPath = `${SESSIONS_ROOT}/session-legacy-abc.jsonl`;
    const env = await buildEnv({ [legacyPath]: buildOldFormatSession('session-legacy-abc') });
    env.refs.set('tab-1', { id: 'session-legacy-abc', path: legacyPath, createdAt: '2026-01-01T00:00:00.000Z', cwd: '/' });
    const manager = env.build();

    const { branch, all } = await manager.getBranchEntries('tab-1');

    // 迁移后：活跃分支 = 旧 leaf 指向的 m1 → a1；历史可读。
    expect(branch.map((e) => e.kind)).toEqual(['user_message', 'assistant_message']);
    expect(await manager.getAvailability('tab-1')).toBe('active');
    // 审批回灌被重建为显式的 approval_outcome 种类（BR1.2 4b）。
    expect(all.some((e) => e.kind === 'approval_outcome')).toBe(true);
    // 内容落到规范路径，旧文件被消费掉（内容已迁移，不留孤儿）。
    expect(await env.adapter.exists(`${SESSIONS_ROOT}/tab-1.jsonl`)).toBe(true);
    expect(await env.adapter.exists(legacyPath)).toBe(false);
    // 迁移后仍是可写的普通新格式会话。
    const session = await manager.getSession('tab-1');
    await appendTurn(session, 'after migration', 'ok');
    expect((await session.buildModelMessages()).length).toBe(4);
  });

  await test('a corrupt legacy file degrades that conversation only, keeping the original bytes (BR1.3)', async () => {
    const legacyPath = `${SESSIONS_ROOT}/session-broken.jsonl`;
    const corrupt = '{ this is not json\n';
    const env = await buildEnv({ [legacyPath]: corrupt });
    env.refs.set('broken-tab', { id: 'session-broken', path: legacyPath, createdAt: 'x', cwd: '/' });
    const manager = env.build();

    // 只读降级：可读历史（这里无历史可读），拒绝新 Entry。
    expect(await manager.getAvailability('broken-tab')).toBe('read_only_degraded');
    expect(await manager.getBranchEntries('broken-tab')).toEqual({ branch: [], all: [] });
    let threw = false;
    try {
      await (await manager.getSession('broken-tab')).append({
        kind: 'user_message',
        parentEntryId: null,
        payload: { content: 'must not be written' },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 原文件零写入，且不生成空的规范文件（不静默重建空会话）。
    expect(await env.adapter.read(legacyPath)).toBe(corrupt);
    expect(await env.adapter.exists(`${SESSIONS_ROOT}/broken-tab.jsonl`)).toBe(false);

    // 不影响其他会话（BR1.3 4d）。
    const healthy = await manager.getSession('healthy-tab');
    await appendTurn(healthy, 'unaffected', 'still works');
    expect(await manager.getAvailability('healthy-tab')).toBe('active');
    expect(await healthy.hasHistory()).toBe(true);
  });

  await test('clear resets the conversation in place and refuses on a degraded session', async () => {
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    await appendTurn(session, 'question to be cleared', 'answer to be cleared');
    expect(await manager.hasHistory('tab-1')).toBe(true);

    await manager.clear('tab-1');

    const reopened = await manager.getSession('tab-1');
    expect(await reopened.hasHistory()).toBe(false);
    expect((await manager.getBranchEntries('tab-1')).branch.length).toBe(0);

    // 只读降级会话不重置（BR1.3 要求原文件零写入）。
    const legacyPath = `${SESSIONS_ROOT}/session-keep.jsonl`;
    const bytes = buildOldFormatSession('session-keep');
    const degradedEnv = await buildEnv({ [legacyPath]: bytes });
    degradedEnv.refs.set('keep-tab', { id: 'session-keep', path: legacyPath, createdAt: 'x', cwd: '/' });
    const degradedManager = degradedEnv.build();
    // 构造一个「旧格式但迁移失败」的降级会话：内容为新格式头部但版本号非法。
    const badNewFormat = JSON.stringify({ record: 'session_meta', session: { conversationId: 'keep-tab' } }) + '\n';
    await degradedEnv.adapter.write(`${SESSIONS_ROOT}/keep-tab.jsonl`, badNewFormat);
    expect(await degradedManager.getAvailability('keep-tab')).toBe('read_only_degraded');
    await degradedManager.clear('keep-tab');
    expect(await degradedEnv.adapter.read(`${SESSIONS_ROOT}/keep-tab.jsonl`)).toBe(badNewFormat);
  });

  await test('purge removes the canonical file, the legacy file, and the persisted ref', async () => {
    const legacyPath = `${SESSIONS_ROOT}/session-legacy-purge.jsonl`;
    const env = await buildEnv({ [legacyPath]: buildOldFormatSession('session-legacy-purge') });
    env.refs.set('tab-1', { id: 'session-legacy-purge', path: legacyPath, createdAt: 'x', cwd: '/' });
    const manager = env.build();

    await manager.purge('tab-1');

    expect(await env.adapter.exists(legacyPath)).toBe(false);
    expect(await env.adapter.exists(`${SESSIONS_ROOT}/tab-1.jsonl`)).toBe(false);
    expect(env.refs.has('tab-1')).toBe(false);
    expect(manager.getRef('tab-1')).toBe(null);
  });

  await test('retry supersedes the old branch so no switchable sibling accumulates', async () => {
    const { projectBranchToMessages } = await import('../src/runtime/pi/session-branch-projector');
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    const first = await appendTurn(session, 'Q retry', 'answer#0');

    // 重试：作废旧问答 → 定位到该 user 之前 → 重跑（新 user 成为兄弟）。
    expect(await manager.supersedeUserEntry('tab-1', first.user.id)).toBe(true);
    expect(await manager.prepareForkAtUser('tab-1', first.user.id)).toBe(true);
    await appendTurn(session, 'Q retry', 'answer#1');

    const { branch, all } = await manager.getBranchEntries('tab-1');
    const projected = projectBranchToMessages(branch as any, all as any);
    const users = projected.filter((m) => m.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0].content).toBe('Q retry');
    // 有效兄弟只剩 1 条 → 不显示 < n/m >。
    expect(users[0].branch).toBe(undefined);
    expect(projected.map((m) => m.content).join('|')).toBe('Q retry|answer#1');
  });

  await test('fork without supersede keeps both branches switchable, and switching rewrites no entry', async () => {
    const { projectBranchToMessages } = await import('../src/runtime/pi/session-branch-projector');
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    const first = await appendTurn(session, 'Q original', 'answer#0');

    // 分叉/编辑：不作废 → 新问答与原问答成为可切换的兄弟。
    expect(await manager.prepareForkAtUser('tab-1', first.user.id)).toBe(true);
    await appendTurn(session, 'Q edited', 'answer#1');

    let { branch, all } = await manager.getBranchEntries('tab-1');
    let projected = projectBranchToMessages(branch as any, all as any);
    const editedUser = projected.find((m) => m.role === 'user')!;
    expect(editedUser.content).toBe('Q edited');
    expect(editedUser.branch!.count).toBe(2);

    const beforeSwitch = JSON.stringify(all);
    const originalLeaf = editedUser.branch!.leafIds[0];
    expect(await manager.moveToBranch('tab-1', originalLeaf)).toBe(true);

    ({ branch, all } = await manager.getBranchEntries('tab-1'));
    projected = projectBranchToMessages(branch as any, all as any);
    expect(projected.map((m) => m.content).join('|')).toBe('Q original|answer#0');
    // BR2.2：切换只改指针，不改写任何 Entry 内容。
    expect(JSON.stringify(all)).toBe(beforeSwitch);
  });

  await test('branch primitives reject non-existent entries and non-user entries', async () => {
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    const turn = await appendTurn(session, 'q', 'a');

    expect(await manager.moveToBranch('tab-1', 'no-such-entry')).toBe(false);
    expect(await manager.prepareForkAtUser('tab-1', 'no-such-entry')).toBe(false);
    expect(await manager.supersedeUserEntry('tab-1', 'no-such-entry')).toBe(false);
    // assistant entry 不是分叉/作废的合法目标。
    expect(await manager.prepareForkAtUser('tab-1', turn.assistant.id)).toBe(false);
    expect(await manager.supersedeUserEntry('tab-1', turn.assistant.id)).toBe(false);
  });

  await test('release drops only the in-memory handle; the file and ref survive', async () => {
    const env = await buildEnv();
    const manager = env.build();
    const session = await manager.getSession('tab-1');
    await appendTurn(session, 'q', 'a');

    manager.release('tab-1');

    // 内存态已释放（ref 取自 Map），但磁盘文件仍在，重开后历史完整。
    expect(manager.getRef('tab-1')).toBe(null);
    expect(await env.adapter.exists(`${SESSIONS_ROOT}/tab-1.jsonl`)).toBe(true);
    const reopened = await manager.getSession('tab-1');
    expect((await reopened.buildModelMessages()).length).toBe(2);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
