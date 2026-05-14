import { App, TFile } from 'obsidian';
import { computeContentHash } from '../src/knowledge/compiler';
import { KnowledgeStatusService } from '../src/knowledge/status-service';

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

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = path.endsWith('.md') ? 'md' : '';
  return file;
}

function createKnowledgeApp(entries: MockEntry[]) {
  const records = new Map<string, MockEntry & { file: TFile }>();

  for (const entry of entries) {
    records.set(entry.path, {
      ...entry,
      file: createFile(entry.path),
      frontmatter: entry.frontmatter || {},
    });
  }

  return {
    app: {
      vault: {
        getMarkdownFiles: () => Array.from(records.values())
          .filter((entry) => entry.file.extension === 'md')
          .map((entry) => entry.file),
        getAbstractFileByPath: (path: string) => records.get(path)?.file || null,
        read: async (file: TFile) => records.get(file.path)?.content || '',
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const entry = records.get(file.path);
          return entry ? { frontmatter: entry.frontmatter } : null;
        },
      },
    } as unknown as App,
  };
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
}

void runTests();
