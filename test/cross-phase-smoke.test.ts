import type { StreamEvent, ToolDefinition } from '../src/models/interfaces';
import type { ChatRuntimeDeps, PreparedChatTurn } from '../src/runtime/runtime-types';

/**
 * 跨阶段整体回归冒烟。
 *
 * 用「真实」的运行时组件拼装(HarnessChatRuntime + HarnessSessionManager +
 * ActiveRunController + PromptTemplateService),只在边界打桩:
 * - provider:pi registerApiProvider 注册 mock(不触网)。
 * - vault:内存 VaultFileAdapter(不碰真实磁盘)。
 *
 * 一条场景串起四个阶段:
 *   阶段0 引擎:工具循环 → 最终答案、审批 terminate。
 *   阶段1 会话:跨轮上下文、JSONL 持久化、历史干净(装饰不落盘)、自动压缩阈值。
 *   阶段2 steering:运行中补话经 ActiveRunController 注入后续轮。
 *   阶段3 命令:用户 .md 模板解析 + 参数替换。
 */

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
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

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 StreamEvent[] 转成 pi 的 AssistantMessageEventStream。 */
function eventsToPiStream(model: any, events: StreamEvent[], usageTokens = 2): any {
  const partial: any = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: usageTokens, output: usageTokens, cacheRead: 0, cacheWrite: 0, totalTokens: usageTokens * 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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
      out.push({ type: 'done', reason: hasTool ? 'toolUse' : 'stop', message: final }); break;
    }
  }
  if (!final) { final = { ...partial, stopReason: hasTool ? 'toolUse' : 'stop' }; out.push({ type: 'done', reason: hasTool ? 'toolUse' : 'stop', message: final }); }
  return { async *[Symbol.asyncIterator]() { for (const e of out) yield e; }, result() { return Promise.resolve(final); } };
}

/** 内存 VaultFileAdapter(HarnessSessionManager + PromptTemplateService 共用)。 */
function createMemoryVault(seed: Record<string, string> = {}) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) files.set(norm(k), v);
  return {
    files,
    adapter: {
      read: async (p: string) => { const n = norm(p); if (!files.has(n)) throw new Error('ENOENT ' + n); return files.get(n)!; },
      write: async (p: string, d: string) => { files.set(norm(p), d); },
      append: async (p: string, d: string) => { const n = norm(p); files.set(n, (files.get(n) || '') + d); },
      exists: async (p: string) => files.has(norm(p)),
      mkdir: async () => {},
      list: async (p: string) => {
        const base = norm(p); const fs: string[] = []; const folders = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(base + '/')) {
            const rest = key.slice(base.length + 1);
            if (rest.includes('/')) folders.add(base + '/' + rest.split('/')[0]);
            else fs.push(key);
          }
        }
        return { files: fs, folders: [...folders] };
      },
      remove: async (p: string) => { files.delete(norm(p)); },
    },
  };
}

const TOOL_DEFS: ToolDefinition[] = [
  { name: 'read_note', description: 'Read a note', parameters: { type: 'object', properties: {} } },
  { name: 'update_file', description: 'Update a file', parameters: { type: 'object', properties: {} } },
];

