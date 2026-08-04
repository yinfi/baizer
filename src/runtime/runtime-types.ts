import type { Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ChatContextItem, StreamEvent, ToolDefinition } from '../models/interfaces';
import type { MemoryManager } from '../memory/memory-manager';
import type { UserProfile } from '../memory/types';
import type { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import type { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ToolRegistry } from '../skills/tool-registry';
import type { WorkspaceEditService } from '../services/workspace-edit-service';
import type { HarnessSessionManager } from './pi/harness-session-manager';
import type { ActiveRunController } from './active-run-controller';

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
  /**
   * @deprecated AgentHarness 内部按 model.api 路由到 pi api-registry,不再消费注入的 streamFn。
   * 保留字段以兼容旧装配与测试;HarnessChatRuntime 忽略它。
   */
  streamFn?: StreamFn;
  /**
   * 取当前 provider 的 apiKey。AgentHarness 通过 getApiKeyAndHeaders 回调按需取值,
   * 使运行期切换凭证下一轮即生效。生产由 model-service 提供。
   */
  getApiKey?: () => string | Promise<string>;
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
  /**
   * pi AgentHarness 所需的完整 ExecutionEnv(FileSystem + Shell)。
   * 生产由 model-service 用 createHarnessExecutionEnv(vault adapter) 构造;
   * 无 vault(如纯单测)时可省略,此时 HarnessChatRuntime 会快速失败。
   */
  harnessEnv?: unknown;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
  /**
   * Harness 会话生命周期管理器。提供时,每轮构造的 AgentHarness 复用它持有的
   * 长生命持久化 session:跨轮上下文由 Harness 从 session 派生(不再 UI 回灌 priorMessages),
   * 轮次结束后由它按真实 usage 判断并触发 harness.compact()。
   * 不提供时(如纯单测)退化为每轮全新内存会话、无持久化、无压缩。
   */
  sessionManager?: HarnessSessionManager | null;
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
   * 可选的运行中 run 控制器。提供时,runtime 在 queryStream 启动时把活跃 harness 登记进去,
   * 使 UI/ModelService 能对当前流调用 Harness 原生 steer()/setActiveTools()。
   * 不提供时退化为「无运行中 steering」。
   */
  activeRunController?: ActiveRunController | null;
  /**
   * 可选:返回用户自定义命令快照(同步),供 slash 契约把用户命令一并列给模型,
   * 避免模型误以为这些命令不存在。由 ModelService 提供(读 PromptTemplateService 缓存)。
   */
  getUserCommandEntries?: () => Array<{ command: string; description: string }>;
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
  /**
   * 本轮开始时会话是否已有跨轮历史。用于短确认/延续判定:
   * 只有存在历史时,"需要"这类短确认才被当作延续上一轮而剔除环境上下文;
   * 无历史时保留(可能是针对当前笔记的首轮请求)。
   * 阶段1 起由 ModelService 从 Harness session 查询后注入(取代旧的 priorMessages.length 判断)。
   */
  hasPriorContext?: boolean;
  /**
   * 会话标识(= UI tab.id)。用于 per-conversation session 隔离(阶段A):
   * runtime 用它向 sessionManager 取该会话专属的长生命 session,不同会话跨轮上下文互不可见。
   * 缺省(undefined)时退化为每轮内存临时会话:无持久、无跨轮记忆(后台/一次性调用,如 file-back、/edit)。
   */
  conversationId?: string;
}

export interface PreparedChatTurn {
  /**
   * 本轮发给模型的干净用户请求(= userRequest 原文)。
   * 阶段1 起:它作为 harness.prompt() 的入参被持久化进 session,
   * 故不再夹带装饰(装饰移到 systemPrompt)。跨轮历史因此保持干净。
   */
  prompt: string;
  /**
   * 每轮发送但不持久化的系统提示(装饰):memory 召回、当前时间、上下文、
   * skill 清单、slash 契约、生成计划、文件写入契约等。作为 Harness 的 systemPrompt。
   */
  systemPrompt?: string;
  tools: ToolDefinition[];
  userRequest?: string;
  memoryContext?: string;
  activeSkillName?: string;
  /** 激活来源：forced = 斜杠/强制激活（收窄工具集）；intent = 意图路由（全量工具）。 */
  activeSkillSource?: 'forced' | 'intent';
  allowedToolNames?: string[];
  requiresFileWrite?: boolean;
  selection?: string;
  generationPlan?: GenerationPlan;
  writingProfile?: WritingProfile;
  systemPromptOverride?: string;
  /** 透传自 ChatTurnRequest,供 runtime 取该会话专属的持久 session(见 ChatTurnRequest.conversationId)。 */
  conversationId?: string;
}

export interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}
