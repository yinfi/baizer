import { StreamEvent } from '../../models/interfaces';
import { BaseChatRuntime } from '../base-chat-runtime';
import { ChatRuntime, PreparedChatTurn } from '../runtime-types';
import {
  createPiFileWriteState,
  formatPiApprovalMessage,
  isPiApprovalResponse,
  recordPiFileWriteResult,
  resolvePiFinalText,
} from './pi-approval-policy';
import { mapPiEventToStreamEvent, unwrapPiToolResult } from './pi-event-adapter';
import { adaptToolDefinitionsToPi } from './pi-tool-adapter';

/**
 * 基于 pi AgentHarness 的聊天运行时(阶段0)。
 *
 * 取代 PiChatRuntime 对底层 agentLoop 的直调:
 * - 引擎:AgentHarness 驱动整个工具循环、会话、事件。
 * - Session:阶段0 用 InMemorySessionRepo(无持久化,等价旧的「不注入 sessionStore」)。
 *   阶段1 再换 JsonlSessionRepo。
 * - LLM 注入:Harness 内部按 model.api 路由到 pi api-registry,不接受注入 streamFn。
 *   生产由 nativeChatFactory 提供已注册 provider 的 model + getApiKeyAndHeaders 回调;
 *   测试通过 registerApiProvider 注册 mock provider。
 * - 审批:afterToolCall hook 检测 approval_required → terminate,中止本轮。
 *
 * 对外仍产出既有的 StreamEvent 契约(text_delta/tool_call/tool_result/step_boundary/done/error),
 * 保持 UI 消费层零改动(UI 消费层重写是后续可分离步骤)。
 */
export class HarnessChatRuntime extends BaseChatRuntime implements ChatRuntime {
  async query(turn: PreparedChatTurn): Promise<string> {
    let finalText = '';
    let approvalText = '';
    for await (const event of this.queryStream(turn)) {
      if (event.type === 'error') {
        throw new Error(event.message);
      }
      if (event.type === 'tool_result' && isPiApprovalResponse(event.result)) {
        approvalText = formatPiApprovalMessage(event.result);
      }
      if (event.type === 'done') {
        finalText = event.text;
      }
    }
    return finalText || approvalText;
  }

  async *queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    if (!this.deps.nativeChatFactory) {
      throw new Error('HarnessChatRuntime requires deps.nativeChatFactory to build a model handle');
    }
    const { model, getApiKey } = resolveModelHandle(this.deps.nativeChatFactory());

    const skillScope = this.createSkillScope(turn);
    const fileWriteState = createPiFileWriteState(turn.requiresFileWrite === true);
    const tools = adaptToolDefinitionsToPi({
      definitions: turn.tools,
      toolRegistry: this.deps.toolRegistry,
      skillRegistry: this.deps.skillRegistry,
      workspaceEditService: this.deps.workspaceEditService,
      skillScope,
    });

    const pi = await import('@earendil-works/pi-agent-core');
    const env = this.deps.harnessEnv;
    if (!env) {
      throw new Error('HarnessChatRuntime requires deps.harnessEnv (ExecutionEnv) to construct the AgentHarness');
    }

    // 阶段0:内存会话,无持久化。阶段1 换 JsonlSessionRepo。
    const repo = new (pi as any).InMemorySessionRepo();
    const session = await repo.create({});

    // 跨轮上下文:阶段0 沿用 UI 回灌的 priorMessages,预置进内存会话。
    // 阶段1 起改由持久化会话派生。
    await seedPriorMessages(session, turn, model);

    const reasoning = (this.deps.thinkingLevel ?? 'medium');

    let approvalMessage = '';
    let fullResponseText = '';

    const harness = new (pi as any).AgentHarness({
      env,
      session,
      model,
      tools,
      systemPrompt: '',
      thinkingLevel: reasoning,
      getApiKeyAndHeaders: async () => ({ apiKey: await getApiKey() }),
      // 审批:工具返回 approval_required 时,记录并请求本轮结束。
      afterToolCall: async ({ result }: any) => {
        const raw = unwrapPiToolResult(result);
        if (isPiApprovalResponse(raw)) {
          approvalMessage = formatPiApprovalMessage(raw);
          return { terminate: true };
        }
        return undefined;
      },
    });

    // 事件桥接:Harness 原生事件 → StreamEvent,推入异步队列供本 generator 产出。
    const queue = createEventQueue<StreamEvent>();
    let approvalToolResultYielded = false;
    // provider 错误/中断在此累计;prompt() 不会 reject provider 错误(见探针结论)。
    let runError: { message: string; aborted: boolean } | null = null;

