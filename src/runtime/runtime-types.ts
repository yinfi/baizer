import { ChatContextItem, StreamEvent, ToolDefinition } from '../models/interfaces';

export interface ChatTurnRequest {
  userMessage: string;
  contextItems: ChatContextItem[];
  selection?: string;
  forcedSkillName?: string;
}

export interface PreparedChatTurn {
  prompt: string;
  tools: ToolDefinition[];
  activeSkillName?: string;
  allowedToolNames?: string[];
  requiresFileWrite?: boolean;
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}
