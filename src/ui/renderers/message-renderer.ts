import { App, MarkdownRenderer } from 'obsidian';
import { renderApprovalCard } from '../approval-card';
import { ChatMessage } from '../types';
import { CodeBlockRenderer } from './code-block-renderer';

type MarkdownRender = (
  app: App,
  markdown: string,
  el: HTMLElement,
  sourcePath: string,
  component: unknown,
) => Promise<void> | void;

interface MessageRendererOptions {
  app: App;
  component: unknown;
  renderMarkdown?: MarkdownRender;
  onApprove?: (message: ChatMessage) => void | Promise<void>;
  onCancel?: (message: ChatMessage) => void | Promise<void>;
  onCopy?: (content: string, message: ChatMessage) => void | Promise<void>;
  onFeedbackUp?: (message: ChatMessage) => void | Promise<void>;
  onFeedbackDown?: (message: ChatMessage) => void | Promise<void>;
  onReviewCodeBlock?: (content: string) => void | Promise<void>;
  onInternalLinkClick?: (href: string) => void;
  onScrollRequest?: () => void;
  onRenderError?: (error: unknown) => void;
}

interface RenderAiContentOptions {
  postProcess?: boolean;
}

export class MessageRenderer {
  private readonly renderMarkdown: MarkdownRender;
  private readonly codeBlockRenderer: CodeBlockRenderer;

  constructor(private readonly options: MessageRendererOptions) {
    this.renderMarkdown = options.renderMarkdown ?? MarkdownRenderer.render.bind(MarkdownRenderer);
    this.codeBlockRenderer = new CodeBlockRenderer({
      onReviewCodeBlock: options.onReviewCodeBlock,
      onInternalLinkClick: options.onInternalLinkClick,
    });
  }

  async renderMessage(container: HTMLElement, message: ChatMessage): Promise<HTMLElement> {
    const entry = (container as any).createDiv({ cls: `shell-entry ${message.role}` }) as HTMLElement;

    try {
      if (message.approval) {
        renderApprovalCard(entry, message.approval, {
          onApprove: () => this.options.onApprove?.(message),
          onCancel: () => this.options.onCancel?.(message),
        });
      } else if (message.role === 'ai') {
        await this.renderAiContent(entry, message.content);
        this.addActionToolbar(entry, message);
      } else if (message.role === 'user') {
        this.setText(entry, message.content);
      } else {
        this.setText(entry, `[System] ${message.content}`);
      }
    } catch (error) {
      this.options.onRenderError?.(error);
      this.setText(entry, 'Error rendering message');
    }

    this.options.onScrollRequest?.();
    return entry;
  }

  async renderAiContent(
    container: HTMLElement,
    content: string,
    options: RenderAiContentOptions = {},
  ) {
    await Promise.resolve(this.renderMarkdown(
      this.options.app,
      content,
      container,
      '',
      this.options.component,
    ));

    if (options.postProcess !== false) {
      this.processAiContent(container);
    }
  }

  processAiContent(container: HTMLElement) {
    this.codeBlockRenderer.process(container);
  }

  addActionToolbar(container: HTMLElement, message: ChatMessage) {
    const toolbar = (container as any).createDiv({ cls: 'shell-feedback-bar shell-message-actions' }) as HTMLElement;
    const copyButton = (toolbar as any).createEl('button', {
      cls: 'shell-message-action-btn shell-copy-btn clickable-icon',
      title: 'Copy message',
      attr: { 'aria-label': 'Copy message' },
    }) as HTMLElement;
    copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
    copyButton.addEventListener('click', () => {
      void this.copyMessage(message);
    });

    const archiveButton = (toolbar as any).createEl('button', {
      cls: 'shell-message-action-btn shell-archive-btn',
      text: 'Archive',
      title: 'Archive to knowledge wiki',
      attr: { 'aria-label': 'Archive to knowledge wiki' },
    }) as HTMLElement;
    archiveButton.addEventListener('click', () => {
      this.activateFeedback(archiveButton, thumbsDownButton);
      void this.options.onFeedbackUp?.(message);
    });

    const thumbsDownButton = (toolbar as any).createEl('button', {
      cls: 'shell-feedback-btn shell-thumbs-down',
      title: 'Not useful',
      attr: { 'aria-label': 'Not useful' },
    }) as HTMLElement;
    thumbsDownButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>';
    thumbsDownButton.addEventListener('click', () => {
      this.activateFeedback(thumbsDownButton, thumbsUpButton);
      void this.options.onFeedbackDown?.(message);
    });

    return toolbar;
  }

  private async copyMessage(message: ChatMessage) {
    if (this.options.onCopy) {
      await this.options.onCopy(message.content, message);
      return;
    }

    await navigator.clipboard?.writeText(message.content);
  }

  private activateFeedback(active: HTMLElement, inactive: HTMLElement) {
    (active as any).addClass?.('active') ?? active.classList.add('active');
    (inactive as any).removeClass?.('active') ?? inactive.classList.remove('active');
  }

  private setText(entry: HTMLElement, text: string) {
    if (typeof (entry as any).setText === 'function') {
      (entry as any).setText(text);
    } else {
      entry.textContent = text;
    }
  }
}
