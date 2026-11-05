function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toMatchObject: (expected: Record<string, any>) => {
      for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(actual?.[key]) !== JSON.stringify(value)) {
          throw new Error(`Expected property ${key} to be ${JSON.stringify(value)} but got ${JSON.stringify(actual?.[key])}`);
        }
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

class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();

  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, content: string) {
    this.files.set(path, content);
  }

  async mkdir(path: string) {
    this.folders.add(path);
  }
}

function createLog(OperationAuditLog: any, adapter = new FakeAdapter(), maxRecords = 100, extraOptions: any = {}) {
  return {
    adapter,
    log: new OperationAuditLog({ vault: { adapter } } as any, { maxRecords, ...extraOptions }),
  };
}

async function runTests() {
  console.log('=== OperationAuditLog Tests ===');
  const {
    OperationAuditLog,
    OPERATION_AUDIT_LOG_PATH,
  } = await import('../src/services/operation-audit-log');

  await test('returns an empty list when the audit log file does not exist', async () => {
    const { log } = createLog(OperationAuditLog);
    expect(await log.list()).toEqual([]);
  });

  await test('records approved operations with provider metadata', async () => {
    const realNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      const { adapter, log } = createLog(OperationAuditLog);
      await log.record({
        action: 'update_file',
        target: 'Docs/summary.md',
        approvalSource: 'user-click',
        provider: 'openai',
        model: 'gpt-4o',
        undoable: true,
      });

      const records = await log.list();
      expect(records.length).toBe(1);
      expect(records[0]).toMatchObject({
        action: 'update_file',
        target: 'Docs/summary.md',
        approvalSource: 'user-click',
        provider: 'openai',
        model: 'gpt-4o',
        undoable: true,
        timestamp: 1700000000000,
      });

      const stored = JSON.parse(adapter.files.get(OPERATION_AUDIT_LOG_PATH) || '{}');
      expect(stored.version).toBe(1);
      expect(stored.operations.length).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  await test('keeps the newest operations first and trims to the configured maximum', async () => {
    const realNow = Date.now;
    let now = 100;
    Date.now = () => now;

    try {
      const { log } = createLog(OperationAuditLog, new FakeAdapter(), 2);
      await log.record({
        action: 'create_note',
        target: 'One.md',
        approvalSource: 'direct-write',
        undoable: true,
      });
      now = 200;
      await log.record({
        action: 'update_note',
        target: 'Two.md',
        approvalSource: 'direct-write',
        undoable: true,
      });
      now = 300;
      await log.record({
        action: 'append_to_note',
        target: 'Three.md',
        approvalSource: 'direct-write',
        undoable: true,
      });

      const records = await log.list();
      expect(records.map((record: any) => record.target)).toEqual(['Three.md', 'Two.md']);
    } finally {
      Date.now = realNow;
    }
  });

  await test('persists approval request states across a restart (#76 P1/P2-B)', async () => {
    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;

    try {
      const { adapter, log } = createLog(OperationAuditLog);
      await log.beginRequest({ id: 'req-1', action: 'update_note', target: 'Docs/a.md' });
      expect((await log.getRequestState('req-1'))?.state).toBe('attempting');

      now = 1200;
      await log.finishRequest({
        id: 'req-1',
        action: 'update_note',
        target: 'Docs/a.md',
        outcome: 'succeeded',
        provider: 'openai',
        model: 'gpt-4o',
        undoable: true,
      });

      // 新实例 + 同一份底层文件 = 进程重启后重新读取。
      const restarted = new OperationAuditLog({ vault: { adapter } } as any, { maxRecords: 100 });
      const state = await restarted.getRequestState('req-1');
      expect({ state: state?.state, timestamp: state?.timestamp }).toEqual({
        state: 'succeeded',
        timestamp: 1000,
      });
      const operations = await restarted.list();
      expect(operations.length).toBe(1);
      expect(operations[0].outcome).toBe('succeeded');
      expect(operations[0].target).toBe('Docs/a.md');
    } finally {
      Date.now = realNow;
    }
  });

  await test('records failed attempts separately from successful executions (#76 P2-B)', async () => {
    const { log } = createLog(OperationAuditLog);
    await log.beginRequest({ id: 'req-fail', action: 'delete_note', target: 'Docs/a.md' });
    await log.finishRequest({
      id: 'req-fail',
      action: 'delete_note',
      target: 'Docs/a.md',
      outcome: 'attempt-failed',
      undoable: false,
    });

    expect((await log.getRequestState('req-fail'))?.state).toBe('attempt-failed');
    const records = await log.list();
    expect(records[0].outcome).toBe('attempt-failed');
  });

  await test('request states are capped and record the eviction watermark (#76 P2-B)', async () => {
    const realNow = Date.now;
    let now = 100;
    Date.now = () => now;

    try {
      const { log } = createLog(OperationAuditLog, new FakeAdapter(), 100, { maxRequests: 2 });
      await log.beginRequest({ id: 'req-old', action: 'create_note', target: 'a.md' });
      now = 200;
      await log.beginRequest({ id: 'req-mid', action: 'create_note', target: 'b.md' });
      now = 300;
      await log.beginRequest({ id: 'req-new', action: 'create_note', target: 'c.md' });

      expect(await log.getRequestState('req-old')).toBe(undefined);
      expect((await log.getRequestState('req-new'))?.state).toBe('attempting');
      // 水位 = 被淘汰的最晚请求时间，用来区分「从无记录」与「记录已过期」。
      expect(await log.getPrunedRequestBefore()).toBe(100);
    } finally {
      Date.now = realNow;
    }
  });

  await test('reads legacy version-1 files without request states', async () => {
    const adapter = new FakeAdapter();
    const legacy = {
      version: 1,
      operations: [{
        id: 'legacy-1',
        action: 'create_note',
        target: 'Old.md',
        timestamp: 1,
        approvalSource: 'direct-write',
        undoable: true,
      }],
    };
    adapter.files.set(OPERATION_AUDIT_LOG_PATH, JSON.stringify(legacy));
    const { log } = createLog(OperationAuditLog, adapter);
    expect((await log.list()).length).toBe(1);
    expect(await log.getRequestState('legacy-1')).toBe(undefined);
    expect(await log.getPrunedRequestBefore()).toBe(0);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
