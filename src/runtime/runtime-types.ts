import type { ChatContextItem, IModelProvider, PriorChatMessage, StreamEvent, ToolDefinition } from '../models/interfaces';
import type { MemoryManager } from '../memory/memory-manager';
import type { UserProfile } from '../memory/types';
import type { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import type { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ToolRegistry } from '../skills/tool-registry';
import type { WorkspaceEditService } from '../services/workspace-edit-service';
import type { SessionStore } from './pi/session-store';
import type { SteeringController } from './steering-controller';

export interface ChatRuntimeDeps {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
  /**
   * 可选的 Session 持久化层。提供时，跨轮上下文（priorMessages）由 Session 维护，
   * 轮次结束后在 retainCompletedTurn 钩子里把 user/assistant 落盘到 JSONL。
   * 不提供时退化为旧行为（priorMessages 由 UI 回灌、仅内存）。
   */
  sessionStore?: SessionStore | null;
  /**
   * 当前模型的上下文窗口（token）。透传给 pi 的 bridge model，
   * 使 pi agentLoop 内部的预算判定基于真实窗口而非硬编码常量。
   */
  contextWindow?: number;
  /**
   * 推理深度控制，透传给 pi agentLoop config 的 reasoning 字段。
   * 对应 pi-ai ThinkingLevel："off" | "minimal" | "low" | "medium" | "high" | "xhigh"。
   * 缺省时为 "medium"。
   */
  thinkingLevel?: string;
  /**
   * 可选的运行中 steering 控制器。提供时，长任务运行中可通过它追加补话
   * （下一轮纳入）或运行时调整可用工具集。不提供时退化为「无运行中 steering」。
   */
  steeringController?: SteeringController | null;
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
