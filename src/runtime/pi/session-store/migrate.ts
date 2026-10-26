/**
 * session-store/migrate.ts
 *
 * 会话文件格式判定（BR1.1）与旧格式迁移（BR1.2）/ 迁移失败降级（BR1.3）。
 *
 * 旧格式 = pi 0.75.5 `JsonlSessionRepo` 的 JSONL 字节结构（session version 3），
 * 证据来自该版本 `dist/harness/session/jsonl-storage.js` 与 `session.js`：
 * - 首行是 session header：`{ type: "session", version: 3, id, timestamp, cwd, parentSession? }`
 * - 其余每行一个 entry：公共字段 `type` / `id` / `parentId` / `timestamp`，
 *   type 取值与附加字段见 `OLD_ENTRY_TYPES`。
 * - 「当前叶子」不是元数据字段，而是**逐行推进**得到的：`leaf` 型 entry 取其 `targetId`，
 *   其余型取自身 `id`（对应旧实现的 `leafIdAfterEntry`）。
 *
 * 新格式 = 本仓自建持久化层（`store.ts` 写出）：首行是
 * `{ record: "session_meta", session: Session }`，其余行是 `{ record: "entry", entry: Entry }`。
 *
 * BR1.1 要求按**内容特征**判定，不依赖单一 formatVersion 字段，故这里的判定全部基于
 * 结构形状（`record` / `type` 字段的存在与取值）。
 */

import {
  CURRENT_SESSION_FORMAT_VERSION,
  type Entry,
  type EntryKind,
  type Session,
} from './types';

/** 旧格式 session header 的 `version` 取值（唯一已知版本）。 */
const OLD_SESSION_VERSION = 3;

/**
 * 旧格式的 entry type 全集（来源：pi 0.75.5 `session.js` 的 append* 方法）。
 * 迁移时据此把旧条目映射为新模型的 Entry；未列出的 type 视为未知，触发 BR1.3。
 */
const OLD_ENTRY_TYPES = [
  'message',
  'thinking_level_change',
  'model_change',
  'compaction',
  'custom',
  'custom_message',
  'label',
  'leaf',
  'session_info',
  'branch_summary',
] as const;

/** 旧格式的「重试作废」label 值（与 session-branch-projector.ts 的 SUPERSEDED_LABEL 一致）。 */
const OLD_SUPERSEDED_LABEL = 'baizer:superseded';

/** 旧格式 entry 的最小结构（只声明迁移用到的字段）。 */
interface OldEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string; content?: unknown };
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  targetId?: string | null;
  label?: string;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  name?: string;
}

interface OldHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

/** 格式判定结果（BR1.1）。 */
export type DetectedFormat = 'new' | 'old' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 把文件内容切成非空行。空文件返回空数组（调用方据此走「新建」而非「损坏」）。
 */
export function splitJsonlLines(raw: string): string[] {
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * BR1.1：按内容特征判定文件格式。
 *
 * - 新格式特征：首行 JSON 是 `{ record: "session_meta", session: {...} }`，
 *   且 session 形状合法（conversationId 非空 + formatVersion 为正整数）。
 *   `formatVersion` 缺失时不判为新格式——entities.md 明确「缺失该字段视为旧格式」，
 *   而它又不满足下面旧格式的 header 特征，于是自然落到 unknown（BR1.3 只读降级），
 *   两条读法在这里收敛到同一结果。
 * - 旧格式特征：首行 JSON 是 `{ type: "session", version: 3, id, timestamp, cwd }`。
 * - 其余（JSON 解析失败、首行形状两者皆不匹配）→ unknown。
 */
export function detectFormat(lines: string[]): DetectedFormat {
  if (lines.length === 0) return 'unknown';

  let first: unknown;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    return 'unknown';
  }
  if (!isRecord(first)) return 'unknown';

  if (first.record === 'session_meta' && isRecord(first.session)) {
    const session = first.session;
    const formatVersion = session.formatVersion;
    if (
      isNonEmptyString(session.conversationId)
      && typeof formatVersion === 'number'
      && Number.isInteger(formatVersion)
      && formatVersion > 0
    ) {
      return 'new';
    }
    return 'unknown';
  }

  if (first.type === 'session') {
    if (
      first.version === OLD_SESSION_VERSION
      && isNonEmptyString(first.id)
      && isNonEmptyString(first.timestamp)
      && isNonEmptyString(first.cwd)
    ) {
      return 'old';
    }
    // 形状像旧 header 但字段不合规（版本不符 / 缺 id / 缺 timestamp / 缺 cwd）：
    // 既不是可用的新格式，也不是已知的旧格式 → BR1.3。
    return 'unknown';
  }

  return 'unknown';
}

