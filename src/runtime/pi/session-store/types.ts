/**
 * session-store/types.ts
 *
 * 自建会话持久化层的数据模型。取代 pi 0.75.5 已移除的 SessionRepo/JsonlSessionRepo，
 * 承载 entities.md 定义的 Session/Entry 两层结构。
 *
 * 设计要点（来源：entities.md）：
 * - “分支”不是独立实体：从根 Entry 到 Session.activeLeafEntryId（或任意历史 Entry）
 *   的一条路径，由投影算法在读取时计算；切换分支只改写 activeLeafEntryId 这一个指针。
 * - Entry.visibleToModel / visibleToUiProjection 是两个独立维度（Q5 答案 A），
 *   取代旧代码里"custom_message 对模型可见、对 UI 不可见"的硬编码规则。
 * - Session.availability 承载 FR2.2 的迁移失败处理：迁移失败时置为
 *   read_only_degraded，而不是删除或静默重建会话（Q3 答案 A）。
 */

import type { UsageLike } from './compaction';

/** Session 的可用性状态。迁移失败时置为 read_only_degraded（entities.md 约束）。 */
export type SessionAvailability = 'active' | 'read_only_degraded';

/** Entry 的种类。approval_outcome 是本次新增的显式种类，取代对 custom_message 的隐式复用。 */
export type EntryKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'approval_outcome'
  | 'custom_message';

/** maybeCompact 判定所需的最少必要字段（延续现有压缩逻辑）。 */
export interface CompactionState {
  lastCompactedAt: string;
  tokensSinceCompaction: number;
}

/**
 * 会话树中的一条条目。Entry 之间通过 parentEntryId 构成分叉树；
 * null 仅允许用于该 Session 的根条目。
 */
export interface Entry {
  /** 全局唯一标识。 */
  id: string;
  /** 引用 Session.conversationId。 */
  sessionId: string;
  /** 引用父 Entry.id；null 表示该 Session 的根条目。 */
  parentEntryId: string | null;
  kind: EntryKind;
  /** 是否进入下一轮发往模型的历史（Q5 答案 A，独立维度一）。 */
  visibleToModel: boolean;
  /**
   * 是否出现在 UI 分支投影结果中（Q5 答案 A，独立维度二）。
   * approval_outcome 的既有行为固定为 visibleToModel=true、visibleToUiProjection=false，
   * 不随用户设置变化（见 createApprovalOutcomeEntry）。
   */
  visibleToUiProjection: boolean;
  /**
   * 编辑/重试产生新 Entry 时，原 Entry 记录其被哪个新 Entry 取代；未被取代为 null。
   * 重试流程在「取代者尚未产生」时就已作废原 Entry（见 SUPERSEDED_PENDING_MARKER），
   * 故该字段除真实 Entry.id 外还可能是那个过渡标记；投影算法只需判定「非 null 即已作废」。
   */
  supersededByEntryId: string | null;
  createdAt: string;
  /** 内容随 kind 变化：见下方各类 payload 契约（MessagePayload 等）。 */
  payload: unknown;
}

/**
 * 重试/编辑已作废该 Entry、但取代它的新 Entry 尚未产生的过渡标记。
 *
 * 现有重试流程是「先作废旧问答 → 再定位到该 user 之前 → 重跑生成新 user Entry」，
 * 作废时刻取代者还不存在（用户编辑后的文本要等下一轮才落盘）。而「作废」必须跨重启持久
 * （否则重启后旧分支会重新作为兄弟出现，UI 冒出多余的 `< n/m >`），故用这个标记占位。
 * 投影只判定 `supersededByEntryId !== null`，不解析具体取值，故标记不影响可观察行为。
 */
export const SUPERSEDED_PENDING_MARKER = 'pending';

/**
 * 消息类 Entry（user_message / assistant_message）的 payload。
 *
 * 写入方落盘的**就是那条 pi 消息对象本身**（除本接口列出的字段外还带 api/provider/model/
 * timestamp 等），读取方原样透传以保真——重建消息会丢掉 provider 需要的字段，也会丢掉
 * assistant 消息里与 toolResult 配对所需的 toolCall 块。本接口只声明读取方真正取用的字段；
 * 迁移来的旧条目 payload 只有 {role, content}，故 usage/stopReason 为可选。
 */
export interface MessagePayload {
  content: unknown;
  /** assistant 消息的真实 token 用量（自动压缩的估算优先取它）。 */
  usage?: UsageLike;
  stopReason?: string;
  errorMessage?: string;
}

/** 工具调用 Entry 的 payload。 */
export interface ToolCallPayload {
  name: string;
  args?: unknown;
  toolCallId?: string;
}

/** 工具结果 Entry 的 payload。 */
export interface ToolResultPayload {
  name: string;
  result: unknown;
  toolCallId?: string;
}

/** 审批回灌 Entry 的 payload（模型可读的带外执行结果）。 */
export interface ApprovalOutcomePayload {
  text: string;
}

/** 带外自定义消息 Entry 的 payload（非审批用途）。 */
export interface CustomMessagePayload {
  customType: string;
  text: string;
  display?: boolean;
}

/**
 * 一个持久化的对话会话，对应 HarnessSessionManager 的 per-conversation 隔离单元
 * （conversationId = tab id）。在 vault 内对应一个 JSONL 文件。
 */
export interface Session {
  /** 在整个 vault 范围内唯一（延续现有多 tab 互不串台的行为）。 */
  conversationId: string;
  /** 当前新格式版本号；首次写入即固定。缺失该字段视为旧格式（由解析器层面判定）。 */
  formatVersion: number;
  createdAt: string;
  /** 每次新增 Entry 时更新。 */
  lastActivityAt: string;
  /** 指向当前激活分支的叶子 Entry；空会话尚无条目时为 null。 */
  activeLeafEntryId: string | null;
  /** 未发生过压缩时为 null。 */
  compactionState: CompactionState | null;
  /** 迁移失败时置为 read_only_degraded；该状态下仍可读历史 Entry，但拒绝新增 Entry 写操作。 */
  availability: SessionAvailability;
}

/** 当前新格式版本号。首次写入新 Session 时固定使用此值。 */
export const CURRENT_SESSION_FORMAT_VERSION = 1;

/**
 * 校验 Entry 是否满足 entities.md 的实体级约束：
 * visibleToModel=false 且 visibleToUiProjection=false 的组合被禁止
 * （没有任何一处会写入完全不可见的 Entry；彻底隐藏应改为不写入，而非写入后双重隐藏）。
 */
export function isValidEntryVisibility(entry: Pick<Entry, 'visibleToModel' | 'visibleToUiProjection'>): boolean {
  return entry.visibleToModel || entry.visibleToUiProjection;
}

/**
 * 校验 approval_outcome Entry 的可见性是否符合其固定组合约束：
 * visibleToModel=true、visibleToUiProjection=false，不随用户设置变化。
 */
export function isValidApprovalOutcomeVisibility(
  entry: Pick<Entry, 'kind' | 'visibleToModel' | 'visibleToUiProjection'>,
): boolean {
  if (entry.kind !== 'approval_outcome') return true;
  return entry.visibleToModel === true && entry.visibleToUiProjection === false;
}
