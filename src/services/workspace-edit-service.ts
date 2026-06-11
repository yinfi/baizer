import { App, TFile } from 'obsidian';
import { ToolRegistry } from '../skills/tool-registry';
import { getFileWriteResultPath } from '../utils/file-operation-contract';

export type WorkspaceEditKind = 'create' | 'update';

export interface WorkspaceEditSummary {
  id: string;
  action: string;
  path: string;
  kind: WorkspaceEditKind;
  appliedAt: number;
  status: 'applied' | 'undone';
  lineDelta?: number;
}

interface WorkspaceEditRecord {
  order: number;
  summary: WorkspaceEditSummary;
  beforeExists: boolean;
  beforeContent: string;
  beforeHash: string;
  afterExists: boolean;
  afterContent: string;
  afterHash: string;
}

export interface WorkspaceEditResult {
  success: boolean;
  edit?: WorkspaceEditSummary;
  error?: string;
}

export interface WorkspaceEditServiceOptions {
  onEditApplied?: (input: {
    edit: WorkspaceEditSummary;
    previousContent?: string;
  }) => void | Promise<void>;
}

const DIRECT_APPLY_WRITE_TOOLS = new Set([
  'create_file',
  'update_file',
  'create_note',
  'update_note',
  'append_to_note',
  'save_webpage',
]);

export function isDirectApplyWorkspaceTool(name: string): boolean {
  return DIRECT_APPLY_WRITE_TOOLS.has(name);
}

export class WorkspaceEditService {
  private readonly records = new Map<string, WorkspaceEditRecord>();
  private nextEditOrder = 0;

  constructor(
    private readonly app: App,
    private readonly toolRegistry: ToolRegistry,
    private readonly options: WorkspaceEditServiceOptions = {},
  ) {}

  async executeWorkspaceTool(action: string, args: Record<string, any>): Promise<any> {
    if (!isDirectApplyWorkspaceTool(action)) {
      return this.toolRegistry.execute(action, args);
    }

    const expectedPath = this.resolveExpectedPath(action, args);
    const beforeSnapshot = expectedPath
      ? await this.readOptionalFile(expectedPath)
      : { exists: false, content: '' };

    const approvedArgs = { ...args, approved: true };
    const result = await this.toolRegistry.execute(action, approvedArgs);
    if (!this.isSuccessfulToolResult(result)) return result;

    const path = this.resolveResultPath(action, result, approvedArgs, expectedPath);
    if (!path) return result;

    const afterSnapshot = await this.readOptionalFile(path);
    const summary: WorkspaceEditSummary = {
      id: this.createId(),
      action,
      path,
      kind: beforeSnapshot.exists ? 'update' : 'create',
      appliedAt: Date.now(),
      status: 'applied',
      lineDelta: this.countLines(afterSnapshot.content) - this.countLines(beforeSnapshot.content),
    };

    this.records.set(summary.id, {
      order: ++this.nextEditOrder,
      summary,
      beforeExists: beforeSnapshot.exists,
      beforeContent: beforeSnapshot.content,
      beforeHash: this.hashContent(beforeSnapshot.content),
      afterExists: afterSnapshot.exists,
      afterContent: afterSnapshot.content,
      afterHash: this.hashContent(afterSnapshot.content),
    });

    await this.notifyEditApplied(summary, beforeSnapshot.exists ? beforeSnapshot.content : undefined);
    await this.openFile(path);
    return { ...result, workspaceEdit: { ...summary } };
  }

  async undoWorkspaceEdit(editId: string): Promise<WorkspaceEditResult> {
    const record = this.records.get(editId);
    if (!record) {
      return { success: false, error: 'Workspace edit not found' };
    }
    if (record.summary.status === 'undone') {
      return { success: false, error: 'Workspace edit already undone' };
    }
    if (!this.isLatestAppliedEditForPath(record)) {
      return {
        success: false,
        error: `Undo the latest AI edit to ${record.summary.path} first.`,
      };
    }

    const file = this.app.vault.getAbstractFileByPath(record.summary.path);
    if (!(file instanceof TFile)) {
      return { success: false, error: `File not found: ${record.summary.path}` };
    }

    const currentContent = await this.app.vault.read(file);
    if (this.hashContent(currentContent) !== record.afterHash) {
      return {
        success: false,
        error: `Cannot undo ${record.summary.path}; file changed since the AI edit.`,
      };
    }

    if (record.beforeExists) {
      await this.app.vault.modify(file, record.beforeContent);
      await this.openFile(record.summary.path);
    } else {
      await this.app.vault.trash(file, true);
    }

    record.summary = { ...record.summary, status: 'undone' };
    this.records.set(editId, record);
    return { success: true, edit: { ...record.summary } };
  }

  async undoAllWorkspaceEdits(): Promise<WorkspaceEditResult[]> {
    const active = Array.from(this.records.values())
      .filter(record => record.summary.status === 'applied')
      .sort((a, b) => b.order - a.order);

    const results: WorkspaceEditResult[] = [];
    for (const record of active) {
      results.push(await this.undoWorkspaceEdit(record.summary.id));
    }
    return results;
  }

  listWorkspaceEdits(): WorkspaceEditSummary[] {
    return Array.from(this.records.values()).map(record => ({ ...record.summary }));
  }

  private isLatestAppliedEditForPath(record: WorkspaceEditRecord): boolean {
    const newer = Array.from(this.records.values()).some(candidate =>
      candidate.summary.status === 'applied'
      && candidate.summary.path === record.summary.path
      && candidate.order > record.order
    );
    return !newer;
  }

  private async readOptionalFile(path: string): Promise<{ exists: boolean; content: string }> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { exists: false, content: '' };
    return {
      exists: true,
      content: await this.app.vault.read(file),
    };
  }

  private resolveExpectedPath(action: string, args: Record<string, any>): string {
    if (action === 'create_note') {
      const filename = args.filename || args.path || args.name || '';
      if (!filename || typeof filename !== 'string') return '';
      return filename.endsWith('.md') ? filename : `${filename}.md`;
    }
    if (typeof args.path === 'string') return args.path;
    if (typeof args.filename === 'string') return args.filename;
    return '';
  }

  private resolveResultPath(
    action: string,
    result: any,
    args: Record<string, any>,
    fallbackPath: string,
  ): string {
    if (action === 'create_note') {
      return typeof result?.path === 'string'
        ? result.path
        : typeof result?.target === 'string'
          ? result.target
          : fallbackPath;
    }
    return getFileWriteResultPath(action, result, args) || fallbackPath;
  }

  private async openFile(path: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      await this.app.workspace.getLeaf(false)?.openFile?.(file);
    } catch {
      // Opening is best-effort; the write itself remains the source of truth.
    }
  }

  private async notifyEditApplied(summary: WorkspaceEditSummary, previousContent?: string): Promise<void> {
    if (!this.options.onEditApplied) return;
    try {
      await this.options.onEditApplied({
        edit: { ...summary },
        previousContent,
      });
    } catch {
      // Audit failures should not make a completed workspace write look failed.
    }
  }

  private isSuccessfulToolResult(result: any): boolean {
    return result?.success === true || result?.status === 'success';
  }

  private createId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private countLines(content: string): number {
    if (!content) return 0;
    return content.split(/\r?\n/).length;
  }

  private hashContent(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash = hash & 0xffffffff;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
