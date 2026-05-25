import { ChatContextItem, IModelProvider, StreamEvent, ToolDefinition } from '../models/interfaces';
import { MemoryManager } from '../memory/memory-manager';
import { UserProfile } from '../memory/types';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { WorkspaceEditService } from '../services/workspace-edit-service';

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
