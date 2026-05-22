// test/knowledge/indexer.test.ts

import { TFile } from 'obsidian';
import { buildBaseFileContent, WikiIndexer } from '../../src/knowledge/indexer';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected to contain "${expected}"`);
      }
    },
    not: {
      toContain: (expected: string) => {
        if (typeof actual === 'string' && actual.includes(expected)) {
          throw new Error(`Expected NOT to contain "${expected}"`);
        }
      }
    }
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

console.log('=== Wiki Indexer Tests ===');

async function main() {
  await test('buildBaseFileContent generates filters matching articlesFolder', () => {
    const content = buildBaseFileContent('Knowledge Wiki/Articles');
    expect(content).toContain('file.folder == "Knowledge Wiki/Articles"');
  });

  await test('buildBaseFileContent includes property definitions', () => {
    const content = buildBaseFileContent('KW/Articles');
    expect(content).toContain('properties:');
    expect(content).toContain('title:');
    expect(content).toContain('topics:');
    expect(content).toContain('concepts:');
    expect(content).toContain('compiled_at:');
    expect(content).toContain('source_url:');
    expect(content).toContain('author:');
  });

  await test('buildBaseFileContent includes views definitions', () => {
    const content = buildBaseFileContent('KW/Articles');
    expect(content).toContain('views:');
    expect(content).toContain('type: table');
    expect(content).toContain('所有文章');
    expect(content).toContain('按主题');
  });

  await test('buildBaseFileContent uses custom folder path in filter', () => {
    const content = buildBaseFileContent('My Notes/Wiki/Articles');
    expect(content).toContain('file.folder == "My Notes/Wiki/Articles"');
    expect(content).not.toContain('Knowledge Wiki/Articles');
  });

  await test('ensureBaseFile updates existing adapter file when vault index is stale', async () => {
    const files = new Map<string, string>([
      ['Knowledge Wiki/index.base', 'stale content'],
    ]);
    const writes: string[] = [];
    const creates: string[] = [];

    const app = {
      vault: {
        adapter: {
          exists: async (path: string) => files.has(path) || path === 'Knowledge Wiki',
          write: async (path: string, content: string) => {
            writes.push(path);
            files.set(path, content);
          },
        },
        getAbstractFileByPath: (path: string) => {
          if (path === 'Knowledge Wiki') return { path };
          return null;
        },
        createFolder: async () => undefined,
        create: async (path: string, content: string) => {
          creates.push(path);
          if (files.has(path)) throw new Error('File already exists.');
          const file = new TFile();
          file.path = path;
          files.set(path, content);
          return file;
        },
        modify: async (file: TFile, content: string) => {
          writes.push(file.path);
          files.set(file.path, content);
        },
      },
      internalPlugins: { plugins: { bases: { enabled: true } } },
    };

    const indexer = new WikiIndexer(app as any, {} as any, 'Knowledge Wiki');
    await indexer.ensureBaseFile();

    expect(writes[0]).toBe('Knowledge Wiki/index.base');
    expect(creates.length).toBe(0);
    expect(files.get('Knowledge Wiki/index.base')).toContain('file.folder == "Knowledge Wiki/Articles"');
  });

  console.log('All indexer tests passed!');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
