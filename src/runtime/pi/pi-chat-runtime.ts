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
    for await (const event of this.queryStream(turn)) {
      if (event.type === 'done') {
        finalText = event.text;
      }
    }
    return finalText;
  }

  async *queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const chat = this.deps.provider.startChat(turn.tools);
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
    };
    const prompts = [{
      role: 'user' as const,
      content: turn.prompt,
      timestamp: Date.now(),
    }];
    let fullResponseText = '';
    let approvalMessage = '';

    const piStream = agentLoop(prompts, context, config, signal, streamFn);
    for await (const piEvent of piStream) {
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
        yield {
          ...streamEvent,
          result: rawResult,
        };

        if (isPiApprovalResponse(rawResult)) {
          approvalMessage = formatPiApprovalMessage(rawResult);
          fullResponseText = '';
          break;
        }
        continue;
      }

      yield streamEvent;
    }

    if (!approvalMessage) {
      fullResponseText = resolvePiFinalText(fileWriteState, fullResponseText);
      fullResponseText = this.applyGenerationQuality(turn, fullResponseText);
    }

    await this.retainCompletedTurn(turn, approvalMessage || fullResponseText);

    yield { type: 'done' as const, text: approvalMessage ? '' : fullResponseText };
  }
}
