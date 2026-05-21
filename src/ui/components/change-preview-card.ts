import { ChangePreview } from '../diff/change-preview';

export function renderChangePreviewCard(
  container: any,
  preview: ChangePreview,
) {
  const card = container.createDiv({ cls: 'shell-change-preview-card' });
  card.createDiv({ cls: 'shell-change-preview-summary', text: preview.summary });
  card.createDiv({ cls: 'shell-change-preview-target', text: preview.target });

  if (preview.oldContent !== undefined || preview.newContent !== undefined) {
    renderCompactDiff(card, preview.oldContent ?? '', preview.newContent ?? '');
  }

  return card;
}

type DiffRow = { type: 'added' | 'removed' | 'context'; text: string };

function renderCompactDiff(card: any, oldContent: string, newContent: string) {
  const diff = buildCompactDiff(oldContent, newContent);
  const diffEl = card.createDiv({ cls: 'shell-change-preview-diff' });
  const header = diffEl.createDiv({ cls: 'shell-change-preview-diff-header' });
  header.createDiv({ cls: 'shell-change-preview-diff-title', text: 'Preview diff' });
  header.createDiv({
    cls: 'shell-change-preview-diff-count',
    text: `${diff.changedLines} changed ${diff.changedLines === 1 ? 'line' : 'lines'}`,
  });

  const lines = diffEl.createDiv({ cls: 'shell-change-preview-diff-lines' });
  for (const row of diff.rows) {
    lines.createDiv({
      cls: `shell-change-preview-diff-line shell-change-preview-diff-line-${row.type}`,
      text: `${row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  '}${row.text}`,
    });
  }

  if (diff.truncated) {
    lines.createDiv({ cls: 'shell-change-preview-diff-line shell-change-preview-diff-line-more', text: '...' });
  }
}

function buildCompactDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const rows: DiffRow[] = [];
  let changedLines = 0;

  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      continue;
    }

    if (oldLine !== undefined) {
      changedLines += 1;
      rows.push({ type: 'removed', text: oldLine });
    }
    if (newLine !== undefined) {
      changedLines += 1;
      rows.push({ type: 'added', text: newLine });
    }
  }

  if (!rows.length) {
    rows.push({ type: 'context', text: oldLines[0] || newLines[0] || '' });
  }

  return { rows, changedLines, truncated: false };
}
