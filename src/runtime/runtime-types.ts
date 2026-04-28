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
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn): AsyncGenerator<StreamEvent, void, unknown>;
}
