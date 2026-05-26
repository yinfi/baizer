// src/skills/builtin/vault-ops.ts — Vault 文件操作工具集

import { App, TFile } from 'obsidian';
import { PluginSettings, VaultWriteScope } from '../../mcp/types';
import { Tool, ToolContext, ToolParameters } from '../types';
import { ToolRegistry } from '../tool-registry';
import { ChangePreview } from '../../ui/diff/change-preview';

// ==================== 工具定义 ====================

const MAX_FILE_READ_CHARS = 20000;

export interface VaultWriteTargetCheck {
  scope: VaultWriteScope;
  target: string;
  activeNote?: string | null;
  configuredFolders?: string[];
}

function normalizeScopePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isPathInsideFolder(target: string, folder: string): boolean {
  const normalizedTarget = normalizeScopePath(target);
  const normalizedFolder = normalizeScopePath(folder);
  if (!normalizedFolder) return false;
  return normalizedTarget === normalizedFolder || normalizedTarget.startsWith(`${normalizedFolder}/`);
}

export function canWriteToVaultTarget(input: VaultWriteTargetCheck): boolean {
  const target = normalizeScopePath(input.target);
  const activeNote = input.activeNote ? normalizeScopePath(input.activeNote) : '';
  const configuredFolders = (input.configuredFolders || []).map(normalizeScopePath).filter(Boolean);

  switch (input.scope) {
    case 'read-only':
      return false;
    case 'current-note':
      return !!activeNote && target === activeNote;
    case 'configured-folders':
      return configuredFolders.some((folder) => isPathInsideFolder(target, folder));
    case 'all-vault':
    default:
      return true;
  }
}

function getVaultWriteScope(settings: PluginSettings): VaultWriteScope {
  return settings.vaultWriteScope || 'all-vault';
}

function getVaultWriteFolders(settings: PluginSettings): string[] {
  return Array.isArray(settings.vaultWriteAllowedFolders) ? settings.vaultWriteAllowedFolders : [];
}

