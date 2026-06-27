import { App, MarkdownRenderer, setIcon } from 'obsidian';
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
  onFocusApprovalPreview?: (message: ChatMessage) => void | Promise<void>;
  onCopy?: (content: string, message: ChatMessage) => void | Promise<void>;
  /** 点赞:用户认可该回答,归档到知识库。 */
  onFeedbackUp?: (message: ChatMessage) => void | Promise<void>;
  /** 点踩:用户不满意。reason 为用户在内联输入里填写的「哪里不好」。 */
  onFeedbackDown?: (message: ChatMessage, reason: string) => void | Promise<void>;
  onReviewCodeBlock?: (content: string) => void | Promise<void>;
  onUndoWorkspaceEdit?: (editId: string) => void | Promise<void>;
  onInternalLinkClick?: (href: string) => void;
  onScrollRequest?: () => void;
  onRenderError?: (error: unknown) => void;
}

interface RenderAiContentOptions {
  postProcess?: boolean;
}

interface ParsedSystemStatus {
  kind: 'updated';
  label: string;
  target: string;
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
      if (message.metadata?.workspaceEdit) {
        this.renderWorkspaceEdit(entry, message);
      } else if (message.approval) {
        (entry as any).addClass?.('shell-approval-entry') ?? entry.classList.add('shell-approval-entry');
        (entry as any).createDiv({ cls: 'shell-approval-avatar', text: 'AI' });
        const approvalBody = (entry as any).createDiv({ cls: 'shell-approval-message-body' }) as HTMLElement;
        const removeApprovalEntry = () => {
          if (typeof (entry as any).remove === 'function') {
            (entry as any).remove();
            return;
          }
          const parent = (entry as any).parentElement;
          if (parent?.children) {
            parent.children = Array.from(parent.children).filter((child) => child !== entry);
          }
        };
        renderApprovalCard(approvalBody, message.approval, {
          onApprove: () => {
            removeApprovalEntry();
            return this.options.onApprove?.(message);
          },
          onCancel: () => {
            removeApprovalEntry();
            return this.options.onCancel?.(message);
          },
          onFocusPreview: () => this.options.onFocusApprovalPreview?.(message),
        });
      } else if (message.role === 'ai') {
        await this.renderAiContent(entry, message.content);
        this.addActionToolbar(entry, message);
      } else if (message.role === 'user') {
        this.setText(entry, message.content);
      } else {
        const status = this.parseSystemStatus(message.content);
        if (status) {
          this.renderSystemStatus(entry, status);
        } else if (this.isCancelledSystemMessage(message.content)) {
          (entry as any).addClass?.('shell-system-cancelled') ?? entry.classList.add('shell-system-cancelled');
          this.setText(entry, `[System] ${message.content}`);
        } else {
          this.setText(entry, `[System] ${message.content}`);
        }
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
    setIcon(copyButton, 'copy');
    copyButton.addEventListener('click', () => {
      void this.copyMessage(message);
    });

    // 点赞:用户认可该回答 → 归档到知识库(onFeedbackUp 内部走 file-back)。
    // 仅在宿主接入归档通路时渲染,避免点了无反应的死按钮。
    if (this.options.onFeedbackUp) {
      const upButton = (toolbar as any).createEl('button', {
        cls: 'shell-feedback-btn shell-thumbs-up clickable-icon',
        title: '认可并保存到知识库',
        attr: { 'aria-label': '认可并保存到知识库' },
      }) as HTMLElement;
      setIcon(upButton, 'thumbs-up');
      upButton.addEventListener('click', () => {
        (upButton as any).addClass?.('active') ?? upButton.classList.add('active');
        void this.options.onFeedbackUp?.(message);
      });
    }

    // 点踩:用户不满意 → 展开内联输入问「哪里不好」,提交后回调 onFeedbackDown(message, reason)。
    if (this.options.onFeedbackDown) {
      const downButton = (toolbar as any).createEl('button', {
        cls: 'shell-feedback-btn shell-thumbs-down clickable-icon',
        title: '不满意,告诉 AI 哪里需要改进',
        attr: { 'aria-label': '不满意,告诉 AI 哪里需要改进' },
      }) as HTMLElement;
      setIcon(downButton, 'thumbs-down');
      downButton.addEventListener('click', () => {
        this.toggleNegativeFeedbackInput(container, toolbar, downButton, message);
      });
    }

    return toolbar;
  }

