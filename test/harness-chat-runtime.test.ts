import type { StreamEvent, ToolDefinition, ToolResult } from '../src/models/interfaces';
import type { ChatRuntimeDeps, NativeChatHandle, PreparedChatTurn } from '../src/runtime/runtime-types';

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
    toBeInstanceOf: (expected: any) => {
      if (!(actual instanceof expected)) {
        throw new Error(`Expected ${actual} to be instance of ${expected.name}`);
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

/**
 * 把 baizer StreamEvent[] 转成 pi 的 AssistantMessageEventStream(同步可迭代 + result())。
 * AgentHarness 内部按 model.api 路由到已注册的 provider,provider 的 stream/streamSimple
 * 返回此形态的事件流。这是「假 LLM 响应」的唯一注入点。
 */
function eventsToPiStream(model: any, events: StreamEvent[]): any {
  const partial: any = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  const out: any[] = [];
  let textIndex: number | undefined;
  let textContent = '';
  let hasToolCall = false;
  let errored = false;
  let finalMessage: any;

  out.push({ type: 'start', partial });
  for (const event of events) {
    if (event.type === 'text_delta') {
      if (textIndex === undefined) {
        textIndex = partial.content.length;
        partial.content.push({ type: 'text', text: '' });
        out.push({ type: 'text_start', contentIndex: textIndex, partial });
      }
      textContent += event.content || '';
      partial.content[textIndex] = { type: 'text', text: textContent };
      out.push({ type: 'text_delta', contentIndex: textIndex, delta: event.content || '', partial });
    } else if (event.type === 'thinking') {
      const idx = partial.content.length;
      partial.content.push({ type: 'thinking', thinking: event.content || '' });
      out.push({ type: 'thinking_start', contentIndex: idx, partial });
      out.push({ type: 'thinking_delta', contentIndex: idx, delta: event.content || '', partial });
      out.push({ type: 'thinking_end', contentIndex: idx, content: event.content || '', partial });
    } else if (event.type === 'tool_call') {
      hasToolCall = true;
      const idx = partial.content.length;
      const toolCall = { type: 'toolCall', id: event.id || `${event.name}_${idx}`, name: event.name, arguments: event.args || {} };
      partial.content.push(toolCall);
      out.push({ type: 'toolcall_start', contentIndex: idx, partial });
      out.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial });
    } else if (event.type === 'error') {
      finalMessage = { ...partial, stopReason: 'error', errorMessage: event.message };
      out.push({ type: 'error', reason: 'error', error: finalMessage });
      errored = true;
      break;
    } else if (event.type === 'done') {
      if (textIndex !== undefined) {
        out.push({ type: 'text_end', contentIndex: textIndex, content: textContent, partial });
      }
      finalMessage = { ...partial, stopReason: hasToolCall ? 'toolUse' : 'stop' };
      out.push({ type: 'done', reason: hasToolCall ? 'toolUse' : 'stop', message: finalMessage });
      break;
    }
  }
  if (!finalMessage && !errored) {
    finalMessage = { ...partial, stopReason: hasToolCall ? 'toolUse' : 'stop' };
    out.push({ type: 'done', reason: hasToolCall ? 'toolUse' : 'stop', message: finalMessage });
  }

  return {
    async *[Symbol.asyncIterator]() { for (const event of out) yield event; },
    result() { return Promise.resolve(finalMessage); },
  };
}

/** 从 pi 传给 provider 的 context.messages 还原「本轮输入」(复刻旧 deriveInput 语义)。 */
function deriveInput(messages: any[]): string | ToolResult[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'toolResult') {
    const batch: any[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'toolResult') break;
      batch.unshift(messages[i]);
    }
    return batch.map((message) => ({
      id: message.toolCallId,
      name: message.toolName,
      response: message.details && Object.prototype.hasOwnProperty.call(message.details, 'baizerResponse')
        ? message.details.baizerResponse
        : unwrapToolResultText(message),
    }));
  }
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
  }
  return '';
}

