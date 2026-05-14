import { setIcon } from 'obsidian';
import { ContextItem } from '../../services/context-manager';

interface ContextChipsHandlers {
  onRemove: (id: string) => void;
  onOpenFile?: (path: string) => void;
  setIcon?: (el: HTMLElement, icon: string) => void;
}

export class ContextChips {
  private readonly setIconFn: (el: HTMLElement, icon: string) => void;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly handlers: ContextChipsHandlers,
  ) {
    this.setIconFn = handlers.setIcon ?? setIcon;
  }

  update(contexts: ContextItem[]) {
    if (!this.containerEl) return;
    this.containerEl.empty();

    contexts.forEach((ctx) => {
      const chip = this.containerEl.createDiv({
        cls: `context-chip context-chip-${ctx.type}`,
        title: ctx.data,
      });
      const iconEl = chip.createSpan({ cls: 'chip-icon' });
      this.setIconFn(iconEl, getContextIconName(ctx.type));
      chip.createSpan({ cls: 'chip-label', text: getContextChipLabel(ctx) });

      const removeButton = chip.createEl('button', {
        cls: 'chip-remove clickable-icon',
        text: 'x',
        attr: { 'aria-label': 'Remove context' },
      });
      removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.onRemove(ctx.id);
      });

      if (ctx.type === 'file') {
        chip.addEventListener('click', () => {
          this.handlers.onOpenFile?.(ctx.data);
        });
      }
    });
  }
}

export function getContextChipLabel(ctx: ContextItem) {
  if (ctx.type === 'scope') {
    return ctx.data;
  }

  if (ctx.type === 'file') {
    return basename(ctx.data);
  }

  return ctx.summary || ctx.data;
}

export function getContextIconName(type: ContextItem['type']) {
  switch (type) {
    case 'image':
      return 'image';
    case 'url':
      return 'link';
    case 'youtube':
      return 'youtube';
    case 'file':
      return 'file-text';
    case 'scope':
      return 'at-sign';
    default:
      return 'sticky-note';
  }
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}