/** 迁移失败（BR1.3 触发条件之一）。 */
export class SessionMigrationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SessionMigrationError';
  }
}

/** 解析旧格式首行。字段不合规时抛 SessionMigrationError（由调用方转 BR1.3）。 */
function parseOldHeader(line: string): OldHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new SessionMigrationError('Old session header is not valid JSON.', error);
  }
  if (!isRecord(parsed) || parsed.type !== 'session') {
    throw new SessionMigrationError('Old session header has an unexpected shape.');
  }
  if (parsed.version !== OLD_SESSION_VERSION) {
    throw new SessionMigrationError(`Unsupported old session version: ${String(parsed.version)}.`);
  }
  if (!isNonEmptyString(parsed.id) || !isNonEmptyString(parsed.timestamp) || !isNonEmptyString(parsed.cwd)) {
    throw new SessionMigrationError('Old session header is missing id/timestamp/cwd.');
  }
  return {
    type: 'session',
    version: OLD_SESSION_VERSION,
    id: parsed.id,
    timestamp: parsed.timestamp,
    cwd: parsed.cwd,
    parentSession: isNonEmptyString(parsed.parentSession) ? parsed.parentSession : undefined,
  };
}

/** 逐行解析旧格式 entry。任一行不合规即抛（整份文件迁移失败，而非跳过该行）。 */
function parseOldEntries(lines: string[]): OldEntry[] {
  const entries: OldEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (error) {
      throw new SessionMigrationError(`Old session line ${i + 1} is not valid JSON.`, error);
    }
    if (!isRecord(parsed)) {
      throw new SessionMigrationError(`Old session line ${i + 1} is not an object.`);
    }
    if (!isNonEmptyString(parsed.type)) {
      throw new SessionMigrationError(`Old session line ${i + 1} is missing entry type.`);
    }
    if (!(OLD_ENTRY_TYPES as readonly string[]).includes(parsed.type)) {
      throw new SessionMigrationError(`Old session line ${i + 1} has unknown entry type "${parsed.type}".`);
    }
    if (!isNonEmptyString(parsed.id)) {
      throw new SessionMigrationError(`Old session line ${i + 1} is missing entry id.`);
    }
    if (parsed.parentId !== null && parsed.parentId !== undefined && typeof parsed.parentId !== 'string') {
      throw new SessionMigrationError(`Old session line ${i + 1} has an invalid parentId.`);
    }
    if (!isNonEmptyString(parsed.timestamp)) {
      throw new SessionMigrationError(`Old session line ${i + 1} is missing timestamp.`);
    }
    entries.push({
      type: parsed.type,
      id: parsed.id,
      parentId: (parsed.parentId as string | null | undefined) ?? null,
      timestamp: parsed.timestamp,
      message: isRecord(parsed.message) ? (parsed.message as OldEntry['message']) : undefined,
      customType: isNonEmptyString(parsed.customType) ? parsed.customType : undefined,
      content: parsed.content,
      display: typeof parsed.display === 'boolean' ? parsed.display : undefined,
      details: parsed.details,
      targetId: (parsed.targetId as string | null | undefined) ?? undefined,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      firstKeptEntryId: isNonEmptyString(parsed.firstKeptEntryId) ? parsed.firstKeptEntryId : undefined,
      tokensBefore: typeof parsed.tokensBefore === 'number' ? parsed.tokensBefore : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
    });
  }
  return entries;
}

