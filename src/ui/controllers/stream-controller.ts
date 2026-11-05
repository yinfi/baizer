import { ChatTurnOutcome, StreamEvent } from '../../models/interfaces';

interface StreamControllerDeps {
  onThinking: (content: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: unknown, error?: string) => void;
  onTextDelta: (content: string) => void;
  onStepBoundary?: () => void;
  // done 携带 runtime 定型后的最终文本:runtime 可能在结束前替换正文
  // (如 generation quality failure),此文本才是入库/重建所见,须用它定型 DOM,
  // 而非 UI 逐字累计的 streamAccumulatedText,否则屏幕与保存不一致。
  // outcome 是本轮唯一终态来源(completed / cancelled),failed 走 onError。
  onDone: (finalText?: string, outcome?: ChatTurnOutcome) => void;
  onError: (message: string) => void;
}

export class StreamController {
  constructor(private deps: StreamControllerDeps) { }

  handleEvent(event: StreamEvent) {
    switch (event.type) {
      case 'thinking':
        this.deps.onThinking(event.content);
        break;
      case 'tool_call':
        this.deps.onToolCall(event.name, event.args as Record<string, unknown>);
        break;
      case 'tool_result':
        this.deps.onToolResult(event.name, event.result, event.error);
        break;
      case 'text_delta':
        this.deps.onTextDelta(event.content);
        break;
      case 'step_boundary':
        this.deps.onStepBoundary?.();
        break;
      case 'done':
        // 旧事件/第三方发射器可能没带 outcome:按 interrupted 回退,仍不把取消当成功。
        this.deps.onDone(
          event.text,
          event.outcome ?? (event.interrupted ? 'cancelled' : 'completed'),
        );
        break;
      case 'error':
        this.deps.onError(event.message);
        break;
    }
  }
}
