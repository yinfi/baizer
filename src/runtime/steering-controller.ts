/**
 * 运行中 steering 与动态工具集控制器。
 *
 * 背景（第一性原理）：长任务在 pi 的 agentLoop 工具循环里跑时，用户可能想
 * 「补一句话调整方向」或「运行时收窄/调整可用工具」，但不想打断、重启当前流。
 *
 * pi 的 agentLoop 在每轮 turn 结束后会轮询两个钩子：
 *   - getSteeringMessages(): 把返回的消息注入会话，作为下一轮的输入；
 *   - prepareNextTurn(): 返回替换的 context（含 context.tools），影响下一轮可执行工具集。
 * 本控制器把「外部补话 / 改工具」与这两个钩子解耦：UI 或 model-service 往队列里塞，
 * 正在运行的 queryStream 在下一轮轮询时取出并纳入。不阻断、不重启当前流。
 *
 * 注意：pi 的 harness Agent.steer()/setActiveTools() 是面向「harness 持有会话」的封装，
 * 与我们「低层 agentLoop + 自建 provider bridge 会话」的架构不兼容（详见文件末尾说明）。
 * 这里用 agentLoop 的 config 钩子做等效实现。
 */

/** pi 期望的最小 user AgentMessage 形状（content 用纯文本即可被 convertToLlm 透传）。 */
export interface SteeringUserMessage {
  role: 'user';
  content: string;
  timestamp: number;
}

/** 工具集过滤的最小约束：只需要 name 字段。 */
interface NamedTool {
  name: string;
}

export class SteeringController {
  /** 待注入的补话队列（FIFO）。每条是用户在运行中追加的纯文本指令。 */
  private steeringQueue: string[] = [];
  /** 待应用的运行时工具集（null 表示「无变更」，空集合表示「显式收窄到仅基础工具」）。 */
  private pendingActiveTools: Set<string> | null = null;
  /** pendingActiveTools 是否有未被 prepareNextTurn 消费的变更。 */
  private activeToolsDirty = false;

  /**
   * 运行中补话：把一条用户补充指令排队。不打断当前流，
   * 由正在运行的 agentLoop 在下一轮 getSteeringMessages 轮询时纳入。
   * 空白文本忽略。
   */
  steer(text: string): void {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return;
    this.steeringQueue.push(trimmed);
  }

  /**
   * 运行时调整可用工具集：下一轮起，pi 只在这些工具里执行调用（外加 read_skill 由 runtime 兜底保留）。
   * 多次调用以最后一次为准。
   */
  setActiveTools(toolNames: string[]): void {
    this.pendingActiveTools = new Set(toolNames ?? []);
    this.activeToolsDirty = true;
  }

  /** 是否有尚未纳入的补话。供 UI 显示状态或调试。 */
  hasPendingSteering(): boolean {
    return this.steeringQueue.length > 0;
  }

  /**
   * pi getSteeringMessages 钩子的实现：取出并清空补话队列，
   * 转成 pi 的 user AgentMessage。无补话时返回空数组（满足「不得抛错」契约）。
   */
  drainSteeringMessages(): SteeringUserMessage[] {
    if (this.steeringQueue.length === 0) return [];
    const now = Date.now();
    const messages = this.steeringQueue.map<SteeringUserMessage>((content) => ({
      role: 'user',
      content,
      timestamp: now,
    }));
    this.steeringQueue = [];
    return messages;
  }

  /**
   * 取出一次未消费的工具集变更；无变更时返回 null。
   * prepareNextTurn 用它决定是否替换 context.tools。消费后标记为已应用。
   */
  consumeActiveToolsUpdate(): Set<string> | null {
    if (!this.activeToolsDirty) return null;
    this.activeToolsDirty = false;
    return this.pendingActiveTools;
  }

  /**
   * 绑定到一次新运行：清空遗留的补话与工具变更，避免跨轮/跨次泄漏。
   * 由 queryStream 在启动 agentLoop 前调用。
   */
  reset(): void {
    this.steeringQueue = [];
    this.pendingActiveTools = null;
    this.activeToolsDirty = false;
  }
}

/**
 * 按运行时工具集过滤 pi 工具数组：保留命中名字的工具，并始终保留 read_skill
 * （skill 激活是元能力，收窄工具集时不应被误删，否则模型无法再读取/切换 skill）。
 */
export function filterPiToolsByActiveTools<T extends NamedTool>(
  tools: T[],
  activeTools: Set<string>,
): T[] {
  return tools.filter((tool) => tool.name === 'read_skill' || activeTools.has(tool.name));
}