/**
 * 旧格式 entry → 新模型 Entry 的 kind 与可见性映射（BR1.2 步骤 4a/4b）。
 *
 * 返回 null 表示该旧条目**不产生新 Entry**（见 `migrateOldToNew` 的说明）。
 * 可见性依据旧实现的既有可观察行为：
 * - `message` 对模型与 UI 都可见（旧投影只认 type==='message'）。
 * - `custom_message` 对模型可见、对 UI 不可见（旧注释：buildSessionContext→convertToLlm 转成
 *   user 消息，而 projectBranchToMessages 跳过它）。
 * - `compaction` 的摘要对模型可见、对 UI 不可见（压缩条目从不渲染成气泡）。
 */
function mapOldEntry(old: OldEntry): { kind: EntryKind; visibleToModel: boolean; visibleToUiProjection: boolean } | null {
  switch (old.type) {
    case 'message': {
      const role = old.message?.role;
      if (role === 'user') return { kind: 'user_message', visibleToModel: true, visibleToUiProjection: true };
      if (role === 'assistant') return { kind: 'assistant_message', visibleToModel: true, visibleToUiProjection: true };
      if (role === 'toolResult') return { kind: 'tool_result', visibleToModel: true, visibleToUiProjection: true };
      // 未知 role 的 message：保守按 UI 可见的普通消息保留，不丢弃用户内容。
      return { kind: 'custom_message', visibleToModel: true, visibleToUiProjection: true };
    }
    case 'custom_message':
      // 审批回灌：旧实现用 custom_message + customType='approval_outcome' 承载，
      // 迁移时重建为显式的 approval_outcome 种类（固定「模型可见、UI 不可见」，BR2.1）。
      if (old.customType === 'approval_outcome') {
        return { kind: 'approval_outcome', visibleToModel: true, visibleToUiProjection: false };
      }
      return { kind: 'custom_message', visibleToModel: true, visibleToUiProjection: false };
    case 'compaction':
      return { kind: 'custom_message', visibleToModel: true, visibleToUiProjection: false };
    // 以下类型不产生新 Entry（见 migrateOldToNew 的丢弃说明）。
    case 'label':
    case 'leaf':
    case 'thinking_level_change':
    case 'model_change':
    case 'custom':
    case 'session_info':
    case 'branch_summary':
      return null;
    default:
      return null;
  }
}

/** 旧格式迁移产物。 */
export interface MigrationResult {
  session: Session;
  entries: Entry[];
}

/**
 * BR1.2：把旧格式文件迁移为新格式的 Session + Entry[]。
 *
 * 结构保真策略：
 * - **保留旧 id 作为新 Entry.id**，便于回溯与外部锚定。
 * - **重定父**：旧树里夹着大量不产生新 Entry 的元数据条目（`label`/`leaf`/
 *   `thinking_level_change`/`model_change`/`custom`/`session_info`/`branch_summary`）。
 *   若直接丢弃它们，其子条目的 parentId 会指向不存在的节点。故每个存活条目的
 *   `parentEntryId` 取「沿旧 parentId 链上溯的第一个存活条目」，根为 null。
 *   这保持了两条消息之间的「兄弟/祖先」关系不变——旧投影的兄弟判定本就只看
 *   同一 parentId 下的 message，而链上夹着的元数据条目对消息层是透明的。
 * - **`label` 折叠为 `supersededByEntryId`**：新模型把「重试作废」从独立 label 条目
 *   提升为字段。迁移时对每个 `baizer:superseded` label 的目标 T，在同 parentId 的
 *   user message 兄弟中取 timestamp 最早且晚于 T 的那条作为取代者。
 *   若找不到取代者，则该 label 无可观察效果（旧投影的作废过滤只在存在兄弟时才有意义），
 *   保持 null 即行为等价。
 * - **`leaf` 折叠为 `activeLeafEntryId`**：旧格式的活跃叶子由逐行推进得到
 *   （`leaf` 条目取 targetId，其余取自身 id）。取推进终值，并回溯到最近的存活条目。
 *
 * @throws SessionMigrationError 旧格式解析出错（调用方转 BR1.3 只读降级）
 */
