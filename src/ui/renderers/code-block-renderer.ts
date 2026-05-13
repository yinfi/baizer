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
      reviewButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="16" x2="12" y2="12"></line><line x1="10" y1="14" x2="10" y2="10"></line></svg>';
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
