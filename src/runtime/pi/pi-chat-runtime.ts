import { StreamEvent } from '../../models/interfaces';
import { DefaultChatRuntime } from '../chat-runtime';
import {
  ChatRuntime,
  ChatRuntimeDeps,
  ChatTurnRequest,
  PreparedChatTurn,
} from '../runtime-types';

export class PiChatRuntime implements ChatRuntime {
  private readonly legacy: DefaultChatRuntime;

  constructor(deps: ChatRuntimeDeps) {
    this.legacy = new DefaultChatRuntime(deps);
  }

  getTools() {
    return this.legacy.getTools();
  }

  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    return this.legacy.prepareTurn(request);
  }

  query(turn: PreparedChatTurn): Promise<string> {
    return this.legacy.query(turn);
  }

  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    return this.legacy.queryStream(turn, signal);
  }
}
