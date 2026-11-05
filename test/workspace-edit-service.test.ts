import { App, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import { ToolRegistry } from '../src/skills/tool-registry';
import { registerVaultTools } from '../src/skills/builtin/vault-ops';
import { WorkspaceEditService } from '../src/services/workspace-edit-service';

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
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
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
  const opened: string[] = [];
  const trashed: string[] = [];
  const files = new Map<string, any>([
    ['Notes', { path: 'Notes' }],
    ['Notes/source.md', createFile('Notes/source.md')],
  ]);
  const contents = new Map<string, string>([
    ['Notes/source.md', 'before'],
  ]);

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      createFolder: async () => undefined,
      create: async (path: string, content: string) => {
        const file = createFile(path);
        files.set(path, file);
        contents.set(path, content);
        return file;
      },
      modify: async (file: any, content: string) => {
        contents.set(file.path, content);
      },
      read: async (file: any) => {
        if (!contents.has(file.path)) {
          throw new Error('EISDIR: illegal operation on a directory, read');
        }
        return contents.get(file.path) || '';
      },
      trash: async (file: any) => {
        trashed.push(file.path);
        files.delete(file.path);
        contents.delete(file.path);
      },
      getFiles: () => Array.from(files.values()),
      getMarkdownFiles: () => Array.from(files.values()).filter(file => file.extension === 'md'),
    },
    metadataCache: {
      getFirstLinkpathDest: (path: string) => files.get(path) || null,
    },
    workspace: {
      getActiveFile: () => files.get('Notes/source.md'),
      getLeaf: () => ({
        openFile: async (file: any) => {
          opened.push(file.path);
        },
      }),
    },
  } as unknown as App;

  return { app, files, contents, opened, trashed };
}

function createService(app: App) {
  const registry = new ToolRegistry(app, {
    ...DEFAULT_SETTINGS,
    allowFileCreation: true,
    allowFileModification: true,
    confirmExecutions: true,
  });
  registerVaultTools(registry);
  return new WorkspaceEditService(app, registry);
}