export function migrateOldToNew(lines: string[]): MigrationResult {
  const header = parseOldHeader(lines[0]);
  const oldEntries = parseOldEntries(lines);

  // ---- 1. 决定哪些旧条目存活，并分配新 Entry ----
  const newIdByOldId = new Map<string, string>();
  const kindByOldId = new Map<string, EntryKind>();
  for (const old of oldEntries) {
    if (mapOldEntry(old) !== null) {
      newIdByOldId.set(old.id, old.id);
      kindByOldId.set(old.id, mapOldEntry(old)!.kind);
    }
  }

  // 沿旧 parentId 链上溯到最近的存活条目（旧条目本身可能不存活）。
  const oldById = new Map(oldEntries.map((e) => [e.id, e]));
  const resolveParent = (old: OldEntry): string | null => {
    let parentId = old.parentId;
    const seen = new Set<string>();
    while (parentId !== null) {
      if (newIdByOldId.has(parentId)) return newIdByOldId.get(parentId)!;
      if (seen.has(parentId)) return null; // 防御旧文件里的环
      seen.add(parentId);
      const parent = oldById.get(parentId);
      if (!parent) return null;
      parentId = parent.parentId;
    }
    return null;
  };

  // ---- 2. 重试作废：label → supersededByEntryId ----
  const supersededByOldId = new Map<string, string>();
  const latestLabelByTarget = new Map<string, string | undefined>();
  for (const old of oldEntries) {
    if (old.type !== 'label' || !isNonEmptyString(old.targetId)) continue;
    latestLabelByTarget.set(old.targetId, old.label);
  }
  for (const [targetId, label] of latestLabelByTarget) {
    if (label !== OLD_SUPERSEDED_LABEL) continue;
    const target = oldById.get(targetId);
    if (!target) continue;
    const replacement = oldEntries
      .filter((candidate) => (
        candidate.id !== target.id
        && candidate.type === 'message'
        && candidate.message?.role === 'user'
        && candidate.parentId === target.parentId
        && candidate.timestamp > target.timestamp
        && latestLabelByTarget.get(candidate.id) !== OLD_SUPERSEDED_LABEL
      ))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
    if (replacement) supersededByOldId.set(target.id, replacement.id);
  }

  // ---- 3. 组装新 Entry[]（保持旧文件顺序）----
  const entries: Entry[] = [];
  for (const old of oldEntries) {
    const mapping = mapOldEntry(old);
    if (mapping === null) continue;
    entries.push({
      id: old.id,
      sessionId: header.id,
      parentEntryId: resolveParent(old),
      kind: mapping.kind,
      visibleToModel: mapping.visibleToModel,
      visibleToUiProjection: mapping.visibleToUiProjection,
      supersededByEntryId: supersededByOldId.get(old.id) ?? null,
      createdAt: old.timestamp,
      payload: buildPayload(old, mapping.kind),
    });
  }

  // ---- 4. 活跃叶子：按旧实现的逐行推进规则取终值，再回溯到存活条目 ----
  let runningLeaf: string | null = null;
  for (const old of oldEntries) {
    runningLeaf = old.type === 'leaf' ? (old.targetId ?? null) : old.id;
  }
  let activeLeafEntryId: string | null = null;
  {
    let cursor = runningLeaf;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (newIdByOldId.has(cursor)) {
        activeLeafEntryId = newIdByOldId.get(cursor)!;
        break;
      }
      seen.add(cursor);
      cursor = oldById.get(cursor)?.parentId ?? null;
    }
  }

  // ---- 5. 压缩状态：取最后一条 compaction 条目的时间与 tokensBefore ----
  const lastCompaction = [...oldEntries].reverse().find((old) => old.type === 'compaction');
  const session: Session = {
    conversationId: header.id,
    formatVersion: CURRENT_SESSION_FORMAT_VERSION,
    createdAt: header.timestamp,
    lastActivityAt: entries.length > 0 ? entries[entries.length - 1].createdAt : header.timestamp,
    activeLeafEntryId,
    compactionState: lastCompaction
      ? { lastCompactedAt: lastCompaction.timestamp, tokensSinceCompaction: lastCompaction.tokensBefore ?? 0 }
      : null,
    availability: 'active',
  };

  return { session, entries };
}

