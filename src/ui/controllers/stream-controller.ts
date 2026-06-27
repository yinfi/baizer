import { StreamEvent } from '../../models/interfaces';

interface StreamControllerDeps {
  onThinking: (content: string) => void;
  onToolCall: (name: string, args: any) => void;
  onToolResult: (name: string, result: any, error?: string) => void;
  onTextDelta: (content: string) => void;
  onStepBoundary?: () => void;
  onDone: () => void;
  onError: (message: string) => void;
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
        this.deps.onDone();
        break;
      case 'error':
        this.deps.onError(event.message);
        break;
    }

    this.deps.onScrollRequest?.();
  }
}
