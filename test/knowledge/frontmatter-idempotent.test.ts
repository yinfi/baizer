// test/knowledge/frontmatter-idempotent.test.ts
// 验证 setKnowledgeStatus 幂等：字段已是目标值时不写盘，避免无谓 touch mtime

import { TFile } from 'obsidian';
import { setKnowledgeStatus } from '../../src/knowledge/frontmatter';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = 'md';
  return file;
}

/** 构造一个记录写次数的 app mock */
function makeApp(frontmatter: Record<string, any>) {
  const file = createFile('Clippings/a.md');
  let writeCount = 0;
  const app = {
    metadataCache: {
      getFileCache: (f: TFile) => f.path === file.path ? { frontmatter } : null,
    },
    fileManager: {
      processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => {
        writeCount++;
        cb(frontmatter);
      },
    },
  } as any;
  return { app, file, get writeCount() { return writeCount; } };
}

console.log('=== Frontmatter Idempotency Tests ===');

async function runTests() {
  await test('skips write when all target fields already match', async () => {
    const ctx = makeApp({
      knowledge_status: 'done',
      knowledge_source_id: 'ksrc_x',
      knowledge_compiled_at: '2026-06-30T08:00:00Z',
      knowledge_summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    await setKnowledgeStatus(ctx.app, ctx.file, 'done', {
      source_id: 'ksrc_x',
      compiled_at: '2026-06-30T08:00:00Z',
      summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    expect(ctx.writeCount).toBe(0);
  });

  await test('writes when status differs', async () => {
    const ctx = makeApp({ knowledge_status: 'pending' });
    await setKnowledgeStatus(ctx.app, ctx.file, 'done', {
      source_id: 'ksrc_x',
      compiled_at: '2026-06-30T08:00:00Z',
      summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    expect(ctx.writeCount).toBe(1);
    expect(ctx.app.metadataCache.getFileCache(ctx.file).frontmatter.knowledge_status).toBe('done');
  });

  await test('writes when compiled_at (fresh recompile) differs', async () => {
    const ctx = makeApp({
      knowledge_status: 'done',
      knowledge_source_id: 'ksrc_x',
      knowledge_compiled_at: '2026-06-30T08:00:00Z',
      knowledge_summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    await setKnowledgeStatus(ctx.app, ctx.file, 'done', {
      source_id: 'ksrc_x',
      compiled_at: '2026-07-01T09:00:00Z',
      summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    expect(ctx.writeCount).toBe(1);
  });

  await test('writes when pending_reason must be added', async () => {
    const ctx = makeApp({ knowledge_status: 'pending' });
    await setKnowledgeStatus(ctx.app, ctx.file, 'pending', { pending_reason: 'content_changed' });
    expect(ctx.writeCount).toBe(1);
  });

  await test('skips when pending_reason already matches', async () => {
    const ctx = makeApp({
      knowledge_status: 'pending',
      knowledge_pending_reason: 'new',
    });
    await setKnowledgeStatus(ctx.app, ctx.file, 'pending', { pending_reason: 'new' });
    expect(ctx.writeCount).toBe(0);
  });

  await test('writes when stale error must be cleared on success', async () => {
    const ctx = makeApp({
      knowledge_status: 'done',
      knowledge_source_id: 'ksrc_x',
      knowledge_compiled_at: '2026-06-30T08:00:00Z',
      knowledge_summary: 'Knowledge Wiki/Articles/ksrc_x.md',
      knowledge_error: 'previous failure',
    });
    await setKnowledgeStatus(ctx.app, ctx.file, 'done', {
      source_id: 'ksrc_x',
      compiled_at: '2026-06-30T08:00:00Z',
      summary: 'Knowledge Wiki/Articles/ksrc_x.md',
    });
    expect(ctx.writeCount).toBe(1);
  });

  await test('writes (not skips) when metadata cache is missing', async () => {
    const file = createFile('Clippings/nocache.md');
    let writeCount = 0;
    const app = {
      metadataCache: { getFileCache: () => null },
      fileManager: {
        processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => { writeCount++; cb({}); },
      },
    } as any;
    await setKnowledgeStatus(app, file, 'pending', { pending_reason: 'new' });
    expect(writeCount).toBe(1);
  });

  console.log('All frontmatter idempotency tests passed!');
}

void runTests();
