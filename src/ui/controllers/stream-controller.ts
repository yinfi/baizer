import { StreamEvent } from '../../models/interfaces';

interface StreamControllerDeps {
  onThinking: (content: string) => void;
  onToolCall: (name: string, args: any) => void;
  onToolResult: (name: string, result: any, error?: string) => void;
  onTextDelta: (content: string) => void;
  onStepBoundary?: () => void;
  // done 携带 runtime 定型后的最终文本:runtime 可能在结束前替换正文
  // (如 generation quality failure),此文本才是入库/重建所见,须用它定型 DOM,
  // 而非 UI 逐字累计的 streamAccumulatedText,否则屏幕与保存不一致。
  // interrupted:本轮是手动停止收尾的(取消终态),而非正常生成完成——
  // 宿主须据此渲染「已停止,答案不完整」而非当作成功折叠。
  onDone: (finalText?: string, interrupted?: boolean) => void;
  // text:失败前已上屏的部分正文(若有),供宿主在失败态容器里保留现场。
  onError: (message: string, text?: string) => void;
  onScrollRequest?: () => void;
}

export class StreamController {
  constructor(private deps: StreamControllerDeps) { }

  handleEvent(event: StreamEvent) {
    switch (event.type) {
      case 'thinking':
        this.deps.onThinking(event.content);
        break;
      case 'tool_call':
        this.deps.onToolCall(event.name, event.args);
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
        this.deps.onDone(event.text, event.interrupted);
        break;
      case 'error':
        this.deps.onError(event.message, event.text);
        break;
    }

    this.deps.onScrollRequest?.();
  }
}
