import { TFile, App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

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
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function createFile(path: string) {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') || path;
  file.extension = path.split('.').pop() || '';
  return file;
}

function createMockApp() {
  const created: Array<{ path: string; content: string }> = [];
  const modified: Array<{ path: string; content: string }> = [];
  const folders: string[] = [];
  const files = new Map<string, any>([
    ['Boards', { path: 'Boards' }],
    ['Boards/roadmap.canvas', createFile('Boards/roadmap.canvas')],
    ['Bases/tasks.base', createFile('Bases/tasks.base')],
  ]);
  const contents = new Map<string, string>([
    ['Boards/roadmap.canvas', '{"nodes":[],"edges":[]}'],
    ['Bases/tasks.base', 'views: []'],
  ]);

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      createFolder: async (path: string) => {
        folders.push(path);
      },
      create: async (path: string, content: string) => {
        created.push({ path, content });
        const file = createFile(path);
        files.set(path, file);
        contents.set(path, content);
        return file;
      },
      modify: async (file: any, content: string) => {
        modified.push({ path: file.path, content });
        contents.set(file.path, content);
      },
      read: async (file: any) => {
        if (!contents.has(file.path)) {
          throw new Error('EISDIR: illegal operation on a directory, read');
        }
        return contents.get(file.path) || '';
      },
      trash: async () => { },
      rename: async () => { },
      getMarkdownFiles: () => [],
      getFiles: () => Array.from(files.values()),
    },
    metadataCache: {
      getFirstLinkpathDest: (path: string) => files.get(path) || null,
    },
    workspace: {
      getLeaf: () => ({ openFile: async () => { } }),
    },
  } as unknown as App;

  return { app, created, modified, folders };
}

async function runTests() {
  console.log('=== Generic File Tool Tests ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { registerVaultTools } = await import('../src/skills/builtin/vault-ops');

  await test('create_file creates non-markdown text files without adding .md', async () => {
    const { app, created } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      confirmExecutions: false,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_file', {
      path: 'Boards/new.canvas',
      content: '{"nodes":[],"edges":[]}',
    });

    expect(result).toEqual({
      success: true,
      path: 'Boards/new.canvas',
      message: 'File created: Boards/new.canvas',
    });
    expect(created).toEqual([
      { path: 'Boards/new.canvas', content: '{"nodes":[],"edges":[]}' },
    ]);
  });

  await test('read_file reads exact non-markdown vault files', async () => {
    const { app } = createMockApp();
    const registry = new ToolRegistry(app, DEFAULT_SETTINGS);
    registerVaultTools(registry);

    const result = await registry.execute('read_file', {
      path: 'Boards/roadmap.canvas',
    });

    expect(result).toEqual({
      success: true,
      path: 'Boards/roadmap.canvas',
      content: '{"nodes":[],"edges":[]}',
      truncated: false,
    });
  });

  await test('read_file rejects folders before calling vault.read', async () => {
    const { app } = createMockApp();
    const registry = new ToolRegistry(app, DEFAULT_SETTINGS);
    registerVaultTools(registry);

    const result = await registry.execute('read_file', {
      path: 'Boards',
    });

    expect(result).toEqual({
      success: false,
      error: 'File not found',
    });
  });

  await test('update_file respects modification permission', async () => {
    const { app, modified } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileModification: false,
    });
    registerVaultTools(registry);

    const result = await registry.execute('update_file', {
      path: 'Bases/tasks.base',
      content: 'views:\n  - type: table',
    });

    expect(result).toEqual({
      success: false,
      error: 'File modification is disabled',
    });
    expect(modified).toEqual([]);
  });

  await test('create_file returns approval_required when confirmations are enabled', async () => {
    const { app, created } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      confirmExecutions: true,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_file', {
      path: 'Bases/new.base',
      content: 'views: []',
    });

    expect(result).toEqual({
      approval_required: true,
      action: 'create_file',
      target: 'Bases/new.base',
      args: {
        path: 'Bases/new.base',
        content: 'views: []',
      },
      message: 'Approval required to create file: Bases/new.base',
      preview: {
        kind: 'note-create',
        target: 'Bases/new.base',
        summary: 'Create file',
        newContent: 'views: []',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      },
    });
    expect(created).toEqual([]);
  });

  await test('update_file approval includes a replace preview with old and new content', async () => {
    const { app, modified } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileModification: true,
      confirmExecutions: true,
    });
    registerVaultTools(registry);

    const result = await registry.execute('update_file', {
      path: 'Bases/tasks.base',
      content: 'views:\n  - type: table',
    });

    expect(result).toEqual({
      approval_required: true,
      action: 'update_file',
      target: 'Bases/tasks.base',
      args: {
        path: 'Bases/tasks.base',
        content: 'views:\n  - type: table',
      },
      message: 'Approval required to update file: Bases/tasks.base',
      preview: {
        kind: 'note-replace',
        target: 'Bases/tasks.base',
        summary: 'Replace file content',
        oldContent: 'views: []',
        newContent: 'views:\n  - type: table',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      },
    });
    expect(modified).toEqual([]);
  });

  await test('write file tools reject unsafe vault paths', async () => {
    const { app } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      allowFileModification: true,
      confirmExecutions: false,
    });
    registerVaultTools(registry);

    const traversal = await registry.execute('create_file', {
      path: '../outside.canvas',
      content: '{}',
    });
    expect(traversal).toEqual({
      success: false,
      error: 'Unsafe vault path',
    });

    const hidden = await registry.execute('update_file', {
      path: '.obsidian/plugins/x/data.json',
      content: '{}',
    });
    expect(hidden).toEqual({
      success: false,
      error: 'Writing .obsidian files is not allowed',
    });
  });
}

runTests().catch(console.error);
