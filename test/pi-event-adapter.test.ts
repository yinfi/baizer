function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toBeUndefined: () => {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Event Adapter Tests ===');
  const {
    mapPiEventToStreamEvent,
    unwrapPiToolResult,
  } = await import('../src/runtime/pi/pi-event-adapter');

  await test('maps text deltas', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as any)).toEqual({ type: 'text_delta', content: 'hello' });
  });

  await test('maps thinking deltas', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' },
    } as any)).toEqual({ type: 'thinking', content: 'plan' });
  });

  await test('maps tool execution start', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'read_note',
      args: { path: 'note.md' },
    } as any)).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'read_note',
      args: { path: 'note.md' },
    });
  });

  await test('unwraps Baizer tool details from a Pi tool result', () => {
    expect(unwrapPiToolResult({
      content: [{ type: 'text', text: '{"success":true}' }],
      details: {
        baizerResponse: { success: true },
      },
    })).toEqual({ success: true });
  });

  await test('unwraps JSON text content when Baizer details are absent', () => {
    expect(unwrapPiToolResult({
      content: [{ type: 'text', text: '{"path":"note.md"}' }],
    })).toEqual({ path: 'note.md' });
  });

  await test('unwraps non-JSON text content as a message object', () => {
    expect(unwrapPiToolResult({
      content: [{ type: 'text', text: 'plain error' }],
    })).toEqual({ message: 'plain error' });
  });

  await test('returns the original result when content is empty', () => {
    const result = { content: [] };
    expect(unwrapPiToolResult(result)).toEqual(result);
  });

  await test('maps tool execution end', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'read_note',
      result: {
        content: [{ type: 'text', text: '{"path":"note.md"}' }],
        details: {
          baizerResponse: { path: 'note.md' },
        },
      },
      isError: false,
    } as any)).toEqual({
      type: 'tool_result',
      name: 'read_note',
      result: { path: 'note.md' },
    });
  });

  await test('maps tool execution errors with details error first', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_end',
      toolName: 'read_note',
      result: {
        content: [{ type: 'text', text: 'fallback error' }],
        details: { error: 'details error' },
      },
      isError: true,
    } as any)).toEqual({
      type: 'tool_result',
      name: 'read_note',
      result: { message: 'fallback error' },
      error: 'details error',
    });
  });

  await test('maps tool execution errors from text content', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_end',
      toolName: 'read_note',
      result: {
        content: [{ type: 'text', text: 'text error' }],
      },
      isError: true,
    } as any)).toEqual({
      type: 'tool_result',
      name: 'read_note',
      result: { message: 'text error' },
      error: 'text error',
    });
  });

  await test('ignores non-delta message events', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start' },
    } as any)).toBeUndefined();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
