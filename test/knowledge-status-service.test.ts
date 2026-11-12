import { App, TFile } from 'obsidian';
import { computeContentHash } from '../src/knowledge/compiler';
import { computeSchemaHash } from '../src/knowledge/ontology';
import { GLOBAL_COUNTS_TTL_MS, KnowledgeStatusService } from '../src/knowledge/status-service';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
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
          throw new Error(`Expected property "${key}" to be ${JSON.stringify(value)} but got ${JSON.stringify(actual?.[key])}`);
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

type MockEntry = {
  path: string;
  content: string;
  frontmatter?: Record<string, any>;
};

type MockAppStats = {
  markdownFilesCalls: number;
  readCalls: string[];
  fileCacheCalls: string[];
};

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = path.endsWith('.md') ? 'md' : '';
  return file;
}

function createKnowledgeApp(entries: MockEntry[]) {
  const records = new Map<string, MockEntry & { file: TFile }>();
  const stats: MockAppStats = {
    markdownFilesCalls: 0,
    readCalls: [],
    fileCacheCalls: [],
  };

  for (const entry of entries) {
    records.set(entry.path, {
      ...entry,
      file: createFile(entry.path),
      frontmatter: entry.frontmatter || {},
    });
  }

  const app = {
    vault: {
      getMarkdownFiles: () => {
        stats.markdownFilesCalls++;
        return Array.from(records.values())
          .filter((entry) => entry.file.extension === 'md')
          .map((entry) => entry.file);
      },
      getAbstractFileByPath: (path: string) => records.get(path)?.file || null,
      read: async (file: TFile) => {
        stats.readCalls.push(file.path);
        return records.get(file.path)?.content || '';
      },
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        stats.fileCacheCalls.push(file.path);
        const entry = records.get(file.path);
        return entry ? { frontmatter: entry.frontmatter } : null;
      },
    },
  } as unknown as App;

  return { app, records, stats };
}

console.log('=== Knowledge Status Service Tests ===');

