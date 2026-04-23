import { App, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
    toContain: (expected: any) => {
      if (!actual.includes(expected)) throw new Error(`Expected ${actual} to contain ${expected}`);
    },
    toHaveProperty: (prop: string) => {
      if (actual[prop] === undefined) throw new Error(`Expected object to have property ${prop}`);
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

function createFile(path: string, content = '# Test Content\nThis is a test note.') {
  const file = new TFile();
  file.path = path;
  file.basename = path.replace('.md', '');
  return { file, content };
}

async function runTests() {
  console.log('=== Vault Tool Integration Test ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { registerVaultTools } = await import('../src/skills/builtin/vault-ops');

  const { file: existingFile, content: existingContent } = createFile('test.md');
  const files = new Map<string, { file: TFile; content: string }>([
    ['test.md', { file: existingFile, content: existingContent }],
  ]);

  const mockApp = {
    vault: {
      getFiles: () => Array.from(files.values()).map(entry => entry.file),
      getMarkdownFiles: () => Array.from(files.values()).map(entry => ({
        ...entry.file,
        stat: { size: entry.content.length, mtime: Date.now() },
      })),
      create: async (path: string, content: string) => {
        const { file } = createFile(path, content);
        files.set(path, { file, content });
        return file;
      },
      read: async (file: TFile) => files.get(file.path)?.content || '',
      getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
      createFolder: async () => { },
      modify: async (file: TFile, content: string) => {
        const entry = files.get(file.path);
        if (entry) entry.content = content;
      },
      trash: async () => { },
      rename: async () => { },
    },
    metadataCache: {
      getFirstLinkpathDest: (path: string) => files.get(path)?.file || null,
    },
    workspace: {
      getLeaf: () => ({
        openFile: async (_file: TFile) => { },
      }),
    },
  } as unknown as App;

  await test('should expose core vault tool definitions', async () => {
    const registry = new ToolRegistry(mockApp, { ...DEFAULT_SETTINGS, confirmExecutions: false });
    registerVaultTools(registry);
    const tools = registry.getAllDefinitions();
    const toolNames = tools.map(t => t.name);

    expect(toolNames).toContain('read_note');
    expect(toolNames).toContain('create_note');
    expect(toolNames).toContain('search_vault');
  });

  await test('should execute read_note successfully', async () => {
    const registry = new ToolRegistry(mockApp, { ...DEFAULT_SETTINGS, confirmExecutions: false });
    registerVaultTools(registry);

    const result = await registry.execute('read_note', { path: 'test.md' });
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('content');
    expect(result.content).toContain('Test Content');
  });

  await test('should execute create_note successfully when confirmations are disabled', async () => {
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      confirmExecutions: false,
      allowFileCreation: true,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_note', {
      filename: 'new-note',
      content: '# New Note\nContent here',
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('new-note.md');
  });

  await test('should execute search_vault successfully', async () => {
    const registry = new ToolRegistry(mockApp, { ...DEFAULT_SETTINGS, confirmExecutions: false });
    registerVaultTools(registry);

    const result = await registry.execute('search_vault', { query: 'test' });
    expect(result).toHaveProperty('matches');
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length > 0).toBe(true);
  });
}

runTests().catch(console.error);
