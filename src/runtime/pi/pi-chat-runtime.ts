import { StreamEvent } from '../../models/interfaces';
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
import { createBaizerStreamFn, createPiBridgeModel } from './pi-provider-bridge';
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
    // priorMessages 注入底层会话：pi 的 agentLoop context 只承载本轮工具循环，
    // 跨轮历史由底层 IChatSession 维护，getBaizerInput 每轮只取当前输入即可。
    const chat = this.deps.provider.startChat(turn.tools, turn.priorMessages, this.deps.thinkingLevel);
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
    const model = createPiBridgeModel(this.deps.contextWindow, this.deps.thinkingLevel);
    const streamFn = createBaizerStreamFn(chat);
    const { agentLoop } = await import('@earendil-works/pi-agent-core');
    // 推理深度：透传 settings.thinkingLevel → agentLoop config.reasoning。
    // "off" 关闭 thinking，省 token；"medium"(默认) 适合常规任务；"high"/"xhigh" 适合复杂任务。
    const reasoning = (this.deps.thinkingLevel ?? 'medium') as any;
    let fullResponseText = '';
    let approvalMessage = '';
    let approvalToolResultYielded = false;
    const context = {
      systemPrompt: '',
      messages: [],
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
      // bridge 的 getBaizerInput 只看最后一条，便会丢弃尚未回传的工具结果，
      // 导致模型的 tool_call 永远得不到应答（OpenAI 还会主动抹掉该 assistant 轮）。
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

function createAbortError(message = 'Stream aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
