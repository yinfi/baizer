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

async function runTests() {
  console.log('=== Approval Flow Tests ===');
  const { ChatController } = await import('../src/ui/chat-controller');
  const { renderApprovalCard } = await import('../src/ui/approval-card');

  await test('slash command approval result becomes an approval message and can be approved', async () => {
    const messages: any[] = [];
    const apiCalls = {
      executeSlashSkillCommand: [] as any[],
      executeApprovedAction: [] as any[],
    };

    const controller = new ChatController({
      app: {} as any,
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
          };
        },
        executeApprovedAction: async (action: string, args: any) => {
          apiCalls.executeApprovedAction.push({ action, args });
          return { success: true, message: 'Approved and executed' };
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
    });

    await controller.approveApproval(messages[messages.length - 1].approval);

    expect(apiCalls.executeApprovedAction).toEqual([{
      action: 'create_note',
      args: { filename: 'Clippings/example.md', content: '# Saved' },
    }]);
    expect(messages[messages.length - 1].content).toBe('Approved and executed');

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
      },
      {
        onApprove: async () => { approved += 1; },
        onCancel: () => { cancelled += 1; },
      },
    );

    const card = container.children[0];
    const actions = card.children[2];
    const approveButton = actions.children[0];
    const cancelButton = actions.children[1];

    approveButton.click();
    cancelButton.click();

    expect(approved).toBe(1);
    expect(cancelled).toBe(1);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
