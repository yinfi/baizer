(global as any).window = {
  setInterval,
  clearInterval,
};

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

  createEl(_tag: string, attr?: any) {
    const child = new FakeElement();
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
          if (!files.has(path)) files.set(path, { path, basename: path.split('/').pop() });
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
        executeApprovedAction: async (action: string, args: any) => {
          apiCalls.executeApprovedAction.push({ action, args });
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
    });

    await controller.processCommand('/save https://example.com');

    expect(apiCalls.executeSlashSkillCommand).toEqual([
      { command: '/save', input: 'https://example.com' },
    ]);
    expect(messages[messages.length - 1].approval).toEqual({
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
    });

    await controller.approveApproval(messages[messages.length - 1].approval);

    expect(apiCalls.executeApprovedAction).toEqual([{
      action: 'create_note',
      args: { filename: 'Clippings/example.md', content: '# Saved' },
    }]);
    expect(messages[messages.length - 1].content).toBe('Approved and executed');
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
    expect(messages[messages.length - 1].approval).toEqual({
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
    });
    expect(streamEvents.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'done']);
    expect(streamEvents[streamEvents.length - 1].text).toBe('');

    controller.cleanup();
  });

  await test('renderApprovalCard wires approve and cancel buttons', async () => {
    const container = new FakeElement();
    let approved = 0;
    let cancelled = 0;
    let approveResolves: (() => void) | null = null;

    renderApprovalCard(
      container as any,
      {
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
        onApprove: async () => {
          approved += 1;
          await new Promise<void>((resolve) => { approveResolves = resolve; });
        },
        onCancel: () => { cancelled += 1; },
      },
    );

    const approveButton = container.querySelector('.shell-approval-confirm');
    const cancelButton = container.querySelector('.shell-approval-cancel');

    approveButton?.click();
    approveButton?.click();
    cancelButton?.click();

    expect(approved).toBe(1);
    expect(cancelled).toBe(0);
    expect(approveButton?.disabled).toBe(true);
    expect(cancelButton?.disabled).toBe(true);
    if (approveResolves) approveResolves();
  });

  await test('renderApprovalCard renders compact icon actions with hover labels', async () => {
    const container = new FakeElement();
    const calls: string[] = [];

    renderApprovalCard(
      container as any,
      {
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
        onCancel: () => { calls.push('cancel'); },
        onFocusPreview: () => { calls.push('focus'); },
      },
    );

    const buttons = container.querySelectorAll('.shell-approval-icon-btn');
    expect(buttons.length).toBe(3);
    expect(buttons.map(button => button.textContent)).toEqual(['', '', '']);
    expect(buttons.map(button => button.attributes.title)).toEqual(['Show editor preview', 'Cancel', 'Approve create']);
    expect(buttons.map(button => button.attributes['aria-label'])).toEqual(['Show editor preview', 'Cancel', 'Approve create']);
    expect(buttons.map(button => button.attributes['data-icon'])).toEqual(['locate-fixed', 'x', 'check']);
    buttons[0].click();
    expect(calls).toEqual(['focus']);
  });

  await test('renderApprovalCard exposes risk target action and concrete approve label', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
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
        onCancel: () => { },
      },
    );

    expect(!!container.querySelector('.is-high-risk')).toBe(true);
    expect(container.querySelector('.shell-approval-risk')?.textContent).toContain('High risk');
    expect(container.querySelector('.shell-approval-action-value')?.textContent).toBe('delete_note');
    expect(container.querySelector('.shell-approval-target-value')?.textContent).toBe('Docs/current.md');
    expect(container.querySelector('.shell-approval-precondition')?.textContent).toContain('target file');
    expect(container.querySelector('.shell-change-preview-precondition')?.textContent).toBeUndefined();
    expect(container.querySelector('.shell-approval-confirm')?.attributes.title).toBe('Approve delete');
  });

  await test('renderApprovalCard shows compact diff preview instead of full side-by-side content', async () => {
    const container = new FakeElement();

    renderApprovalCard(
      container as any,
      {
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
        onCancel: () => { },
      },
    );

    expect(container.querySelector('.shell-approval-title')?.textContent).toBe('需要审批：修改当前笔记');
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
        onCancel: () => { },
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