async function runTests() {
  console.log('=== Workspace Edit Service Tests ===');

  await test('safe update_file applies immediately and can be undone', async () => {
    const { app, contents, opened } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'after',
    });

    expect(result.success).toBe(true);
    expect(result.workspaceEdit.path).toBe('Notes/source.md');
    expect(contents.get('Notes/source.md')).toBe('after');
    expect(opened).toEqual(['Notes/source.md']);

    const undo = await service.undoWorkspaceEdit(result.workspaceEdit.id);

    expect(undo.success).toBe(true);
    expect(contents.get('Notes/source.md')).toBe('before');
    expect(opened).toEqual(['Notes/source.md', 'Notes/source.md']);
  });

  await test('undo refuses to overwrite user edits made after AI application', async () => {
    const { app, contents } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'after',
    });
    contents.set('Notes/source.md', 'user changed this again');

    const undo = await service.undoWorkspaceEdit(result.workspaceEdit.id);

    expect(undo.success).toBe(false);
    expect(undo.error).toContain('changed since the AI edit');
    expect(contents.get('Notes/source.md')).toBe('user changed this again');
  });

  await test('undo requires the latest AI edit first when a file has stacked edits', async () => {
    const { app, contents } = createMockApp();
    const service = createService(app);

    const first = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'after 1',
    });
    await new Promise(resolve => setTimeout(resolve, 1));
    const second = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'after 2',
    });

    const staleUndo = await service.undoWorkspaceEdit(first.workspaceEdit.id);
    expect(staleUndo.success).toBe(false);
    expect(staleUndo.error).toContain('latest AI edit');
    expect(contents.get('Notes/source.md')).toBe('after 2');

    const latestUndo = await service.undoWorkspaceEdit(second.workspaceEdit.id);
    expect(latestUndo.success).toBe(true);
    expect(contents.get('Notes/source.md')).toBe('after 1');

    const firstUndo = await service.undoWorkspaceEdit(first.workspaceEdit.id);
    expect(firstUndo.success).toBe(true);
    expect(contents.get('Notes/source.md')).toBe('before');
  });

  await test('undo still requires the latest AI edit first when stacked edits share a timestamp', async () => {
    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const { app, contents } = createMockApp();
      const service = createService(app);

      const first = await service.executeWorkspaceTool('update_file', {
        path: 'Notes/source.md',
        content: 'same millisecond 1',
      });
      const second = await service.executeWorkspaceTool('update_file', {
        path: 'Notes/source.md',
        content: 'same millisecond 2',
      });

      const staleUndo = await service.undoWorkspaceEdit(first.workspaceEdit.id);
      expect(staleUndo.success).toBe(false);
      expect(staleUndo.error).toContain('latest AI edit');
      expect(contents.get('Notes/source.md')).toBe('same millisecond 2');

      const latestUndo = await service.undoWorkspaceEdit(second.workspaceEdit.id);
      expect(latestUndo.success).toBe(true);
      expect(contents.get('Notes/source.md')).toBe('same millisecond 1');
    } finally {
      Date.now = originalNow;
    }
  });

  await test('undoing a created file trashes the created file', async () => {
    const { app, files, contents, trashed } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('create_file', {
      path: 'Notes/new.md',
      content: 'new content',
    });

    expect(result.success).toBe(true);
    expect(files.has('Notes/new.md')).toBe(true);
    expect(contents.get('Notes/new.md')).toBe('new content');

    const undo = await service.undoWorkspaceEdit(result.workspaceEdit.id);

    expect(undo.success).toBe(true);
    expect(files.has('Notes/new.md')).toBe(false);
    expect(trashed).toEqual(['Notes/new.md']);
  });

  await test('create_note summaries use the normalized markdown path', async () => {
    const { app } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('create_note', {
      filename: 'Notes/new-note',
      content: 'new content',
    });

    expect(result.workspaceEdit.path).toBe('Notes/new-note.md');
  });

  await test('dangerous write tools are not handled by the direct workspace edit path', async () => {
    const { app } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('delete_note', {
      path: 'Notes/source.md',
    });

    expect(result.approval_required).toBe(true);
  });

  await test('direct workspace writes do not read folders while taking snapshots', async () => {
    const { app } = createMockApp();
    const service = createService(app);

    const result = await service.executeWorkspaceTool('create_file', {
      path: 'Notes',
      content: 'new content',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File already exists');
  });
  await test('non-string path arguments are rejected without recording a workspace edit', async () => {
    const { app, contents, opened } = createMockApp();
    const service = createService(app);

    // 工具参数来自模型，可能是错类型：resolveExpectedPath 只认字符串，
    // 工具本身也会拒绝，故不应产生编辑记录、打开文件或改动内容。
    const result = await service.executeWorkspaceTool('update_file', { path: 42, content: 'x' });

    expect(result.success).toBe(false);
    expect(result.workspaceEdit).toBe(undefined);
    expect(opened).toEqual([]);
    expect(contents.get('Notes/source.md')).toBe('before');
  });

  await test('create_note falls back to a string path when filename is the wrong type', async () => {
    const { app, files } = createMockApp();
    const service = createService(app);

    // filename 是数字（错类型）时不参与路径归一，回落 path 字段——不会拼出 "42.md"。
    const result = await service.executeWorkspaceTool('create_note', {
      filename: 42,
      path: 'Notes/typed.md',
      content: 'content',
    });

    expect(result.status).toBe('success');
    expect(files.has('Notes/typed.md')).toBe(true);
    expect(Array.from(files.keys()).some((path) => path.includes('42'))).toBe(false);
  });

  await test('narrows malformed tool results instead of inventing a workspace edit', async () => {
    const { app } = createMockApp();
    const registry = new ToolRegistry(app, {
      ...DEFAULT_SETTINGS,
      allowFileCreation: true,
      allowFileModification: true,
      confirmExecutions: true,
    });
    registerVaultTools(registry);
    const service = new WorkspaceEditService(app, registry);

    // 非对象结果：既不能算成功（原值透传、不登记编辑），也不会被当成 {path}/{target} 读取。
    (registry as any).execute = async () => 'not-an-object';
    const malformed = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'x',
    });
    expect(malformed).toBe('not-an-object');
    expect(service.listWorkspaceEdits().length).toBe(0);

    // 成功但没有 path/target：回退到按 args 推出的预期路径（旧代码的 fallbackPath 分支）。
    (registry as any).execute = async () => ({ success: true });
    const fallback = await service.executeWorkspaceTool('create_note', {
      filename: 'Notes/fallback.md',
      content: 'x',
    });
    expect(fallback.workspaceEdit.path).toBe('Notes/fallback.md');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
