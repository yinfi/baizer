// src/skills/builtin/vault-ops.ts — Vault 文件操作工具集

import { App, TFile } from 'obsidian';
import { Tool, ToolContext } from '../types';
import { ToolRegistry } from '../tool-registry';
import { logger } from '../../utils/logger';
import { ChangePreview } from '../../ui/diff/change-preview';
import {
  checkWriteScope,
  checkFileCapability,
  needsApproval,
  canWriteToVaultTarget as canWriteToVaultTargetImpl,
  type VaultWriteTargetCheck,
} from '../../permissions/permission-service';

// ==================== 工具定义 ====================

const MAX_FILE_READ_CHARS = 20000;

// ==================== 参数窄化 ====================
// 工具 args 是模型生成的 JSON（外部输入）：统一按 unknown 处理，再按字段类型取值。
// 这样既不再依赖 any，也保留了原来 `args.x || 默认值` 的容错语义。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(args: unknown, key: string): string {
  if (!isRecord(args)) return '';
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function readField(args: unknown, key: string): unknown {
  return isRecord(args) ? args[key] : undefined;
}

/** 与原 `args.limit || 20` 对齐：只有数字真值才采用（0 / NaN / 非数字走默认值）。 */
function readNumber(args: unknown, key: string): number | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === 'number' && value ? value : undefined;
}

/** 与原 `!args.approved` 对齐：任何真值都算已批准。 */
function hasFlag(args: unknown, key: string): boolean {
  return isRecord(args) && Boolean(args[key]);
}

// 权限决策已迁入 PermissionService（Stage 2）。这里再导出 canWriteToVaultTarget
// 与其类型，保持既有调用方（test/vault-permissions.test.ts 等）import 路径不变。
export { canWriteToVaultTargetImpl as canWriteToVaultTarget };
export type { VaultWriteTargetCheck };

/** 写入范围检查：从 ctx 取 activeNote 后委托 PermissionService.checkWriteScope。 */
function getWriteScopeError(ctx: ToolContext, target: string): string | null {
  const activeNote = ctx.app.workspace.getActiveFile?.()?.path || null;
  return checkWriteScope(target, ctx.settings, activeNote);
}

const readNote: Tool = {
  name: 'read_note',
  description: 'Read the content of a specific note in the vault.',
  executionMode: 'parallel',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path to the note (e.g., "Folder/Note.md")' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = readString(args, 'path');
    const file = ctx.app.metadataCache.getFirstLinkpathDest(path, '');
    if (!file) return { success: false, error: 'File not found' };
    const content = await ctx.app.vault.read(file);
    return { path: file.path, content: content.substring(0, 5000) };
  },
};

