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

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== ChatState Tests ===');
  const { ChatState } = await import('../src/ui/state/chat-state');

  await test('tracks messages, streaming state, and dirty state', () => {
    const state = new ChatState('tab-1');

    state.addMessage({ id: 'm1', role: 'user', content: 'hello', timestamp: 1 });
    state.setStreaming(true);

    expect(state.getMessages()).toEqual([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
    ]);
    expect(state.isStreaming()).toBe(true);
    expect(state.isDirty()).toBe(true);

    state.markClean();
    expect(state.isDirty()).toBe(false);
  });

  await test('updates, removes, and clears messages', () => {
    const state = new ChatState('tab-1');

    state.addMessage({ id: 'm1', role: 'user', content: 'hello', timestamp: 1 });
    state.addMessage({ id: 'm2', role: 'ai', content: 'hi', timestamp: 2 });
    state.updateMessage('m2', { content: 'updated', feedback: 'up' });
    state.removeMessage('m1');

    expect(state.getMessages()).toEqual([
      { id: 'm2', role: 'ai', content: 'updated', timestamp: 2, feedback: 'up' },
    ]);

    state.clearMessages();
    expect(state.getMessages()).toEqual([]);
  });

  await test('upserts tool runs and returns defensive copies', () => {
    const state = new ChatState('tab-1');

    state.upsertTool({
      id: 'tool-1',
      name: 'read_note',
      status: 'running',
      input: { path: 'Daily.md' },
      startedAt: 10,
    });
    state.upsertTool({
      id: 'tool-1',
      name: 'read_note',
      status: 'completed',
      input: { path: 'Daily.md' },
      result: 'done',
      startedAt: 10,
      finishedAt: 20,
    });

    const tools = state.getTools();
    tools[0].status = 'error';

    expect(state.getTools()).toEqual([{
      id: 'tool-1',
      name: 'read_note',
      status: 'completed',
      input: { path: 'Daily.md' },
      result: 'done',
      startedAt: 10,
      finishedAt: 20,
    }]);
  });

  await test('tracks workspace edits and returns defensive copies', () => {
    const state = new ChatState('tab-1');

    state.upsertWorkspaceEdit({
      id: 'edit-1',
      action: 'update_file',
      path: 'Notes/source.md',
      kind: 'update',
      appliedAt: 10,
      status: 'applied',
    });
    state.upsertWorkspaceEdit({
      id: 'edit-1',
      action: 'update_file',
      path: 'Notes/source.md',
      kind: 'update',
      appliedAt: 10,
      status: 'undone',
    });

    const edits = state.getWorkspaceEdits();
    edits[0].status = 'applied';

    expect(state.getWorkspaceEdits()).toEqual([{
      id: 'edit-1',
      action: 'update_file',
      path: 'Notes/source.md',
      kind: 'update',
      appliedAt: 10,
      status: 'undone',
    }]);
  });

  await test('clones approval previews inside messages', () => {
    const state = new ChatState('tab-1');

    state.addMessage({
      id: 'm3',
      role: 'system',
      content: 'Approval required',
      timestamp: 3,
      approval: {
        action: 'create_file',
        target: 'Plans/Native-AI.md',
        args: { path: 'Plans/Native-AI.md' },
        message: 'Approval required',
        preview: {
          kind: 'note-create',
          target: 'Plans/Native-AI.md',
          summary: 'Create note',
          preconditions: ['Folder exists'],
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
    } as any);

    const messages = state.getMessages();
    messages[0].approval.preview.preconditions.push('Mutated');

    expect(state.getMessages()).toEqual([{
      id: 'm3',
      role: 'system',
      content: 'Approval required',
      timestamp: 3,
      approval: {
        action: 'create_file',
        target: 'Plans/Native-AI.md',
        args: { path: 'Plans/Native-AI.md' },
        message: 'Approval required',
        preview: {
          kind: 'note-create',
          target: 'Plans/Native-AI.md',
          summary: 'Create note',
          preconditions: ['Folder exists'],
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
    }]);
  });

  await test('clones workspace edit metadata inside messages', () => {
    const state = new ChatState('tab-1');

    state.addMessage({
      id: 'workspace-edit-edit-1',
      role: 'system',
      content: '',
      timestamp: 4,
      metadata: {
        workspaceEdit: {
          id: 'edit-1',
          action: 'update_file',
          path: 'Notes/source.md',
          kind: 'update',
          appliedAt: 4,
          status: 'applied',
          lineDelta: 2,
        },
      },
    } as any);

    const messages = state.getMessages();
    messages[0].metadata.workspaceEdit.status = 'undone';

    expect(state.getMessages()).toEqual([{
      id: 'workspace-edit-edit-1',
      role: 'system',
      content: '',
      timestamp: 4,
      metadata: {
        workspaceEdit: {
          id: 'edit-1',
          action: 'update_file',
          path: 'Notes/source.md',
          kind: 'update',
          appliedAt: 4,
          status: 'applied',
          lineDelta: 2,
        },
      },
    }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
