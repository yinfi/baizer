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
    this.children.push(child);
    return child;
  }

  setText(text: string) {
    this.textContent = text;
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
        onApprove: async () => { approved += 1; },
        onCancel: () => { cancelled += 1; },
      },
    );

    const card = container.children[0];
    const actions = card.children.find((child: any) => child.className === 'shell-approval-actions');
    const approveButton = actions.children[0];
    const cancelButton = actions.children[1];

    approveButton.click();
    cancelButton.click();

    expect(approved).toBe(1);
    expect(cancelled).toBe(1);
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
