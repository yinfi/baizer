import type { StreamEvent } from '../src/models/interfaces';
import type { ChatRuntimeDeps, NativeChatHandle, PreparedChatTurn } from '../src/runtime/runtime-types';
import { ActiveRunController, type SteerableHarness } from '../src/runtime/active-run-controller';

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

/** 记录 steer/setActiveTools 调用的假 harness。 */
function createFakeHarness(): SteerableHarness & { steered: string[]; toolSets: string[][] } {
  const steered: string[] = [];
  const toolSets: string[][] = [];
  return {
    steered,
    toolSets,
    async steer(text: string) { steered.push(text); },
    async setActiveTools(names: string[]) { toolSets.push(names); },
  };
}

async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 把 StreamEvent[] 转成 pi 的 AssistantMessageEventStream(与 harness-chat-runtime.test 同款)。 */
function eventsToPiStream(model: any, events: StreamEvent[]): any {
  const partial: any = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  const out: any[] = [{ type: 'start', partial }];
  let ti: number | undefined; let tc = ''; let hasTool = false; let final: any;
  for (const e of events) {
    if (e.type === 'text_delta') {
      if (ti === undefined) { ti = partial.content.length; partial.content.push({ type: 'text', text: '' }); out.push({ type: 'text_start', contentIndex: ti, partial }); }
      tc += e.content || ''; partial.content[ti] = { type: 'text', text: tc };
      out.push({ type: 'text_delta', contentIndex: ti, delta: e.content || '', partial });
    } else if (e.type === 'tool_call') {
      hasTool = true; const i = partial.content.length;
      const t = { type: 'toolCall', id: e.id || `${e.name}_${i}`, name: e.name, arguments: e.args || {} };
      partial.content.push(t);
      out.push({ type: 'toolcall_start', contentIndex: i, partial }, { type: 'toolcall_end', contentIndex: i, toolCall: t, partial });
    } else if (e.type === 'done') {
      if (ti !== undefined) out.push({ type: 'text_end', contentIndex: ti, content: tc, partial });
      final = { ...partial, stopReason: hasTool ? 'toolUse' : 'stop' };
      out.push({ type: 'done', reason: hasTool ? 'toolUse' : 'stop', message: final });
      break;
    }
  }
  if (!final) { final = { ...partial, stopReason: hasTool ? 'toolUse' : 'stop' }; out.push({ type: 'done', reason: hasTool ? 'toolUse' : 'stop', message: final }); }
  return { async *[Symbol.asyncIterator]() { for (const e of out) yield e; }, result() { return Promise.resolve(final); } };
}

let mockSeq = 0;

function createMockEnv(): any {
  const ok = (v: any) => ({ ok: true, value: v });
  const er = (c: string, m: string) => ({ ok: false, error: { code: c, message: m } });
  return {
    cwd: '/', absolutePath: async (p: string) => ok(p), joinPath: async (a: string[]) => ok(a.join('/')),
    readTextFile: async () => er('not_found', 'x'), readTextLines: async () => er('not_found', 'x'), readBinaryFile: async () => er('not_found', 'x'),
    writeFile: async () => ok(undefined), appendFile: async () => ok(undefined), fileInfo: async () => er('not_found', 'x'),
    listDir: async () => ok([]), canonicalPath: async (p: string) => ok(p), exists: async () => ok(false),
    createDir: async () => ok(undefined), remove: async () => ok(undefined), createTempDir: async () => ok('/t'), createTempFile: async () => ok('/t/f'),
    cleanup: async () => {}, exec: async () => er('shell_unavailable', 'x'),
  };
}

