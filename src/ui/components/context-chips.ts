import { setIcon } from 'obsidian';
import { ContextItem } from '../../services/context-manager';

interface ContextChipsHandlers {
  onRemove: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onCompileFile?: (path: string) => void | Promise<void>;
  onAddRelatedContext?: (path: string) => void;
  onOpenSummary?: (path: string) => void;
  onRunLint?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  onOpenSettings?: () => void;
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
        cls: `context-chip context-chip-${ctx.type}${ctx.type === 'scope' && ctx.scope ? ` context-chip-scope-${ctx.scope}` : ''}`,
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
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          this.toggleFileActions(chip, ctx);
        });
      }
    });
  }

  private toggleFileActions(parent: HTMLElement, ctx: ContextItem) {
    const existing = parent.querySelector?.('.context-chip-action-row');
    if (existing) {
      existing.remove();
      this.removeClass(parent, 'is-action-open');
      return;
    }

    this.addClass(parent, 'is-action-open');
    const row = parent.createDiv({ cls: 'context-chip-action-row' });
    this.createAction(row, 'Open file', 'external-link', () => {
      this.handlers.onOpenFile?.(ctx.data);
    });
    this.createAction(row, 'Compile note', 'refresh-cw', () => {
      void this.handlers.onCompileFile?.(ctx.data);
    });
    this.createAction(row, 'Add backlinks', 'network', () => {
      this.handlers.onAddRelatedContext?.(ctx.data);
    });
    this.createAction(row, 'Open wiki summary', 'external-link', () => {
      this.handlers.onOpenSummary?.(ctx.data);
    });
    this.createAction(row, 'Run knowledge lint', 'scan-line', () => {
      this.handlers.onRunLint?.(ctx.data);
    });
    this.createAction(row, 'Copy note path', 'copy', () => {
      this.handlers.onCopyPath?.(ctx.data);
    });
    this.createAction(row, 'Settings', 'settings', () => {
      this.handlers.onOpenSettings?.();
    });
  }

  private createAction(container: HTMLElement, label: string, icon: string, handler: () => void) {
    const button = container.createEl('button', {
      cls: 'context-chip-icon-action',
      attr: { type: 'button', 'aria-label': label, title: label },
    });
    this.setIconFn(button, icon);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
  }

  private addClass(el: HTMLElement, className: string) {
    if (typeof (el as any).addClass === 'function') {
      (el as any).addClass(className);
      return;
    }
    el.classList.add(className);
  }

  private removeClass(el: HTMLElement, className: string) {
    if (typeof (el as any).removeClass === 'function') {
      (el as any).removeClass(className);
      return;
    }
    el.classList.remove(className);
  }
}

export function getContextChipLabel(ctx: ContextItem) {
  if (ctx.type === 'scope') {
    if (ctx.scope === 'tag' && ctx.tag) {
      return `tag:${ctx.tag}`;
    }
    return stripLeadingAt(ctx.data);
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

function stripLeadingAt(value: string) {
  return value.replace(/^@/, '');
}
