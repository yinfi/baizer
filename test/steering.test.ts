import type { StreamEvent, ToolDefinition, ToolResult } from '../src/models/interfaces';
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
  const deps = {
    sessionInputs,
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

  // ————————————————————————————————————————————————————————————————
  // 阶段2 待重写:以下 3 个「运行中 steering」端到端断言原本驱动已删除的 PiChatRuntime,
  // 验证旧的 getSteeringMessages/prepareNextTurn 自造钩子。阶段2 会删掉 SteeringController、
  // 改用 AgentHarness 原生 steer()/setActiveTools(),届时这些行为断言在 Harness 接缝上重建。
  // 阶段0 只接入引擎、不接管 steering,故此处显式跳过而非伪造通过。
  // ————————————————————————————————————————————————————————————————
  console.log('  SKIP (phase 2) steering message injected after pending tool result');
  console.log('  SKIP (phase 2) reset on new run drops pre-run steering');
  console.log('  SKIP (phase 2) setActiveTools mid-run filters context.tools');
  return;

}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
