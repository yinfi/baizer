import { setIcon } from 'obsidian';

interface CodeBlockRendererOptions {
  onReviewCodeBlock?: (content: string) => void | Promise<void>;
  onInternalLinkClick?: (href: string) => void;
}

export class CodeBlockRenderer {
  constructor(private readonly options: CodeBlockRendererOptions = {}) { }

  process(container: HTMLElement) {
    this.processCodeBlocks(container);
    this.processInternalLinks(container);
  }

  private processCodeBlocks(container: HTMLElement) {
    const codeBlocks = Array.from(container.querySelectorAll('pre > code'));
    codeBlocks.forEach((codeBlock) => {
      const pre = codeBlock.parentElement as any;
      if (!pre || pre.querySelector?.('.shell-code-block-header')) return;

      const header = pre.createDiv({ cls: 'shell-code-block-header' });
      const lang = this.getLanguage(codeBlock as HTMLElement);
      header.createDiv({
        cls: 'shell-code-block-filename',
        text: `untitled.${lang === 'text' ? 'txt' : lang}`,
      });

      const buttons = header.createDiv({ cls: 'shell-code-block-buttons' });
      const reviewButton = buttons.createEl('button', {
        cls: 'shell-apply-btn clickable-icon',
        title: 'Review Changes',
        attr: { 'aria-label': 'Review Changes' },
      });
      // 用 Obsidian 的 setIcon 而不是给 innerHTML 赋值:后者是官方插件审核
      // 明确不建议的写法,且图标不会随主题的图标包变化。
      setIcon(reviewButton, 'file-search');
      reviewButton.addEventListener('click', () => {
        void this.options.onReviewCodeBlock?.(codeBlock.textContent || '');
      });

      pre.insertBefore(header, codeBlock);
    });
  }

  private processInternalLinks(container: HTMLElement) {
    const links = Array.from(container.querySelectorAll('a.internal-link'));
    links.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
        if (href) this.options.onInternalLinkClick?.(href);
      });
    });
  }

  private getLanguage(codeBlock: HTMLElement) {
    const classNames = Array.from(codeBlock.classList || []);
    const langClass = classNames.find(cls => cls.startsWith('language-'));
    return langClass ? langClass.replace('language-', '') : 'text';
  }
}
