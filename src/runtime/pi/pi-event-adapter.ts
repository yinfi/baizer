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
  // turn_start: 智能体一个工具循环回合开始。透传为 step_boundary,
  // 让 UI 把「过程叙述 + 工具调用」按回合分组(Step N)。
  if (event.type === 'turn_start') {
    return { type: 'step_boundary' };
  }

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
