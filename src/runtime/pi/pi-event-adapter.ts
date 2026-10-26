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

/**
 * 把 pi 1.3.0 `Agent` 的原生 `AgentEvent`（`agent.d.ts` / `types.d.ts` 的 `AgentEvent` 联合类型）
 * 映射为 Baizer 的 `StreamEvent`。对照
 * `aidlc/spaces/default/intents/261021-pi-runtime-refactor/construction/functional-design/functional-spec.md`
 * §4 决策表逐行核实：
 *
 * | 决策表行 | 本函数的处理 |
 * |---|---|
 * | 文本增量 | `message_update` 里 `assistantMessageEvent.type === 'text_delta'` → `StreamEvent.text_delta`（延续现状） |
 * | 工具调用开始/结束 | `tool_execution_start`/`tool_execution_end` → `tool_call`/`tool_result`（延续现状） |
 * | 回合结束 | `turn_start` → `step_boundary`（延续现状）；`turn_end`/`agent_end` 不单独映射——
 * |          | 本轮的"完成"判定走 `harness-chat-runtime.ts` 里 `agent.prompt()` resolve 后的收尾逻辑
 * |          | （落盘、entryId 锚定、压缩），不依赖这两个事件本身携带的字段，映射后无额外可观察行为 |
 * | 错误/异常事件 | 1.3.0 不存在独立的错误事件类型；provider 错误经 `message_end` 且 `message.stopReason==='error'`
 * |              | 出现，由 `harness-chat-runtime.ts` 的 subscribe 回调单独拦截处理（见该文件），不经本函数 |
 * | 会话压缩事件 | 不适用：1.3.0 的 `AgentEvent` 联合类型里没有压缩相关事件（逐项核对 `types.d.ts`），
 * |             | 压缩完全由本项目的 `HarnessSessionManager.maybeCompact` 在轮次结束后自驱动，
 * |             | 其结果经 `harness-chat-runtime.ts` 产出新增的 `StreamEvent.compaction`（不经本函数） |
 * | usage/token 用量事件 | 不适用：1.3.0 没有独立的 usage/token 事件类型，usage 搭载在 `AgentMessage.usage`
 * |                     | 字段里随消息到达，不是本函数要处理的独立事件家族 |
 * | 审批/权限原生信号 | 不适用：1.3.0 把审批信号折进 `afterToolCall` 回调（`harness-chat-runtime.ts` 里
 * |                  | `afterToolCall` 检测 `approval_required` 并 `terminate`），不是独立的 `AgentEvent` 类型 |
 *
 * `message_start`/`message_end`/`agent_start`/`tool_execution_update` 四类 1.3.0 新增事件：
 * 经核对均不产出新的可观察 `StreamEvent`（`message_end` 的 provider 错误分支已被上游单独拦截，
 * 其余三类没有决策表要求的映射目标），函数对它们返回 `undefined`，与"不认识的事件类型"同处理。
 */
export function mapPiEventToStreamEvent(event: any): StreamEvent | undefined {
  // turn_start: 智能体一个工具循环回合开始。透传为 step_boundary,
  // 让 UI 把「过程叙述 + 工具调用」按回合分组展示(Step N)。
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

  // agent_start / turn_end / message_start / message_end / tool_execution_update / agent_end:
  // 决策表核对后均无映射目标(见上方文档注释),显式落到 undefined,与未知事件同处理。
  return undefined;
}

function getToolErrorMessage(result: any): string | undefined {
  if (typeof result?.details?.error === 'string') return result.details.error;
  if (typeof result?.content?.[0]?.text === 'string') return result.content[0].text;
  return undefined;
}