/**
 * 构造新 Entry 的 payload。
 * - message → 原样保留 `{ role, content }`（内容形状不变，投影/模型组装各自读取）。
 * - custom_message / compaction → 保留可辨识的来源信息，便于回溯。
 * - label / leaf 等不产生 Entry，不走这里。
 */
function buildPayload(old: OldEntry, kind: EntryKind): unknown {
  if (old.type === 'message') {
    return { role: old.message?.role, content: old.message?.content };
  }
  if (old.type === 'compaction') {
    return {
      customType: 'compaction',
      summary: old.summary,
      firstKeptEntryId: old.firstKeptEntryId,
      tokensBefore: old.tokensBefore,
    };
  }
  if (old.type === 'custom_message') {
    return {
      customType: old.customType,
      content: old.content,
      display: old.display,
      details: old.details,
      kind,
    };
  }
  return { customType: old.customType, content: old.content };
}

/**
 * BR1.3 只读降级时的**尽力读取**：逐行独立解析，能映射成 Entry 的保留下来供 UI 查看历史，
 * 解析不了的行跳过。绝不抛异常、绝不写盘——调用方据此构造
 * `availability = read_only_degraded` 的会话。
 *
 * 与 `migrateOldToNew` 的区别：后者要求整份文件结构完好（一行坏则整体失败），
 * 前者是「已经确定迁移失败」之后的只读兜底。
 */
export function bestEffortReadOldEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  const seenIds = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (!isRecord(parsed)) continue;
      if (!isNonEmptyString(parsed.type) || !isNonEmptyString(parsed.id)) continue;
      if (!(OLD_ENTRY_TYPES as readonly string[]).includes(parsed.type)) continue;
      const old: OldEntry = {
        type: parsed.type,
        id: parsed.id,
        parentId: (parsed.parentId as string | null | undefined) ?? null,
        timestamp: isNonEmptyString(parsed.timestamp) ? parsed.timestamp : new Date(0).toISOString(),
        message: isRecord(parsed.message) ? (parsed.message as OldEntry['message']) : undefined,
        customType: isNonEmptyString(parsed.customType) ? parsed.customType : undefined,
        content: parsed.content,
        targetId: (parsed.targetId as string | null | undefined) ?? undefined,
        label: typeof parsed.label === 'string' ? parsed.label : undefined,
      };
      const mapping = mapOldEntry(old);
      if (mapping === null) continue;
      if (seenIds.has(old.id)) continue;
      seenIds.add(old.id);
      entries.push({
        id: old.id,
        sessionId: '',
        parentEntryId: old.parentId,
        kind: mapping.kind,
        visibleToModel: mapping.visibleToModel,
        visibleToUiProjection: mapping.visibleToUiProjection,
        supersededByEntryId: null,
        createdAt: old.timestamp,
        payload: buildPayload(old, mapping.kind),
      });
    } catch {
      // 单行坏：跳过，继续尽力读取其余行。
    }
  }
  return entries;
}