/** 组装真实运行时组件。scripted:按 provider 调用序返回的 StreamEvent[]。 */
async function buildStack(opts: {
  scripted: (input: string, callIndex: number) => StreamEvent[];
  vaultSeed?: Record<string, string>;
  contextWindow?: number;
  workspaceResult?: any;
  /** 每轮 assistant 回复的真实 usage token 数(estimateContextTokens 优先用它)。默认 2。 */
  usageTokens?: number;
}) {
  const piAi: any = await import('@earendil-works/pi-ai');
  const { HarnessSessionManager } = await import('../src/runtime/pi/harness-session-manager');
  const { createHarnessExecutionEnv } = await import('../src/runtime/pi/harness-env');
  const { PromptTemplateService } = await import('../src/runtime/pi/prompt-template-service');
  const { ActiveRunController } = await import('../src/runtime/active-run-controller');
  const { HarnessChatRuntime } = await import('../src/runtime/pi/harness-chat-runtime');

  const apiName = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const model = { id: 'm', name: 'm', api: apiName, provider: 'mock', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: opts.contextWindow ?? 100000, maxTokens: 100 } as any;
  const providerInputs: string[] = [];
  let call = 0;
  const streamSimple = (_m: any, ctx: any) => {
    const msgs = ctx.messages || [];
    const last = msgs[msgs.length - 1];
    const input = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    providerInputs.push(input);
    const events = opts.scripted(input, call);
    call++;
    return eventsToPiStream(model, events, opts.usageTokens ?? 2);
  };
  piAi.registerApiProvider({ api: apiName, stream: streamSimple, streamSimple }, apiName);

  const vault = createMemoryVault(opts.vaultSeed);
  const { createVaultFileAdapter } = await import('../src/runtime/pi/vault-session-fs');
  const vaultAdapter = createVaultFileAdapter(vault.adapter as any);
  let savedRef: any = null;
  const sessionManager = new HarnessSessionManager(vaultAdapter, {
    loadRef: () => savedRef, saveRef: (r: any) => { savedRef = r; }, contextWindow: () => opts.contextWindow ?? 100000,
  });
  const harnessEnv = createHarnessExecutionEnv(vaultAdapter);
  const promptTemplateService = new PromptTemplateService(harnessEnv);
  const activeRunController = new ActiveRunController();

  const deps: ChatRuntimeDeps = {
    nativeChatFactory: () => ({ model, getApiKey: () => 'k' }) as any,
    harnessEnv,
    sessionManager,
    activeRunController,
    memoryManager: null,
    toolRegistry: {
      get: () => undefined,
      getAllDefinitions: () => TOOL_DEFS,
      execute: async () => ({ success: true, content: 'note body' }),
    } as any,
    skillRegistry: { getSkillSummaryText: () => '', activateSkill: () => null } as any,
    workspaceEditService: { executeWorkspaceTool: async () => opts.workspaceResult ?? { success: true } } as any,
    getUserCommandEntries: () => promptTemplateService.listCommandsSync().map(c => ({ command: c.command, description: c.description })),
  };
  const runtime = new HarnessChatRuntime(deps);

  const collect = async (turn: PreparedChatTurn, signal?: AbortSignal) => {
    const events: StreamEvent[] = [];
    for await (const e of runtime.queryStream(turn, signal)) events.push(e);
    return events;
  };

  return { runtime, collect, providerInputs, vault, sessionManager, promptTemplateService, activeRunController, getCall: () => call };
}

const cleanTurn = (prompt: string, extra: Partial<PreparedChatTurn> = {}): PreparedChatTurn => ({
  prompt, tools: TOOL_DEFS, userRequest: prompt, ...extra,
});

