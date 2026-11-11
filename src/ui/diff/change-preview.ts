export type ChangePreviewKind =
  | 'editor-selection-replace'
  | 'note-replace'
  | 'note-append'
  | 'note-create'
  | 'note-rename'
  | 'note-delete'
  | 'plugin-command'
  | 'external-publish';

/**
 * 对外发布的**不可编辑**元信息。
 *
 * 刻意不含 title 与 body：可编辑的字节一律只存在于 `request.args`（见
 * approval-card 的 ApprovalRequest）。preview 本身也会被持久化，一旦它持有字节，
 * 重挂载后卡片就会从 preview 渲染出旧正文、而提交走 args 里的新正文——稳定复现
 * 「用户批准的 ≠ 他看到的」，而这是一个不可撤销的公开写操作。
 */
export interface ExternalPublishMeta {
  repo: string;
  kind: 'new_issue' | 'issue_comment';
  issueNumber?: number;
  labels: string[];
}

export interface ChangePreview {
  kind: ChangePreviewKind;
  target: string;
  summary: string;
  oldContent?: string;
  newContent?: string;
  commandId?: string;
  preconditions?: string[];
  externalPublish?: ExternalPublishMeta;
  risk: 'low' | 'medium' | 'high';
  supportsPartialApply: boolean;
  undoable: boolean;
}

export function cloneChangePreview(
  preview?: ChangePreview,
): ChangePreview | undefined {
  if (!preview) return undefined;

  return {
    ...preview,
    preconditions: preview.preconditions ? [...preview.preconditions] : undefined,
    externalPublish: preview.externalPublish
      ? { ...preview.externalPublish, labels: [...preview.externalPublish.labels] }
      : undefined,
  };
}

export function buildSelectionPreview(input: {
  target: string;
  oldContent: string;
  newContent: string;
}): ChangePreview {
  return {
    kind: 'editor-selection-replace',
    target: input.target,
    summary: 'Replace the current editor selection',
    oldContent: input.oldContent,
    newContent: input.newContent,
    risk: 'medium',
    supportsPartialApply: true,
    undoable: true,
  };
}
