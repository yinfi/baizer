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

function createLog(OperationAuditLog: any, adapter = new FakeAdapter(), maxRecords = 100) {
  return {
    adapter,
    log: new OperationAuditLog({ vault: { adapter } } as any, { maxRecords }),
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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
