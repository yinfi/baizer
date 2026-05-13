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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
