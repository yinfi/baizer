import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { IChatSession, StreamEvent, ToolResult } from '../../models/interfaces';

/** 与 settings.contextWindow 默认值对齐（src/mcp/types.ts DEFAULT_SETTINGS）。 */
const DEFAULT_CONTEXT_WINDOW = 100000;

export function createPiBridgeModel(contextWindow?: number, thinkingLevel?: string): Model<any> {
  return {
    id: 'baizer-bridge',
    name: 'Baizer Bridge',
    api: 'baizer-bridge',
    provider: 'baizer',
    baseUrl: 'baizer://local',
    // thinkingLevel が 'off' 以外のときは reasoning: true にして
    // pi が thinking イベントを通すようにする。undefined (缺省) も有効化。
    reasoning: thinkingLevel !== 'off',
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    // 取実際配置的上下文窗口，而非誤導性的硬編碼常量；缺省回落到 settings 默認值。
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: 8192,
  };
}

export function createBaizerStreamFn(session: IChatSession): StreamFn {
  return (model: Model<any>, context: Context, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStreamCompat();
    void bridgeBaizerStream(session, model, context, stream, options?.signal);
    return stream;
  };
}

function createAssistantMessageEventStreamCompat(): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [];
  const waiting: ((result: IteratorResult<AssistantMessageEvent>) => void)[] = [];
  let done = false;
  let resolveFinalResult: (message: AssistantMessage) => void = () => undefined;
  const finalResultPromise = new Promise<AssistantMessage>((resolve) => {
    resolveFinalResult = resolve;
  });

  const stream = {
    push(event: AssistantMessageEvent) {
      if (done) return;
      if (event.type === 'done' || event.type === 'error') {
        done = true;
        resolveFinalResult(event.type === 'done' ? event.message : event.error);
      }
      const waiter = waiting.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end(result?: AssistantMessage) {
      done = true;
      if (result) resolveFinalResult(result);
      while (waiting.length > 0) {
        const waiter = waiting.shift();
        waiter?.({ value: undefined, done: true });
      }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as AssistantMessageEvent;
        } else if (done) {
          return;
        } else {
          const result = await new Promise<IteratorResult<AssistantMessageEvent>>(resolve => waiting.push(resolve));
          if (result.done) return;
          yield result.value;
        }
      }
    },
    result() {
      return finalResultPromise;
    },
  };

  return stream as AssistantMessageEventStream;
}

function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantMessage(model: Model<any>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function bridgeBaizerStream(
  session: IChatSession,
  model: Model<any>,
  context: Context,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
) {
  const partial = createAssistantMessage(model);
  let textContent = '';
  let textContentIndex: number | undefined;
  let thinkingContent = '';
  let thinkingContentIndex: number | undefined;
  let thinkingOpen = false;
  let hasToolCall = false;
  let finished = false;

  stream.push({ type: 'start', partial });

  try {
    if (signal?.aborted) {
      throw createAbortError();
    }

    for await (const event of session.sendMessageStream(getBaizerInput(context), signal)) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      if (event.type === 'text_delta') {
        finishThinkingIfNeeded();
        if (textContentIndex === undefined) {
          textContentIndex = partial.content.length;
          partial.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: textContentIndex, partial });
        }
        textContent += event.content || '';
        partial.content[textContentIndex] = { type: 'text', text: textContent };
        stream.push({
          type: 'text_delta',
          contentIndex: textContentIndex,
          delta: event.content || '',
          partial,
        });
        continue;
      }

      if (event.type === 'thinking') {
        if (!thinkingOpen) {
          thinkingContent = '';
          thinkingContentIndex = partial.content.length;
          partial.content.push({ type: 'thinking', thinking: '' });
          stream.push({ type: 'thinking_start', contentIndex: thinkingContentIndex, partial });
          thinkingOpen = true;
        }
        thinkingContent += event.content || '';
        partial.content[thinkingContentIndex!] = { type: 'thinking', thinking: thinkingContent };
        stream.push({
          type: 'thinking_delta',
          contentIndex: thinkingContentIndex!,
          delta: event.content || '',
          partial,
        });
        continue;
      }

      if (event.type === 'tool_call') {
        finishThinkingIfNeeded();
        hasToolCall = true;
        const contentIndex = partial.content.length;
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: event.id || `${event.name}_${contentIndex}`,
          name: event.name,
          arguments: event.args || {},
        };
        partial.content.push(toolCall);
        stream.push({ type: 'toolcall_start', contentIndex, partial });
        stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial });
        continue;
      }

      if (event.type === 'error') {
        finishWithError(stream, partial, event.message || 'Provider error', 'error');
        finished = true;
        break;
      }

      if (event.type === 'done') {
        finishThinkingIfNeeded();
        finishTextIfNeeded(stream, partial, textContentIndex, textContent);
        const final = {
          ...partial,
          stopReason: hasToolCall ? 'toolUse' as const : 'stop' as const,
        };
        stream.push({
          type: 'done',
          reason: hasToolCall ? 'toolUse' : 'stop',
          message: final,
        });
        stream.end(final);
        finished = true;
        break;
      }
    }

    if (!finished) {
      finishThinkingIfNeeded();
      finishTextIfNeeded(stream, partial, textContentIndex, textContent);
      const final = {
        ...partial,
        stopReason: hasToolCall ? 'toolUse' as const : 'stop' as const,
      };
      stream.push({
        type: 'done',
        reason: hasToolCall ? 'toolUse' : 'stop',
        message: final,
      });
      stream.end(final);
    }
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'aborted' : 'error';
    finishWithError(stream, partial, e?.message || 'Provider error', reason);
  }

  function finishThinkingIfNeeded(): void {
    if (!thinkingOpen || thinkingContentIndex === undefined) return;
    stream.push({
      type: 'thinking_end',
      contentIndex: thinkingContentIndex,
      content: thinkingContent,
      partial,
    });
    thinkingOpen = false;
  }
}

function finishTextIfNeeded(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  textContentIndex: number | undefined,
  textContent: string,
) {
  if (textContentIndex === undefined) return;
  stream.push({
    type: 'text_end',
    contentIndex: textContentIndex,
    content: textContent,
    partial,
  });
}

function finishWithError(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  message: string,
  reason: 'error' | 'aborted',
) {
  const final = {
    ...partial,
    stopReason: reason,
    errorMessage: message,
  };
  stream.push({ type: 'error', reason, error: final });
  stream.end(final);
}

export function getBaizerInput(context: Context): string | ToolResult[] {
  const messages = context.messages || [];
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'toolResult') {
    return getTrailingToolResults(messages).map(toolResultToBaizerInput);
  }

  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
  if (!lastUserMessage || lastUserMessage.role !== 'user') return '';
  return stringifyUserContent(lastUserMessage.content);
}

function getTrailingToolResults(messages: Context['messages']): ToolResultMessage[] {
  const toolResults: ToolResultMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'toolResult') break;
    toolResults.unshift(message);
  }
  return toolResults;
}

function toolResultToBaizerInput(message: ToolResultMessage): ToolResult {
  return {
    id: message.toolCallId,
    name: message.toolName,
    response: unwrapToolResultResponse(message),
  };
}

function unwrapToolResultResponse(message: ToolResultMessage): any {
  if (message.details && Object.prototype.hasOwnProperty.call(message.details, 'baizerResponse')) {
    return (message.details as any).baizerResponse;
  }

  const text = message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');

  if (!text) return message.content;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyUserContent(content: Context['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
  }
  return '';
}

function createAbortError(): Error {
  const error = new Error('Provider stream aborted');
  error.name = 'AbortError';
  return error;
}
