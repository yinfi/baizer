import { StreamEvent } from '../../models/interfaces';
import { DefaultChatRuntime } from '../chat-runtime';
import {
  ChatRuntime,
  ChatRuntimeDeps,
  ChatTurnRequest,
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

export class PiChatRuntime extends DefaultChatRuntime implements ChatRuntime {
  private readonly legacy: DefaultChatRuntime;

  constructor(private readonly deps: ChatRuntimeDeps) {
    super(deps);
    this.legacy = new DefaultChatRuntime(deps);
  }

  getTools() {
    return this.legacy.getTools();
  }

  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    return this.legacy.prepareTurn(request);
  }

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
    const chat = this.deps.provider.startChat(turn.tools);
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
    const model = createPiBridgeModel();
    const streamFn = createBaizerStreamFn(chat);
    const { agentLoop } = await import('@earendil-works/pi-agent-core');
    let fullResponseText = '';
    let approvalMessage = '';
    let approvalToolResultYielded = false;
    const context = {
      systemPrompt: '',
      messages: [],
      tools,
    };
    const config = {
      model,
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
