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

  await test('maps turn_start to a step boundary for process grouping', () => {
    expect(mapPiEventToStreamEvent({
      type: 'turn_start',
    } as any)).toEqual({ type: 'step_boundary' });
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

  // functional-spec.md §4 决策表:下列 1.3.0 AgentEvent 家族均"不适用/丢弃",
  // 本函数不为它们产出任何 StreamEvent(压缩走独立的 maybeCompact 结果,
  // 不经本函数;usage 搭载在 AgentMessage.usage 字段里,不是独立事件)。
  await test('drops agent_start (no decision-table mapping target)', () => {
    expect(mapPiEventToStreamEvent({ type: 'agent_start' } as any)).toBeUndefined();
  });

  await test('drops turn_end (turn completion handled by the runtime, not this mapping)', () => {
    expect(mapPiEventToStreamEvent({
      type: 'turn_end',
      message: { role: 'assistant', content: [] },
      toolResults: [],
    } as any)).toBeUndefined();
  });

  await test('drops agent_end (final messages handled by the runtime, not this mapping)', () => {
    expect(mapPiEventToStreamEvent({ type: 'agent_end', messages: [] } as any)).toBeUndefined();
  });

  await test('drops message_start (no decision-table mapping target)', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    } as any)).toBeUndefined();
  });

  await test('drops message_end (provider-error branch is intercepted upstream, not here)', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'stop' },
    } as any)).toBeUndefined();
  });

  await test('drops tool_execution_update (no decision-table mapping target)', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_update',
      toolCallId: 'call_1',
      toolName: 'read_note',
      args: {},
      partialResult: 'partial',
    } as any)).toBeUndefined();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