    const unsubscribe = harness.subscribe((event: any) => {
      // Provider 错误不会让 harness.prompt() reject,而是以 message_end(stopReason:'error') 出现。
      // 中断(aborted)由 runError 分支处理,这里只转 error。
      if (event?.type === 'message_end' && event.message?.stopReason === 'error') {
        if (!approvalMessage) {
          runError = { message: event.message?.errorMessage || 'Provider error', aborted: false };
        }
        return;
      }

      const mapped = mapHarnessEvent(event);
      if (!mapped) return;

      if (mapped.type === 'tool_result') {
        const raw = unwrapPiToolResult((event as any).result);
        recordPiFileWriteResult(fileWriteState, mapped.name, raw);
        if (isPiApprovalResponse(raw)) {
          approvalMessage = formatPiApprovalMessage(raw);
          fullResponseText = '';
          approvalToolResultYielded = true;
          queue.push({ ...mapped, result: raw });
          return;
        }
        if (!approvalMessage) queue.push({ ...mapped, result: raw });
        return;
      }

      if (mapped.type === 'tool_call') {
        // 工具调用出现 = 此前正文是过程叙述,不进最终答案。重置累计。
        fullResponseText = '';
        if (!approvalMessage) queue.push(mapped);
        return;
      }

      if (mapped.type === 'text_delta') {
        if (!approvalMessage) {
          fullResponseText += mapped.content;
          queue.push(mapped);
        }
        return;
      }

      if (!approvalMessage) queue.push(mapped);
    });

    // 外部中断:透传到 Harness.abort()。
    const onAbort = () => { void harness.abort(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    // 后台驱动一轮 prompt;完成/失败后标记队列结束。
    // 注:provider 错误不会 reject(见 subscribe 里 message_end 处理);此处 catch 仅兜底真正的抛错/中断。
    const runPromise = (async () => {
      try {
        await harness.prompt(turn.prompt);
      } catch (error: any) {
        const aborted = error?.name === 'AbortError' || signal?.aborted === true;
        if (!runError) runError = { message: error?.message || 'Harness run failed', aborted };
      } finally {
        queue.close();
      }
    })();

    try {
      // 消费桥接队列,逐个产出 StreamEvent(近似实时流)。
      for await (const event of queue.drain()) {
        yield event;
      }
      await runPromise;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }

    if (runError) {
      if (runError.aborted) {
        yield { type: 'done', text: fullResponseText, interrupted: true };
        return;
      }
      if (!approvalMessage) {
        yield { type: 'error', message: runError.message };
        return;
      }
    }

    if (approvalMessage) {
      await this.retainCompletedTurn(turn, approvalMessage);
      if (!approvalToolResultYielded) fullResponseText = '';
      yield { type: 'done', text: '' };
      return;
    }

    fullResponseText = resolvePiFinalText(fileWriteState, fullResponseText);
    fullResponseText = this.applyGenerationQuality(turn, fullResponseText);
    await this.retainCompletedTurn(turn, fullResponseText);
    yield { type: 'done', text: fullResponseText };
  }
}

/**
 * 从 NativeChatHandle 解析出 model 与 apiKey 取值器。
 * 兼容两种句柄形态:
 *  - 旧形态 { model, streamFn } —— streamFn 已被 Harness 弃用,仅从其闭包无法取 key;
 *    但生产工厂同时可提供 apiKey/getApiKey,优先使用。
 *  - 新形态 { model, getApiKey } 或 { model, apiKey }。
 */
function resolveModelHandle(handle: any): { model: any; getApiKey: () => Promise<string> } {
  const model = handle.model;
  if (typeof handle.getApiKey === 'function') {
    return { model, getApiKey: async () => (await handle.getApiKey()) ?? '' };
  }
  if (typeof handle.apiKey === 'string') {
    const key = handle.apiKey;
    return { model, getApiKey: async () => key };
  }
  // 无显式 key(如测试用 mock provider,不校验 key):返回占位空串。
  return { model, getApiKey: async () => '' };
}

/** 把 UI 回灌的 priorMessages 预置进(内存)会话,作为跨轮历史前缀。 */
async function seedPriorMessages(session: any, turn: PreparedChatTurn, model: any): Promise<void> {
  const prior = turn.priorMessages;
  if (!prior?.length) return;
  const now = Date.now();
  for (const message of prior) {
    if (message.role === 'model') {
      await session.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: now,
      });
    } else {
      await session.appendMessage({ role: 'user', content: message.content, timestamp: now });
    }
  }
}

/**
 * 把 Harness 原生 AgentEvent 映射为 StreamEvent。
 * 复用既有 pi-event-adapter(它按 turn_start/message_update/tool_execution_* 分派),
 * Harness 事件形状与底层 agentLoop 事件一致,故可直接复用。
 */
function mapHarnessEvent(event: any): StreamEvent | undefined {
  return mapPiEventToStreamEvent(event);
}

/** 极简异步事件队列:生产者 push/close,消费者 drain() 异步迭代直到 close。 */
function createEventQueue<T>() {
  const buffer: T[] = [];
  let closed = false;
  let waiter: (() => void) | null = null;

  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };

  return {
    push(item: T) {
      if (closed) return;
      buffer.push(item);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *drain(): AsyncGenerator<T, void, unknown> {
      while (true) {
        while (buffer.length > 0) {
          yield buffer.shift() as T;
        }
        if (closed) return;
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    },
  };
}
