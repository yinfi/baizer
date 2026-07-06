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
  /** 重试(阶段C):对某条 ai 回复重新生成,产生兄弟分支。 */
  onRetry?: (message: ChatMessage) => void | Promise<void>;
  /** 编辑重问(阶段C):改写某条 user 消息文本后重跑,产生兄弟分支。 */
  onEdit?: (message: ChatMessage, newText: string) => void | Promise<void>;
  /** 分叉(阶段C):在 ai 回复底部操作栏触发,编辑对应问题后重跑,产生兄弟分支。 */
  onFork?: (message: ChatMessage, newText: string) => void | Promise<void>;
  /** 切换兄弟分支(阶段C):targetLeafId 为目标分支子树叶子 entry id。 */
  onSwitchBranch?: (message: ChatMessage, targetLeafId: string) => void | Promise<void>;
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
        this.addUserMessageControls(entry, message);
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

    // 重试(阶段C):对该 ai 回复重新生成,产生兄弟分支。仅在宿主接入且该消息已锚定会话树时可用。
    if (this.options.onRetry && message.sessionEntryId) {
      const retryButton = (toolbar as any).createEl('button', {
        cls: 'shell-message-action-btn shell-retry-btn clickable-icon',
        title: '重新生成(保留原回答为分支)',
        attr: { 'aria-label': '重新生成' },
      }) as HTMLElement;
      setIcon(retryButton, 'refresh-cw');
      retryButton.addEventListener('click', () => {
        void this.options.onRetry?.(message);
      });
    }

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

    // 分叉(阶段C):在底部操作栏直接给一个「分叉」入口——展开预填原问题的输入,
    // 改写后从该问题重新提问,原问答保留为兄弟分支。放在 ai 操作栏是因为流结束时才渲染,
    // 能拿到真实 entryId(user 消息在发送时渲染,拿不到);统一入口也更直观。
    if (this.options.onFork && message.sessionEntryId) {
      const forkButton = (toolbar as any).createEl('button', {
        cls: 'shell-message-action-btn shell-fork-btn clickable-icon',
        title: '分叉:编辑问题并重新生成(保留当前对话为分支)',
        attr: { 'aria-label': '分叉' },
      }) as HTMLElement;
      setIcon(forkButton, 'git-branch');
      forkButton.addEventListener('click', () => {
        this.toggleForkInput(container, message);
      });
    }

    // 兄弟分支导航条 `< n/m >`:该轮问答有多个分支时,在操作栏渲染切换控件。
    if (this.options.onSwitchBranch && message.branch && message.branch.count > 1) {
      this.renderBranchNav(toolbar, message);
    }

    return toolbar;
  }

  /** 在操作栏内渲染兄弟分支 `< index/count >` 切换控件。 */
  private renderBranchNav(toolbar: HTMLElement, message: ChatMessage) {
    const branch = message.branch!;
    const nav = (toolbar as any).createDiv({ cls: 'shell-branch-nav' }) as HTMLElement;
    const prev = (nav as any).createEl('button', {
      cls: 'shell-branch-prev clickable-icon',
      attr: { type: 'button', title: '上一个分支', 'aria-label': '上一个分支' },
    }) as HTMLElement;
    setIcon(prev, 'chevron-left');
    (nav as any).createSpan({ cls: 'shell-branch-count', text: `${branch.index + 1}/${branch.count}` });
    const next = (nav as any).createEl('button', {
      cls: 'shell-branch-next clickable-icon',
      attr: { type: 'button', title: '下一个分支', 'aria-label': '下一个分支' },
    }) as HTMLElement;
    setIcon(next, 'chevron-right');

    const go = (targetIndex: number) => {
      if (targetIndex < 0 || targetIndex >= branch.count || targetIndex === branch.index) return;
      const targetLeaf = branch.leafIds[targetIndex];
      if (targetLeaf) void this.options.onSwitchBranch?.(message, targetLeaf);
    };
    prev.addEventListener('click', () => go(branch.index - 1));
    next.addEventListener('click', () => go(branch.index + 1));
  }

  /** 分叉输入:预填原问题,提交 → onFork(message, newText);Esc / 再次点击收起。 */
  private toggleForkInput(container: HTMLElement, message: ChatMessage) {
    const existing = (container as any).querySelector?.('.shell-fork-box') as HTMLElement | null;
    if (existing) {
      (existing as any).remove?.();
      return;
    }

    const box = (container as any).createDiv({ cls: 'shell-fork-box shell-edit-box' }) as HTMLElement;
    const input = (box as any).createEl('textarea', {
      cls: 'shell-edit-input',
      attr: { 'aria-label': '编辑问题并重新提问' },
    }) as HTMLTextAreaElement;
    input.value = message.forkSourceText ?? '';
    const submit = (box as any).createEl('button', {
      cls: 'shell-edit-submit',
      text: '重新提问',
      attr: { type: 'button' },
    }) as HTMLElement;

    const commit = () => {
      const text = (input.value || '').trim();
      if (!text) { input.focus(); return; }
      (box as any).remove?.();
      void this.options.onFork?.(message, text);
    };
    submit.addEventListener('click', commit);
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        (box as any).remove?.();
      }
    });
    setTimeout(() => input.focus?.(), 0);
  }

  /**
   * user 消息的分支控件(阶段C):编辑重问按钮 + 兄弟分支 `< index/count >` 导航条。
   * 仅在该消息已锚定会话树(sessionEntryId)时渲染编辑;仅在有多个兄弟(branch.count>1)时渲染导航。
   */
  private addUserMessageControls(container: HTMLElement, message: ChatMessage) {
    const branch = message.branch;
    const canEdit = !!this.options.onEdit && !!message.sessionEntryId;
    const canNavigate = !!this.options.onSwitchBranch && !!branch && branch.count > 1;
    if (!canEdit && !canNavigate) return;

    const bar = (container as any).createDiv({ cls: 'shell-user-actions shell-branch-bar' }) as HTMLElement;

    if (canNavigate && branch) {
      const nav = (bar as any).createDiv({ cls: 'shell-branch-nav' }) as HTMLElement;
      const prev = (nav as any).createEl('button', {
        cls: 'shell-branch-prev clickable-icon',
        attr: { type: 'button', title: '上一个分支', 'aria-label': '上一个分支' },
      }) as HTMLElement;
      setIcon(prev, 'chevron-left');
      (nav as any).createSpan({ cls: 'shell-branch-count', text: `${branch.index + 1}/${branch.count}` });
      const next = (nav as any).createEl('button', {
        cls: 'shell-branch-next clickable-icon',
        attr: { type: 'button', title: '下一个分支', 'aria-label': '下一个分支' },
      }) as HTMLElement;
      setIcon(next, 'chevron-right');

      const go = (targetIndex: number) => {
        if (targetIndex < 0 || targetIndex >= branch.count || targetIndex === branch.index) return;
        const targetLeaf = branch.leafIds[targetIndex];
        if (targetLeaf) void this.options.onSwitchBranch?.(message, targetLeaf);
      };
      prev.addEventListener('click', () => go(branch.index - 1));
      next.addEventListener('click', () => go(branch.index + 1));
    }

    if (canEdit) {
      const editButton = (bar as any).createEl('button', {
        cls: 'shell-message-action-btn shell-edit-btn clickable-icon',
        attr: { type: 'button', title: '编辑并重新提问(保留原对话为分支)', 'aria-label': '编辑重问' },
      }) as HTMLElement;
      setIcon(editButton, 'pencil');
      editButton.addEventListener('click', () => {
        this.toggleEditInput(container, bar, message);
      });
    }
  }

  /** 编辑重问的内联输入:预填原文,提交 → onEdit(message, newText);Esc 收起。 */
  private toggleEditInput(container: HTMLElement, bar: HTMLElement, message: ChatMessage) {
    const existing = (container as any).querySelector?.('.shell-edit-box') as HTMLElement | null;
    if (existing) {
      (existing as any).remove?.();
      return;
    }

    const box = (container as any).createDiv({ cls: 'shell-edit-box' }) as HTMLElement;
    const input = (box as any).createEl('textarea', {
      cls: 'shell-edit-input',
      attr: { 'aria-label': '编辑消息内容' },
    }) as HTMLTextAreaElement;
    input.value = message.content;
    const submit = (box as any).createEl('button', {
      cls: 'shell-edit-submit',
      text: '重新提问',
      attr: { type: 'button' },
    }) as HTMLElement;

    const commit = () => {
      const text = (input.value || '').trim();
      if (!text) { input.focus(); return; }
      (box as any).remove?.();
      void this.options.onEdit?.(message, text);
    };
    submit.addEventListener('click', commit);
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        (box as any).remove?.();
      }
    });
    setTimeout(() => input.focus?.(), 0);
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
