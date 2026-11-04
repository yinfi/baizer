(global as any).window = {
  setInterval,
  clearInterval,
};

import { TFile } from 'obsidian';

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
    toBeUndefined: () => {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${actual}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  tagName = 'div';
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  disabled = false;

  createDiv(attr?: any) {
    const child = new FakeElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    this.children.push(child);
    return child;
  }

  createEl(tag: string, attr?: any) {
    const child = new FakeElement();
    child.tagName = tag;
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    if (attr?.title) child.attributes.title = attr.title;
    if (attr?.attr) {
      for (const [name, value] of Object.entries(attr.attr)) {
        child.attributes[name] = String(value);
      }
    }
    this.children.push(child);
    return child;
  }

  setText(text: string) {
    this.textContent = text;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) {
      handler();
    }
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    return this.findAll((item) => item.className.split(' ').includes(className));
  }

  private findAll(predicate: (item: FakeElement) => boolean): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) matches.push(child);
      matches.push(...child.findAll(predicate));
    }
    return matches;
  }
}

function createWorkspaceApp() {
  const opened: string[] = [];
  const files = new Map<string, any>();
  return {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => {
          if (!files.has(path)) {
            const file = new TFile();
            file.path = path;
            file.basename = path.split('/').pop() || '';
            files.set(path, file);
          }
          return files.get(path);
        },
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: any) => {
            opened.push(file.path);
          },
        }),
      },
    } as any,
    opened,
  };
}

