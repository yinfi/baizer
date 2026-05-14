// test/knowledge/watcher.test.ts

import { TFile } from 'obsidian';
import {
  isInWatchedFolder,
  shouldEnqueueFile
} from '../../src/knowledge/watcher';
import { computeContentHash } from '../../src/knowledge/compiler';
import { KnowledgeRuntime } from '../../src/knowledge/runtime';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); }
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

console.log('=== Folder Watcher Tests ===');

async function runTests() {
  await test('isInWatchedFolder matches exact folder', () => {
    expect(isInWatchedFolder('Clippings/test.md', ['Clippings'])).toBeTruthy();
    expect(isInWatchedFolder('Clippings/sub/test.md', ['Clippings'])).toBeTruthy();
  });

  await test('isInWatchedFolder rejects non-watched paths', () => {
    expect(isInWatchedFolder('Notes/test.md', ['Clippings'])).toBeFalsy();
    expect(isInWatchedFolder('test.md', ['Clippings'])).toBeFalsy();
  });

  await test('isInWatchedFolder handles multiple folders', () => {
    const folders = ['Clippings', 'Reading Notes'];
    expect(isInWatchedFolder('Clippings/a.md', folders)).toBeTruthy();
    expect(isInWatchedFolder('Reading Notes/b.md', folders)).toBeTruthy();
    expect(isInWatchedFolder('Other/c.md', folders)).toBeFalsy();
  });

  await test('isInWatchedFolder handles trailing slashes', () => {
    expect(isInWatchedFolder('Clippings/test.md', ['Clippings/'])).toBeTruthy();
  });

  await test('shouldEnqueueFile filters non-markdown files', () => {
    expect(shouldEnqueueFile('test.md', ['Clippings'])).toBeFalsy();
    expect(shouldEnqueueFile('Clippings/test.md', ['Clippings'])).toBeTruthy();
    expect(shouldEnqueueFile('Clippings/test.txt', ['Clippings'])).toBeFalsy();
    expect(shouldEnqueueFile('Clippings/test.png', ['Clippings'])).toBeFalsy();
  });

  await test('shouldEnqueueFile excludes wiki output folder', () => {
    expect(shouldEnqueueFile('Knowledge Wiki/Articles/ksrc_a.md', ['Knowledge Wiki'])).toBeFalsy();
  });

  await test('KnowledgeRuntime exposes a status service with derived stale note state', async () => {
    const summaryPath = 'Knowledge Wiki/Articles/ksrc_native-ai.md';
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>([
      ['Projects/Native AI.md', {
        file: createFile('Projects/Native AI.md'),
        content: '# Native AI\nupdated body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: summaryPath,
        },
      }],
      [summaryPath, {
        file: createFile(summaryPath),
        content: '# Summary',
        frontmatter: {
          compiled_at: '2026-05-13T10:00:00Z',
          content_hash: computeContentHash('# Native AI\noriginal body'),
        },
      }],
    ]);

    const app = {
      vault: {
        getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
        getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
        read: async (file: TFile) => files.get(file.path)?.content || '',
        getFiles: () => Array.from(files.values()).map((entry) => entry.file),
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const entry = files.get(file.path);
          return entry ? { frontmatter: entry.frontmatter } : null;
        },
      },
    } as any;

    const runtime = new KnowledgeRuntime(app, {
      knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'],
      knowledgeAutoCompile: false,
      knowledgeMaxCompileBatch: 50,
    } as any, {
      generate: async () => '',
    } as any);

    const status = await runtime.getStatusService().getNoteStatus('Projects/Native AI.md');
    expect(status?.state).toBe('stale');
  });

  console.log('All watcher tests passed!');
}

void runTests();
