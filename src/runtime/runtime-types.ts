import { ChatContextItem, StreamEvent, ToolDefinition } from '../models/interfaces';
import { UserProfile } from '../memory/types';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';

export interface ChatTurnRequest {
  userMessage: string;
  contextItems: ChatContextItem[];
  selection?: string;
  forcedSkillName?: string;
  source?: GenerationSource;
  obsidianContext?: ObsidianContextSnapshot;
  userProfile?: UserProfile | null;
  systemPromptOverride?: string;
}

export interface PreparedChatTurn {
  prompt: string;
  tools: ToolDefinition[];
  userRequest?: string;
  memoryContext?: string;
  activeSkillName?: string;
  allowedToolNames?: string[];
  requiresFileWrite?: boolean;
  selection?: string;
  generationPlan?: GenerationPlan;
  writingProfile?: WritingProfile;
  systemPromptOverride?: string;
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}