const createNote: Tool = {
  name: 'create_note',
  description: 'Create a new note with the specified content.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'The name/path of the new note' },
      content: { type: 'string', description: 'The content to write to the note' },
    },
    required: ['filename', 'content'],
  },
  async execute(args, ctx) {
    let path = readString(args, 'filename') || readString(args, 'path') || readString(args, 'name');
    const content = readString(args, 'content');
    if (!path) return { success: false, error: 'Missing filename parameter' };
    if (!path.endsWith('.md')) path += '.md';

    const scopeError = getWriteScopeError(ctx, path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }

    const capabilityError = checkFileCapability('create', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }

    const existing = ctx.app.vault.getAbstractFileByPath(path);
    if (existing) {
      return { success: false, error: `File already exists: ${path}. Use update_note to modify existing files.` };
    }

    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      return buildApprovalResponse('create_note', path, {
        filename: path,
        content: content || '',
      }, 'create note', {
        kind: 'note-create',
        target: path,
        summary: 'Create note',
        newContent: content || '',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ensureParentFolder(ctx.app, path);
    await ctx.app.vault.create(path, content || '');
    return { status: 'success', message: `✅ Note created: ${path}` };
  },
};

const updateNote: Tool = {
  name: 'update_note',
  description: 'Update the content of an existing note. Replaces the entire content.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path to the note to update' },
      content: { type: 'string', description: 'The new content for the note' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const path = readString(args, 'path');
    const content = readString(args, 'content');
    const scopeError = getWriteScopeError(ctx, path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    const capabilityError = checkFileCapability('modify', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }
    const file = ctx.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return { success: false, error: 'File not found' };
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      const oldContent = await ctx.app.vault.read(file);
      return buildApprovalResponse('update_note', path, {
        path,
        content,
      }, 'update note', {
        kind: 'note-replace',
        target: path,
        summary: 'Replace note content',
        oldContent,
        newContent: content,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.modify(file, content);
    return { success: true, message: `✅ Updated: ${path}` };
  },
};

const appendToNote: Tool = {
  name: 'append_to_note',
  description: 'Append content to the end of an existing note.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path to the note' },
      content: { type: 'string', description: 'The content to append' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const path = readString(args, 'path');
    const content = readString(args, 'content');
    const scopeError = getWriteScopeError(ctx, path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    const capabilityError = checkFileCapability('modify', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }
    const file = ctx.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return { success: false, error: 'File not found' };
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      const existing = await ctx.app.vault.read(file);
      return buildApprovalResponse('append_to_note', path, {
        path,
        content,
      }, 'append to note', {
        kind: 'note-append',
        target: path,
        summary: 'Append to note',
        oldContent: existing,
        newContent: `${existing}\n${content}`,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    const existing = await ctx.app.vault.read(file);
    await ctx.app.vault.modify(file, existing + '\n' + content);
    return { success: true, message: `✅ Appended to: ${path}` };
  },
};

const deleteNote: Tool = {
  name: 'delete_note',
  description: 'Delete a note from the vault.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path to the note to delete' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = readString(args, 'path');
    const scopeError = getWriteScopeError(ctx, path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    const capabilityError = checkFileCapability('modify', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }
    const file = ctx.app.vault.getAbstractFileByPath(path);
    if (!file) return { success: false, error: 'File not found' };
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      return buildApprovalResponse('delete_note', path, {
        path,
      }, 'delete note', {
        kind: 'note-delete',
        target: path,
        summary: 'Delete note',
        risk: 'high',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.trash(file, true);
    return { success: true, message: `✅ Deleted: ${path}` };
  },
};

const renameNote: Tool = {
  name: 'rename_note',
  description: 'Rename or move a note.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      oldPath: { type: 'string', description: 'The current path of the note' },
      newPath: { type: 'string', description: 'The new path/name for the note' },
    },
    required: ['oldPath', 'newPath'],
  },
  async execute(args, ctx) {
    const oldPath = readString(args, 'oldPath');
    const newPath = readString(args, 'newPath');
    const scopeError = getWriteScopeError(ctx, oldPath);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    const newPathScopeError = getWriteScopeError(ctx, newPath);
    if (newPathScopeError) {
      return { success: false, error: newPathScopeError };
    }
    const capabilityError = checkFileCapability('modify', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }
    const file = ctx.app.vault.getAbstractFileByPath(oldPath);
    if (!file) return { success: false, error: 'File not found' };
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      return buildApprovalResponse('rename_note', oldPath, {
        oldPath,
        newPath,
      }, 'rename note', {
        kind: 'note-rename',
        target: oldPath,
        summary: 'Rename note',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.rename(file, newPath);
    return { success: true, message: `✅ Renamed: ${oldPath} -> ${newPath}` };
  },
};

const listNotes: Tool = {
  name: 'list_notes',
  description: 'List notes in a specific folder or the entire vault.',
  executionMode: 'parallel',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'The folder to list (optional, defaults to root)' },
      limit: { type: 'integer', description: 'Maximum number of notes to return (default 20)' },
    },
  },
  async execute(args, ctx) {
    const folderPath = readString(args, 'folder') || '/';
    const limit = readNumber(args, 'limit') ?? 20;
    let files = ctx.app.vault.getMarkdownFiles();
    if (folderPath !== '/') {
      files = files.filter(f => f.path.startsWith(folderPath));
    }
    const fileList = files.slice(0, limit).map(f => ({
      path: f.path,
      name: f.basename,
      size: f.stat.size,
      modified: new Date(f.stat.mtime).toISOString(),
    }));
    return { success: true, files: fileList, total: files.length };
  },
};

const searchVault: Tool = {
  name: 'search_vault',
  description: 'Search for files in the vault by name.',
  executionMode: 'parallel',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = readString(args, 'query');
    if (!query) return { matches: [] };
    const matches = ctx.app.vault.getFiles()
      .filter(f => f.basename.toLowerCase().includes(query.toLowerCase()))
      .map(f => f.path)
      .slice(0, 5);
    return { matches };
  },
};

const openFile: Tool = {
  name: 'open_file',
  description: 'Open a file in the Obsidian workspace.',
  executionMode: 'sequential',
  risk: 'unknown',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path or name of the file to open' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = readString(args, 'path');
    if (!path) return { success: false, error: 'Missing path parameter' };
    const allFiles = ctx.app.vault.getFiles();
    let target = allFiles.find(f => f.path === path);
    if (!target) {
      target = allFiles.find(f =>
        f.basename === path || f.basename === path.replace('.md', '')
      );
    }
    if (!target) {
      const fuzzy = allFiles.filter(f =>
        f.path.toLowerCase().includes(path.toLowerCase())
      );
      if (fuzzy.length === 1) {
        target = fuzzy[0];
      } else if (fuzzy.length > 1) {
        return { success: false, error: `Found ${fuzzy.length} matches`, matches: fuzzy.map(f => f.path) };
      }
    }
    if (!target) return { success: false, error: 'File not found' };
    const leaf = ctx.app.workspace.getLeaf(false);
    await leaf.openFile(target);
    return { success: true, path: target.path, message: `✅ Opened: ${target.path}` };
  },
};

// ==================== 辅助函数 ====================

const readFile: Tool = {
  name: 'read_file',
  description: 'Read the exact content of a text file in the vault, including .md, .canvas, .base, and .json files.',
  executionMode: 'parallel',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Exact vault path to the file, e.g. "Boards/map.canvas"' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const pathResult = normalizeVaultPath(readField(args, 'path'));
    if (pathResult.error) return { success: false, error: pathResult.error };

    const file = ctx.app.vault.getAbstractFileByPath(pathResult.path);
    if (!isReadableVaultFile(file)) {
      return { success: false, error: 'File not found' };
    }

    const content = await ctx.app.vault.read(file);
    const truncated = content.length > MAX_FILE_READ_CHARS;
    return {
      success: true,
      path: file.path,
      content: truncated ? content.slice(0, MAX_FILE_READ_CHARS) : content,
      truncated,
    };
  },
};

const createFile: Tool = {
  name: 'create_file',
  description: 'Create a new text file in the vault without changing its extension. Supports .md, .canvas, .base, and .json files.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Exact vault path for the new file, e.g. "Bases/tasks.base"' },
      content: { type: 'string', description: 'The complete file content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const pathResult = normalizeVaultPath(readField(args, 'path'));
    const content = readString(args, 'content');
    if (pathResult.error) return { success: false, error: pathResult.error };
    const scopeError = getWriteScopeError(ctx, pathResult.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (isObsidianConfigPath(pathResult.path)) {
      return { success: false, error: 'Writing .obsidian files is not allowed' };
    }
    const capabilityError = checkFileCapability('create', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }
    if (ctx.app.vault.getAbstractFileByPath(pathResult.path)) {
      return { success: false, error: `File already exists: ${pathResult.path}` };
    }
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      return buildApprovalResponse('create_file', pathResult.path, {
        path: pathResult.path,
        content: content || '',
      }, 'create file', {
        kind: 'note-create',
        target: pathResult.path,
        summary: 'Create file',
        newContent: content || '',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ensureParentFolder(ctx.app, pathResult.path);
    await ctx.app.vault.create(pathResult.path, content || '');
    return {
      success: true,
      path: pathResult.path,
      message: `File created: ${pathResult.path}`,
    };
  },
};

const updateFile: Tool = {
  name: 'update_file',
  description: 'Replace the exact content of an existing text file in the vault. Supports .md, .canvas, .base, and .json files.',
  executionMode: 'sequential',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Exact vault path to the file to update' },
      content: { type: 'string', description: 'The complete replacement file content' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const pathResult = normalizeVaultPath(readField(args, 'path'));
    const content = readString(args, 'content');
    if (pathResult.error) return { success: false, error: pathResult.error };
    const scopeError = getWriteScopeError(ctx, pathResult.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (isObsidianConfigPath(pathResult.path)) {
      return { success: false, error: 'Writing .obsidian files is not allowed' };
    }
    const capabilityError = checkFileCapability('modify', ctx.settings);
    if (capabilityError) {
      return { success: false, error: capabilityError };
    }

    const file = ctx.app.vault.getAbstractFileByPath(pathResult.path);
    if (!isReadableVaultFile(file)) {
      return { success: false, error: 'File not found' };
    }
    if (needsApproval('write', ctx.settings) && !hasFlag(args, 'approved')) {
      const oldContent = await ctx.app.vault.read(file);
      return buildApprovalResponse('update_file', pathResult.path, {
        path: pathResult.path,
        content,
      }, 'update file', {
        kind: 'note-replace',
        target: pathResult.path,
        summary: 'Replace file content',
        oldContent,
        newContent: content,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ctx.app.vault.modify(file, content);
    return {
      success: true,
      path: pathResult.path,
      message: `File updated: ${pathResult.path}`,
    };
  },
};

function normalizeVaultPath(rawPath: unknown): { path: string; error?: string } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { path: '', error: 'Missing path parameter' };
  }

  const path = rawPath.trim().replace(/\\/g, '/');
  const parts = path.split('/');

  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    parts.some(part => part === '..') ||
    parts.some(part => part.trim() === '')
  ) {
    return { path, error: 'Unsafe vault path' };
  }

  return { path };
}

function isObsidianConfigPath(path: string): boolean {
  return path === '.obsidian' || path.startsWith('.obsidian/');
}

function isReadableVaultFile(file: any): file is TFile {
  return file instanceof TFile;
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parts = path.split('/');
  if (parts.length <= 1) return;
  const folderPath = parts.slice(0, -1).join('/');
  if (!folderPath || app.vault.getAbstractFileByPath(folderPath)) return;
  try {
    await app.vault.createFolder(folderPath);
  } catch (e) {
    // 文件夹可能已存在（并发创建）
  }
}

function buildApprovalResponse(
  action: string,
  target: string,
  args: Record<string, any>,
  description: string,
  preview?: ChangePreview,
) {
  return {
    approval_required: true,
    action,
    target,
    args,
    message: `Approval required to ${description}: ${target}`,
    preview,
  };
}

// ==================== 注册 ====================

/** 所有 vault 操作工具 */
const ALL_VAULT_TOOLS: Tool[] = [
  readNote, createNote, updateNote, appendToNote,
  deleteNote, renameNote, listNotes, searchVault, openFile,
  readFile, createFile, updateFile,
];

/**
 * 将所有 vault 工具注册到 ToolRegistry
 */
export function registerVaultTools(registry: ToolRegistry): void {
  for (const tool of ALL_VAULT_TOOLS) {
    registry.register(tool);
  }
  logger.info(`Registered ${ALL_VAULT_TOOLS.length} vault tools.`, 'vault-ops');
}
