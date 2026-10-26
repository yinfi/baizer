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

/** 内存 VaultFileAdapter(与 cross-phase-smoke.test.ts 同模式),不碰真实磁盘。 */
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

async function runTests() {
  console.log('=== Session Store Branching Tests ===');
  const { SessionStore } = await import('../src/runtime/pi/session-store/store');

  await test('create() writes a fresh active Session with no entries', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');

    const session = await store.create('tab-1');

    expect(session.conversationId).toBe('tab-1');
    expect(session.availability).toBe('active');
    expect(session.activeLeafEntryId).toBe(null);

    const loaded = await store.load('tab-1');
    expect(loaded?.session.conversationId).toBe('tab-1');
    expect(loaded?.entries.length).toBe(0);
  });

  await test('appendEntry() creates a root entry and updates activeLeafEntryId', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');

    const root = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: null,
      payload: { text: 'hello' },
    });

    const loaded = await store.load('tab-1');
    expect(loaded?.session.activeLeafEntryId).toBe(root.id);
    expect(loaded?.entries.length).toBe(1);
    expect(loaded?.entries[0].parentEntryId).toBe(null);
  });

  await test('appendEntry() appends a child entry under an existing parent', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');
    const root = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: null,
      payload: { text: 'hello' },
    });

    const child = await store.appendEntry('tab-1', {
      kind: 'assistant_message',
      parentEntryId: root.id,
      payload: { text: 'hi there' },
    });

    const loaded = await store.load('tab-1');
    expect(loaded?.entries.length).toBe(2);
    expect(loaded?.session.activeLeafEntryId).toBe(child.id);
    const childEntry = loaded?.entries.find((e) => e.id === child.id);
    expect(childEntry?.parentEntryId).toBe(root.id);
  });

  await test('moveActiveLeaf() only changes the pointer, not any entry content (sibling switch)', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');
    const root = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: null,
      payload: { text: 'question A' },
    });
    const siblingA = await store.appendEntry('tab-1', {
      kind: 'assistant_message',
      parentEntryId: root.id,
      payload: { text: 'answer A' },
    });
    // 切回 root 后再新增一个兄弟分支(模拟分叉)。
    await store.moveActiveLeaf('tab-1', root.id);
    const siblingB = await store.appendEntry('tab-1', {
      kind: 'assistant_message',
      parentEntryId: root.id,
      payload: { text: 'answer B' },
    });

    const beforeSwitch = await store.load('tab-1');
    const switched = await store.moveActiveLeaf('tab-1', siblingA.id);
    const afterSwitch = await store.load('tab-1');

    expect(switched).toBe(true);
    expect(afterSwitch?.session.activeLeafEntryId).toBe(siblingA.id);
    // Entry 内容本身不受切换影响(只有指针变了)。
    expect(afterSwitch?.entries.length).toBe(beforeSwitch?.entries.length);
    const a = afterSwitch?.entries.find((e) => e.id === siblingA.id);
    const b = afterSwitch?.entries.find((e) => e.id === siblingB.id);
    expect(a?.payload).toEqual({ text: 'answer A' });
    expect(b?.payload).toEqual({ text: 'answer B' });
  });

  await test('moveActiveLeaf() returns false for a target entry that does not exist', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');

    const result = await store.moveActiveLeaf('tab-1', 'nonexistent-entry');

    expect(result).toBe(false);
  });

  await test('markSuperseded() creates a new entry and marks the original as superseded, without altering its payload', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');
    const original = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: null,
      payload: { text: 'original question' },
    });

    // 编辑产生新 Entry(挂在同一个 parent 下,与原 Entry 成为兄弟)。
    const edited = await store.appendEntry('tab-1', {
      kind: 'user_message',
      parentEntryId: original.parentEntryId,
      payload: { text: 'edited question' },
    });
    const marked = await store.markSuperseded('tab-1', original.id, edited.id);

    const loaded = await store.load('tab-1');
    const originalAfter = loaded?.entries.find((e) => e.id === original.id);
    const editedAfter = loaded?.entries.find((e) => e.id === edited.id);

    expect(marked).toBe(true);
    expect(originalAfter?.supersededByEntryId).toBe(edited.id);
    // 原 Entry 的 payload 保持不变(BR2.2:只写 supersededByEntryId,不改写其余内容)。
    expect(originalAfter?.payload).toEqual({ text: 'original question' });
    expect(editedAfter?.supersededByEntryId).toBe(null);
  });

  await test('appendEntry() forces the fixed visibility combination for approval_outcome entries', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');

    const entry = await store.appendEntry('tab-1', {
      kind: 'approval_outcome',
      parentEntryId: null,
      payload: { text: 'approved and executed' },
      // 故意传反的可见性组合,预期被强制覆盖为固定值(BR2.1)。
      visibleToModel: false,
      visibleToUiProjection: true,
    });

    expect(entry.visibleToModel).toBe(true);
    expect(entry.visibleToUiProjection).toBe(false);
  });

  await test('appendEntry() rejects new entries on a read_only_degraded session', async () => {
    const vault = createMemoryVault();
    const store = new SessionStore(vault.adapter as any, '.obsidian/baizer-sessions');
    await store.create('tab-1');
    await store.markDegraded('tab-1');

    let threw = false;
    try {
      await store.appendEntry('tab-1', {
        kind: 'user_message',
        parentEntryId: null,
        payload: { text: 'should not be written' },
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
