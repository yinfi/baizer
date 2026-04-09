// test/knowledge/registry.test.ts

import { KnowledgeRegistryManager } from '../../src/knowledge/registry';
import { KnowledgeRegistry, KnowledgeRegistryRecord } from '../../src/knowledge/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy but got ${actual}`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy but got ${actual}`); },
    toBeDefined: () => { if (actual === undefined) throw new Error(`Expected defined`); },
    toBeNull: () => { if (actual !== null) throw new Error(`Expected null but got ${actual}`); },
    toThrow: () => {
      let threw = false;
      try { actual(); } catch { threw = true; }
      if (!threw) throw new Error('Expected function to throw');
    }
  };
}

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    result.then(() => console.log(`  ✓ ${name}`))
      .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); });
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function createMockAdapter() {
  let storage: Record<string, string> = {};
  return {
    storage,
    exists: async (path: string) => path in storage,
    read: async (path: string) => {
      if (!(path in storage)) throw new Error('File not found');
      return storage[path];
    },
    write: async (path: string, data: string) => { storage[path] = data; },
    mkdir: async (path: string) => { /* no-op */ }
  };
}

console.log('=== Knowledge Registry Tests ===');

test('generateId produces ksrc_ prefixed IDs', () => {
  const id = KnowledgeRegistryManager.generateId();
  expect(id.startsWith('ksrc_')).toBeTruthy();
  expect(id.length > 10).toBeTruthy();
});

test('generateId produces unique IDs', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(KnowledgeRegistryManager.generateId());
  expect(ids.size).toBe(100);
});

test('empty registry initializes correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const all = mgr.getAllRecords();
  expect(Object.keys(all).length).toBe(0);
});

test('register creates a pending record', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('Clippings/test.md');
  expect(record.status).toBe('pending');
  expect(record.path).toBe('Clippings/test.md');
  expect(record.id.startsWith('ksrc_')).toBeTruthy();
  expect(record.summary_path).toBeNull();
  expect(record.error).toBeNull();
});

test('transition updates status correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('test.md');
  mgr.transition(record.id, 'processing');
  expect(mgr.getRecord(record.id)!.status).toBe('processing');
  mgr.transition(record.id, 'done');
  expect(mgr.getRecord(record.id)!.status).toBe('done');
});

test('invalid transition throws', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('test.md');
  expect(() => mgr.transition(record.id, 'done')).toThrow();
});

test('findByPath returns correct record', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  mgr.register('Clippings/a.md');
  mgr.register('Clippings/b.md');
  const found = mgr.findByPath('Clippings/a.md');
  expect(found).toBeDefined();
  expect(found!.path).toBe('Clippings/a.md');
});

test('getByStatus filters correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r1 = mgr.register('a.md');
  const r2 = mgr.register('b.md');
  mgr.transition(r1.id, 'processing');
  mgr.transition(r1.id, 'done');
  const pending = mgr.getByStatus('pending');
  expect(pending.length).toBe(1);
  expect(pending[0].path).toBe('b.md');
  const done = mgr.getByStatus('done');
  expect(done.length).toBe(1);
  expect(done[0].path).toBe('a.md');
});

test('resetProcessingOnStartup resets processing to pending', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r = mgr.register('test.md');
  mgr.transition(r.id, 'processing');
  mgr.resetProcessingOnStartup();
  expect(mgr.getRecord(r.id)!.status).toBe('pending');
});

test('save and load round-trip', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  mgr.register('test.md');
  await mgr.save();

  const mgr2 = new KnowledgeRegistryManager(adapter as any);
  await mgr2.load();
  const found = mgr2.findByPath('test.md');
  expect(found).toBeDefined();
  expect(found!.path).toBe('test.md');
});

test('updatePath changes record path', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r = mgr.register('old.md');
  mgr.updatePath(r.id, 'new.md');
  expect(mgr.getRecord(r.id)!.path).toBe('new.md');
  expect(mgr.findByPath('old.md')).toBeNull();
  expect(mgr.findByPath('new.md')).toBeDefined();
});

console.log('All registry tests passed!');
