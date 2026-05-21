interface ThinkingRendererOptions {
  now?: () => number;
}

export class ThinkingRenderer {
  private currentThinkingBlock: HTMLElement | null = null;
  private currentStartedAt = 0;
  private nodeCount = 0;
  private readonly now: () => number;

  constructor(private timeline: HTMLElement, options: ThinkingRendererOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  appendThinking(content: string) {
    if (!this.currentThinkingBlock) {
      this.currentStartedAt = this.now();
      this.currentThinkingBlock = (this.timeline as any).createDiv({ cls: 'ocli-thinking-block is-thinking' });
      const block = this.currentThinkingBlock;

      const header = (block as any).createDiv({ cls: 'ocli-thinking-header' }) as HTMLElement;
      (header as any).createSpan({ cls: 'ocli-thinking-caret', text: '>' });
      (header as any).createSpan({ cls: 'ocli-thinking-label', text: 'Thinking' });
      (header as any).createSpan({ cls: 'ocli-thinking-timer', text: '0s' });
      this.setAttribute(header, 'role', 'button');
      this.setAttribute(header, 'tabindex', '0');
      this.setAttribute(header, 'aria-expanded', 'true');

      (block as any).createDiv({ cls: 'ocli-thinking-content' });
      header.addEventListener('click', () => this.toggleCollapsed(block));
      header.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.toggleCollapsed(block);
      });
      this.nodeCount++;
    }

    const detail = this.currentThinkingBlock.querySelector('.ocli-thinking-content') as HTMLElement;
    const label = this.currentThinkingBlock.querySelector('.ocli-thinking-label') as HTMLElement;
    const timer = this.currentThinkingBlock.querySelector('.ocli-thinking-timer') as HTMLElement;
    if (detail) detail.textContent = (detail.textContent || '') + content;
    if (label) {
      const fullText = detail?.textContent || '';
      label.textContent = this.preview(fullText);
    }
    if (timer) timer.textContent = this.formatDuration(this.now() - this.currentStartedAt);
  }

  finalizeCurrentThinking() {
    if (!this.currentThinkingBlock) return;

    this.removeClass(this.currentThinkingBlock, 'is-thinking');
    this.addClass(this.currentThinkingBlock, 'is-complete');

    const label = this.currentThinkingBlock.querySelector('.ocli-thinking-label') as HTMLElement;
    const timer = this.currentThinkingBlock.querySelector('.ocli-thinking-timer') as HTMLElement;
    const duration = this.formatDuration(this.now() - this.currentStartedAt);
    if (label) label.textContent = `Thought for ${duration}`;
    if (timer) timer.textContent = duration;

    this.currentThinkingBlock = null;
  }

  getNodeCount() {
    return this.nodeCount;
  }

  private toggleCollapsed(block: HTMLElement) {
    const header = block.querySelector('.ocli-thinking-header') as HTMLElement;
    const nextCollapsed = !this.hasClass(block, 'is-collapsed');
    this.toggleClass(block, 'is-collapsed', nextCollapsed);
    if (header) {
      this.setAttribute(header, 'aria-expanded', String(!nextCollapsed));
    }
  }

  private preview(value: string) {
    return value.length > 48 ? `${value.substring(0, 48)}...` : value;
  }

  private formatDuration(durationMs: number) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
    return `${seconds}s`;
  }

  private setAttribute(el: HTMLElement, name: string, value: string) {
    if (typeof (el as any).setAttribute === 'function') {
      (el as any).setAttribute(name, value);
    }
  }

  private hasClass(el: HTMLElement, name: string) {
    if (typeof (el as any).hasClass === 'function') {
      return (el as any).hasClass(name);
    }
    return el.classList.contains(name);
  }

  private addClass(el: HTMLElement, name: string) {
    if (typeof (el as any).addClass === 'function') {
      (el as any).addClass(name);
    } else {
      el.classList.add(name);
    }
  }

  private removeClass(el: HTMLElement, name: string) {
    if (typeof (el as any).removeClass === 'function') {
      (el as any).removeClass(name);
    } else {
      el.classList.remove(name);
    }
  }

  private toggleClass(el: HTMLElement, name: string, enabled: boolean) {
    if (typeof (el as any).toggleClass === 'function') {
      (el as any).toggleClass(name, enabled);
      return;
    }

    if (enabled) this.addClass(el, name);
    else this.removeClass(el, name);
  }
}