function getWriteScopeError(ctx: ToolContext, target: string): string | null {
  const activeNote = ctx.app.workspace.getActiveFile?.()?.path || null;
  const allowed = canWriteToVaultTarget({
    scope: getVaultWriteScope(ctx.settings),
    target,
    activeNote,
    configuredFolders: getVaultWriteFolders(ctx.settings),
  });
  return allowed ? null : `Write not allowed for path: ${target}`;
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
    const file = ctx.app.metadataCache.getFirstLinkpathDest(args.path, '');
    if (!file) return { error: 'File not found' };
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
    let path = args.filename || args.path || args.name;
    if (!path) return { status: 'error', message: 'Missing filename parameter' };
    if (!path.endsWith('.md')) path += '.md';

    const scopeError = getWriteScopeError(ctx, path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }

    if (!ctx.settings.allowFileCreation) {
      return { success: false, error: 'File creation is disabled' };
    }

    const existing = ctx.app.vault.getAbstractFileByPath(path);
    if (existing) {
      return { status: 'error', message: `File already exists: ${path}. Use update_note to modify existing files.` };
    }

    if (ctx.settings.confirmExecutions && !args.approved) {
      return buildApprovalResponse('create_note', path, {
        filename: path,
        content: args.content || '',
      }, 'create note', {
        kind: 'note-create',
        target: path,
        summary: 'Create note',
        newContent: args.content || '',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ensureParentFolder(ctx.app, path);
    await ctx.app.vault.create(path, args.content || '');
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
    const scopeError = getWriteScopeError(ctx, args.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (!ctx.settings.allowFileModification) {
      return { success: false, error: 'File modification is disabled' };
    }
    const file = ctx.app.vault.getAbstractFileByPath(args.path);
    if (!file || !(file instanceof TFile)) return { success: false, error: 'File not found' };
    if (ctx.settings.confirmExecutions && !args.approved) {
      const oldContent = await ctx.app.vault.read(file);
      return buildApprovalResponse('update_note', args.path, {
        path: args.path,
        content: args.content,
      }, 'update note', {
        kind: 'note-replace',
        target: args.path,
        summary: 'Replace note content',
        oldContent,
        newContent: args.content,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.modify(file, args.content);
    return { success: true, message: `✅ Updated: ${args.path}` };
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
    const scopeError = getWriteScopeError(ctx, args.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (!ctx.settings.allowFileModification) {
      return { success: false, error: 'File modification is disabled' };
    }
    const file = ctx.app.vault.getAbstractFileByPath(args.path);
    if (!file || !(file instanceof TFile)) return { success: false, error: 'File not found' };
    if (ctx.settings.confirmExecutions && !args.approved) {
      const existing = await ctx.app.vault.read(file);
      return buildApprovalResponse('append_to_note', args.path, {
        path: args.path,
        content: args.content,
      }, 'append to note', {
        kind: 'note-append',
        target: args.path,
        summary: 'Append to note',
        oldContent: existing,
        newContent: `${existing}\n${args.content}`,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    const existing = await ctx.app.vault.read(file);
    await ctx.app.vault.modify(file, existing + '\n' + args.content);
    return { success: true, message: `✅ Appended to: ${args.path}` };
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
    const scopeError = getWriteScopeError(ctx, args.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (!ctx.settings.allowFileModification) {
      return { success: false, error: 'File modification is disabled' };
    }
    const file = ctx.app.vault.getAbstractFileByPath(args.path);
    if (!file) return { success: false, error: 'File not found' };
    if (ctx.settings.confirmExecutions && !args.approved) {
      return buildApprovalResponse('delete_note', args.path, {
        path: args.path,
      }, 'delete note', {
        kind: 'note-delete',
        target: args.path,
        summary: 'Delete note',
        risk: 'high',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.trash(file, true);
    return { success: true, message: `✅ Deleted: ${args.path}` };
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
    const scopeError = getWriteScopeError(ctx, args.oldPath);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    const newPathScopeError = getWriteScopeError(ctx, args.newPath);
    if (newPathScopeError) {
      return { success: false, error: newPathScopeError };
    }
    if (!ctx.settings.allowFileModification) {
      return { success: false, error: 'File modification is disabled' };
    }
    const file = ctx.app.vault.getAbstractFileByPath(args.oldPath);
    if (!file) return { success: false, error: 'File not found' };
    if (ctx.settings.confirmExecutions && !args.approved) {
      return buildApprovalResponse('rename_note', args.oldPath, {
        oldPath: args.oldPath,
        newPath: args.newPath,
      }, 'rename note', {
        kind: 'note-rename',
        target: args.oldPath,
        summary: 'Rename note',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }
    await ctx.app.vault.rename(file, args.newPath);
    return { success: true, message: `✅ Renamed: ${args.oldPath} -> ${args.newPath}` };
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
    const folderPath = args.folder || '/';
    const limit = args.limit || 20;
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
    const matches = ctx.app.vault.getFiles()
      .filter(f => f.basename.toLowerCase().includes(args.query.toLowerCase()))
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
    const allFiles = ctx.app.vault.getFiles();
    let target = allFiles.find(f => f.path === args.path);
    if (!target) {
      target = allFiles.find(f =>
        f.basename === args.path || f.basename === args.path.replace('.md', '')
      );
    }
    if (!target) {
      const fuzzy = allFiles.filter(f =>
        f.path.toLowerCase().includes(args.path.toLowerCase())
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
    const pathResult = normalizeVaultPath(args.path);
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
    const pathResult = normalizeVaultPath(args.path);
    if (pathResult.error) return { success: false, error: pathResult.error };
    const scopeError = getWriteScopeError(ctx, pathResult.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (isObsidianConfigPath(pathResult.path)) {
      return { success: false, error: 'Writing .obsidian files is not allowed' };
    }
    if (!ctx.settings.allowFileCreation) {
      return { success: false, error: 'File creation is disabled' };
    }
    if (ctx.app.vault.getAbstractFileByPath(pathResult.path)) {
      return { success: false, error: `File already exists: ${pathResult.path}` };
    }
    if (ctx.settings.confirmExecutions && !args.approved) {
      return buildApprovalResponse('create_file', pathResult.path, {
        path: pathResult.path,
        content: args.content || '',
      }, 'create file', {
        kind: 'note-create',
        target: pathResult.path,
        summary: 'Create file',
        newContent: args.content || '',
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ensureParentFolder(ctx.app, pathResult.path);
    await ctx.app.vault.create(pathResult.path, args.content || '');
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
    const pathResult = normalizeVaultPath(args.path);
    if (pathResult.error) return { success: false, error: pathResult.error };
    const scopeError = getWriteScopeError(ctx, pathResult.path);
    if (scopeError) {
      return { success: false, error: scopeError };
    }
    if (isObsidianConfigPath(pathResult.path)) {
      return { success: false, error: 'Writing .obsidian files is not allowed' };
    }
    if (!ctx.settings.allowFileModification) {
      return { success: false, error: 'File modification is disabled' };
    }

    const file = ctx.app.vault.getAbstractFileByPath(pathResult.path);
    if (!isReadableVaultFile(file)) {
      return { success: false, error: 'File not found' };
    }
    if (ctx.settings.confirmExecutions && !args.approved) {
      const oldContent = await ctx.app.vault.read(file);
      return buildApprovalResponse('update_file', pathResult.path, {
        path: pathResult.path,
        content: args.content,
      }, 'update file', {
        kind: 'note-replace',
        target: pathResult.path,
        summary: 'Replace file content',
        oldContent,
        newContent: args.content,
        risk: 'medium',
        supportsPartialApply: false,
        undoable: true,
      });
    }

    await ctx.app.vault.modify(file, args.content);
    return {
      success: true,
      path: pathResult.path,
      message: `File updated: ${pathResult.path}`,
    };
  },
};

function normalizeVaultPath(rawPath: any): { path: string; error?: string } {
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
  return !!file && typeof file.path === 'string';
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

/** 高频核心工具（始终注册到 function calling） */
export const CORE_VAULT_TOOL_NAMES = [
  'read_note', 'create_note', 'update_note', 'append_to_note',
  'list_notes', 'search_vault', 'open_file',
  'read_file', 'create_file', 'update_file',
];

/** 危险操作工具（通过 vault-danger skill 按需激活） */
export const DANGER_VAULT_TOOL_NAMES = ['delete_note', 'rename_note'];

/**
 * 将所有 vault 工具注册到 ToolRegistry
 */
export function registerVaultTools(registry: ToolRegistry): void {
  for (const tool of ALL_VAULT_TOOLS) {
    registry.register(tool);
  }
  console.log(`[vault-ops] Registered ${ALL_VAULT_TOOLS.length} vault tools.`);
}
