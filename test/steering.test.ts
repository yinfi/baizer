import type { IModelProvider, StreamEvent, ToolDefinition, ToolResult } from '../src/models/interfaces';
import type { ChatRuntimeDeps, NativeChatHandle, PreparedChatTurn } from '../src/runtime/runtime-types';
import { SteeringController, filterPiToolsByActiveTools } from '../src/runtime/steering-controller';

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
    prompt: 'User Request: do a long task',
    tools: [
      { name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} } },
      { name: 'web_search', description: 'Search web', parameters: { type: 'object', properties: {} } },
      { name: 'use_skill', description: 'Use skill', parameters: { type: 'object', properties: {} } },
    ],
    userRequest: 'do a long task',
    ...overrides,
  };
}

/**
 * 构造一个 deps，mock streamFn 记录每一轮收到的输入。
 * streamFactory 接收 (input, callIndex)，便于「第二轮才停」式的多轮编排。
 *
 * 走原生后注入点从 mock IChatSession 上移到 mock streamFn：
 * 每次 agentLoop 调 streamFn 时，从 llmContext.messages 还原本轮输入
 * （首轮=最后一条 user 文本；工具轮=末尾连续 toolResult 批次解包成 ToolResult[]），
 * 喂给 streamFactory，再把 StreamEvent[] 转成 pi 的 AssistantMessageEvent 流。
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
        : message.content,
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
    } else if (event.type === 'tool_call') {
      hasToolCall = true;
      const idx = partial.content.length;
      const toolCall = { type: 'toolCall', id: event.id || `${event.name}_${idx}`, name: event.name, arguments: event.args || {} };
      partial.content.push(toolCall);
      out.push({ type: 'toolcall_start', contentIndex: idx, partial });
      out.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial });
    } else if (event.type === 'done') {
      if (textIndex !== undefined) {
        out.push({ type: 'text_end', contentIndex: textIndex, content: textContent, partial });
      }
      finalMessage = { ...partial, stopReason: hasToolCall ? 'toolUse' : 'stop' };
      out.push({ type: 'done', reason: hasToolCall ? 'toolUse' : 'stop', message: finalMessage });
      break;
    }
  }
  if (!finalMessage) {
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
  streamFactory: (input: string | ToolResult[], callIndex: number) => StreamEvent[];
  steeringController?: SteeringController;
  toolResults?: Record<string, any>;
  onTurn?: (callIndex: number, input: string | ToolResult[]) => void;
}): ChatRuntimeDeps & { sessionInputs: (string | ToolResult[])[] } {
  const sessionInputs: (string | ToolResult[])[] = [];
  let callIndex = 0;
  const model = { id: 'mock-model', name: 'Mock', api: 'mock', provider: 'mock' } as any;
  const streamFn = (_model: any, llmContext: any) => {
    const thisCall = callIndex++;
    const input = deriveInput(llmContext.messages || []);
    sessionInputs.push(input);
    options.onTurn?.(thisCall, input);
    return eventsToPiStream(model, options.streamFactory(input, thisCall));
  };
  const nativeChatFactory = (): NativeChatHandle => ({ model, streamFn: streamFn as any });
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
  };
  const deps = {
    sessionInputs,
    provider,
    nativeChatFactory,
    memoryManager: null,
    skillRegistry: {
      getSkillSummaryText: () => '',
      activateSkill: (name: string) => ({ skill: { name }, instructions: '', tools: [] }),
    } as any,
    workspaceEditService: {
      executeWorkspaceTool: async () => ({ success: true }),
    } as any,
    toolRegistry: {
      get: () => undefined,
      getAllDefinitions: () => [],
      execute: async (name: string) => options.toolResults?.[name] ?? { success: true, content: 'ok' },
    } as any,
    steeringController: options.steeringController,
  };
  return deps;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function isToolResultInput(input: string | ToolResult[]): input is ToolResult[] {
  return Array.isArray(input);
}

async function runTests() {
  console.log('=== Running Steering Tests ===');
  const { PiChatRuntime } = await import('../src/runtime/pi/pi-chat-runtime');

  await test('drainSteeringMessages returns queued user messages then clears', () => {
    const controller = new SteeringController();
    expect(controller.hasPendingSteering()).toBe(false);
    controller.steer('focus on section 2');
    controller.steer('keep it short');
    expect(controller.hasPendingSteering()).toBe(true);

    const drained = controller.drainSteeringMessages();
    expect(drained.length).toBe(2);
    expect(drained[0].role).toBe('user');
    expect(drained[0].content).toBe('focus on section 2');
    expect(drained[1].content).toBe('keep it short');
    // 取出后队列清空。
    expect(controller.hasPendingSteering()).toBe(false);
    expect(controller.drainSteeringMessages().length).toBe(0);
  });

  await test('steer ignores blank text', () => {
    const controller = new SteeringController();
    controller.steer('   ');
    controller.steer('');
    expect(controller.hasPendingSteering()).toBe(false);
  });

  await test('reset clears queued steering and tool updates', () => {
    const controller = new SteeringController();
    controller.steer('hi');
    controller.setActiveTools(['read_note']);
    controller.reset();
    expect(controller.hasPendingSteering()).toBe(false);
    expect(controller.consumeActiveToolsUpdate()).toBe(null);
  });

  await test('consumeActiveToolsUpdate returns set once then null', () => {
    const controller = new SteeringController();
    expect(controller.consumeActiveToolsUpdate()).toBe(null);
    controller.setActiveTools(['read_note', 'web_search']);
    const update = controller.consumeActiveToolsUpdate();
    expect(update instanceof Set).toBe(true);
    expect((update as Set<string>).has('read_note')).toBe(true);
    // 消费后不再重复返回，直到下一次 setActiveTools。
    expect(controller.consumeActiveToolsUpdate()).toBe(null);
  });

  await test('filterPiToolsByActiveTools keeps read_skill plus active tools', () => {
    const tools = [
      { name: 'read_note' },
      { name: 'web_search' },
      { name: 'read_skill' },
      { name: 'delete_note' },
    ];
    const filtered = filterPiToolsByActiveTools(tools, new Set(['read_note']));
    // B 方案：read_skill 是 skill 激活的元能力，收窄工具集时必须保留。
    expect(filtered.map(t => t.name)).toEqual(['read_note', 'read_skill']);
  });

  // 核心断言：运行中追加的 steering 消息被纳入后续轮次，
  // 且不得吞掉尚未回传的工具结果（回归防护）。
  // 编排：第 0 轮模型发起一个工具调用 -> 触发工具循环；
  // 在工具结果到达前往 controller 塞一条补话。
  // 期望：工具结果先作为 ToolResult[] 回传给 provider，补话随后作为独立 user 文本进入更晚一轮。
  await test('steering message added mid-run is injected after the pending tool result is delivered', async () => {
    const controller = new SteeringController();
    // 按到达顺序记录每一轮 provider 收到的输入类型，用于断言「工具结果先、补话后」。
    const inputLog: Array<{ kind: 'tool_result' | 'text'; value: string }> = [];

    const deps = createDeps({
      steeringController: controller,
      toolResults: { read_note: { success: true, content: 'chapter text' } },
      onTurn: (callIndex) => {
        // 在第一轮（发起工具调用那轮）结束后、pi 轮询 steering 前补话。
        if (callIndex === 0) {
          controller.steer('actually, summarize in Chinese');
        }
      },
      streamFactory: (input, callIndex) => {
        if (callIndex === 0) {
          // 首轮：模型请求一个工具，触发工具循环继续。
          return [
            { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'A.md' } },
            { type: 'done', text: '' },
          ];
        }
        // 后续轮：按类型记录输入。工具结果应先于补话到达。
        if (isToolResultInput(input)) {
          inputLog.push({ kind: 'tool_result', value: input.map(r => r.name).join(',') });
        } else {
          inputLog.push({ kind: 'text', value: input });
        }
        return [
          { type: 'text_delta', content: 'Summary' },
          { type: 'done', text: 'Summary' },
        ];
      },
    });

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    // 流正常完成。
    expect((events.at(-1) as any).type).toBe('done');

    // 工具结果作为 ToolResult[] 真的回传给了 provider（read_note 的结果未被吞掉）。
    const toolResultRoundIndex = inputLog.findIndex(e => e.kind === 'tool_result' && e.value.includes('read_note'));
    expect(toolResultRoundIndex >= 0).toBe(true);

    // 补话作为独立的 user 文本输入进入了后续某一轮。
    const steeringRoundIndex = inputLog.findIndex(e => e.kind === 'text' && e.value === 'actually, summarize in Chinese');
    expect(steeringRoundIndex >= 0).toBe(true);

    // 关键顺序：工具结果先回传，补话才进入——证明工具循环契约未被 steering 破坏。
    expect(toolResultRoundIndex < steeringRoundIndex).toBe(true);
  });

  await test('reset on new run drops steering queued before the run started', async () => {
    const controller = new SteeringController();
    // 在运行开始前就排队一条补话 —— 它应被 queryStream 启动时的 reset 清掉，
    // 不污染本次运行（避免上一次残留泄漏到新流）。
    controller.steer('stale instruction from before');
    const seenInputs: string[] = [];

    const deps = createDeps({
      steeringController: controller,
      streamFactory: (input) => {
        if (!isToolResultInput(input)) seenInputs.push(input);
        return [
          { type: 'text_delta', content: 'Done' },
          { type: 'done', text: 'Done' },
        ];
      },
    });

    const runtime = new PiChatRuntime(deps);
    await collect(runtime.queryStream(createTurn()));

    expect(seenInputs.includes('stale instruction from before')).toBe(false);
  });

  // 端到端断言：运行中 setActiveTools 后，pi 在下一轮真的只在收窄后的工具集内执行。
  // 编排：第 0 轮模型调用 read_note（此时全工具可用，应成功）；
  // 第 0 轮 turn 内通过 controller.setActiveTools(['read_note']) 收窄；
  // 第 1 轮模型尝试调用 web_search —— 因 prepareNextTurn 已把 context.tools 过滤掉它，
  // pi 应直接返回「Tool web_search not found」而非执行；第 2 轮收尾。
  await test('setActiveTools mid-run filters pi context.tools so excluded tool is blocked next turn', async () => {
    const controller = new SteeringController();
    const executedTools: string[] = [];

    const deps = createDeps({
      steeringController: controller,
      toolResults: {
        read_note: { success: true, content: 'chapter text' },
        web_search: { success: true, content: 'should never run' },
      },
      onTurn: (callIndex) => {
        // 第 0 轮（首个 assistant 流）内收窄工具集；prepareNextTurn 在本轮 turn_end 后消费它。
        if (callIndex === 0) {
          controller.setActiveTools(['read_note']);
        }
      },
      streamFactory: (_input, callIndex) => {
        if (callIndex === 0) {
          return [
            { type: 'tool_call', id: 'c1', name: 'read_note', args: { path: 'A.md' } },
            { type: 'done', text: '' },
          ];
        }
        if (callIndex === 1) {
          // 收窄后尝试调用被剔除的 web_search。
          return [
            { type: 'tool_call', id: 'c2', name: 'web_search', args: { q: 'x' } },
            { type: 'done', text: '' },
          ];
        }
        return [
          { type: 'text_delta', content: 'final' },
          { type: 'done', text: 'final' },
        ];
      },
    });

    // 包一层 toolRegistry.execute 以记录哪些工具真正被执行，证明 web_search 被短路、未执行。
    const innerExecute = deps.toolRegistry.execute.bind(deps.toolRegistry);
    deps.toolRegistry.execute = async (name: string, args: any) => {
      executedTools.push(name);
      return innerExecute(name, args);
    };

    const runtime = new PiChatRuntime(deps);
    const events = await collect(runtime.queryStream(createTurn()));

    // read_note 在收窄生效前的那一轮执行成功，无错误。
    const readResult = events.find(e => e.type === 'tool_result' && (e as any).name === 'read_note');
    expect(!!readResult).toBe(true);
    expect((readResult as any).error).toBe(undefined);

    // web_search 被收窄剔除：pi 直接报「not found」，工具体未被执行。
    const searchResult = events.find(e => e.type === 'tool_result' && (e as any).name === 'web_search');
    expect(!!searchResult).toBe(true);
    expect(String((searchResult as any).error || '')).toContain('not found');

    expect(executedTools.includes('read_note')).toBe(true);
    expect(executedTools.includes('web_search')).toBe(false);

    // 流正常收尾。
    expect((events.at(-1) as any).type).toBe('done');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