async function runTests() {
  console.log('=== Cross-Phase Regression Smoke ===');

  // 阶段0+1:工具循环 → 最终答案;跨轮上下文;JSONL 持久化;历史干净(装饰不落盘)。
  await test('phase0+1: tool loop, cross-turn context, clean persisted history', async () => {
    const stack = await buildStack({
      scripted: (input) => input.includes('read_note') || input.includes('note body')
        ? [{ type: 'text_delta', content: 'here is the summary' }, { type: 'done', text: 'here is the summary' }]
        : [{ type: 'tool_call', id: 'c1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }],
    });

    // 轮1:带装饰的 systemPrompt + 干净 prompt,触发工具循环。
    const e1 = await stack.collect(cleanTurn('summarize A.md', { systemPrompt: '[Memory Context] SECRET_DECORATION' }));
    assert(e1.some(e => e.type === 'tool_call'), 'expected a tool_call');
    assert((e1.at(-1) as any).text === 'here is the summary', 'final answer wrong');

    // 轮2:全新流复用同一 session,provider 应看到轮1历史(跨轮上下文)。
    await stack.collect(cleanTurn('and the key points?'));
    const round2Ctx = stack.providerInputs.join('\n');
    assert(round2Ctx.includes('summarize A.md'), 'round 2 should see round-1 user message');

    // 持久化:JSONL 落盘,含干净 userRequest,但不含 systemPrompt 装饰。
    const jsonl = [...stack.vault.files.entries()].filter(([k]) => k.endsWith('.jsonl')).map(([, v]) => v).join('\n');
    assert(jsonl.includes('summarize A.md'), 'session jsonl missing clean user request');
    assert(!jsonl.includes('SECRET_DECORATION'), 'decoration leaked into persisted history (phase-1 regression)');
    assert(!!stack.sessionManager.getRef(), 'sessionRef not persisted');
  });

  // 阶段0:审批 terminate —— 写工具返回 approval_required 时本轮结束,不再发 provider 调用。
  await test('phase0: approval-required tool terminates the turn', async () => {
    const stack = await buildStack({
      scripted: () => [{ type: 'tool_call', id: 'c1', name: 'update_file', args: { path: 'A.md', content: 'x' } }, { type: 'done', text: '' }],
      workspaceResult: { approval_required: true, action: 'update_file', target: 'A.md' },
    });
    const events = await stack.collect(cleanTurn('update A.md with x'));
    assert((events.at(-1) as any).type === 'done', 'should end with done');
    assert((events.at(-1) as any).text === '', 'approval turn should yield empty final text');
    // 只发生一次 provider 调用(审批后不继续)。
    assert(stack.getCall() === 1, `expected exactly 1 provider call, got ${stack.getCall()}`);
  });

  // 阶段2:运行中 steering —— 收到 tool_result 时经 ActiveRunController 补话,注入后续轮。
  await test('phase2: mid-run steer via ActiveRunController reaches a later provider turn', async () => {
    const stack = await buildStack({
      scripted: (input) => input.includes('read_note') || input.includes('note body')
        ? [{ type: 'text_delta', content: 'done' }, { type: 'done', text: 'done' }]
        : [{ type: 'tool_call', id: 'c1', name: 'read_note', args: { path: 'A.md' } }, { type: 'done', text: '' }],
    });
    let steered = false;
    const events: StreamEvent[] = [];
    for await (const e of stack.runtime.queryStream(cleanTurn('start task'))) {
      events.push(e);
      if (e.type === 'tool_result' && !steered) {
        steered = true;
        stack.activeRunController.steer('STEER_INJECTED focus on section 2');
        await wait(0);
      }
    }
    assert((events.at(-1) as any).type === 'done', 'stream should complete');
    assert(stack.providerInputs.some(s => s.includes('STEER_INJECTED')), 'steered message never reached provider');
    // 运行结束后控制器清空。
    assert(stack.activeRunController.isActive() === false, 'controller should be idle after run');
  });

  // 阶段3:用户自定义命令 —— .md 模板解析 + $ARGUMENTS 替换。
  await test('phase3: user command template resolves with argument substitution', async () => {
    const stack = await buildStack({
      scripted: () => [{ type: 'done', text: 'ok' }],
      vaultSeed: {
        '.obsidian/baizer-commands/summarize.md': '---\ndescription: Summarize input\n---\nPlease summarize: $ARGUMENTS',
      },
    });
    await stack.promptTemplateService.load();
    // 命令出现在快照(供 / 补全与 slash 契约)。
    const cmds = stack.promptTemplateService.listCommandsSync();
    assert(cmds.some(c => c.command === '/summarize'), 'user command not listed');
    // 解析 + 参数替换。
    const expanded = await stack.promptTemplateService.resolve('/summarize', 'the Q3 report');
    assert(expanded === 'Please summarize: the Q3 report', `bad expansion: ${expanded}`);
    // slash 契约把用户命令列给模型(阶段3 接线)。
    assert(stack.promptTemplateService.listCommandsSync().length === 1, 'exactly one user command expected');
  });

  // 阶段1:自动压缩 —— 真实累积 token 超过 (contextWindow - reserveTokens) 时触发 harness.compact()。
  // reserveTokens 默认 16384;取窗口略高于它,让几轮的真实 usage 累积越过 (window - reserve) 的正阈值,
  // 验证的是「真实溢出触发」而非负阈值假触发(后者是我们刚修掉的坑)。
  await test('phase1: auto-compaction triggers on genuine context overflow', async () => {
    const RESERVE = 16384;
    const MARGIN = 300; // 有效阈值 = window - reserve = 300
    // 每轮真实 usage.totalTokens = 500 > 阈值 300 → estimateContextTokens 越过阈值,genuine 触发。
    const stack = await buildStack({
      scripted: () => [{ type: 'text_delta', content: 'reply' }, { type: 'done', text: 'reply' }],
      contextWindow: RESERVE + MARGIN,
      usageTokens: 250, // eventsToPiStream: totalTokens = usageTokens*2 = 500
    });
    for (let i = 0; i < 3; i++) {
      await stack.collect(cleanTurn(`turn ${i}`));
    }
    const jsonl = [...stack.vault.files.entries()].filter(([k]) => k.endsWith('.jsonl')).map(([, v]) => v).join('\n');
    assert(jsonl.includes('"type":"compaction"') || jsonl.includes('compaction'), 'expected a compaction entry after genuine overflow');
  });

  // 阶段1 防呆:contextWindow <= reserveTokens 时,压缩不应每轮假触发(修复的负阈值坑)。
  await test('phase1: no spurious compaction when window <= reserveTokens', async () => {
    const stack = await buildStack({
      scripted: () => [{ type: 'text_delta', content: 'reply' }, { type: 'done', text: 'reply' }],
      contextWindow: 50, // < reserveTokens(16384)
    });
    for (let i = 0; i < 4; i++) {
      await stack.collect(cleanTurn(`turn ${i} short`));
    }
    const jsonl = [...stack.vault.files.entries()].filter(([k]) => k.endsWith('.jsonl')).map(([, v]) => v).join('\n');
    assert(!jsonl.includes('compaction'), 'compaction must NOT fire when window <= reserveTokens (negative-threshold guard)');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
