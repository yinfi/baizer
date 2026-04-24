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
  file.basename = path.replace('.md', '');
  return file;
}

async function runTests() {
  console.log('=== Vault Permission Tests ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { registerVaultTools } = await import('../src/skills/builtin/vault-ops');

  const created: string[] = [];
  const modified: string[] = [];
  const files = new Map<string, any>([
    ['existing.md', createFile('existing.md')],
  ]);

  const mockApp = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      createFolder: async () => { },
      create: async (path: string, _content: string) => {
        created.push(path);
        const file = createFile(path);
        files.set(path, file);
        return file;
      },
      modify: async (file: any, _content: string) => {
        modified.push(file.path);
      },
      read: async () => 'current',
      trash: async () => { },
      rename: async () => { },
      getMarkdownFiles: () => [],
      getFiles: () => [],
    },
    metadataCache: {
      getFirstLinkpathDest: (path: string) => files.get(path) || null,
    },
    workspace: {
      getLeaf: () => ({ openFile: async () => { } }),
    },
  } as unknown as App;

  await test('create_note respects allowFileCreation', async () => {
    created.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: false,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_note', {
      filename: 'new-note',
      content: '# New',
    });

    expect(result).toEqual({
      success: false,
      error: 'File creation is disabled',
    });
    expect(created.length).toBe(0);
  });

  await test('update_note respects allowFileModification', async () => {
    modified.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileModification: false,
    });
    registerVaultTools(registry);

    const result = await registry.execute('update_note', {
      path: 'existing.md',
      content: 'updated',
    });

    expect(result).toEqual({
      success: false,
      error: 'File modification is disabled',
    });
    expect(modified.length).toBe(0);
  });

  await test('create_note returns approval_required when confirmExecutions is enabled', async () => {
    created.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      confirmExecutions: true,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_note', {
      filename: 'approval-note',
      content: '# Approval',
    });

    expect(result).toEqual({
      approval_required: true,
      action: 'create_note',
      target: 'approval-note.md',
      args: {
        filename: 'approval-note.md',
        content: '# Approval',
      },
      message: 'Approval required to create note: approval-note.md',
    });
    expect(created.length).toBe(0);
  });
}

runTests().catch(console.error);
