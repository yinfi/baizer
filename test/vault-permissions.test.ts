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
  const { canWriteToVaultTarget, registerVaultTools } = await import('../src/skills/builtin/vault-ops');

  const created: string[] = [];
  const modified: string[] = [];
  const files = new Map<string, any>([
    ['existing.md', createFile('existing.md')],
    ['Projects/A.md', createFile('Projects/A.md')],
    ['Projects/B.md', createFile('Projects/B.md')],
    ['Allowed/Scoped.md', createFile('Allowed/Scoped.md')],
  ]);
  let activeFilePath = 'Projects/A.md';

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
      getActiveFile: () => files.get(activeFilePath) || null,
    },
  } as unknown as App;

  await test('canWriteToVaultTarget respects current-note and configured folder scopes', async () => {
    expect(canWriteToVaultTarget({
      scope: 'current-note',
      target: 'Projects/A.md',
      activeNote: 'Projects/A.md',
      configuredFolders: [],
    })).toBe(true);
    expect(canWriteToVaultTarget({
      scope: 'current-note',
      target: 'Projects/B.md',
      activeNote: 'Projects/A.md',
      configuredFolders: [],
    })).toBe(false);
    expect(canWriteToVaultTarget({
      scope: 'configured-folders',
      target: 'Allowed/Scoped.md',
      activeNote: 'Projects/A.md',
      configuredFolders: ['Allowed'],
    })).toBe(true);
    expect(canWriteToVaultTarget({
      scope: 'configured-folders',
      target: 'Projects/B.md',
      activeNote: 'Projects/A.md',
      configuredFolders: ['Allowed'],
    })).toBe(false);
  });

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

  await test('create_note uses the standard error result for invalid or existing targets', async () => {
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      confirmExecutions: false,
    });
    registerVaultTools(registry);

    expect(await registry.execute('create_note', { content: '# Missing' })).toEqual({
      success: false,
      error: 'Missing filename parameter',
    });
    expect(await registry.execute('create_note', { filename: 'existing.md', content: '# Existing' })).toEqual({
      success: false,
      error: 'File already exists: existing.md. Use update_note to modify existing files.',
    });
  });

  await test('read_note uses the standard error result when a note is missing', async () => {
    const registry = new ToolRegistry(mockApp, DEFAULT_SETTINGS);
    registerVaultTools(registry);

    expect(await registry.execute('read_note', { path: 'missing.md' })).toEqual({
      success: false,
      error: 'File not found',
    });
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
      preview: {
        kind: 'note-create',
        target: 'approval-note.md',
        summary: 'Create note',
        newContent: '# Approval',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      },
    });
    expect(created.length).toBe(0);
  });

  await test('create_note executes after approval when approved flag is provided', async () => {
    created.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      confirmExecutions: true,
    });
    registerVaultTools(registry);

    const result = await registry.execute('create_note', {
      filename: 'approved-note',
      content: '# Approved',
      approved: true,
    });

    expect(result).toEqual({
      status: 'success',
      message: '✅ Note created: approved-note.md',
    });
    expect(created).toEqual(['approved-note.md']);
  });

  await test('update_note blocks writes outside the active note when scope is current-note', async () => {
    modified.length = 0;
    activeFilePath = 'Projects/A.md';
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileModification: true,
      confirmExecutions: false,
      vaultWriteScope: 'current-note',
    } as any);
    registerVaultTools(registry);

    const result = await registry.execute('update_note', {
      path: 'Projects/B.md',
      content: 'updated',
    });

    expect(result).toEqual({
      success: false,
      error: 'Write not allowed for path: Projects/B.md',
    });
    expect(modified.length).toBe(0);
  });

  await test('create_file allows writes inside configured folders only', async () => {
    created.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      confirmExecutions: false,
      vaultWriteScope: 'configured-folders',
      vaultWriteAllowedFolders: ['Allowed'],
    } as any);
    registerVaultTools(registry);

    const allowed = await registry.execute('create_file', {
      path: 'Allowed/new.canvas',
      content: '{}',
    });
    const blocked = await registry.execute('create_file', {
      path: 'Blocked/new.canvas',
      content: '{}',
    });

    expect(allowed).toEqual({
      success: true,
      path: 'Allowed/new.canvas',
      message: 'File created: Allowed/new.canvas',
    });
    expect(blocked).toEqual({
      success: false,
      error: 'Write not allowed for path: Blocked/new.canvas',
    });
  });
}

runTests().catch(console.error);