async function runE2ETests() {
  // 端到端:运行中补话经 ActiveRunController → 活跃 harness.steer() 注入下一轮。
  await test('mid-run steer via ActiveRunController is injected into a later provider turn', async () => {
    const piAi: any = await import('@earendil-works/pi-ai');
    const apiName = `steer-mock-${mockSeq++}`;
    const lastInputs: string[] = [];
    let call = 0;
    const model = { id: 'm', name: 'm', api: apiName, provider: 'mock', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 100 } as any;
    const streamSimple = (_m: any, ctx: any) => {
      call++;
      const msgs = ctx.messages || [];
      const last = msgs[msgs.length - 1];
      lastInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
      if (call === 1) return eventsToPiStream(model, [{ type: 'tool_call', id: 'c1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }]);
      return eventsToPiStream(model, [{ type: 'text_delta', content: 'final' }, { type: 'done', text: 'final' }]);
    };
    piAi.registerApiProvider({ api: apiName, stream: streamSimple, streamSimple }, 'steer-test');

    const controller = new ActiveRunController();
    const deps: ChatRuntimeDeps = {
      nativeChatFactory: (): NativeChatHandle => ({ model, getApiKey: () => 'k' }) as any,
      harnessEnv: createMockEnv(),
      activeRunController: controller,
      memoryManager: null,
      toolRegistry: {
        get: () => undefined,
        getAllDefinitions: () => [{ name: 'read_note', description: 'r', parameters: { type: 'object', properties: {} } }],
        execute: async () => ({ success: true, content: 'A' }),
      } as any,
      skillRegistry: { getSkillSummaryText: () => '', activateSkill: () => null } as any,
    };

    const { HarnessChatRuntime } = await import('../src/runtime/pi/harness-chat-runtime');
    const runtime = new HarnessChatRuntime(deps);
    const turn: PreparedChatTurn = {
      prompt: 'start task',
      tools: [{ name: 'read_note', description: 'r', parameters: { type: 'object', properties: {} } }],
      userRequest: 'start task',
    };

    // 消费流;在收到首个 tool_result 时通过 controller 补话(此时 runtime 已 register 活跃 harness)。
    let steered = false;
    const events: StreamEvent[] = [];
    for await (const event of runtime.queryStream(turn)) {
      events.push(event);
      if (event.type === 'tool_result' && !steered) {
        steered = true;
        controller.steer('actually, summarize in Chinese');
        await wait(0);
      }
    }

    expect((events.at(-1) as any).type).toBe('done');
    // 补话应作为独立 user 文本进入后续某一轮 provider 输入。
    const injected = lastInputs.some(s => s.includes('actually, summarize in Chinese'));
    expect(injected).toBe(true);
    // 运行结束后控制器应已 clear(不再活跃)。
    expect(controller.isActive()).toBe(false);
  });
}

async function runTests() {
  console.log('=== Running Steering Tests ===');

  // ——— ActiveRunController 单元测试 ———

  await test('isActive reflects register/clear lifecycle', () => {
    const controller = new ActiveRunController();
    expect(controller.isActive()).toBe(false);
    const harness = createFakeHarness();
    controller.register(harness);
    expect(controller.isActive()).toBe(true);
    controller.clear(harness);
    expect(controller.isActive()).toBe(false);
  });

  await test('steer forwards trimmed text to the active harness', async () => {
    const controller = new ActiveRunController();
    const harness = createFakeHarness();
    controller.register(harness);
    controller.steer('  focus on section 2  ');
    await wait(0);
    expect(harness.steered).toEqual(['focus on section 2']);
  });

  await test('steer ignores blank text and no-op when idle', async () => {
    const controller = new ActiveRunController();
    const harness = createFakeHarness();
    controller.register(harness);
    controller.steer('   ');
    controller.steer('');
    await wait(0);
    expect(harness.steered).toEqual([]);

    controller.clear();
    controller.steer('nobody home');
    await wait(0);
    expect(harness.steered).toEqual([]);
  });

  await test('setActiveTools forwards names plus read_skill fallback', async () => {
    const controller = new ActiveRunController();
    const harness = createFakeHarness();
    controller.register(harness);
    controller.setActiveTools(['read_note', 'web_search']);
    await wait(0);
    // read_skill 是 skill 激活的元能力,收窄工具集时必须保留。
    expect(harness.toolSets.length).toBe(1);
    const names = harness.toolSets[0].slice().sort();
    expect(names).toEqual(['read_note', 'read_skill', 'web_search']);
  });

  await test('setActiveTools is a no-op when idle', async () => {
    const controller = new ActiveRunController();
    controller.setActiveTools(['read_note']);
    await wait(0);
    // 无活跃 run,不应抛错;无可断言的副作用,仅验证不抛。
    expect(true).toBe(true);
  });

  await test('clear only clears when the passed harness is the active one', () => {
    const controller = new ActiveRunController();
    const first = createFakeHarness();
    const second = createFakeHarness();
    controller.register(first);
    // 新流已启动(second 登记),旧流结束时用 first 调 clear 不应误清 second。
    controller.register(second);
    controller.clear(first);
    expect(controller.isActive()).toBe(true);
    controller.clear(second);
    expect(controller.isActive()).toBe(false);
  });

  await runE2ETests();
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
