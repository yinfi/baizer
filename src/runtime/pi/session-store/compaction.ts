/**
 * session-store/compaction.ts
 *
 * 自建自动压缩判定。取代 pi 0.75.5 的 `DEFAULT_COMPACTION_SETTINGS` /
 * `estimateContextTokens` / `shouldCompact`（三者均在 1.3.0 移除，见 code-summary.md 的迁移映射）。
 *
 * 判定语义与阈值**逐值对齐旧实现**（依据 0.75.5
 * `dist/harness/compaction/compaction.js`），以保证 FR2.1 的「自动压缩判定不变」：
 * - `DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`
 * - `shouldCompact(tokens, window, settings) = settings.enabled && tokens > window - settings.reserveTokens`
 * - token 估算优先用**最后一条成功 assistant 消息的真实 usage**，其后追加的消息按字符启发式估算。
 */

/** 压缩阈值与保留预算。字段与旧版 pi 的 CompactionSettings 同名同义。 */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** 旧版 pi 的默认压缩设置（逐值对齐 0.75.5）。 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** 消息的 token 用量（形如 pi-ai 的 Usage，只读本模块关心的字段）。 */
export interface UsageLike {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 估算所需的最小消息形状。 */
export interface EstimableMessage {
  role?: string;
  content?: unknown;
  usage?: UsageLike;
  stopReason?: string;
}

/** 旧实现的 `calculateContextTokens`：优先 totalTokens，否则四项相加。 */
export function calculateContextTokens(usage: UsageLike): number {
  return usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * 取消息里的真实 usage。与旧实现一致：只有**非 aborted / 非 error** 的 assistant 消息
 * 的 usage 才可信（中断或失败的回合 usage 不完整）。
 */
function getAssistantUsage(message: EstimableMessage): UsageLike | undefined {
  if (message.role !== 'assistant') return undefined;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined;
  return message.usage;
}

/** 单条消息的字符启发式估算（旧实现：字符数 / 4 向上取整，只数 text 块）。 */
export function estimateTokens(message: EstimableMessage): number {
  const content = message.content;
  let chars = 0;
  if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
        chars += (block as any).text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export interface ContextTokenEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

/**
 * 估算上下文 token（旧实现 `estimateContextTokens` 的等价物）：
 * 从后往前找最后一条带可信 usage 的 assistant 消息，其 usage 计为已知量，
 * 它之后的消息按字符启发式累加。
 */
export function estimateContextTokens(messages: EstimableMessage[]): ContextTokenEstimate {
  let usageInfo: { usage: UsageLike; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      usageInfo = { usage, index: i };
      break;
    }
  }

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** 是否越过压缩阈值（旧实现 `shouldCompact` 的等价物）。 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * 压缩动作的切分点（取代 pi 0.75.5 的 `harness.compact()`——1.3.0 的 `Agent` 不再提供它，
 * 动作改为本层自建：保留最近 `keepRecentTokens` 内的消息，其余折叠成一条摘要）。
 *
 * 从尾部往前按字符启发式累加，找到「保留到这里为止，累计 token 数不超过预算」的切分点。
 * 返回值是 messages 的下标：`messages[0, cutoff)` 应被摘要+隐藏，`messages[cutoff..]` 保留原样。
 * 返回 0 表示没有足够旧的内容可压缩（整段都在预算内）。
 */
export function pickCompactionCutoff(messages: EstimableMessage[], keepRecentTokens: number): number {
  let kept = 0;
  let cutoff = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i]);
    if (kept > 0 && kept + cost > keepRecentTokens) break;
    kept += cost;
    cutoff = i;
  }
  return cutoff;
}
