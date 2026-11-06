/**
 * Startup scan runs in the background; stale detection uses a persisted marker.
 * Read counts are from a synthetic in-memory vault, not from a real Obsidian vault.
 */
import { TFile } from 'obsidian';
import { computeContentHash } from '../../src/knowledge/compiler';
import { KnowledgeRuntime } from '../../src/knowledge/runtime';
import { KnowledgeStatusService } from '../../src/knowledge/status-service';
import { logger } from '../../src/utils/logger';

(global as any).window = (global as any).window ?? {
  setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
  clearTimeout: (h: any) => clearTimeout(h),
};

function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0));

interface Rec { file: TFile; content: string; frontmatter: Record<string, any>; }

function mkFile(path: string, size: number, mtime: number): TFile {
  const f = new TFile() as any;
  f.path = path; f.basename = path.split('/').pop()!.replace(/\.md$/, ''); f.extension = 'md';
  f.stat = { mtime, size, ctime: 0 };
  return f as TFile;
}

/** N compiled ('done') notes under Projects/, each with an in-sync summary under the wiki folder. */
function mkVault(n: number) {
  const files = new Map<string, Rec>();
  const disk = new Map<string, string>();
  const reads: string[] = [];
  for (let i = 0; i < n; i++) {
    const src = `Projects/n${i}.md`;
    const sum = `Knowledge Wiki/Articles/ksrc_${i}.md`;
    const body = `# Note ${i}\nbody ${i}`;
    files.set(src, { file: mkFile(src, body.length, 1000 + i), content: body,
      frontmatter: { knowledge_status: 'done', knowledge_summary: sum } });
    files.set(sum, { file: mkFile(sum, 10, 2000 + i), content: '# s',
      frontmatter: { schema_hash: 'h', compiled_at: 'x', content_hash: computeContentHash(body) } });
  }
  const app: any = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: async (p: string) => disk.has(p) || p.endsWith('-knowledge'),
        read: async (p: string) => disk.get(p) ?? '',
        write: async (p: string, c: string) => { disk.set(p, c); },
        mkdir: async () => {},
      },
      getMarkdownFiles: () => Array.from(files.values()).map(r => r.file),
      getFiles: () => Array.from(files.values()).map(r => r.file),
      trash: async () => {},
      createFolder: async () => {},
      create: async (path: string, content: string) => { files.set(path, { file: mkFile(path, content.length, 1), content, frontmatter: {} }); },
      modify: async (f: TFile, content: string) => { const r = files.get(f.path); if (r) r.content = content; },
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      read: async (f: TFile) => { reads.push(f.path); return files.get(f.path)?.content ?? ''; },
    },
    metadataCache: {
      initialized: true,
      getFileCache: (f: TFile) => { const r = files.get(f.path); return r ? { frontmatter: r.frontmatter } : null; },
    },
  };
  const svc = () => new KnowledgeStatusService(app, { watchedFolders: ['Projects'], wikiFolder: 'Knowledge Wiki' });
  return { app, files, disk, reads, svc };
}

const MARKER = '.obsidian/baizer-knowledge/stale-check.json';

