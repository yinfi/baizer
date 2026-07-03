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
 * 走原生后，假 LLM 响应的注入点从 mock IChatSession 上移到 mock streamFn。
 * 下面两个 helper 把测试沿用的 streamFactory(StreamEvent[]) 契约桥接到
 * pi 原生的 AssistantMessageEventStream 上：
 *   - deriveInput：从 agentLoop 传入的 llmContext.messages 还原「本轮输入」
 *     （首轮=最后一条 user 文本；工具轮=末尾连续 toolResult 批次解包成 ToolResult[]）。
 *     这复刻了被删 bridge 的 getBaizerInput 语义，使 sessionInputs 断言保持不变。
 *   - eventsToPiStream：把 StreamEvent[] 转成 pi 的 AssistantMessageEvent 流
 *     （start→text/thinking/toolcall→done），事件形状照搬被删 bridge 的 bridgeBaizerStream。
 */
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
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 把 baizer StreamEvent[] 转成 pi 的 AssistantMessageEventStream（同步可迭代 + result()）。 */
function eventsToPiStream(model: any, events: StreamEvent[]): any {
  const partial: any = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
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
    async *[Symbol.asyncIterator]() {
      for (const event of out) yield event;
    },
    result() {
      return Promise.resolve(finalMessage);
    },
  };
}

