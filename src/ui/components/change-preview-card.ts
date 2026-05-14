import { ChangePreview } from '../diff/change-preview';

export function renderChangePreviewCard(
  container: any,
  preview: ChangePreview,
) {
  const card = container.createDiv({ cls: 'shell-change-preview-card' });
  card.createDiv({ cls: 'shell-change-preview-summary', text: preview.summary });
  card.createDiv({ cls: 'shell-change-preview-target', text: preview.target });

  if (preview.preconditions?.length) {
    const conditions = card.createDiv({ cls: 'shell-change-preview-preconditions' });
    for (const condition of preview.preconditions) {
      conditions.createDiv({ cls: 'shell-change-preview-precondition', text: condition });
    }
  }

  if (preview.oldContent !== undefined || preview.newContent !== undefined) {
    const content = card.createDiv({ cls: 'shell-change-preview-content' });
    if (preview.oldContent !== undefined) {
      const oldBlock = content.createDiv({ cls: 'shell-change-preview-block shell-change-preview-old' });
      oldBlock.createDiv({ cls: 'shell-change-preview-label', text: 'Current content' });
      oldBlock.createEl('pre', {
        cls: 'shell-change-preview-old-content shell-change-preview-code',
        text: preview.oldContent,
      });
    }
    if (preview.newContent !== undefined) {
      const newBlock = content.createDiv({ cls: 'shell-change-preview-block shell-change-preview-new' });
      newBlock.createDiv({ cls: 'shell-change-preview-label', text: 'Proposed content' });
      newBlock.createEl('pre', {
        cls: 'shell-change-preview-new-content shell-change-preview-code',
        text: preview.newContent,
      });
    }
  }

  return card;
}
