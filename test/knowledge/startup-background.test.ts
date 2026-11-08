/**
 * Startup scan runs in the background; stale detection uses a persisted marker.
 * Read counts are from a synthetic in-memory vault, not from a real Obsidian vault.
 */
import { TFile } from 'obsidian';
import { computeContentHash } from '../../src/knowledge/compiler';
import {
  KnowledgeRuntime,
  STALE_MARKER_RECHECK_INTERVAL_MS,
  STARTUP_SCAN_FAILURE_NOTICE,
} from '../../src/knowledge/runtime';
import { KnowledgeStatusService } from '../../src/knowledge/status-service';
import { logger } from '../../src/utils/logger';

const win: any = (global as any).window ?? ((global as any).window = {});
win.setTimeout = win.setTimeout ?? ((cb: () => void, ms?: number) => setTimeout(cb, ms));
win.clearTimeout = win.clearTimeout ?? ((h: any) => clearTimeout(h));
win.setInterval = win.setInterval ?? ((cb: () => void, ms?: number) => setInterval(cb, ms) as unknown as number);
win.clearInterval = win.clearInterval ?? ((h: any) => clearInterval(h));

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
      on: () => ({}),
      getMarkdownFiles: () => Array.from(files.values()).map(r => r.file),
      getFiles: () => Array.from(files.values()).map(r => r.file),
      trash: async () => {},
      createFolder: async () => {},
      create: async (path: string, content: string) => { files.set(path, { file: mkFile(path, content.length, 1), content, frontmatter: {} }); },
      modify: async (f: TFile, content: string) => { const r = files.get(f.path); if (r) r.content = content; },
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      read: async (f: TFile) => { reads.push(f.path); return files.get(f.path)?.content ?? ''; },
      cachedRead: async (f: TFile) => { reads.push(f.path); return files.get(f.path)?.content ?? ''; },
    },
    metadataCache: {
      initialized: true,
      on: () => ({}),
      offref: () => {},
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
    // obsidian 的 Notice 在测试环境里是冻结的 mock（模块对象只读），所以观察运行时里
    // 负责"发一次失败提示"的那个接缝是否被调用。
    let notified = false;
    try {
      const rt = new KnowledgeRuntime(v.app, settings, { generate: async () => '' } as any);
      (rt as any).notifyStartupScanFailure = () => { notified = true; };
      armed = true;
      await rt.initialize();             // must not reject
      await rt.whenStartupSettled();     // must resolve
    } finally { (logger as any).error = orig; }
    assert(errors.some(e => e.includes('Startup scan') && e.includes('boom')), `failure not logged; got ${JSON.stringify(errors)}`);
    assert(notified, 'the startup-scan failure must be user-visible, not only logged');
    assert(STARTUP_SCAN_FAILURE_NOTICE.includes('Rescan knowledge status'),
      `the failure notice must point at the retry entry; got: ${STARTUP_SCAN_FAILURE_NOTICE}`);
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

  await test('two concurrent getStaleFiles() calls share one pass and one marker load', async () => {
    const N = 8;
    const v = mkVault(N);
    let markerWrites = 0;
    const realWrite = v.app.vault.adapter.write;
    v.app.vault.adapter.write = async (p: string, c: string) => { if (p === MARKER) markerWrites++; return realWrite(p, c); };
    const svc = v.svc();
    const [a, b] = await Promise.all([svc.getStaleFiles(), svc.getStaleFiles()]);
    assert(a.length === 0 && b.length === 0, 'nothing stale expected');
    // 单飞：两次并发调用只应产生一次全库遍历、一次标记落盘（不是 2N 次读取 / 2 次写）。
    assert(v.reads.length === N, `expected a single ${N}-file pass, got ${v.reads.length} reads`);
    assert(markerWrites === 1, `marker should be written once, wrote ${markerWrites} times`);
  });

  await test('an expired marker entry forces a full re-check (same fingerprints, stale verifiedAt)', async () => {
    const N = 5;
    const v = mkVault(N);
    await v.svc().getStaleFiles();          // cold: builds the marker
    const parsed = JSON.parse(v.disk.get(MARKER)!);
    assert(parsed.version === 2, `expected marker version 2, got ${parsed.version}`);
    for (const key of Object.keys(parsed.entries)) {
      parsed.entries[key].verifiedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;   // 8 days old
    }
    v.disk.set(MARKER, JSON.stringify(parsed));
    v.reads.length = 0;
    const stale = await v.svc().getStaleFiles();
    assert(stale.length === 0, 'still in sync, so nothing stale');
    assert(v.reads.length === N, `expired marker must re-hash all ${N} files, read ${v.reads.length}`);
    // ...and the recheck refreshes verifiedAt so the next pass is a shortcut again
    v.reads.length = 0;
    await v.svc().getStaleFiles();
    assert(v.reads.length === 0, `expected shortcut after refresh, read ${v.reads.length}`);
  });

  await test('a future verifiedAt (clock rollback) is treated as expired, not as fresh', async () => {
    const N = 4;
    const v = mkVault(N);
    await v.svc().getStaleFiles();          // cold: builds the marker
    const parsed = JSON.parse(v.disk.get(MARKER)!);
    for (const key of Object.keys(parsed.entries)) {
      // 系统时钟回拨会让 now - verifiedAt 变成负数；没有守卫的话这会被当成"未过期"，
      // 快路径就能无限期生效。
      parsed.entries[key].verifiedAt = Date.now() + 8 * 24 * 60 * 60 * 1000;
    }
    v.disk.set(MARKER, JSON.stringify(parsed));
    v.reads.length = 0;
    const stale = await v.svc().getStaleFiles();
    assert(stale.length === 0, 'still in sync, so nothing stale');
    assert(v.reads.length === N, `a future verifiedAt must not take the shortcut, read ${v.reads.length}`);
  });

  await test('a deleted note is pruned from the marker', async () => {
    const v = mkVault(4);
    await v.svc().getStaleFiles();
    assert(Object.keys(JSON.parse(v.disk.get(MARKER)!).entries).includes('Projects/n1.md'), 'n1 should be tracked');
    v.files.delete('Projects/n1.md');
    await v.svc().getStaleFiles();
    const entries = Object.keys(JSON.parse(v.disk.get(MARKER)!).entries);
    assert(!entries.includes('Projects/n1.md'), `deleted note still tracked: ${entries.join()}`);
    assert(entries.length === 3, `expected 3 remaining entries, got ${entries.length}`);
  });

  await test('calling initialize() twice runs the startup scan only once', async () => {
    const v = mkVault(0);
    const rec: Rec = { file: mkFile('Projects/stuck.md', 5, 1), content: 'x',
      frontmatter: { knowledge_status: 'processing' } };
    v.files.set('Projects/stuck.md', rec);
    let frontmatterWrites = 0;
    v.app.fileManager = { processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => { frontmatterWrites++; cb(rec.frontmatter); } };
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'], knowledgeAutoCompile: false } as any, { generate: async () => '' } as any);
    // frontmatter 写次数钉不住单飞：第一个文件被重置成 pending 之后，第二次扫描即使真的
    // 跑了也不会再写它（同理，未注册文件第一次扫描后就有了 source_id）。getStaleFiles()
    // 是每次扫描都必经的一步，用它计数才能真正区分"扫描跑了几遍"。
    const svc = (rt as any).statusService;
    const realGetStale = svc.getStaleFiles.bind(svc);
    let scanPasses = 0;
    svc.getStaleFiles = async () => { scanPasses++; return realGetStale(); };
    await rt.initialize();
    await rt.initialize();
    await rt.whenStartupSettled();
    assert(scanPasses === 1, `startup scan should run exactly once, ran ${scanPasses} time(s)`);
    assert(frontmatterWrites === 1, `stuck file should be reset once, wrote ${frontmatterWrites} times`);
  });

  await test('whenStartupSettled() returns immediately when initialize() was never called', async () => {
    const v = mkVault(0);
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'] } as any, { generate: async () => '' } as any);
    let settled = false;
    await Promise.race([
      rt.whenStartupSettled().then(() => { settled = true; }),
      new Promise(resolve => setTimeout(resolve, 100)),
    ]);
    assert(settled, 'whenStartupSettled() must not hang before initialize()');
  });

  await test('compileByPath() waits for the startup scan instead of racing it', async () => {
    const v = mkVault(0);
    const rec: Rec = { file: mkFile('Projects/stuck.md', 5, 1), content: 'x',
      frontmatter: { knowledge_status: 'processing' } };
    v.files.set('Projects/stuck.md', rec);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    v.app.fileManager = { processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => { await gate; cb(rec.frontmatter); } };
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    let generateCalls = 0;
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'], knowledgeAutoCompile: false,
      knowledgeOntologyUpdateMode: 'suggest' } as any,
      { generate: async () => { generateCalls++; return ''; } } as any);
    await rt.initialize();                       // scan starts, blocked on the gate
    // compileByPath() 在等待门控期间不应该做任何编译侧的工作。用 loadOntologySchema()
    // 当探针：它在 compileByPath() 里早于任何 frontmatter 写入发生，所以"扫描结束后才被
    // 调用"能干净地区分"确实在等"和"被 processFrontMatter 门一起挡住"。
    let released = false;
    let earlyOntologyLoads = 0;
    const realLoad = rt.loadOntologySchema.bind(rt);
    rt.loadOntologySchema = async () => { if (!released) earlyOntologyLoads++; return realLoad(); };
    let compileSettled = false;
    const compile = rt.compileByPath('Projects/stuck.md').then(() => { compileSettled = true; });
    await tick(); await tick(); await tick();
    assert(earlyOntologyLoads === 0, `compileByPath() must wait for the startup scan (proceeded ${earlyOntologyLoads} time(s) early)`);
    assert(!compileSettled, 'compileByPath() must not settle before the scan finishes');
    assert(generateCalls === 0, `compile must not run before the scan finishes (generate calls: ${generateCalls})`);
    released = true;
    release();
    await compile;
    assert(generateCalls >= 1, `compile should run once the scan finished (generate calls: ${generateCalls})`);
  });

  await test('markOntologyStaleFilesPending() waits for the startup scan too', async () => {
    const v = mkVault(0);
    const rec: Rec = { file: mkFile('Projects/stuck.md', 5, 1), content: 'x',
      frontmatter: { knowledge_status: 'processing' } };
    v.files.set('Projects/stuck.md', rec);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    v.app.fileManager = { processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => { await gate; cb(rec.frontmatter); } };
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'], knowledgeAutoCompile: false,
      knowledgeOntologyUpdateMode: 'suggest' } as any, { generate: async () => '' } as any);
    await rt.initialize();
    const svc = (rt as any).statusService;
    const realGetStale = svc.getStaleFiles.bind(svc);
    let scanPasses = 0;
    svc.getStaleFiles = async () => { scanPasses++; return realGetStale(); };
    let pendingSettled = false;
    const pending = rt.markOntologyStaleFilesPending().then(() => { pendingSettled = true; });
    await tick(); await tick();
    // 启动扫描此刻正卡在"重置 stuck 文件"的 processFrontMatter 上，还没走到 detectStaleFiles；
    // 所以只要 markOntologyStaleFilesPending() 真的在等，这里就该是 0 次。没门控的话它会在
    // 第一个 await 之前就冲进去，这里会变成 1。
    assert(scanPasses === 0, `markOntologyStaleFilesPending() must wait for the startup scan (passes so far: ${scanPasses})`);
    assert(!pendingSettled, 'markOntologyStaleFilesPending() must not settle before the scan finishes');
    release();
    await pending;
    assert(scanPasses === 2, `expected the startup scan plus one own pass, got ${scanPasses}`);
  });

  await test('the periodic re-check applies the marker TTL while the plugin stays open', async () => {
    const N = 6;
    const v = mkVault(N);
    await v.svc().getStaleFiles();               // build the marker
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'], knowledgeAutoCompile: false,
      knowledgeOntologyUpdateMode: 'suggest' } as any, { generate: async () => '' } as any);
    await rt.initialize();
    await rt.whenStartupSettled();
    v.reads.length = 0;
    await rt.recheckStaleMarkers();
    assert(v.reads.length === 0, `a fresh marker must be a cheap no-op, read ${v.reads.length}`);
    // 模拟"7 天后插件仍然开着"：把 verifiedAt 推老，再走同一个周期入口
    const parsed = JSON.parse(v.disk.get(MARKER)!);
    for (const key of Object.keys(parsed.entries)) {
      parsed.entries[key].verifiedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    }
    v.disk.set(MARKER, JSON.stringify(parsed));
    v.reads.length = 0;
    const marked = await rt.recheckStaleMarkers();
    assert(v.reads.length === N, `the periodic entry must re-hash expired entries, read ${v.reads.length}`);
    assert(marked === 0, 'files are still in sync, so nothing should be marked stale');
  });

  await test('registerEvents() wires the periodic stale re-check interval and cleanup() clears it', async () => {
    const v = mkVault(0);
    const rt = new KnowledgeRuntime(v.app, { knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'] } as any, { generate: async () => '' } as any);
    let intervalMs: number | null = null;
    let fired: (() => void) | null = null;
    let cleared: number | null = null;
    const origSet = win.setInterval;
    const origClear = win.clearInterval;
    win.setInterval = ((cb: () => void, ms?: number) => { fired = cb; intervalMs = ms ?? 0; return 4242; }) as any;
    win.clearInterval = ((h: number) => { cleared = h; }) as any;
    try {
      const registered: unknown[] = [];
      rt.registerEvents({ registerEvent: (r: unknown) => { registered.push(r); } } as any);
      assert(intervalMs === STALE_MARKER_RECHECK_INTERVAL_MS,
        `expected the ${STALE_MARKER_RECHECK_INTERVAL_MS}ms recheck interval, got ${intervalMs}`);
      assert(!!fired, 'interval callback was not registered');
      assert(registered.length === 4, `expected the 4 vault/cache events to still be registered, got ${registered.length}`);
      rt.cleanup();
      assert(cleared === 4242, `cleanup() must clear the recheck interval, cleared ${cleared}`);
    } finally {
      win.setInterval = origSet;
      win.clearInterval = origClear;
    }
  });

  await test('rescanKnowledgeStatus() retries the work a failed startup scan skipped', async () => {
    const v = mkVault(0);
    const rec: Rec = { file: mkFile('Projects/stuck.md', 5, 1), content: 'x',
      frontmatter: { knowledge_status: 'processing' } };
    v.files.set('Projects/stuck.md', rec);
    v.app.fileManager = { processFrontMatter: async (_f: TFile, cb: (fm: any) => void) => { cb(rec.frontmatter); } };
    v.app.internalPlugins = { plugins: { bases: { enabled: true } } };
    let armed = false;
    const settings: any = { knowledgeWikiFolder: 'Knowledge Wiki', knowledgeAutoCompile: false };
    Object.defineProperty(settings, 'knowledgeSourceFolders', {
      get() { if (armed) throw new Error('boom: settings unreadable'); return []; },
    });
    const orig = logger.error.bind(logger);
    (logger as any).error = () => { /* expected during the armed failure */ };
    try {
      const rt = new KnowledgeRuntime(v.app, settings, { generate: async () => '' } as any);
      armed = true;
      await rt.initialize();
      await rt.whenStartupSettled();
      assert(rec.frontmatter.knowledge_status === 'processing',
        'the failed scan should have skipped the stuck-file reset');
      armed = false;
      const result = await rt.rescanKnowledgeStatus();
      assert(result.ok, `rescan should succeed, got: ${result.message}`);
      assert(rec.frontmatter.knowledge_status === 'pending',
        'rescan should have reset the stuck processing file');
    } finally { (logger as any).error = orig; }
  });

  console.log('Knowledge startup tests: all passed');
}
main().catch(e => { console.error(e); process.exit(1); });