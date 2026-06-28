import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { StreamEvent } from '../../models/interfaces';
import type { PriorChatMessage } from '../../models/interfaces';
import { BaseChatRuntime } from '../base-chat-runtime';
import {
  ChatRuntime,
  PreparedChatTurn,
} from '../runtime-types';
import {
  createPiFileWriteState,
  formatPiApprovalMessage,
  isPiApprovalResponse,
  recordPiFileWriteResult,
  resolvePiFinalText,
} from './pi-approval-policy';
import { mapPiEventToStreamEvent, unwrapPiToolResult } from './pi-event-adapter';
import { adaptToolDefinitionsToPi } from './pi-tool-adapter';
import { filterPiToolsByActiveTools } from '../steering-controller';

export class PiChatRuntime extends BaseChatRuntime implements ChatRuntime {
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
    // Phase 2：pi 的 agentLoop 改用原生 streamFn 直连 LLM。
    // 取本轮的 model + streamFn（生产由 model-service 依 ProviderConfig 构造，测试注入 mock）。
    // 缺省即编程错误：生产装配必须提供 nativeChatFactory，故快速失败而非静默降级。
    if (!this.deps.nativeChatFactory) {
      throw new Error('PiChatRuntime requires deps.nativeChatFactory to stream natively');
    }
    const { model, streamFn } = this.deps.nativeChatFactory();
    const controller = new AbortController();
    const forwardExternalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      forwardExternalAbort();
    } else {
      signal?.addEventListener('abort', forwardExternalAbort, { once: true });
    }
    const skillScope = this.createSkillScope(turn);
    const fileWriteState = createPiFileWriteState(turn.requiresFileWrite === true);
    const tools = adaptToolDefinitionsToPi({
      definitions: turn.tools,
      toolRegistry: this.deps.toolRegistry,
      skillRegistry: this.deps.skillRegistry,
      workspaceEditService: this.deps.workspaceEditService,
      skillScope,
    });
    // 运行中 steering：每次新运行清空遗留的补话/工具变更，避免跨次泄漏。
    const steeringController = this.deps.steeringController ?? null;
    steeringController?.reset();
    const { agentLoop } = await import('@earendil-works/pi-agent-core');
    // 推理深度：透传 settings.thinkingLevel → agentLoop config.reasoning。
    // "off" 关闭 thinking，省 token；"medium"(默认) 适合常规任务；"high"/"xhigh" 适合复杂任务。
    const reasoning = (this.deps.thinkingLevel ?? 'medium') as any;
    let fullResponseText = '';
    let approvalMessage = '';
    let approvalToolResultYielded = false;
    // 跨轮上下文：priorMessages 作为 context.messages 的历史前缀（user/assistant 交替）。
    // 历史不再由底层会话维护，必须显式放进 context。
    // systemPrompt 保持空字符串：系统提示仍靠 turn.prompt 内拼接（与桥接期行为一致，避免漂移）。
    const context = {
      systemPrompt: '',
      messages: buildPriorContextMessages(turn.priorMessages, model),
      tools,
    };
    // 暂缓 steering 一轮的闸门：本轮产生了工具结果时置位，
    // 让工具结果先作为最后一条消息回传给 provider，下一轮再放行补话。
    // 详见下方 getSteeringMessages / prepareNextTurn 注释。
    let holdSteeringForPendingToolResults = false;
    const config = {
      model,
      reasoning,
      convertToLlm: (messages: any[]) => messages.filter(message =>
        message?.role === 'user'
        || message?.role === 'assistant'
        || message?.role === 'toolResult',
      ),
      toolExecution: 'parallel' as const,
      afterToolCall: async ({ result }: any) => {
        const rawResult = unwrapPiToolResult(result);
        if (isPiApprovalResponse(rawResult)) {
          approvalMessage = formatPiApprovalMessage(rawResult);
          controller.abort();
          return { terminate: true };
        }
        return undefined;
      },
      shouldStopAfterTurn: () => approvalMessage !== '',
      // 运行中补话：pi 在每轮 turn 结束后轮询此钩子，把队列里的用户指令
      // 注入会话作为下一轮输入。无补话时返回 []（满足 pi「不得抛错」契约）。
      //
      // 关键：当本轮刚产生工具结果时暂缓一轮放行（holdSteeringForPendingToolResults）。
      // 否则 pi 会把补话 user 消息压在工具结果之后，使其成为 context 的最后一条；
      // agentLoopContinue 契约要求 context 最后一条必须能转成 user 或 toolResult。
      // 工具结果与补话 user 消息同处一批时，会扰乱「工具调用→工具结果」的应答配对，
      // 导致模型的 tool_call 得不到应答（OpenAI 兼容端还会主动抹掉该 assistant 轮）。
      // 暂缓一轮让工具结果先回传，下一轮再放行补话，两者都不丢。
      getSteeringMessages: async () => {
        if (!steeringController) return [];
        if (holdSteeringForPendingToolResults) {
          holdSteeringForPendingToolResults = false;
          return [];
        }
        return steeringController.drainSteeringMessages();
      },
      // 运行时动态工具集：pi 在每轮 turn 结束后调用此钩子（早于 getSteeringMessages）。
      // 这里兼做暂缓闸门的置位点：本轮有工具结果时置位，使紧随其后的 getSteeringMessages
      // 暂缓一轮，保证工具结果先回传 provider。
      // 收到工具集变更时，按变更过滤 pi 工具数组并替换 context.tools，下一轮起生效。
      prepareNextTurn: ({ context: turnContext, toolResults }: any) => {
        holdSteeringForPendingToolResults = Array.isArray(toolResults) && toolResults.length > 0;
        if (!steeringController) return undefined;
        const activeTools = steeringController.consumeActiveToolsUpdate();
        if (!activeTools) return undefined;
        return {
          context: {
            ...turnContext,
            tools: filterPiToolsByActiveTools(tools, activeTools),
          },
        };
      },
    };
    const prompts = [{
      role: 'user' as const,
      content: turn.prompt,
      timestamp: Date.now(),
    }];

    try {
      const piStream = agentLoop(prompts, context, config, controller.signal, streamFn);
      for await (const piEvent of piStream) {
        if (isTerminalAssistantError(piEvent)) {
          if (approvalMessage) continue;
          const stopReason = (piEvent as any).message?.stopReason;
          const message = (piEvent as any).message?.errorMessage || 'Provider error';
          if (stopReason === 'aborted') {
            throw createAbortError(message);
          }
          yield { type: 'error' as const, message };
          return;
        }

        const streamEvent = mapPiEventToStreamEvent(piEvent);
        if (!streamEvent) continue;

        if (streamEvent.type === 'text_delta') {
          if (!approvalMessage) {
            fullResponseText += streamEvent.content;
            yield streamEvent;
          }
          continue;
        }

        if (streamEvent.type === 'tool_result') {
          const rawResult = unwrapPiToolResult((piEvent as any).result);
          recordPiFileWriteResult(fileWriteState, streamEvent.name, rawResult);
          if (isPiApprovalResponse(rawResult)) {
            approvalMessage = formatPiApprovalMessage(rawResult);
            fullResponseText = '';
            approvalToolResultYielded = true;
            yield {
              ...streamEvent,
              result: rawResult,
            };
            continue;
          }

          if (!approvalMessage) {
            yield {
              ...streamEvent,
              result: rawResult,
            };
          }
          continue;
        }

        if (streamEvent.type === 'tool_call') {
          // 工具调用出现 = 此前这一轮的正文是「该步的过程叙述」,不属于最终答案。
          // 重置累计,使 done.text 只保留最后一轮(其后不再有工具调用)的回复,
          // 既让叙述沉淀进 UI 时间线,又避免叙述污染最终答案与历史。
          fullResponseText = '';
          if (!approvalMessage) {
            yield streamEvent;
          }
          continue;
        }

        if (!approvalMessage) {
          yield streamEvent;
        }
      }
    } finally {
      signal?.removeEventListener('abort', forwardExternalAbort);
    }

    if (approvalMessage) {
      await this.retainCompletedTurn(turn, approvalMessage);
      if (!approvalToolResultYielded) {
        // A defensive fallback for unusual Pi event streams where afterToolCall
        // sees the approval but no tool_execution_end event is emitted.
        fullResponseText = '';
      }
      yield { type: 'done' as const, text: '' };
      return;
    }

    fullResponseText = resolvePiFinalText(fileWriteState, fullResponseText);
    fullResponseText = this.applyGenerationQuality(turn, fullResponseText);

    await this.retainCompletedTurn(turn, fullResponseText);

    yield { type: 'done' as const, text: fullResponseText };
  }
}

