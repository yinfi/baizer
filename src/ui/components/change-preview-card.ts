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

  return card;
}
