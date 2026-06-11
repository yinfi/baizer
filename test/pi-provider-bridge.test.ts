import type { Context, ToolResultMessage } from '@earendil-works/pi-ai';
import type { IChatSession, StreamEvent, ToolResult } from '../src/models/interfaces';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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

function createMockSession(eventsOrFactory: StreamEvent[] | ((input: string | ToolResult[]) => AsyncGenerator<StreamEvent, void, unknown>)): IChatSession & { inputs: (string | ToolResult[])[] } {
  const inputs: (string | ToolResult[])[] = [];
  return {
    inputs,
    async sendMessage() {
      return { text: '' };
    },
    async *sendMessageStream(input: string | ToolResult[]) {
      inputs.push(input);
      if (typeof eventsOrFactory === 'function') {
        yield* eventsOrFactory(input);
        return;
      }
      for (const event of eventsOrFactory) {
        yield event;
      }
    },
    async getHistory() {
      return [];
    },
    async clearHistory() {
      undefined;
    },
  };
}

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function runTests() {
  console.log('=== Pi Provider Bridge Tests ===');
  const {
    createBaizerStreamFn,
    createPiBridgeModel,
  } = await import('../src/runtime/pi/pi-provider-bridge');

  await test('bridges Baizer text deltas into Pi assistant text events', async () => {
    const session = createMockSession([
      { type: 'text_delta', content: 'hi' },
      { type: 'done', text: 'hi' },
    ]);
    const model = createPiBridgeModel();
    const context: Context = {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    };

    const stream = createBaizerStreamFn(session)(model, context);
    const events = await collect(stream);
    const result = await stream.result();

    expect(events.map(event => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
    expect(result.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(session.inputs).toEqual(['hello']);
  });

  await test('bridges Baizer thinking deltas into Pi assistant thinking events', async () => {
    const session = createMockSession([
      { type: 'thinking', content: 'plan' },
      { type: 'text_delta', content: 'hi' },
      { type: 'done', text: 'hi' },
    ]);
    const model = createPiBridgeModel();
    const context: Context = {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    };

    const stream = createBaizerStreamFn(session)(model, context);
    const events = await collect(stream);
    const result = await stream.result();

    expect(events.map(event => event.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);
    expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'plan' });
    expect(result.content[1]).toEqual({ type: 'text', text: 'hi' });
  });

  await test('bridges Baizer tool calls into Pi tool call events', async () => {
    const session = createMockSession([
      { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'Daily.md' } },
      { type: 'done', text: '' },
    ]);
    const model = createPiBridgeModel();
    const context: Context = {
      messages: [{ role: 'user', content: 'read it', timestamp: 1 }],
    };

    const stream = createBaizerStreamFn(session)(model, context);
    const events = await collect(stream);
    const result = await stream.result();
    const toolEnd = events.find(event => event.type === 'toolcall_end');

    expect(events.map(event => event.type)).toEqual(['start', 'toolcall_start', 'toolcall_end', 'done']);
    expect(toolEnd.toolCall).toEqual({
      type: 'toolCall',
      id: 'call_1',
      name: 'read_note',
      arguments: { path: 'Daily.md' },
    });
    expect(result.stopReason).toBe('toolUse');
    expect(result.content[0]).toEqual(toolEnd.toolCall);
  });

  await test('converts Pi tool results into Baizer tool result input', async () => {
    const session = createMockSession([
      { type: 'text_delta', content: 'ok' },
      { type: 'done', text: 'ok' },
    ]);
    const model = createPiBridgeModel();
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read_note',
      content: [{ type: 'text', text: '{"fallback":true}' }],
      details: { baizerResponse: { content: 'from details' } },
      isError: false,
      timestamp: 2,
    };

    const stream = createBaizerStreamFn(session)(model, { messages: [toolResult] });
    await collect(stream);

    expect(session.inputs).toEqual([[
      { id: 'call_1', name: 'read_note', response: { content: 'from details' } },
    ]]);
  });

  await test('sends only the trailing Pi tool result batch to Baizer', async () => {
    const session = createMockSession([
      { type: 'text_delta', content: 'ok' },
      { type: 'done', text: 'ok' },
    ]);
    const model = createPiBridgeModel();
    const oldToolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_old',
      toolName: 'read_note',
      content: [{ type: 'text', text: '{"old":true}' }],
      isError: false,
      timestamp: 2,
    };
    const assistantMessage: any = {
      role: 'assistant',
      content: [{ type: 'text', text: 'old result processed' }],
      api: 'baizer-bridge',
      provider: 'baizer',
      model: 'baizer-bridge',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 3,
    };
    const newToolResult1: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_new_1',
      toolName: 'search_vault',
      content: [{ type: 'text', text: '{"matches":["A.md"]}' }],
      isError: false,
      timestamp: 4,
    };
    const newToolResult2: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_new_2',
      toolName: 'read_note',
      content: [{ type: 'text', text: '{"content":"A"}' }],
      isError: false,
      timestamp: 5,
    };

    const stream = createBaizerStreamFn(session)(model, {
      messages: [
        { role: 'user', content: 'start', timestamp: 1 },
        oldToolResult,
        assistantMessage,
        newToolResult1,
        newToolResult2,
      ],
    });
    await collect(stream);

    expect(session.inputs).toEqual([[
      { id: 'call_new_1', name: 'search_vault', response: { matches: ['A.md'] } },
      { id: 'call_new_2', name: 'read_note', response: { content: 'A' } },
    ]]);
  });

  await test('falls back to non-JSON tool result text as Baizer response', async () => {
    const session = createMockSession([
      { type: 'text_delta', content: 'ok' },
      { type: 'done', text: 'ok' },
    ]);
    const model = createPiBridgeModel();
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'read_note',
      content: [{ type: 'text', text: 'plain text' }],
      isError: false,
      timestamp: 2,
    };

    const stream = createBaizerStreamFn(session)(model, { messages: [toolResult] });
    await collect(stream);

    expect(session.inputs).toEqual([[
      { id: 'call_2', name: 'read_note', response: 'plain text' },
    ]]);
  });

  await test('maps Baizer error events to Pi error events without rejecting the stream function', async () => {
    const session = createMockSession([
      { type: 'error', message: 'provider failed' },
    ]);
    const model = createPiBridgeModel();

    const stream = createBaizerStreamFn(session)(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }],
    });
    const events = await collect(stream);
    const result = await stream.result();

    expect(events.map(event => event.type)).toEqual(['start', 'error']);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('provider failed');
  });

  await test('maps thrown Baizer stream errors to Pi error events', async () => {
    const session = createMockSession(async function* () {
      throw new Error('stream exploded');
    });
    const model = createPiBridgeModel();

    const stream = createBaizerStreamFn(session)(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    });
    const events = await collect(stream);
    const result = await stream.result();

    expect(events.map(event => event.type)).toEqual(['start', 'error']);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('stream exploded');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
