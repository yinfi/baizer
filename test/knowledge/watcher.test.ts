// test/knowledge/watcher.test.ts

import { TFile } from 'obsidian';
import {
  isInWatchedFolder,
  shouldEnqueueFile,
  KnowledgeWatcher
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

  await test('onFileModify ignores frontmatter-only updates when source content hash is unchanged', async () => {
    const sourcePath = 'Projects/Native AI.md';
    const summaryPath = 'Knowledge Wiki/Articles/ksrc_native-ai.md';
    const sourceContent = '---\nknowledge_status: done\n---\n# Native AI\nsame body';
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>([
      [sourcePath, {
        file: createFile(sourcePath),
        content: sourceContent,
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
          content_hash: computeContentHash(sourceContent),
        },
      }],
    ]);
    const statusWrites: string[] = [];
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
        read: async (file: TFile) => files.get(file.path)?.content || '',
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const entry = files.get(file.path);
          return entry ? { frontmatter: entry.frontmatter } : null;
        },
      },
      fileManager: {
        processFrontMatter: async (file: TFile, updater: (fm: any) => void) => {
          const entry = files.get(file.path);
          if (!entry) throw new Error(`Missing file: ${file.path}`);
          updater(entry.frontmatter);
          statusWrites.push(entry.frontmatter.knowledge_status);
        },
      },
    } as any;

    const watcher = new KnowledgeWatcher(app, ['Projects'], 'Knowledge Wiki', 1);
    let compileNeeded = 0;
    watcher.setOnCompileNeeded(() => { compileNeeded++; });

    watcher.onFileModify(files.get(sourcePath)!.file);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(files.get(sourcePath)!.frontmatter.knowledge_status).toBe('done');
    expect(statusWrites.length).toBe(0);
    expect(compileNeeded).toBe(0);
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

  await test('KnowledgeRuntime loads valid ontology schema and ignores empty schema files', async () => {
    const schemaPath = 'Knowledge Wiki/_ontology.md';
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>([
      [schemaPath, {
        file: createFile(schemaPath),
        content: '',
        frontmatter: {},
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
      knowledgeOntologyEnabled: true,
    } as any, {
      generate: async () => '',
    } as any);

    expect(await runtime.loadOntologySchema()).toBe(null);

    files.set(schemaPath, {
      file: createFile(schemaPath),
      content: `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "Methods"
    description: "Reusable methods"
---
# Knowledge Ontology Schema
`,
      frontmatter: {},
    });

    const loaded = await runtime.loadOntologySchema();
    expect(loaded?.schema.categories[0].name).toBe('Methods');
  });

  await test('KnowledgeRuntime does not auto-write ontology in manual or suggest mode', async () => {
    for (const mode of ['manual', 'suggest']) {
      const writes: string[] = [];
      let generated = false;
      const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>();
      for (const name of ['a', 'b']) {
        const path = `Knowledge Wiki/Articles/${name}.md`;
        files.set(path, {
          file: createFile(path),
          content: `# ${name}`,
          frontmatter: {
            topics: ['AI'],
            concepts: ['Agent'],
            key_claims: [`${name} claim`],
          },
        });
      }

      const app = {
        vault: {
          getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
          getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
          read: async (file: TFile) => files.get(file.path)?.content || '',
          getFiles: () => Array.from(files.values()).map((entry) => entry.file),
          create: async (path: string, content: string) => { writes.push(path); files.set(path, { file: createFile(path), content, frontmatter: {} }); },
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
        knowledgeOntologyEnabled: true,
        knowledgeOntologyUpdateMode: mode,
        knowledgeOntologyMinArticles: 2,
        knowledgeOntologyMinTopicFrequency: 2,
        knowledgeOntologyMinConceptFrequency: 2,
      } as any, {
        generate: async () => {
          generated = true;
          return '{"categories":[{"name":"Methods","description":"Reusable methods"}],"entity_types":[]}';
        },
      } as any);

      const result = await runtime.discoverOntology();

      expect(result).toBe(null);
      expect(generated).toBeFalsy();
      expect(writes.length).toBe(0);
    }
  });

  await test('KnowledgeRuntime auto mode creates missing ontology when discovery is ready', async () => {
    const writes: string[] = [];
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>();
    for (const name of ['a', 'b']) {
      const path = `Knowledge Wiki/Articles/${name}.md`;
      files.set(path, {
        file: createFile(path),
        content: `# ${name}`,
        frontmatter: {
          topics: ['AI'],
          concepts: ['Agent'],
          key_claims: [`${name} claim`],
        },
      });
    }

    const app = {
      vault: {
        getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
        getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
        read: async (file: TFile) => files.get(file.path)?.content || '',
        getFiles: () => Array.from(files.values()).map((entry) => entry.file),
        create: async (path: string, content: string) => { writes.push(path); files.set(path, { file: createFile(path), content, frontmatter: {} }); },
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
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'auto',
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    } as any, {
      generate: async () => '{"categories":[{"name":"Methods","description":"Reusable methods"}],"entity_types":[]}',
    } as any);

    const result = await runtime.discoverOntology();

    expect(result).toBe('Knowledge Wiki/_ontology.md');
    expect(writes.includes('Knowledge Wiki/_ontology.md')).toBeTruthy();
  });

  await test('KnowledgeRuntime auto mode fills empty ontology when discovery is ready', async () => {
    const writes: string[] = [];
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>([
      ['Knowledge Wiki/_ontology.md', {
        file: createFile('Knowledge Wiki/_ontology.md'),
        content: '   \n',
        frontmatter: {},
      }],
    ]);
    for (const name of ['a', 'b']) {
      const path = `Knowledge Wiki/Articles/${name}.md`;
      files.set(path, {
        file: createFile(path),
        content: `# ${name}`,
        frontmatter: {
          topics: ['AI'],
          concepts: ['Agent'],
          key_claims: [`${name} claim`],
        },
      });
    }

    const app = {
      vault: {
        getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
        getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
        read: async (file: TFile) => files.get(file.path)?.content || '',
        getFiles: () => Array.from(files.values()).map((entry) => entry.file),
        create: async (path: string, content: string) => { writes.push(`create:${path}`); files.set(path, { file: createFile(path), content, frontmatter: {} }); },
        modify: async (file: TFile, content: string) => {
          writes.push(`modify:${file.path}`);
          const entry = files.get(file.path)!;
          entry.content = content;
        },
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
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'auto',
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    } as any, {
      generate: async () => '{"categories":[{"name":"Methods","description":"Reusable methods"}],"entity_types":[]}',
    } as any);

    const result = await runtime.discoverOntology();

    expect(result).toBe('Knowledge Wiki/_ontology.md');
    expect(writes.includes('modify:Knowledge Wiki/_ontology.md')).toBeTruthy();
  });

  await test('KnowledgeRuntime updateSettings triggers ontology auto discovery', async () => {
    const writes: string[] = [];
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>();
    for (const name of ['a', 'b']) {
      const path = `Knowledge Wiki/Articles/${name}.md`;
      files.set(path, {
        file: createFile(path),
        content: `# ${name}`,
        frontmatter: {
          topics: ['AI'],
          concepts: ['Agent'],
          key_claims: [`${name} claim`],
        },
      });
    }

    const app = {
      vault: {
        getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
        getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
        read: async (file: TFile) => files.get(file.path)?.content || '',
        getFiles: () => Array.from(files.values()).map((entry) => entry.file),
        create: async (path: string, content: string) => { writes.push(path); files.set(path, { file: createFile(path), content, frontmatter: {} }); },
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
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'manual',
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    } as any, {
      generate: async () => '{"categories":[{"name":"Methods","description":"Reusable methods"}],"entity_types":[]}',
    } as any);

    await runtime.updateSettings({
      knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'],
      knowledgeAutoCompile: false,
      knowledgeMaxCompileBatch: 50,
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'auto',
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
      knowledgeOntologyAutoRecompileStale: false,
    } as any);

    expect(writes.includes('Knowledge Wiki/_ontology.md')).toBeTruthy();
  });

  await test('KnowledgeRuntime updateSettings marks ontology stale files pending when enabled', async () => {
    const summaryPath = 'Knowledge Wiki/Articles/ksrc_old.md';
    const schemaPath = 'Knowledge Wiki/_ontology.md';
    const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>([
      [schemaPath, {
        file: createFile(schemaPath),
        content: `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "Methods"
    description: "Reusable methods"
---
# Knowledge Ontology Schema
`,
        frontmatter: {},
      }],
      ['Projects/Old.md', {
        file: createFile('Projects/Old.md'),
        content: '# Old\nsame body',
        frontmatter: {
          knowledge_status: 'done',
          knowledge_summary: summaryPath,
        },
      }],
      [summaryPath, {
        file: createFile(summaryPath),
        content: '# Old Summary',
        frontmatter: {
          compiled_at: '2026-05-13T11:00:00Z',
          content_hash: computeContentHash('# Old\nsame body'),
        },
      }],
    ]);

    let compileTriggered = false;
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
      fileManager: {
        processFrontMatter: async (file: TFile, cb: (fm: Record<string, any>) => void) => {
          const entry = files.get(file.path)!;
          cb(entry.frontmatter);
        },
      },
    } as any;

    const runtime = new KnowledgeRuntime(app, {
      knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'],
      knowledgeAutoCompile: false,
      knowledgeMaxCompileBatch: 50,
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'suggest',
      knowledgeOntologyAutoRecompileStale: false,
    } as any, {
      generate: async () => '',
    } as any);
    (runtime as any).watcher.setOnCompileNeeded(() => { compileTriggered = true; });

    await runtime.updateSettings({
      knowledgeWikiFolder: 'Knowledge Wiki',
      knowledgeSourceFolders: ['Projects'],
      knowledgeAutoCompile: true,
      knowledgeMaxCompileBatch: 50,
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'suggest',
      knowledgeOntologyAutoRecompileStale: true,
    } as any);

    expect(files.get('Projects/Old.md')!.frontmatter.knowledge_status).toBe('pending');
    expect(compileTriggered).toBeTruthy();
  });

  await test('KnowledgeRuntime does not read the previous plugin registry during startup', async () => {
    const previousRegistryPath = ['.obsidian', ['obsidian', 'cli'].join('-'), 'knowledge-registry.json'].join('/');
    const touchedPaths: string[] = [];
    const folders = new Set<string>();
    const files = new Map<string, string>();

    const app = {
      vault: {
        adapter: {
          exists: async (path: string) => {
            touchedPaths.push(path);
            if (path === previousRegistryPath) return true;
            return files.has(path) || folders.has(path);
          },
          read: async (path: string) => {
            if (path === previousRegistryPath) {
              throw new Error('previous registry should not be read');
            }
            return files.get(path) ?? '';
          },
          write: async (path: string, content: string) => {
            files.set(path, content);
          },
          remove: async (path: string) => {
            touchedPaths.push(path);
            files.delete(path);
          },
        },
        getMarkdownFiles: () => [],
        getFiles: () => [],
        getAbstractFileByPath: (path: string) => folders.has(path) ? { path } : null,
        read: async () => '',
        trash: async () => {},
        createFolder: async (path: string) => {
          folders.add(path);
        },
        create: async (path: string, content: string) => {
          files.set(path, content);
        },
      },
      metadataCache: {
        initialized: true,
        getFileCache: () => null,
      },
      internalPlugins: {
        plugins: {
          bases: { enabled: true },
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

    await runtime.initialize();

    expect(touchedPaths.includes(previousRegistryPath)).toBe(false);
  });

  console.log('All watcher tests passed!');
}

void runTests();
