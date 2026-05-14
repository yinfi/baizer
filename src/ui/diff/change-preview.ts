export type ChangePreviewKind =
  | 'editor-selection-replace'
  | 'note-replace'
  | 'note-append'
  | 'note-create'
  | 'note-rename'
  | 'note-delete'
  | 'plugin-command';

export interface ChangePreview {
  kind: ChangePreviewKind;
  target: string;
  summary: string;
  oldContent?: string;
  newContent?: string;
  commandId?: string;
  preconditions?: string[];
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
