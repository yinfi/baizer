import type { IChatSession, IModelProvider, StreamEvent, ToolDefinition, ToolResult } from '../src/models/interfaces';
import type { ChatRuntimeDeps, PreparedChatTurn } from '../src/runtime/runtime-types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toContain: (expected: string) => {
      if (!String(actual).includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
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

function createTurn(overrides: Partial<PreparedChatTurn> = {}): PreparedChatTurn {
  return {
    prompt: 'User Request: hello',
    tools: [
      { name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} } },
      { name: 'update_file', description: 'Update file', parameters: { type: 'object', properties: {} } },
      { name: 'web_search', description: 'Search web', parameters: { type: 'object', properties: {} } },
      { name: 'use_skill', description: 'Use skill', parameters: { type: 'object', properties: {} } },
    ],
    userRequest: 'hello',
    ...overrides,
  };
}

function createDeps(options: {
  streamFactory: (input: string | ToolResult[]) => StreamEvent[];
  toolResults?: Record<string, any>;
  workspaceResult?: any;
  sendMessageError?: string;
  memoryManager?: any;
  skillRegistry?: any;
}): ChatRuntimeDeps & { sessionInputs: (string | ToolResult[])[]; registryCalls: any[]; workspaceCalls: any[] } {
  const sessionInputs: (string | ToolResult[])[] = [];
  const registryCalls: any[] = [];
  const workspaceCalls: any[] = [];
  const session: IChatSession = {
    async sendMessage() {
      throw new Error(options.sendMessageError || 'sendMessage should not be used by PiChatRuntime.query');
    },
    async *sendMessageStream(input: string | ToolResult[]) {
      sessionInputs.push(input);
      for (const event of options.streamFactory(input)) {
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
  const provider: IModelProvider = {
    id: 'mock',
    name: 'Mock',
    configure() {
      undefined;
    },
    getCapabilities() {
      return { imageInput: false, customBaseUrl: false } as any;
    },
    async checkAvailability() {
      return true;
    },
    async generateContent() {
      return { text: '' };
    },
    startChat(_tools?: ToolDefinition[]) {
      return session;
    },
  };
  const skillRegistry = options.skillRegistry || {
    getSkillSummaryText: () => '',
    activateSkill: (name: string) => ({
      skill: { name },
      instructions: 'Use only web search',
      tools: [{ name: 'web_search', description: 'Search web', parameters: { type: 'object', properties: {} } }],
    }),
  };
  return {
    sessionInputs,
    registryCalls,
    workspaceCalls,
    provider,
    memoryManager: options.memoryManager || null,
    skillRegistry,
    workspaceEditService: {
      executeWorkspaceTool: async (name: string, args: any) => {
        workspaceCalls.push({ name, args });
        return options.workspaceResult ?? { success: true, path: args.path };
      },
    } as any,
    toolRegistry: {
      get: () => undefined,
      getAllDefinitions: () => [],
      execute: async (name: string, args: any) => {
        registryCalls.push({ name, args });
        return options.toolResults?.[name] ?? { success: true, content: 'A' };
      },
    } as any,
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function runTests() {
  console.log('=== Pi Chat Runtime Tests ===');
  const { PiChatRuntime } = await import('../src/runtime/pi/pi-chat-runtime');

  await test('query consumes queryStream and returns the final done text', async () => {
    const deps = createDeps({
      sendMessageError: 'legacy delegated behavior: sendMessage was called',
      streamFactory: () => [
        { type: 'text_delta', content: 'Hello' },
        { type: 'done', text: 'Hello' },
      ],
    });

    const runtime = new PiChatRuntime(deps);
    const text = await runtime.query(createTurn());

    expect(text).toBe('Hello');
  });

  await test('streams a no-tool response through the Pi loop', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Hello' },
        { type: 'done', text: 'Hello' },
      ],
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello' },
      { type: 'done', text: 'Hello' },
    ]);
  });

  await test('runs a tool loop and sends unwrapped Baizer results to the second provider call', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Read done' },
            { type: 'done', text: 'Read done' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } },
            { type: 'done', text: '' },
          ],
      toolResults: { read_note: { success: true, content: 'A' } },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'text_delta', 'done']);
    expect(deps.sessionInputs[1]).toEqual([
      { id: 'call_1', name: 'read_note', response: { success: true, content: 'A' } },
    ]);
  });

  await test('stops after approval-required tool results without another provider call', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } },
        { type: 'done', text: '' },
      ],
      workspaceResult: {
        approval_required: true,
        action: 'update_file',
        target: 'A.md',
      },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'done']);
    expect((events[2] as any).text).toBe('');
    expect(deps.sessionInputs.length).toBe(1);
  });

  await test('routes workspace write tools through WorkspaceEditService', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Updated' },
            { type: 'done', text: 'Updated' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } },
            { type: 'done', text: '' },
          ],
    });

    const runtime = new PiChatRuntime(deps);
    await collect(runtime.queryStream(createTurn()));

    expect(deps.workspaceCalls).toEqual([
      { name: 'update_file', args: { path: 'A.md', content: 'after' } },
    ]);
    expect(deps.registryCalls).toEqual([]);
  });

  await test('activates use_skill and blocks non-active-skill tools in the same Pi turn', async () => {
    const activated: string[] = [];
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Scoped' },
            { type: 'done', text: 'Scoped' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'use_skill', args: { name: 'web' } },
            { type: 'tool_call', id: 'call_2', name: 'update_file', args: { path: 'A.md', content: 'after' } },
            { type: 'done', text: '' },
          ],
      skillRegistry: {
        getSkillSummaryText: () => '',
        activateSkill: (name: string) => {
          activated.push(name);
          return {
            skill: { name },
            instructions: 'Use web_search only',
            tools: [{ name: 'web_search', description: 'Search web', parameters: { type: 'object', properties: {} } }],
          };
        },
      },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    expect(activated).toEqual(['web']);
    expect(deps.workspaceCalls).toEqual([]);
    const blockedResult = events.find(event =>
      event.type === 'tool_result' && event.name === 'update_file',
    ) as any;
    expect(blockedResult.result).toEqual({
      error: 'Tool "update_file" is not available for active skill "web"',
    });
  });

  await test('includes file-write failure warning in streamed done text and query result', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Updated' },
            { type: 'done', text: 'Updated' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: '../A.md', content: 'after' } },
            { type: 'done', text: '' },
          ],
      workspaceResult: { success: false, error: 'Unsafe vault path' },
    });
    const runtime = new PiChatRuntime(deps);
    const done = (await collect(runtime.queryStream(createTurn({ requiresFileWrite: true })))).at(-1) as any;

    expect(done.text).toContain('Unsafe vault path');

    const queryText = await runtime.query(createTurn({ requiresFileWrite: true }));
    expect(queryText).toContain('Unsafe vault path');
  });

  await test('retains completed Pi turns in memory', async () => {
    const retained: any[] = [];
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Remembered' },
        { type: 'done', text: 'Remembered' },
      ],
      memoryManager: {
        retainTurn: async (turn: any) => retained.push(turn),
      },
    });

    const runtime = new PiChatRuntime(deps);
    await collect(runtime.queryStream(createTurn({ userRequest: 'remember this' })));

    expect(retained).toEqual([
      { userMessage: 'remember this', assistantMessage: 'Remembered', source: 'shell' },
    ]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