async function runTests() {
  await test('getNoteStatus derives stale from mismatched summary content hash', async () => {
    const staleSummaryPath = 'Knowledge Wiki/Articles/ksrc_native-ai.md';
    const { app } = createKnowledgeApp([
      {
        path: 'Projects/Native AI.md',
        content: '# Native AI\nupdated body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: staleSummaryPath,
          knowledge_compiled_at: '2026-05-13T10:00:00Z',
        },
      },
      {
        path: staleSummaryPath,
        content: '# Summary',
        frontmatter: {
          compiled_at: '2026-05-13T10:00:00Z',
          content_hash: computeContentHash('# Native AI\noriginal body'),
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getNoteStatus('Projects/Native AI.md')).toMatchObject({
      state: 'stale',
      summaryPath: staleSummaryPath,
      compiledAt: '2026-05-13T10:00:00Z',
    });
  });

  await test('getNoteStatus returns unregistered for watched note without metadata', async () => {
    const { app } = createKnowledgeApp([
      {
        path: 'Projects/Inbox.md',
        content: '# Inbox\n',
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getNoteStatus('Projects/Inbox.md')).toMatchObject({
      state: 'unregistered',
      summaryPath: null,
      compiledAt: null,
      error: null,
    });
  });

  await test('getGlobalCounts aggregates pending failed and stale notes from watched folders', async () => {
    const staleSummaryPath = 'Knowledge Wiki/Articles/ksrc_stale.md';
    const freshSummaryPath = 'Knowledge Wiki/Articles/ksrc_done.md';
    const { app } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
      {
        path: 'Projects/Failed.md',
        content: '# Failed',
        frontmatter: {
          knowledge_status: 'failed',
          knowledge_error: 'parse error',
        },
      },
      {
        path: 'Projects/Stale.md',
        content: '# Stale\nnew body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: staleSummaryPath,
        },
      },
      {
        path: staleSummaryPath,
        content: '# Stale Summary',
        frontmatter: {
          compiled_at: '2026-05-13T10:00:00Z',
          content_hash: computeContentHash('# Stale\nold body'),
        },
      },
      {
        path: 'Projects/Done.md',
        content: '# Done\nsame body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: freshSummaryPath,
        },
      },
      {
        path: freshSummaryPath,
        content: '# Done Summary',
        frontmatter: {
          compiled_at: '2026-05-13T11:00:00Z',
          content_hash: computeContentHash('# Done\nsame body'),
        },
      },
      {
        path: 'Scratch/Outside.md',
        content: '# Outside',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 1,
      stale: 1,
    });
  });

  await test('getGlobalCounts caches counts within TTL and skips re-traversal', async () => {
    const { app, records, stats } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
      {
        path: 'Projects/Failed.md',
        content: '# Failed',
        frontmatter: {
          knowledge_status: 'failed',
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(GLOBAL_COUNTS_TTL_MS).toBe(30_000);
    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 1,
      stale: 0,
    });

    const traversalCallsAfterFirst = stats.markdownFilesCalls;
    const fileCacheCallsAfterFirst = stats.fileCacheCalls.length;
    expect(traversalCallsAfterFirst).toBe(1);
    expect(fileCacheCallsAfterFirst > 0).toBe(true);

    // 改动底层数据：若 TTL 内重新遍历，计数会变成 pending=0/failed=2
    records.get('Projects/Pending.md')!.frontmatter = { knowledge_status: 'failed' };

    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 1,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst);
    expect(stats.fileCacheCalls.length).toBe(fileCacheCallsAfterFirst);
  });

  await test('getGlobalCounts forceFresh recomputes and reflects changed data', async () => {
    const { app, records, stats } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 0,
      stale: 0,
    });
    const traversalCallsAfterFirst = stats.markdownFilesCalls;

    records.get('Projects/Pending.md')!.frontmatter = { knowledge_status: 'failed' };

    // TTL 内非强制调用仍命中缓存
    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 0,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst);

    // forceFresh 绕过缓存，并反映改动后的数据
    expect(await service.getGlobalCounts({ forceFresh: true })).toEqual({
      pending: 0,
      failed: 1,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst + 1);
  });

  await test('concurrent getGlobalCounts calls share a single traversal', async () => {
    const summaryPath = 'Knowledge Wiki/Articles/ksrc_concurrent.md';
    const { app, stats } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
      {
        path: 'Projects/Stale.md',
        content: '# Stale\nnew body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: summaryPath,
        },
      },
      {
        path: summaryPath,
        content: '# Stale Summary',
        frontmatter: {
          compiled_at: '2026-05-13T10:00:00Z',
          content_hash: computeContentHash('# Stale\nold body'),
        },
      },
      {
        path: 'Projects/Unregistered.md',
        content: '# Unregistered',
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    const [first, second] = await Promise.all([
      service.getGlobalCounts(),
      service.getGlobalCounts(),
    ]);

    expect(first).toEqual({ pending: 1, failed: 0, stale: 1 });
    expect(second).toEqual({ pending: 1, failed: 0, stale: 1 });
    // 只遍历一次：getMarkdownFiles 只调用一次，stale 笔记正文也只读取一次
    expect(stats.markdownFilesCalls).toBe(1);
    expect(stats.readCalls.filter((path) => path === 'Projects/Stale.md').length).toBe(1);
  });

  await test('updateConfig invalidates counts only when the scan scope changes', async () => {
    const { app, stats } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
      {
        path: 'Research/Failed.md',
        content: '# Failed',
        frontmatter: {
          knowledge_status: 'failed',
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 0,
      stale: 0,
    });
    const traversalCallsAfterFirst = stats.markdownFilesCalls;

    // 相同扫描范围（数组为新实例）不失效缓存
    service.updateConfig({ watchedFolders: ['Projects'], wikiFolder: 'Knowledge Wiki' });
    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 0,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst);

    // 监听目录真正变化：立即失效，下一次调用重新遍历并计入 Research/Failed.md
    service.updateConfig({ watchedFolders: ['Projects', 'Research'] });
    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 1,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst + 1);

    // wiki 目录变化同样失效
    service.updateConfig({ wikiFolder: 'Other Wiki' });
    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 1,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst + 2);
  });

  await test('invalidateGlobalCounts makes the next call re-traverse', async () => {
    const { app, records, stats } = createKnowledgeApp([
      {
        path: 'Projects/Pending.md',
        content: '# Pending',
        frontmatter: {
          knowledge_status: 'pending',
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getGlobalCounts()).toEqual({
      pending: 1,
      failed: 0,
      stale: 0,
    });
    const traversalCallsAfterFirst = stats.markdownFilesCalls;

    records.get('Projects/Pending.md')!.frontmatter = { knowledge_status: 'failed' };
    service.invalidateGlobalCounts();

    expect(await service.getGlobalCounts()).toEqual({
      pending: 0,
      failed: 1,
      stale: 0,
    });
    expect(stats.markdownFilesCalls).toBe(traversalCallsAfterFirst + 1);
  });

  await test('getNoteStatus keeps content-current summaries done when only ontology schema changed', async () => {
    const summaryPath = 'Knowledge Wiki/Articles/ksrc_old.md';
    const ontologyContent = `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "Methods"
    description: "Reusable methods"
---
# Knowledge Ontology Schema
`;
    const { app } = createKnowledgeApp([
      {
        path: 'Knowledge Wiki/_ontology.md',
        content: ontologyContent,
      },
      {
        path: 'Projects/Old.md',
        content: '# Old\nsame body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: summaryPath,
        },
      },
      {
        path: summaryPath,
        content: '# Old Summary',
        frontmatter: {
          compiled_at: '2026-05-13T11:00:00Z',
          content_hash: computeContentHash('# Old\nsame body'),
        },
      },
    ]);

    const service = new KnowledgeStatusService(app, {
      watchedFolders: ['Projects'],
      wikiFolder: 'Knowledge Wiki',
    });

    expect(await service.getNoteStatus('Projects/Old.md')).toMatchObject({
      state: 'done',
      summaryPath,
    });

    const summaryFile = app.vault.getAbstractFileByPath(summaryPath) as TFile;
    const summaryCache = app.metadataCache.getFileCache(summaryFile)!;
    summaryCache.frontmatter.schema_hash = computeSchemaHash(ontologyContent);

    expect(await service.getNoteStatus('Projects/Old.md')).toMatchObject({
      state: 'done',
      summaryPath,
    });
  });
}

void runTests();
