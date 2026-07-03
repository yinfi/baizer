import type { Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ChatContextItem, PriorChatMessage, StreamEvent, ToolDefinition } from '../models/interfaces';
import type { MemoryManager } from '../memory/memory-manager';
import type { UserProfile } from '../memory/types';
import type { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import type { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ToolRegistry } from '../skills/tool-registry';
import type { WorkspaceEditService } from '../services/workspace-edit-service';
import type { SessionStore } from './pi/session-store';
import type { SteeringController } from './steering-controller';

/**
 * 一次 queryStream 运行所需的原生 LLM 直连句柄。
 *
 * Phase 2 起，pi 的 agentLoop 直接用 pi-ai 原生 streamFn 直连，
 * 不再经由旧的 IChatSession 桥接路径调用 LLM。
 * 本句柄把「该用哪个 Model」与「如何发起 stream」
 * 这两件事打包在一起：
 *   - model:    pi-ai 的 Model 配置对象（由 buildGeminiModel / buildOpenAICompatModel 构造）
 *   - streamFn: 注入了 apiKey 的 StreamFn（生产由 createNativeStreamFn 提供；测试注入 mock）
 *
 * 两者必须同源构造（同一 provider 类型、同一 apiKey），故合并为一个句柄一次性给出，
 * 避免 runtime 自己拼装 provider 细节。
 */
export interface NativeChatHandle {
  model: Model<any>;
  streamFn: StreamFn;
}

/**
 * 原生直连句柄工厂。每次 queryStream 启动时调用一次，返回当前 provider 对应的
 * model + streamFn。做成工厂（而非直接传 model/streamFn）是为了：
 * (a) 凭证/模型可能在运行期被 settings 改动，每轮取最新值；
 * (b) 测试可注入一个产出 mock streamFn 的工厂，作为「假 LLM 响应」的唯一注入点。
 */
export type NativeChatFactory = () => NativeChatHandle;

export interface ChatRuntimeDeps {
  /**
   * 原生 LLM 直连句柄工厂（Phase 2 接入点）。
   * 生产由 model-service 依据当前 ProviderConfig 构造（gemini→buildGeminiModel，
   * openai-compatible→buildOpenAICompatModel，streamFn=createNativeStreamFn(apiKey)）。
   * 测试注入 mock streamFn 以驱动工具循环。
   * 缺省时 PiChatRuntime.queryStream 会抛出明确错误（生产必须提供）。
   */
  nativeChatFactory?: NativeChatFactory;
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
  /** 跨轮注入的历史消息，使新会话携带跨轮上下文。 */
  priorMessages?: PriorChatMessage[];
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}