async function runTests() {
  console.log('=== Approval Flow Tests ===');
  // 审批卡文案已走 t()。这些是结构性断言(按钮 title/aria),与语言无关,
  // 固定英文 locale 以保证在中文机器上也确定性通过。
  const { setLocaleForTesting } = await import('../src/i18n/zh');
  setLocaleForTesting(false);
  const { ChatController } = await import('../src/ui/chat-controller');
  const { renderApprovalCard } = await import('../src/ui/approval-card');

  await test('slash command approval result becomes an approval message and can be approved', async () => {
    const messages: any[] = [];
    const { app, opened } = createWorkspaceApp();
    const apiCalls = {
      executeSlashSkillCommand: [] as any[],
      executeApprovedAction: [] as any[],
    };

    const controller = new ChatController({
      app,
      api: {
        getSkillCommands: () => [
          { command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' },
        ],
        executeSlashSkillCommand: async (command: string, input: string) => {
          apiCalls.executeSlashSkillCommand.push({ command, input });
          return {
            approval_required: true,
            action: 'create_note',
            target: 'Clippings/example.md',
            args: { filename: 'Clippings/example.md', content: '# Saved' },
            message: 'Approval required to create note: Clippings/example.md',
            preview: {
              kind: 'note-create',
              target: 'Clippings/example.md',
              summary: 'Create note',
              newContent: '# Saved',
              risk: 'medium',
              supportsPartialApply: false,
              undoable: true,
            },
          };
        },
        executeApprovedAction: async (action: string, args: any, _conversationId?: string, options?: any) => {
          apiCalls.executeApprovedAction.push({ action, args, options });
          return {
            success: true,
            path: 'Clippings/example.md',
            message: 'Approved and executed',
          };
        },
        chat: async () => 'unused',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onMessageUpdated: (message) => {
        const index = messages.findIndex(item => item.id === message.id);
        if (index >= 0) messages[index] = message;
      },
    });

    await controller.processCommand('/save https://example.com');

    expect(apiCalls.executeSlashSkillCommand).toEqual([
      { command: '/save', input: 'https://example.com' },
    ]);
    const approval = messages[messages.length - 1].approval;
    expect(approval.action).toBe('create_note');
    expect(approval.target).toBe('Clippings/example.md');
    expect(approval.args).toEqual({ filename: 'Clippings/example.md', content: '# Saved' });
    expect(approval.message).toBe('Approval required to create note: Clippings/example.md');
    expect(approval.preview.kind).toBe('note-create');
    expect(typeof approval.id).toBe('string');

    await controller.approveApproval(messages[messages.length - 1].id);

    expect(apiCalls.executeApprovedAction).toEqual([{
      action: 'create_note',
      args: { filename: 'Clippings/example.md', content: '# Saved' },
      options: { requestId: approval.id, retry: false },
    }]);
    const resolved = messages[messages.length - 1];
    expect(resolved.approvalState.status).toBe('succeeded');
    expect(resolved.approvalState.outcome.detail).toBe('Approved and executed');
    expect(resolved.content).toBe(approval.message);
    expect(opened).toEqual(['Clippings/example.md']);

    controller.cleanup();
  });

  await test('streaming tool approval result becomes an approval message instead of a success claim', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        chatStream: async function* () {
          yield {
            type: 'tool_call',
            name: 'create_file',
            args: {
              path: 'Assets/Canvas/summary.canvas',
              content: '{"nodes":[],"edges":[]}',
            },
          };
          yield {
            type: 'tool_result',
            name: 'create_file',
            result: {
              approval_required: true,
              action: 'create_file',
              target: 'Assets/Canvas/summary.canvas',
              args: {
                path: 'Assets/Canvas/summary.canvas',
                content: '{"nodes":[],"edges":[]}',
              },
              message: 'Approval required to create file: Assets/Canvas/summary.canvas',
              preview: {
                kind: 'note-create',
                target: 'Assets/Canvas/summary.canvas',
                summary: 'Create file',
                newContent: '{"nodes":[],"edges":[]}',
                risk: 'medium',
                supportsPartialApply: false,
                undoable: true,
              },
            },
          };
          yield { type: 'text_delta', content: 'I created the canvas file.' };
          yield { type: 'done', text: 'I created the canvas file.' };
        },
        chat: async () => 'unused',
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: (event) => streamEvents.push(event),
    });

    await controller.processCommand('Create a canvas file');

    expect(messages.map(message => message.role)).toEqual(['user', 'system']);
    const approval = messages[messages.length - 1].approval;
    expect(approval.action).toBe('create_file');
    expect(approval.target).toBe('Assets/Canvas/summary.canvas');
    expect(approval.args).toEqual({
      path: 'Assets/Canvas/summary.canvas',
      content: '{"nodes":[],"edges":[]}',
    });
    expect(approval.message).toBe('Approval required to create file: Assets/Canvas/summary.canvas');
    expect(approval.preview.kind).toBe('note-create');
    expect(typeof approval.id).toBe('string');
    expect(streamEvents.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'done']);
    expect(streamEvents[streamEvents.length - 1].text).toBe('');

    controller.cleanup();
  });

  await test('renderApprovalCard shows visible action and reject text buttons', async () => {
    const container = new FakeElement();
    const calls: string[] = [];

    renderApprovalCard(
      container as any,
      {
        id: 'req-create',
        action: 'create_note',
        target: 'Clippings/example.md',
        args: { filename: 'Clippings/example.md' },
        message: 'Approval required to create note: Clippings/example.md',
        preview: {
          kind: 'note-create',
          target: 'Clippings/example.md',
          summary: 'Create note',
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      {
        onApprove: () => { calls.push('approve'); },
        onReject: () => { calls.push('reject'); },
        onFocusPreview: () => { calls.push('focus'); },
      },
    );

    const approveButton = container.querySelector('.shell-approval-confirm');
    const rejectButton = container.querySelector('.shell-approval-cancel');
    expect(approveButton?.textContent).toBe('Approve this create');
    expect(rejectButton?.textContent).toBe('Reject');
    expect(approveButton?.attributes.title).toBe('Approve this create');
    expect(approveButton?.attributes['aria-label']).toBe('Approve this create');
    expect(rejectButton?.attributes['aria-label']).toBe('Reject');
    expect(approveButton?.attributes.type).toBe('button');
    // 决策按钮是原生 <button>：Tab/Shift+Tab 可聚焦，Enter/Space 触发 click；
    // 禁用时用原生 disabled，Tab 会跳过。
    expect(approveButton?.tagName).toBe('button');
    expect(rejectButton?.tagName).toBe('button');
    expect(approveButton?.disabled).toBe(false);
    expect(rejectButton?.disabled).toBe(false);
    // 预览仍是辅助图标按钮；决策按钮必须是可见文字。
    const previewButton = container.querySelector('.shell-approval-focus-preview');
    expect(previewButton?.attributes.title).toBe('Show editor preview');
    previewButton?.click();
    expect(calls).toEqual(['focus']);
  });

  await test('renderApprovalCard blocks repeat clicks while the request is in flight', async () => {
    const container = new FakeElement();
    let approved = 0;
    let rejected = 0;

    renderApprovalCard(
      container as any,
      {
        id: 'req-double',
        action: 'create_note',
        target: 'Clippings/example.md',
        args: { filename: 'Clippings/example.md' },
        message: 'Approval required to create note: Clippings/example.md',
        preview: {
          kind: 'note-create',
          target: 'Clippings/example.md',
          summary: 'Create note',
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      {
        onApprove: () => { approved += 1; },
        onReject: () => { rejected += 1; },
      },
    );

    const approveButton = container.querySelector('.shell-approval-confirm');
    const rejectButton = container.querySelector('.shell-approval-cancel');
    approveButton?.click();
    approveButton?.click();
    rejectButton?.click();

    expect(approved).toBe(1);
    expect(rejected).toBe(0);
    expect(approveButton?.disabled).toBe(true);
    expect(rejectButton?.disabled).toBe(true);
    expect(approveButton?.attributes['aria-disabled']).toBe('true');
  });

  await test('renderApprovalCard shows a running state without dropping the card', async () => {
    const container = new FakeElement();
    let approved = 0;

    renderApprovalCard(
      container as any,
      {
        id: 'req-running',
        action: 'delete_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md' },
        message: 'Approval required to delete note: Docs/current.md',
      },
      { onApprove: () => { approved += 1; }, onReject: () => { } },
      { status: 'running' },
    );

    const processing = container.querySelector('.shell-approval-processing');
    expect(processing?.textContent).toBe('Processing…');
    expect(processing?.attributes.role).toBe('status');
    const approveButton = container.querySelector('.shell-approval-confirm');
    const rejectButton = container.querySelector('.shell-approval-cancel');
    expect(approveButton?.disabled).toBe(true);
    expect(rejectButton?.disabled).toBe(true);
    approveButton?.click();
    expect(approved).toBe(0);
  });

  await test('renderApprovalCard renders a persisted success outcome without action buttons', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
        id: 'req-success',
        action: 'create_note',
        target: 'Clippings/example.md',
        args: { filename: 'Clippings/example.md' },
        message: 'Approval required to create note: Clippings/example.md',
      },
      { onApprove: () => { }, onReject: () => { } },
      {
        status: 'succeeded',
        outcome: {
          status: 'succeeded',
          detail: 'Approved and executed',
          target: 'Clippings/example.md',
          completedAt: 1,
        },
      },
    );

    const outcome = container.querySelector('.shell-approval-outcome');
    expect(outcome?.className).toContain('is-succeeded');
    expect(container.querySelector('.shell-approval-outcome-title')?.textContent).toBe('Approved and executed successfully');
    expect(container.querySelector('.shell-approval-outcome-detail')?.textContent).toBe('Approved and executed');
    expect(!!container.querySelector('.shell-approval-confirm')).toBe(false);
    expect(!!container.querySelector('.shell-approval-cancel')).toBe(false);
    expect(!!container.querySelector('.shell-approval-retry')).toBe(false);
  });

  await test('renderApprovalCard shows a failure reason and a retry action', async () => {
    const container = new FakeElement();
    let retried = 0;

    renderApprovalCard(
      container as any,
      {
        id: 'req-failed',
        action: 'delete_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md' },
        message: 'Approval required to delete note: Docs/current.md',
      },
      { onApprove: () => { }, onReject: () => { }, onRetry: () => { retried += 1; } },
      {
        status: 'failed',
        outcome: {
          status: 'failed',
          error: 'File is locked',
          detail: 'File is locked',
          completedAt: 1,
          retryable: true,
        },
      },
    );

    const outcome = container.querySelector('.shell-approval-outcome');
    expect(outcome?.className).toContain('is-failed');
    expect(container.querySelector('.shell-approval-outcome-title')?.textContent).toBe('Approved but execution failed');
    expect(container.querySelector('.shell-approval-outcome-detail')?.textContent).toBe('File is locked');
    const retryButton = container.querySelector('.shell-approval-retry');
    expect(retryButton?.textContent).toBe('Retry');
    retryButton?.click();
    retryButton?.click();
    expect(retried).toBe(1);
    expect(!!container.querySelector('.shell-approval-confirm')).toBe(false);
  });

  await test('renderApprovalCard renders a rejected outcome with no write action', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
        id: 'req-rejected',
        action: 'delete_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md' },
        message: 'Approval required to delete note: Docs/current.md',
      },
      { onApprove: () => { }, onReject: () => { } },
      {
        status: 'rejected',
        outcome: {
          status: 'rejected',
          detail: 'No write was performed.',
          target: 'Docs/current.md',
          completedAt: 1,
        },
      },
    );

    const outcome = container.querySelector('.shell-approval-outcome');
    expect(outcome?.className).toContain('is-rejected');
    expect(container.querySelector('.shell-approval-outcome-title')?.textContent).toBe('Rejected — no changes were made');
    expect(container.querySelector('.shell-approval-outcome-detail')?.textContent).toBe('No write was performed.');
    expect(!!container.querySelector('.shell-approval-confirm')).toBe(false);
    expect(!!container.querySelector('.shell-approval-retry')).toBe(false);
  });

  await test('renderApprovalCard asks to verify an unknown result before retrying', async () => {
    const container = new FakeElement();
    let rechecked = 0;

    renderApprovalCard(
      container as any,
      {
        id: 'req-unknown',
        action: 'delete_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md' },
        message: 'Approval required to delete note: Docs/current.md',
      },
      { onApprove: () => { }, onReject: () => { }, onRecheck: () => { rechecked += 1; } },
      {
        status: 'unknown',
        outcome: {
          status: 'unknown',
          detail: 'Check the target before retrying.',
          completedAt: 1,
          retryable: false,
        },
      },
    );

    expect(container.querySelector('.shell-approval-outcome-title')?.textContent).toBe('Execution result is unknown');
    const recheckButton = container.querySelector('.shell-approval-recheck');
    expect(recheckButton?.textContent).toBe('Check result');
    recheckButton?.click();
    expect(rechecked).toBe(1);
    expect(!!container.querySelector('.shell-approval-retry')).toBe(false);
  });

  // rename_note 同时是「重命名」和「移动」:父目录变了 = 移动。审批卡必须显示去向(从→到)、
  // 文案说「移动」、且不渲染对移动无意义的 🎯 聚焦预览按钮(截图三问)。
  await test('renderApprovalCard renders a move as 操作/从/到 without a dead preview button', async () => {
    const container = new FakeElement();
    const calls: string[] = [];

    renderApprovalCard(
      container as any,
      {
        id: 'req-move',
        action: 'rename_note',
        target: 'AI开发指南.md',
        args: { oldPath: 'AI开发指南.md', newPath: 'study/AI/AI开发指南.md' },
        message: 'Approval required to rename note: AI开发指南.md',
        preview: {
          kind: 'note-rename',
          target: 'AI开发指南.md',
          summary: 'Rename note',
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      {
        onApprove: () => { calls.push('approve'); },
        onReject: () => { calls.push('reject'); },
        onFocusPreview: () => { calls.push('focus'); },
      },
    );

    expect(container.querySelector('.shell-approval-title')?.textContent).toBe('Approval needed: move file');
    expect(container.querySelector('.shell-approval-action-value')?.textContent).toBe('Move');
    expect(container.querySelector('.shell-approval-target-value')?.textContent).toBe('AI开发指南.md');
    expect(container.querySelector('.shell-approval-newpath-value')?.textContent).toBe('study/AI/AI开发指南.md');
    expect(container.querySelector('.shell-approval-confirm')?.textContent).toBe('Approve this move');
    // 移动无正文可在编辑器预览:🎯 按钮不渲染,只剩 拒绝 + 批准。
    expect(container.querySelectorAll('.shell-approval-icon-btn').length).toBe(0);
    expect(!!container.querySelector('.shell-approval-focus-preview')).toBe(false);
    // rename 不再嵌入重复 summary+路径的预览子卡。
    expect(!!container.querySelector('.shell-change-preview-card')).toBe(false);
  });

  // 父目录不变、仅文件名变 = 纯重命名:文案区分于「移动」。
  await test('renderApprovalCard labels a same-folder rename as 重命名', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
        id: 'req-rename',
        action: 'rename_note',
        target: 'notes/draft.md',
        args: { oldPath: 'notes/draft.md', newPath: 'notes/final.md' },
        message: 'Approval required to rename note: notes/draft.md',
        preview: {
          kind: 'note-rename',
          target: 'notes/draft.md',
          summary: 'Rename note',
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      { onApprove: () => { }, onReject: () => { } },
    );

    expect(container.querySelector('.shell-approval-title')?.textContent).toBe('Approval needed: rename file');
    expect(container.querySelector('.shell-approval-action-value')?.textContent).toBe('Rename');
    expect(container.querySelector('.shell-approval-confirm')?.textContent).toBe('Approve this rename');
  });

  await test('renderApprovalCard exposes risk target action and a high-risk warning', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
        id: 'req-delete',
        action: 'delete_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md' },
        message: 'Approval required to delete note: Docs/current.md',
        preview: {
          kind: 'note-delete',
          target: 'Docs/current.md',
          summary: 'Delete note',
          oldContent: '# Current',
          risk: 'high',
          preconditions: ['The target file must still exist.'],
          supportsPartialApply: false,
          undoable: false,
        },
      },
      {
        onApprove: () => { },
        onReject: () => { },
      },
    );

    expect(!!container.querySelector('.is-high-risk')).toBe(true);
    expect(container.querySelector('.shell-approval-risk')?.textContent).toContain('High risk');
    expect(container.querySelector('.shell-approval-action-value')?.textContent).toBe('delete_note');
    expect(container.querySelector('.shell-approval-target-value')?.textContent).toBe('Docs/current.md');
    expect(container.querySelector('.shell-approval-precondition')?.textContent).toContain('target file');
    expect(container.querySelector('.shell-change-preview-precondition')?.textContent).toBeUndefined();
    expect(container.querySelector('.shell-approval-confirm')?.textContent).toBe('Approve this delete');
    // 高风险动作 + 对象写在确认区域,不依赖悬停。
    const warning = container.querySelector('.shell-approval-warning');
    expect(warning?.textContent).toContain('delete');
    expect(warning?.textContent).toContain('Docs/current.md');
    expect(warning?.textContent).toContain('may not be undoable');
  });

  await test('renderApprovalCard shows compact diff preview instead of full side-by-side content', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
        id: 'req-edit',
        action: 'update_note',
        target: 'Docs/current.md',
        args: { path: 'Docs/current.md', content: '# New title\n\nImproved body' },
        message: 'Approval required to update note: Docs/current.md',
        preview: {
          kind: 'note-replace',
          target: 'Docs/current.md',
          summary: 'Replace note content',
          oldContent: '# Old title\n\nDraft body',
          newContent: '# New title\n\nImproved body',
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      {
        onApprove: () => { },
        onReject: () => { },
      },
    );

    expect(container.querySelector('.shell-approval-title')?.textContent).toBe('Approval needed: modify current note');
    expect(container.querySelector('.shell-approval-confirm')?.textContent).toBe('Approve this edit');
    expect(container.querySelector('.shell-change-preview-diff-count')?.textContent).toContain('changed lines');
    expect(!!container.querySelector('.shell-change-preview-diff-line-removed')).toBe(true);
    expect(!!container.querySelector('.shell-change-preview-diff-line-added')).toBe(true);
    expect(container.querySelector('.shell-change-preview-old-content')?.textContent).toBeUndefined();
    expect(container.querySelector('.shell-change-preview-new-content')?.textContent).toBeUndefined();
  });

  await test('renderApprovalCard keeps every changed diff row available for scrolling', async () => {
    const container = new FakeElement();
    const oldContent = Array.from({ length: 24 }, (_, index) => `old line ${index + 1}`).join('\n');
    const newContent = Array.from({ length: 24 }, (_, index) => `new line ${index + 1}`).join('\n');

    renderApprovalCard(
      container as any,
      {
        id: 'req-large',
        action: 'update_note',
        target: 'Docs/large.md',
        args: { path: 'Docs/large.md', content: newContent },
        message: 'Approval required to update note: Docs/large.md',
        preview: {
          kind: 'note-replace',
          target: 'Docs/large.md',
          summary: 'Replace note content',
          oldContent,
          newContent,
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
      {
        onApprove: () => { },
        onReject: () => { },
      },
    );

    const removedRows = container.querySelectorAll('.shell-change-preview-diff-line-removed');
    const addedRows = container.querySelectorAll('.shell-change-preview-diff-line-added');
    expect(removedRows.length).toBe(24);
    expect(addedRows.length).toBe(24);
    expect(removedRows[23].textContent).toContain('old line 24');
    expect(addedRows[23].textContent).toContain('new line 24');
    expect(container.querySelector('.shell-change-preview-diff-line-more')?.textContent).toBeUndefined();
  });

  await test('applyPreviewedChange records direct-write audit entries after applying the change', async () => {
    const auditCalls: any[] = [];
    const applied: string[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        recordDirectWrite: async (entry: any) => {
          auditCalls.push(entry);
        },
        chat: async () => 'unused',
        chatStream: async function* () { },
        clearSession: async () => { },
        getSkillCommands: () => [],
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
    });

    await controller.applyPreviewedChange({
      action: 'selection_rewrite',
      target: 'Notes/Native AI.md',
      previousContent: 'before',
      apply: async () => {
        applied.push('done');
      },
    });

    expect(applied).toEqual(['done']);
    expect(auditCalls).toEqual([{
      action: 'selection_rewrite',
      target: 'Notes/Native AI.md',
      previousContent: 'before',
      undoable: true,
    }]);

    controller.cleanup();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