function isTerminalAssistantError(event: any): boolean {
  if (event?.type !== 'message_end') return false;
  const stopReason = event.message?.stopReason;
  return stopReason === 'error' || stopReason === 'aborted';
}

/**
 * 把跨轮历史（priorMessages）转成 pi 原生 context.messages 的历史前缀。
 *
 * priorMessages 已是「干净对话原文」（user 提问 + AI 回答，
 * 无 system 装饰/工具细节），逐条转成 pi 的 UserMessage / AssistantMessage：
 *   - role 'user'  → UserMessage（content 用纯文本即可被 convertToLlm 透传）
 *   - role 'model' → AssistantMessage（需补齐 api/provider/model/usage/stopReason 等必填字段，
 *                    取值对齐当前 model，使各 provider 的 convertMessages 能正确序列化历史）
 *
 * 本轮的新 prompt 不在此处加入——它由 agentLoop(prompts, ...) 的 prompts 参数注入，
 * 会追加在这些历史消息之后，成为 context 的最后一条 user 消息。
 */
function buildPriorContextMessages(
  priorMessages: PriorChatMessage[] | undefined,
  model: { api: any; provider: any; id: string },
): Message[] {
  if (!priorMessages?.length) return [];
  const now = Date.now();
  return priorMessages.map((message): Message => {
    if (message.role === 'model') {
      return buildAssistantHistoryMessage(message.content, model, now);
    }
    return {
      role: 'user',
      content: message.content,
      timestamp: now,
    };
  });
}

/** 构造一条历史 AssistantMessage：补齐 pi 必填字段，content 为单个 text 块。 */
function buildAssistantHistoryMessage(
  text: string,
  model: { api: any; provider: any; id: string },
  timestamp: number,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

function createAbortError(message = 'Stream aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
