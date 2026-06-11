import type { StreamEvent } from '../../models/interfaces';

export function unwrapPiToolResult(result: any): any {
  if (result?.details && Object.prototype.hasOwnProperty.call(result.details, 'baizerResponse')) {
    return result.details.baizerResponse;
  }
  if (typeof result?.content?.[0]?.text === 'string') {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return { message: result.content[0].text };
    }
  }
  return result;
}

export function mapPiEventToStreamEvent(event: any): StreamEvent | undefined {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent?.type === 'text_delta') {
      return { type: 'text_delta', content: assistantEvent.delta || '' };
    }
    if (assistantEvent?.type === 'thinking_delta') {
      return { type: 'thinking', content: assistantEvent.delta || '' };
    }
    return undefined;
  }

  if (event.type === 'tool_execution_start') {
    return {
      type: 'tool_call',
      id: event.toolCallId,
      name: event.toolName,
      args: event.args || {},
    };
  }

  if (event.type === 'tool_execution_end') {
    const streamEvent: StreamEvent = {
      type: 'tool_result',
      name: event.toolName,
      result: unwrapPiToolResult(event.result),
    };
    if (event.isError) {
      streamEvent.error = getToolErrorMessage(event.result);
    }
    return streamEvent;
  }

  return undefined;
}

function getToolErrorMessage(result: any): string | undefined {
  if (typeof result?.details?.error === 'string') return result.details.error;
  if (typeof result?.content?.[0]?.text === 'string') return result.content[0].text;
  return undefined;
}