async function main() {
  console.log('=== Knowledge startup (background scan + stale marker) ===');

  await test('stale marker: warm run reads zero source files; cold run reads every one', async () => {
    const N = 200;
    const v = mkVault(N);
    const cold = await v.svc().getStaleFiles();
    const coldReads = v.reads.length;
    v.reads.length = 0;
    const warm = await v.svc().getStaleFiles();
    const warmReads = v.reads.length;
    console.log(`    synthetic vault, ${N} compiled notes: vault.read calls cold=${coldReads} warm=${warmReads}`);
    assert(cold.length === 0 && warm.length === 0, 'nothing should be stale');
    assert(coldReads === N, `cold run should read ${N} files, read ${coldReads}`);
    assert(warmReads === 0, `warm run should read 0 files, read ${warmReads}`);
    assert(v.disk.has(MARKER), 'marker was not persisted');
  });

  await test('stale marker: a changed note is still detected and only that note is re-read', async () => {
    const v = mkVault(20);
    await v.svc().getStaleFiles();
    const r = v.files.get('Projects/n7.md')!;
    r.content = '# Note 7\nEDITED body that is longer';
    (r.file as any).stat = { mtime: 99999, size: r.content.length, ctime: 0 };
    v.reads.length = 0;
    const stale = await v.svc().getStaleFiles();
    assert(stale.map(f => f.path).join() === 'Projects/n7.md', `expected only n7 stale, got ${stale.map(f => f.path)}`);
    assert(v.reads.length === 1 && v.reads[0] === 'Projects/n7.md', `expected 1 read of n7, got ${v.reads.join()}`);
    // a stale note is not recorded as fresh: it is re-checked (and re-reported) next time
    v.reads.length = 0;
    const again = await v.svc().getStaleFiles();
    assert(again.length === 1 && v.reads.length === 1, 'stale note must be re-checked on the next pass');
  });

  await test('stale marker: a changed summary invalidates the shortcut', async () => {
    const v = mkVault(5);
    await v.svc().getStaleFiles();
    const sum = v.files.get('Knowledge Wiki/Articles/ksrc_2.md')!;
    sum.frontmatter = { ...sum.frontmatter, content_hash: 'something-else' };
    (sum.file as any).stat = { mtime: 777777, size: 11, ctime: 0 };
    const stale = await v.svc().getStaleFiles();
    assert(stale.map(f => f.path).join() === 'Projects/n2.md', `expected n2 stale, got ${stale.map(f => f.path)}`);
  });

  await test('stale marker: corrupt marker falls back to a full check', async () => {
    const v = mkVault(10);
    await v.svc().getStaleFiles();
    v.disk.set(MARKER, '{not json');
    v.reads.length = 0;
    const stale = await v.svc().getStaleFiles();
    assert(stale.length === 0 && v.reads.length === 10, `expected 10 reads after corrupt marker, got ${v.reads.length}`);
  });

  await test('stale marker: wrong-version / missing marker falls back to a full check', async () => {
    const v = mkVault(10);
    await v.svc().getStaleFiles();
    v.disk.set(MARKER, JSON.stringify({ version: 999, entries: {} }));
    v.reads.length = 0;
    await v.svc().getStaleFiles();
    assert(v.reads.length === 10, `wrong version: expected 10 reads, got ${v.reads.length}`);
    v.disk.delete(MARKER);
    v.reads.length = 0;
    await v.svc().getStaleFiles();
    assert(v.reads.length === 10, `missing marker: expected 10 reads, got ${v.reads.length}`);
  });

  await test('stale marker: hosts without file.stat never take the shortcut', async () => {
    const v = mkVault(6);
    for (const r of v.files.values()) delete (r.file as any).stat;
    await v.svc().getStaleFiles();
    v.reads.length = 0;
    await v.svc().getStaleFiles();
    assert(v.reads.length === 6, `expected full reads without stat, got ${v.reads.length}`);
  });

  await test('initialize() returns before the startup scan finishes; whenStartupSettled() waits for it', async () => {
    const v = mkVault(0);
    const rec: Rec = { file: mkFile('Projects/stuck.md', 5, 1), content: 'x',
      frontmatter: { knowledge_status: 'processing' } };
    v.files.set('Projects/stuck.md', rec);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let reset = false;
    v.app.fileManager = { processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => {
      await gate; cb(rec.frontmatter); reset = rec.frontmatter.knowledge_status === 'pending';
    } };
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'], knowledgeAutoCompile: false } as any, { generate: async () => '' } as any);
    await rt.initialize();               // would hang forever if it still awaited the gated scan
    assert(!reset, 'scan should still be blocked on the gate');
    let settled = false;
    const waiter = rt.whenStartupSettled().then(() => { settled = true; });
    await tick(); await tick();
    assert(!settled, 'whenStartupSettled() must wait for the scan');
    release();
    await waiter;
    assert(reset, 'stuck processing note should have been reset to pending by the scan');
  });

  await test('startup scan failure is logged, not thrown, and does not hang waiters', async () => {
    const v = mkVault(0);
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    let armed = false;
    const settings: any = { knowledgeWikiFolder: 'Knowledge Wiki', knowledgeAutoCompile: false };
    Object.defineProperty(settings, 'knowledgeSourceFolders', {
      get() { if (armed) throw new Error('boom: settings unreadable'); return []; },
    });
    const errors: string[] = [];
    const orig = logger.error.bind(logger);
    (logger as any).error = (msg: string, err?: unknown, ctx?: string) => { errors.push(`${ctx}: ${msg}: ${String((err as Error)?.message)}`); };
    try {
      const rt = new KnowledgeRuntime(v.app, settings, { generate: async () => '' } as any);
      armed = true;
      await rt.initialize();             // must not reject
      await rt.whenStartupSettled();     // must resolve
    } finally { (logger as any).error = orig; }
    assert(errors.some(e => e.includes('Startup scan') && e.includes('boom')), `failure not logged; got ${JSON.stringify(errors)}`);
  });

  await test('cleanup() before the scan starts releases whenStartupSettled()', async () => {
    const v = mkVault(0);
    v.app.metadataCache.initialized = false;
    v.app.metadataCache.on = () => ({});
    v.app.metadataCache.offref = () => {};
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'] } as any, { generate: async () => '' } as any);
    await rt.initialize();
    let settled = false;
    const waiter = rt.whenStartupSettled().then(() => { settled = true; });
    await tick();
    assert(!settled, 'should still be waiting for metadataCache');
    rt.cleanup();
    await waiter;
    assert(settled, 'cleanup() must release waiters');
  });

  console.log('Knowledge startup tests: all passed');
}
main().catch(e => { console.error(e); process.exit(1); });