function unwrapToolResultText(message: any): any {
  const text = (message.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
  if (!text) return message.content;
  try { return JSON.parse(text); } catch { return text; }
}

/** 最小内存 ExecutionEnv:满足 Harness 构造,不触网、不落真实盘。 */
function createMockEnv(): any {
  const ok = (value: any) => ({ ok: true, value });
  const err = (code: string, message: string) => ({ ok: false, error: { code, message } });
  const store = new Map<string, string>();
  return {
    cwd: '/',
    absolutePath: async (p: string) => ok(p),
    joinPath: async (parts: string[]) => ok(parts.join('/')),
    readTextFile: async (p: string) => (store.has(p) ? ok(store.get(p)) : err('not_found', 'nf')),
    readTextLines: async (p: string) => (store.has(p) ? ok((store.get(p) || '').split('\n')) : err('not_found', 'nf')),
    readBinaryFile: async () => err('not_found', 'nf'),
    writeFile: async (p: string, c: string) => { store.set(p, c); return ok(undefined); },
    appendFile: async (p: string, c: string) => { store.set(p, (store.get(p) || '') + c); return ok(undefined); },
    fileInfo: async () => err('not_found', 'nf'),
    listDir: async () => ok([]),
    canonicalPath: async (p: string) => ok(p),
    exists: async (p: string) => ok(store.has(p)),
    createDir: async () => ok(undefined),
    remove: async (p: string) => { store.delete(p); return ok(undefined); },
    createTempDir: async () => ok('/tmp'),
    createTempFile: async () => ok('/tmp/f'),
    cleanup: async () => {},
    exec: async () => err('shell_unavailable', 'no shell'),
  };
}

let mockApiSeq = 0;

function createDeps(options: {
  streamFactory: (input: string | ToolResult[]) => StreamEvent[];
  toolResults?: Record<string, any>;
  workspaceResult?: any;
  workspaceEditService?: any;
  memoryManager?: any;
  skillRegistry?: any;
  toolDefinitions?: ToolDefinition[];
}): ChatRuntimeDeps & {
  sessionInputs: (string | ToolResult[])[];
  registryCalls: any[];
  workspaceCalls: any[];
  capturedReasoning: () => string | undefined;
  register: (piAi: any) => void;
} {
  const sessionInputs: (string | ToolResult[])[] = [];
  const registryCalls: any[] = [];
  const workspaceCalls: any[] = [];
  let lastReasoning: string | undefined;
  const apiName = `mock-${mockApiSeq++}`;
  const model = { id: 'mock-model', name: 'Mock', api: apiName, provider: 'mock', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 } as any;

  // 注册一个 mock api provider:Harness 内部按 model.api 路由到它。
  const streamSimple = (_model: any, context: any, opts?: any) => {
    lastReasoning = opts?.reasoning ?? opts?.thinkingLevel;
    const input = deriveInput(context.messages || []);
    sessionInputs.push(input);
    return eventsToPiStream(model, options.streamFactory(input));
  };
  const register = (piAi: any) => {
    piAi.registerApiProvider({ api: apiName, stream: streamSimple, streamSimple }, 'baizer-test');
  };

  const nativeChatFactory = (): NativeChatHandle => ({ model, getApiKey: () => 'k' });
  const skillRegistry = options.skillRegistry || {
    getSkillSummaryText: () => '',
    activateSkill: (name: string) => ({
      skill: { name },
      instructions: 'Use only web search',
      tools: [{ name: 'web_search', description: 'Search web', parameters: { type: 'object', properties: {} } }],
    }),
  };
  const deps = {
    sessionInputs,
    registryCalls,
    workspaceCalls,
    capturedReasoning: () => lastReasoning,
    register,
    nativeChatFactory,
    harnessEnv: createMockEnv(),
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
      getAllDefinitions: () => options.toolDefinitions ?? [],
      execute: async (name: string, args: any) => {
        registryCalls.push({ name, args });
        return options.toolResults?.[name] ?? { success: true, content: 'A' };
      },
    } as any,
  };
  if (options.workspaceEditService !== undefined) {
    (deps as any).workspaceEditService = options.workspaceEditService;
  }
  return deps as any;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRuntime(deps: any) {
  const piAi: any = await import('@earendil-works/pi-ai');
  deps.register(piAi);
  const { HarnessChatRuntime } = await import('../src/runtime/pi/harness-chat-runtime');
  return new HarnessChatRuntime(deps);
}

async function runTests() {
  console.log('=== Harness Chat Runtime Tests ===');

  await test('query consumes queryStream and returns the final done text', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Hello' },
        { type: 'done', text: 'Hello' },
      ],
    });
    const runtime = await makeRuntime(deps);
    const text = await runtime.query(createTurn());
    expect(text).toBe('Hello');
  });

  await test('streams a no-tool response ending in done text', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Hello' },
        { type: 'done', text: 'Hello' },
      ],
    });
    const runtime = await makeRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    const types = events.map(e => e.type);
    expect(types.includes('text_delta')).toBe(true);
    const textDelta = events.find(e => e.type === 'text_delta') as any;
    expect(textDelta.content).toBe('Hello');
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.text).toBe('Hello');
  });

  await test('runs a tool loop and sends unwrapped Baizer results to the second provider call', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Read done' }, { type: 'done', text: 'Read done' }]
        : [{ type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }],
      toolResults: { read_note: { success: true, content: 'A' } },
    });
    const runtime = await makeRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    const types = events.map(e => e.type);
    expect(types.includes('tool_call')).toBe(true);
    expect(types.includes('tool_result')).toBe(true);
    const done = events.at(-1) as any;
    expect(done.text).toBe('Read done');
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
      workspaceResult: { approval_required: true, action: 'update_file', target: 'A.md' },
    });
    const runtime = await makeRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.text).toBe('');
    expect(deps.sessionInputs.length).toBe(1);

    const deps2 = createDeps({
      streamFactory: () => [
        { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } },
        { type: 'done', text: '' },
      ],
      workspaceResult: { approval_required: true, action: 'update_file', target: 'A.md' },
    });
    const runtime2 = await makeRuntime(deps2);
    const queryText = await runtime2.query(createTurn());
    expect(queryText).toBe('Approval required to update_file: A.md');
  });

  await test('routes workspace write tools through WorkspaceEditService', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Updated' }, { type: 'done', text: 'Updated' }]
        : [{ type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } }, { type: 'done', text: '' }],
    });
    const runtime = await makeRuntime(deps);
    await collect(runtime.queryStream(createTurn()));
    expect(deps.workspaceCalls).toEqual([{ name: 'update_file', args: { path: 'A.md', content: 'after' } }]);
    expect(deps.registryCalls).toEqual([]);
  });

  await test('blocks non-active-skill tools when the turn is scoped to an active skill', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Scoped' }, { type: 'done', text: 'Scoped' }]
        : [{ type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } }, { type: 'done', text: '' }],
      skillRegistry: { getSkillSummaryText: () => '', activateSkill: () => null },
    });
    const runtime = await makeRuntime(deps);
    const scopedTurn = createTurn({ activeSkillName: 'web', activeSkillSource: 'forced', allowedToolNames: ['web_search'] });
    const events = await collect(runtime.queryStream(scopedTurn));
    expect(deps.workspaceCalls).toEqual([]);
    const blocked = events.find(e => e.type === 'tool_result' && e.name === 'update_file') as any;
    expect(blocked.result).toEqual({ error: 'Tool "update_file" is not available for active skill "web"' });
  });

  await test('includes file-write failure warning in streamed done text and query result', async () => {
    const mk = () => createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Updated' }, { type: 'done', text: 'Updated' }]
        : [{ type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: '../A.md', content: 'after' } }, { type: 'done', text: '' }],
      workspaceResult: { success: false, error: 'Unsafe vault path' },
    });
    const runtime = await makeRuntime(mk());
    const done = (await collect(runtime.queryStream(createTurn({ requiresFileWrite: true })))).at(-1) as any;
    expect(done.text).toContain('Unsafe vault path');

    const runtime2 = await makeRuntime(mk());
    const queryText = await runtime2.query(createTurn({ requiresFileWrite: true }));
    expect(queryText).toContain('Unsafe vault path');
  });

  await test('queryStream surfaces generation quality failures in done text', async () => {
    const deps = createDeps({
      streamFactory: () => [{ type: 'text_delta', content: 'Bad sentence.' }, { type: 'done', text: 'Bad sentence.' }],
    });
    const runtime = await makeRuntime(deps);
    const done = (await collect(runtime.queryStream(createTurn({
      selection: 'Bad sentence.',
      generationPlan: { source: 'slash-edit', mode: 'rewrite', targetShape: 'replacement', previewRequired: true, mustPreserveVoice: true, mustUseObsidianMarkdown: true, qualityChecklist: [] },
    } as any)))).at(-1) as any;
    expect(done.text).toContain('Generation quality check failed');
  });

  await test('retains completed turns in memory', async () => {
    const retained: any[] = [];
    const deps = createDeps({
      streamFactory: () => [{ type: 'text_delta', content: 'Remembered' }, { type: 'done', text: 'Remembered' }],
      memoryManager: { retainTurn: async (turn: any) => retained.push(turn) },
    });
    const runtime = await makeRuntime(deps);
    await collect(runtime.queryStream(createTurn({ userRequest: 'remember this' })));
    expect(retained).toEqual([{ userMessage: 'remember this', assistantMessage: 'Remembered', source: 'shell' }]);
  });

  await test('forwards tool results to memory so tool-only turns can be retained', async () => {
    const retained: any[] = [];
    const deps = createDeps({
      // 两阶段:先叫工具(input 是字符串),拿到结果后(input 是数组)给最终答案。
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Saved.' }, { type: 'done', text: 'Saved.' }]
        : [{ type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }],
      toolResults: { read_note: { success: true, content: 'note body' } },
      memoryManager: { retainTurn: async (turn: any) => retained.push(turn) },
    });
    const runtime = await makeRuntime(deps);
    await collect(runtime.queryStream(createTurn({ userRequest: 'open A' })));

    expect(retained.length).toBe(1);
    // toolResults 被接线回传(此前恒缺失 → hadToolAction 恒 false → 工具轮次不沉淀)。
    const tr = retained[0].toolResults;
    expect(Array.isArray(tr)).toBe(true);
    expect(tr.length).toBe(1);
    expect(tr[0].name).toBe('read_note');
  });

  await test('emits provider errors from queryStream and query throws them', async () => {
    const mk = () => createDeps({ streamFactory: () => [{ type: 'error', message: 'provider failed' }] });
    const runtime = await makeRuntime(mk());
    const events = await collect(runtime.queryStream(createTurn()));
    const errorEvent = events.find(e => e.type === 'error') as any;
    expect(errorEvent.message).toContain('provider failed');

    const runtime2 = await makeRuntime(mk());
    try {
      await runtime2.query(createTurn());
      throw new Error('Expected query to throw provider error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toContain('provider failed');
    }
  });

  await test('drops intermediate-turn narration so the final answer keeps only the last turn', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [{ type: 'text_delta', content: 'Here is the real answer.' }, { type: 'done', text: 'Here is the real answer.' }]
        : [{ type: 'text_delta', content: 'Let me read the note first. ' }, { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }],
      toolResults: { read_note: { success: true, content: 'A' } },
    });
    const runtime = await makeRuntime(deps);
    const done = (await collect(runtime.queryStream(createTurn()))).at(-1) as any;
    expect(done.text).toBe('Here is the real answer.');
  });

  await test('forwards turn boundaries as step_boundary events', async () => {
    const deps = createDeps({
      streamFactory: () => [{ type: 'text_delta', content: 'Hi' }, { type: 'done', text: 'Hi' }],
    });
    const runtime = await makeRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    expect(events.some(e => e.type === 'step_boundary')).toBe(true);
  });

  await test('thinking level defaults to medium when not specified in deps', async () => {
    const deps = createDeps({ streamFactory: () => [{ type: 'text_delta', content: 'Hi' }, { type: 'done', text: 'Hi' }] });
    expect((deps as ChatRuntimeDeps).thinkingLevel).toBe(undefined);
    const runtime = await makeRuntime(deps);
    const text = await runtime.query(createTurn());
    expect(text).toBe('Hi');
    expect(deps.capturedReasoning()).toBe('medium');
  });

  await test('thinking level is forwarded from deps', async () => {
    const deps = createDeps({ streamFactory: () => [{ type: 'text_delta', content: 'Low thinking' }, { type: 'done', text: 'Low thinking' }] });
    (deps as ChatRuntimeDeps).thinkingLevel = 'low';
    const runtime = await makeRuntime(deps);
    const text = await runtime.query(createTurn());
    expect(text).toBe('Low thinking');
    expect(deps.capturedReasoning()).toBe('low');
  });

  await test('passes turn.systemPrompt to the harness (decoration not persisted as a message)', async () => {
    // 阶段1:装饰经 systemPrompt 每轮发送,不作为 user 消息持久化。
    // provider 收到的 context 里应只有干净的 user prompt(装饰不在消息流中)。
    const deps = createDeps({
      streamFactory: () => [{ type: 'text_delta', content: 'ok' }, { type: 'done', text: 'ok' }],
    });
    const runtime = await makeRuntime(deps);
    await collect(runtime.queryStream(createTurn({
      prompt: 'clean user request',
      systemPrompt: '[Memory Context] decoration that must not enter the message stream',
    } as any)));
    // 本轮只有一次 provider 调用,输入是干净的 user 请求;装饰不在 messages 里。
    expect(deps.sessionInputs.length).toBe(1);
    const firstInput = deps.sessionInputs[0];
    expect(typeof firstInput === 'string' && firstInput.includes('clean user request')).toBe(true);
    expect(typeof firstInput === 'string' && firstInput.includes('decoration that must not enter')).toBe(false);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});