  /**
   * 点踩后在消息底部展开/收起一个轻量理由输入。
   * 提交(Enter / 按钮)→ onFeedbackDown(message, reason);Esc / 再次点踩 → 收起。
   */
  private toggleNegativeFeedbackInput(
    container: HTMLElement,
    toolbar: HTMLElement,
    downButton: HTMLElement,
    message: ChatMessage,
  ) {
    const existing = (container as any).querySelector?.('.shell-feedback-reason') as HTMLElement | null;
    if (existing) {
      (existing as any).remove?.();
      (downButton as any).removeClass?.('active') ?? downButton.classList.remove('active');
      return;
    }

    (downButton as any).addClass?.('active') ?? downButton.classList.add('active');
    const box = (container as any).createDiv({ cls: 'shell-feedback-reason' }) as HTMLElement;
    const input = (box as any).createEl('input', {
      cls: 'shell-feedback-reason-input',
      attr: {
        type: 'text',
        placeholder: '哪里不好?AI 会据此改进并重新回答',
        'aria-label': '反馈:哪里需要改进',
      },
    }) as HTMLInputElement;
    const submit = (box as any).createEl('button', {
      cls: 'shell-feedback-reason-submit',
      text: '改进重答',
      attr: { type: 'button' },
    }) as HTMLElement;

    const commit = () => {
      const reason = (input.value || '').trim();
      if (!reason) {
        input.focus();
        return;
      }
      (box as any).remove?.();
      void this.options.onFeedbackDown?.(message, reason);
    };

    submit.addEventListener('click', commit);
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        (box as any).remove?.();
        (downButton as any).removeClass?.('active') ?? downButton.classList.remove('active');
      }
    });

    setTimeout(() => input.focus?.(), 0);
  }

  private async copyMessage(message: ChatMessage) {
    if (this.options.onCopy) {
      await this.options.onCopy(message.content, message);
      return;
    }

    await navigator.clipboard?.writeText(message.content);
  }

  private setText(entry: HTMLElement, text: string) {
    if (typeof (entry as any).setText === 'function') {
      (entry as any).setText(text);
    } else {
      entry.textContent = text;
    }
  }

  private isCancelledSystemMessage(content: string) {
    return /^Cancelled:/i.test(content.trim());
  }

  private parseSystemStatus(content: string): ParsedSystemStatus | null {
    const updated = content.trim().match(/^(?:✅\s*)?Updated:\s*(.+)$/i);
    if (!updated) return null;

    return {
      kind: 'updated',
      label: 'Updated',
      target: updated[1].trim(),
    };
  }

  private renderSystemStatus(entry: HTMLElement, status: ParsedSystemStatus) {
    (entry as any).addClass?.('shell-system-status') ?? entry.classList.add('shell-system-status');
    (entry as any).addClass?.(`shell-system-status-${status.kind}`) ?? entry.classList.add(`shell-system-status-${status.kind}`);

    const icon = (entry as any).createSpan({ cls: 'shell-system-status-icon', text: '✓' }) as HTMLElement;
    this.setAttribute(icon, 'aria-hidden', 'true');

    const main = (entry as any).createSpan({ cls: 'shell-system-status-main' }) as HTMLElement;
    (main as any).createSpan({ cls: 'shell-system-status-action', text: status.label });
    (main as any).createSpan({
      cls: 'shell-system-status-target',
      text: this.basename(status.target),
      title: status.target,
    });
  }

  private renderWorkspaceEdit(entry: HTMLElement, message: ChatMessage) {
    const edit = message.metadata?.workspaceEdit;
    if (!edit) return;

    (entry as any).addClass?.('shell-workspace-edit-entry') ?? entry.classList.add('shell-workspace-edit-entry');
    if (edit.status === 'undone') {
      (entry as any).addClass?.('is-undone') ?? entry.classList.add('is-undone');
    }

    const row = (entry as any).createDiv({ cls: 'shell-workspace-edit-row' }) as HTMLElement;
    (row as any).createSpan({ cls: 'shell-workspace-edit-bullet', text: '\u2022' });
    (row as any).createSpan({
      cls: 'shell-workspace-edit-name',
      text: this.basename(edit.path),
      title: edit.path,
    });
    (row as any).createSpan({
      cls: 'shell-workspace-edit-meta',
      text: this.formatWorkspaceEditMeta(edit),
    });

    if (edit.status !== 'applied') return;

    const undoButton = (row as any).createEl('button', {
      cls: 'clickable-icon shell-workspace-edit-undo',
      attr: {
        type: 'button',
        title: `Undo ${edit.path}`,
        'aria-label': `Undo ${edit.path}`,
      },
    }) as HTMLElement;
    setIcon(undoButton, 'undo-2');
    undoButton.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      void this.options.onUndoWorkspaceEdit?.(edit.id);
    });
  }

  private formatWorkspaceEditMeta(edit: NonNullable<ChatMessage['metadata']>['workspaceEdit']) {
    if (!edit) return '';
    if (edit.status === 'undone') return 'undone';

    const delta = edit.lineDelta ?? 0;
    if (delta === 0) return edit.kind === 'create' ? 'new' : 'updated';
    return `${delta > 0 ? '+' : ''}${delta} lines`;
  }

  private basename(path: string) {
    return path.split(/[\\/]/).filter(Boolean).pop() || path;
  }

  private setAttribute(el: HTMLElement, name: string, value: string) {
    if (typeof (el as any).setAttribute === 'function') {
      (el as any).setAttribute(name, value);
    }
  }
}
