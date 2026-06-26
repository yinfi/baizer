import type { ChatContextItem, IModelProvider, PriorChatMessage, StreamEvent, ToolDefinition } from '../models/interfaces';
import type { MemoryManager } from '../memory/memory-manager';
import type { UserProfile } from '../memory/types';
import type { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import type { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ToolRegistry } from '../skills/tool-registry';
import type { WorkspaceEditService } from '../services/workspace-edit-service';

export type RuntimeEngine = 'legacy' | 'pi';

export interface ChatRuntimeDeps {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
}

export interface ChatTurnRequest {
  userMessage: string;
  contextItems: ChatContextItem[];
  selection?: string;
  forcedSkillName?: string;
  source?: GenerationSource;
  obsidianContext?: ObsidianContextSnapshot;
  userProfile?: UserProfile | null;
  systemPromptOverride?: string;
  /** 上一轮起的干净对话原文，由 UI 层提供，用于跨轮上下文延续。 */
  priorMessages?: PriorChatMessage[];
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
  /** 透传给 provider.startChat 的历史，使新会话携带跨轮上下文。 */
  priorMessages?: PriorChatMessage[];
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}