function createDeps(options: {
  streamFactory: (input: string | ToolResult[]) => StreamEvent[];
  toolResults?: Record<string, any>;
  workspaceResult?: any;
  workspaceEditService?: any;
  sendMessageError?: string;
  memoryManager?: any;
  skillRegistry?: any;
  toolDefinitions?: ToolDefinition[];
}): ChatRuntimeDeps & {
  sessionInputs: (string | ToolResult[])[];
  registryCalls: any[];
  workspaceCalls: any[];
  capturedReasoning: () => string | undefined;
} {
  const sessionInputs: (string | ToolResult[])[] = [];
  const registryCalls: any[] = [];
  const workspaceCalls: any[] = [];
  let lastReasoning: string | undefined;
  // 假 model：字段足够 eventsToPiStream / convertToLlm 使用即可，不发真实网络。
  const model = { id: 'mock-model', name: 'Mock', api: 'mock', provider: 'mock' } as any;
  // 假 streamFn：每次调用从 llmContext.messages 还原本轮输入，喂给测试的 streamFactory，
  // 再把得到的 StreamEvent[] 转成 pi 事件流。这是「假 LLM 响应」的唯一注入点。
  const streamFn = (_model: any, llmContext: any, opts?: any) => {
    lastReasoning = opts?.reasoning;
    const input = deriveInput(llmContext.messages || []);
    sessionInputs.push(input);
    return eventsToPiStream(model, options.streamFactory(input));
  };
  const nativeChatFactory = (): NativeChatHandle => ({ model, streamFn: streamFn as any });
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
    nativeChatFactory,
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
  return deps;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== Pi Chat Runtime Tests ===');
  const { PiChatRuntime } = await import('../src/runtime/pi/pi-chat-runtime');
  const { createChatRuntime } = await import('../src/runtime/runtime-factory');

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

    // agentLoop 每回合开头发 turn_start → 映射为 step_boundary;单回合响应带 1 个。
    expect(events).toEqual([
      { type: 'step_boundary' },
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

    expect(events.map(event => event.type)).toEqual(['step_boundary', 'tool_call', 'tool_result', 'step_boundary', 'text_delta', 'done']);
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

    expect(events.map(event => event.type)).toEqual(['step_boundary', 'tool_call', 'tool_result', 'done']);
    expect((events[3] as any).text).toBe('');
    expect(deps.sessionInputs.length).toBe(1);

    const queryText = await runtime.query(createTurn());
    expect(queryText).toBe('Approval required to update_file: A.md');
  });

  await test('aborts the Pi tool batch after an approval result', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'This should not run' },
            { type: 'done', text: 'This should not run' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } },
            { type: 'tool_call', id: 'call_2', name: 'read_note', args: { path: 'A.md' } },
            { type: 'done', text: '' },
          ],
      workspaceResult: {
        approval_required: true,
        action: 'update_file',
        target: 'A.md',
      },
      toolResults: { read_note: { success: true, content: 'A' } },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    await wait(20);

    expect(events.map(event => event.type)).toEqual(['step_boundary', 'tool_call', 'tool_result', 'done']);
    expect((events[1] as any).name).toBe('update_file');
    expect((events[3] as any).text).toBe('');
    expect(deps.registryCalls).toEqual([]);
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

  await test('blocks non-active-skill tools when the turn is scoped to an active skill', async () => {
    // B 方案：use_skill 元工具已移除。skill 由 read_skill（普通工具）激活，
    // 工具门控改为 turn 级：prepareTurn 强制激活 skill 时设 activeSkillName/allowedToolNames，
    // 越出白名单的工具在 pi 回合内被拦截。此处直接用带 scope 的 turn 验证该行为。
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Scoped' },
            { type: 'done', text: 'Scoped' },
          ]
        : [
            { type: 'tool_call', id: 'call_1', name: 'update_file', args: { path: 'A.md', content: 'after' } },
            { type: 'done', text: '' },
          ],
      skillRegistry: {
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      },
    });

    const runtime = new PiChatRuntime(deps);
    const scopedTurn = createTurn({
      activeSkillName: 'web',
      allowedToolNames: ['web_search'],
    });
    const events = await collect(runtime.queryStream(scopedTurn));

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

  await test('factory-selected Pi runtime preserves write failure warnings', async () => {
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Created' },
            { type: 'done', text: 'Created' },
          ]
        : [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'create_file',
              args: {
                path: '../summary.canvas',
                content: '{"nodes":[],"edges":[]}',
              },
            },
            { type: 'done', text: '' },
          ],
      toolDefinitions: [
        { name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {} } },
      ],
      toolResults: {
        create_file: { success: false, error: 'Unsafe vault path' },
      },
      workspaceEditService: null,
    });
    const runtime = createChatRuntime(deps);
    const prepared = await runtime.prepareTurn({
      userMessage: 'Create a canvas file',
      contextItems: [],
    });

    const result = await runtime.query(prepared);

    expect(result).toContain('No file was created or modified');
    expect(result).toContain('Unsafe vault path');
  });

  await test('queryStream surfaces generation quality failures in done text', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Bad sentence.' },
        { type: 'done', text: 'Bad sentence.' },
      ],
    });

    const runtime = new PiChatRuntime(deps);
    const done = (await collect(runtime.queryStream(createTurn({
      selection: 'Bad sentence.',
      generationPlan: {
        source: 'slash-edit',
        mode: 'rewrite',
        targetShape: 'replacement',
        previewRequired: true,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    } as any)))).at(-1) as any;

    expect(done.text).toContain('Generation quality check failed');
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

  await test('emits provider errors from queryStream and query throws them', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'error', message: 'provider failed' },
      ],
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    // 错误发生在第一回合内,前面已有 turn_start → step_boundary。
    expect(events).toEqual([
      { type: 'step_boundary' },
      { type: 'error', message: 'provider failed' },
    ]);

    try {
      await runtime.query(createTurn());
      throw new Error('Expected query to throw provider error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe('provider failed');
    }
  });

  await test('persists the completed turn to the injected sessionStore', async () => {
    const appended: Array<{ user: string; assistant: string }> = [];
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Answer' },
        { type: 'done', text: 'Answer' },
      ],
    });
    // 注入一个最小 SessionStore stub，断言 retainCompletedTurn 触发落盘。
    (deps as ChatRuntimeDeps).sessionStore = {
      appendTurn: async (user: string, assistant: string) => {
        appended.push({ user, assistant });
      },
    } as any;

    const runtime = new PiChatRuntime(deps);
    const text = await runtime.query(createTurn({ userRequest: 'persist me' }));

    expect(text).toBe('Answer');
    expect(appended.length).toBe(1);
    expect(appended[0].user).toBe('persist me');
    expect(appended[0].assistant).toBe('Answer');
  });

  await test('turn still completes when sessionStore append throws', async () => {
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Resilient' },
        { type: 'done', text: 'Resilient' },
      ],
    });
    (deps as ChatRuntimeDeps).sessionStore = {
      appendTurn: async () => {
        throw new Error('disk full');
      },
    } as any;

    const runtime = new PiChatRuntime(deps);
    // 落盘失败不得阻断回答返回。
    const text = await runtime.query(createTurn());
    expect(text).toBe('Resilient');
  });

  await test('drops intermediate-turn narration so the final answer keeps only the last turn', async () => {
    // 第一轮: 模型先叙述"我要读文件"再发起工具调用 → 叙述属于过程,不进最终答案。
    // 第二轮(收到工具结果后): 输出真正的回答。done.text 应只含第二轮文本。
    const deps = createDeps({
      streamFactory: (input) => Array.isArray(input)
        ? [
            { type: 'text_delta', content: 'Here is the real answer.' },
            { type: 'done', text: 'Here is the real answer.' },
          ]
        : [
            { type: 'text_delta', content: 'Let me read the note first. ' },
            { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } },
            { type: 'done', text: '' },
          ],
      toolResults: { read_note: { success: true, content: 'A' } },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));
    const done = events.at(-1) as any;

    // 中间叙述通过 text_delta 透传给 UI(沉淀进时间线),但不留在最终答案里。
    expect(done.text).toBe('Here is the real answer.');
    // query() 同样只返回末轮答案。
    const queryText = await runtime.query(createTurn());
    expect(queryText).toBe('Here is the real answer.');
  });

  await test('forwards turn_start as a step_boundary through queryStream', async () => {
    // step_boundary 由真实 agentLoop 的 turn_start 派生(非 provider 层注入)。
    // 单回合无工具响应应恰好携带 1 个 step_boundary,位于内容之前。
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Hi' },
        { type: 'done', text: 'Hi' },
      ],
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    expect(events.map(event => event.type)).toEqual(['step_boundary', 'text_delta', 'done']);
  });

  await test('thinking level defaults to medium when not specified in deps', async () => {
    // deps 未设置 thinkingLevel，agentLoop config.reasoning 以 "medium" 兜底，
    // 透传到 streamFn 的 options.reasoning。
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Hi' },
        { type: 'done', text: 'Hi' },
      ],
    });
    // 明确不设置 thinkingLevel，保留 undefined。
    expect((deps as ChatRuntimeDeps).thinkingLevel).toBe(undefined);

    const runtime = new PiChatRuntime(deps);
    const text = await runtime.query(createTurn());
    expect(text).toBe('Hi');
    // thinkingLevel 未设置时，streamFn 收到的 reasoning 以 "medium" 兜底。
    expect(deps.capturedReasoning()).toBe('medium');
  });

  await test('thinking level is forwarded from deps to the native streamFn and model', async () => {
    // 验证透传路径：deps.thinkingLevel → agentLoop config.reasoning → streamFn options.reasoning；
    // 同时验证 pi-native-model 依 thinkingLevel 设置 model.reasoning。
    const deps = createDeps({
      streamFactory: () => [
        { type: 'text_delta', content: 'Low thinking' },
        { type: 'done', text: 'Low thinking' },
      ],
    });
    (deps as ChatRuntimeDeps).thinkingLevel = 'low';

    const runtime = new PiChatRuntime(deps);
    const text = await runtime.query(createTurn());
    expect(text).toBe('Low thinking');
    // thinkingLevel 必须从 deps 透传到 streamFn 的 reasoning。
    expect(deps.capturedReasoning()).toBe('low');

    // 验证原生 model 构造：'low' 不是 'off'，所以 reasoning 应为 true。
    const { buildGeminiModel } = await import('../src/runtime/pi/pi-native-model');
    const lowModel = buildGeminiModel(
      { type: 'gemini', label: 'G', apiKey: 'k', baseUrl: '', model: 'gemini-2.5-flash' },
      undefined,
      'low',
    );
    expect(lowModel.reasoning).toBe(true);

    // 'off' 时 reasoning 应为 false。
    const offModel = buildGeminiModel(
      { type: 'gemini', label: 'G', apiKey: 'k', baseUrl: '', model: 'gemini-2.5-flash' },
      undefined,
      'off',
    );
    expect(offModel.reasoning).toBe(false);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
