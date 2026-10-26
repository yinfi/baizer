/**
 * session-store/store.ts
 *
 * Session/Entry 的读写仓储层（FR2.3）。落盘走注入的 VaultFileAdapter（vault 相对路径、
 * 不碰 node fs，延续 VaultSessionFileSystem 的移动端约束），一个 Session 对应 vault 内
 * 一个 JSONL 文件：首行是 Session 元数据记录，其余每行一个 Entry 记录（append-only）。
 *
 * BR2.2：分支切换（分叉/重试/编辑/兄弟切换）只改写 Session.activeLeafEntryId 这一个指针，
 * 不复制、不删除、不改写既有 Entry（除 supersededByEntryId 字段的标记写入）。
 */

import type { VaultFileAdapter } from '../vault-session-fs';
import {
  bestEffortReadOldEntries,
  detectFormat,
  migrateOldToNew,
  splitJsonlLines,
  type MigrationResult,
} from './migrate';
import {
  CURRENT_SESSION_FORMAT_VERSION,
  isValidApprovalOutcomeVisibility,
  isValidEntryVisibility,
  type CompactionState,
  type Entry,
  type EntryKind,
  type Session,
} from './types';

/** JSONL 文件首行的 Session 元数据记录形状（区分于后续的 Entry 记录）。 */
interface SessionMetaRecord {
  record: 'session_meta';
  session: Session;
}

/** JSONL 文件数据行的 Entry 记录形状。 */
interface EntryRecord {
  record: 'entry';
  entry: Entry;
}

type JsonlLine = SessionMetaRecord | EntryRecord;

function normalizeVaultPath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join('/');
}

function dirname(path: string): string {
  const normalized = normalizeVaultPath(path);
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '' : normalized.slice(0, idx);
}

/** 递归确保某目录及其所有上级目录存在。 */
async function ensureDir(adapter: VaultFileAdapter, dir: string): Promise<void> {
  if (!dir) return;
  const segments = dir.split('/');
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

/** 生成一个足够唯一的 Entry id（时间戳 + 随机片段，无需 UUID 依赖）。 */
function generateEntryId(): string {
  return `entry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 新建 Entry 的输入：由调用方决定 kind/parent/payload，可见性维度允许覆盖，
 * 但 approval_outcome 的固定可见性组合在 appendEntry 内强制生效（BR2.1）。
 */
export interface NewEntryInput {
  kind: EntryKind;
  parentEntryId: string | null;
  payload: unknown;
  visibleToModel?: boolean;
  visibleToUiProjection?: boolean;
}

/** SessionStore.open 的结果。 */
export interface OpenResult {
  session: Session;
  entries: Entry[];
  /** 本次调用是否真的执行了旧→新迁移（供日志/测试观察）。 */
  migrated: boolean;
  /** 本次被消费掉（内容已迁移进规范路径后删除）的旧文件路径；没有则为 null。 */
  legacyMigratedPath: string | null;
}

/**
 * Session/Entry 仓储：单个 Session 对应一个 JSONL 文件。
 * 全部读写经注入的 VaultFileAdapter，不持有 node fs 依赖。
 */
export class SessionStore {
  constructor(private readonly adapter: VaultFileAdapter, private readonly sessionsRoot: string) {}

  /** 该会话的规范文件路径（vault 相对）。 */
  pathFor(conversationId: string): string {
    // conversationId 直接作为文件名片段；vault 内按会话 id 唯一（entities.md 约束）。
    return normalizeVaultPath(`${this.sessionsRoot}/${conversationId}.jsonl`);
  }

  /** 新建一个空的新格式 Session，并立刻落盘。 */
  async create(conversationId: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      conversationId,
      formatVersion: CURRENT_SESSION_FORMAT_VERSION,
      createdAt: now,
      lastActivityAt: now,
      activeLeafEntryId: null,
      compactionState: null,
      availability: 'active',
    };
    await this.writeFile(conversationId, session, []);
    return session;
  }

  /** 该会话对应的文件是否存在。 */
  async exists(conversationId: string): Promise<boolean> {
    return this.adapter.exists(this.pathFor(conversationId));
  }

  /**
   * 打开一个会话（BR1.1/BR1.2/BR1.3 的唯一入口）：
   *
   * 1. 规范路径（`<sessionsRoot>/<conversationId>.jsonl`）不存在，但 `legacyPath`
   *    （该会话在 pi 0.75.5 时代的旧文件，路径由调用方从持久化 ref 解析）存在
   *    → 按 BR1.2 迁移/搬运到规范路径。这是旧格式迁移在生产中唯一的触达点：
   *    旧文件的命名由 pi 生成（会话 id），与本层的 conversationId 命名规则不同，
   *    没有这一步，BR1.2 的迁移代码永远不会被执行，用户历史会静默丢失。
   * 2. 文件不存在（且无旧文件）→ 新建新格式会话（active）。
   * 3. 判定为新格式 → 直接解析返回。
   * 4. 判定为旧格式 → 迁移为新格式并**落盘**，返回迁移后的会话（active，用户无感）。
   * 5. 判定为未知 / 迁移抛错 → BR1.3 只读降级：返回
   *    `availability = 'read_only_degraded'` 的会话，**原文件一个字节都不动**
   *    （既不写入也不删除），历史尽力只读读出。因为不落盘，下次打开会重新判定，
   *    结果确定性地一致。此路径不触碰其他会话文件。
   *
   * @returns `migrated` 表示本次调用真的执行了旧→新迁移；`legacyMigratedPath` 为本次
   *   被消费掉（内容已迁移进规范路径后删除）的旧文件路径，供调用方记日志。
   */
  async open(
    conversationId: string,
    options: { legacyPath?: string | null } = {},
  ): Promise<OpenResult> {
    const path = this.pathFor(conversationId);
    if (!(await this.adapter.exists(path))) {
      const legacyPath = options.legacyPath ? normalizeVaultPath(options.legacyPath) : null;
      if (legacyPath && legacyPath !== path && (await this.adapter.exists(legacyPath))) {
        return await this.adoptLegacyFile(conversationId, legacyPath, path);
      }
      return {
        session: await this.create(conversationId),
        entries: [],
        migrated: false,
        legacyMigratedPath: null,
      };
    }

    const raw = await this.readOrNull(path);
    // 读失败（IO 错误等）与「内容无法识别」同等处理：一律 BR1.3 只读降级，
    // 绝不改写原文件——一次瞬时读错误不该把用户的对话历史清成空会话。
    if (raw === null) {
      return { ...this.buildDegradedSession(conversationId, []), migrated: false, legacyMigratedPath: null };
    }
    const lines = splitJsonlLines(raw);
    const format = detectFormat(lines);

    if (format === 'new') {
      const loaded = await this.load(conversationId);
      if (loaded) return { ...loaded, migrated: false, legacyMigratedPath: null };
      // load() 对「首行是合法 session_meta 但后续行损坏」会抛——同样落到只读降级。
      return { ...this.buildDegradedSession(conversationId, []), migrated: false, legacyMigratedPath: null };
    }

    if (format === 'old') {
      try {
        const migrated = migrateOldToNew(lines);
        const normalized = this.normalizeIdentity(conversationId, migrated);
        await this.writeFile(conversationId, normalized.session, normalized.entries);
        return { ...normalized, migrated: true, legacyMigratedPath: null };
      } catch {
        // BR1.3 触发条件之二：迁移过程本身出错。原文件保留，尽力只读。
        return {
          ...this.buildDegradedSession(conversationId, bestEffortReadOldEntries(lines)),
          migrated: false,
          legacyMigratedPath: null,
        };
      }
    }

    // BR1.3 触发条件之一：既不是新格式也不是已知旧格式（含 JSON 损坏）。
    return { ...this.buildDegradedSession(conversationId, []), migrated: false, legacyMigratedPath: null };
  }

  /**
   * 把某会话在旧命名规则下的文件搬到规范路径（BR1.2）。
   * 旧格式迁移成功或内容已是新格式时，旧文件在内容落到规范路径后删除（一个会话只留一份，
   * 也避免用户显式删除会话后旧文件里的对话原文成为隐私残留）；
   * 任何失败路径都**不动**旧文件，改走 BR1.3 只读降级。
   */
  private async adoptLegacyFile(
    conversationId: string,
    legacyPath: string,
    canonicalPath: string,
  ): Promise<OpenResult> {
    const raw = await this.readOrNull(legacyPath);
    if (raw === null) {
      // 旧文件读不出来 → BR1.3 只读降级，旧文件原样保留。
      return { ...this.buildDegradedSession(conversationId, []), migrated: false, legacyMigratedPath: null };
    }
    const lines = splitJsonlLines(raw);
    const format = detectFormat(lines);

    if (format === 'old') {
      try {
        const migrated = migrateOldToNew(lines);
        const normalized = this.normalizeIdentity(conversationId, migrated);
        await this.writeFile(conversationId, normalized.session, normalized.entries);
        await this.removeQuietly(legacyPath);
        return { ...normalized, migrated: true, legacyMigratedPath: legacyPath };
      } catch {
        return {
          ...this.buildDegradedSession(conversationId, bestEffortReadOldEntries(lines)),
          migrated: false,
          legacyMigratedPath: null,
        };
      }
    }

    if (format === 'new') {
      // 内容已是本层格式、只是放在旧路径（如 sessionsRoot 变更过）：原样搬过去，不改内容。
      await ensureDir(this.adapter, dirname(canonicalPath));
      await this.adapter.write(canonicalPath, raw);
      const loaded = await this.load(conversationId);
      if (loaded) {
        await this.removeQuietly(legacyPath);
        return { ...loaded, migrated: false, legacyMigratedPath: legacyPath };
      }
    }

    // 旧路径上的文件既非新格式也非已知旧格式 → BR1.3 只读降级，旧文件原样保留。
    return { ...this.buildDegradedSession(conversationId, []), migrated: false, legacyMigratedPath: null };
  }

  /**
   * 迁移产物的身份归一到本次打开的 conversationId。
   * 旧文件里的 id 是 pi 生成的会话 id，而本层的会话身份由 conversationId 决定；
   * 不归一会让文件内记录的 conversationId 与文件名互相矛盾。
   */
  private normalizeIdentity(conversationId: string, migrated: MigrationResult): MigrationResult {
    return {
      session: { ...migrated.session, conversationId },
      entries: migrated.entries.map((entry) => ({ ...entry, sessionId: conversationId })),
    };
  }

  /** 删除文件，失败不影响主流程（旧文件已迁移完，删不掉只是留个孤儿）。 */
  private async removeQuietly(path: string): Promise<void> {
    try {
      await this.adapter.remove(path);
    } catch {
      // 尽力而为：内容已落到规范路径，旧文件残留不影响正确性。
    }
  }

  /**
   * 构造 BR1.3 的只读降级会话（**不触碰磁盘**），供调用方在 open 之外遇到
   * 无法安全读取的情形时兜底（如 adapter 抛异常）。该状态下 `appendEntry` 会抛错，
   * 满足「拒绝写入任何新 Entry」。
   */
  openDegraded(conversationId: string): { session: Session; entries: Entry[] } {
    return this.buildDegradedSession(conversationId, []);
  }

  /** 读文件；读失败返回 null，由调用方按「无法判定格式」处理（BR1.3 只读降级）。 */
  private async readOrNull(path: string): Promise<string | null> {
    try {
      return await this.adapter.read(path);
    } catch {
      return null;
    }
  }

  /**
   * 构造 BR1.3 的只读降级会话。**不写盘**——降级是内存态，原文件原样保留。
   * 该状态下 `appendEntry` 会抛错，满足「拒绝写入任何新 Entry」。
   */
  private buildDegradedSession(
    conversationId: string,
    entries: Entry[],
  ): { session: Session; entries: Entry[] } {
    const now = new Date().toISOString();
    const session: Session = {
      conversationId,
      formatVersion: CURRENT_SESSION_FORMAT_VERSION,
      createdAt: now,
      lastActivityAt: now,
      activeLeafEntryId: entries.length > 0 ? entries[entries.length - 1].id : null,
      compactionState: null,
      availability: 'read_only_degraded',
    };
    return { session, entries };
  }

  /** 读取整份会话（元数据 + 全部 Entry）。文件不存在时返回 null。 */
  async load(conversationId: string): Promise<{ session: Session; entries: Entry[] } | null> {
    const path = this.pathFor(conversationId);
    if (!(await this.adapter.exists(path))) return null;
    const raw = await this.adapter.read(path);
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return null;

    const first = JSON.parse(lines[0]) as JsonlLine;
    if (first.record !== 'session_meta') {
      throw new Error(`Session file ${path} is missing its session_meta header line.`);
    }
    const session = first.session;
    const entries: Entry[] = [];
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line) as JsonlLine;
      if (parsed.record === 'entry') entries.push(parsed.entry);
    }
    return { session, entries };
  }

  /** 整份覆盖写（用于 create 与迁移写出新格式文件）。 */
  async writeFile(conversationId: string, session: Session, entries: Entry[]): Promise<void> {
    const path = this.pathFor(conversationId);
    await ensureDir(this.adapter, dirname(path));
    const metaLine = JSON.stringify({ record: 'session_meta', session } satisfies SessionMetaRecord);
    const entryLines = entries.map((entry) => JSON.stringify({ record: 'entry', entry } satisfies EntryRecord));
    await this.adapter.write(path, [metaLine, ...entryLines].join('\n') + (entryLines.length > 0 ? '\n' : ''));
  }

  /**
   * 追加一条新 Entry 并更新 Session.activeLeafEntryId / lastActivityAt。
   * availability = read_only_degraded 的会话拒绝写入（BR1.3）。
   * approval_outcome 的可见性组合被强制为固定值（BR2.1），不接受调用方覆盖。
   */
  async appendEntry(conversationId: string, input: NewEntryInput): Promise<Entry> {
    const loaded = await this.load(conversationId);
    if (!loaded) throw new Error(`Session ${conversationId} does not exist.`);
    const { session } = loaded;
    if (session.availability === 'read_only_degraded') {
      throw new Error(`Session ${conversationId} is read_only_degraded and rejects new entries.`);
    }

    const visibleToModel = input.kind === 'approval_outcome' ? true : input.visibleToModel ?? true;
    const visibleToUiProjection = input.kind === 'approval_outcome' ? false : input.visibleToUiProjection ?? true;
    const entry: Entry = {
      id: generateEntryId(),
      sessionId: conversationId,
      parentEntryId: input.parentEntryId,
      kind: input.kind,
      visibleToModel,
      visibleToUiProjection,
      supersededByEntryId: null,
      createdAt: new Date().toISOString(),
      payload: input.payload,
    };
    if (!isValidEntryVisibility(entry)) {
      throw new Error('Entry visibility cannot have both visibleToModel and visibleToUiProjection set to false.');
    }
    if (!isValidApprovalOutcomeVisibility(entry)) {
      throw new Error('approval_outcome entries must have visibleToModel=true and visibleToUiProjection=false.');
    }

    const now = new Date().toISOString();
    session.activeLeafEntryId = entry.id;
    session.lastActivityAt = now;

    // 整份重写首行（Session 元数据会随每次 append 变化），Entry 行保持 append-only。
    // 简单实现：读全部已存在的 entry 行，连同新 entry 一并重写整份文件。
    const allEntries = [...loaded.entries, entry];
    await this.writeFile(conversationId, session, allEntries);
    return entry;
  }

  /**
   * 执行一次压缩动作（取代 pi 0.75.5 的 `harness.compact()`——1.3.0 的 `Agent` 不再提供它）：
   * 把 `hideEntryIds` 标记为 `visibleToModel = false`（不删除、不改写其余字段，`visibleToUiProjection`
   * 不变——这些 Entry 仍完整出现在 UI 历史里，只是不再计入下一轮发往模型的消息），
   * 追加一条摘要 Entry（`kind: 'custom_message'`，模型可见、UI 不可见，与审批回灌同一可见性模式），
   * 并更新 `Session.compactionState`。单次 `writeFile` 原子完成，不会留下半压缩状态。
   */
  async applyCompaction(
    conversationId: string,
    input: { hideEntryIds: string[]; summaryPayload: unknown; compactionState: CompactionState },
  ): Promise<Entry> {
    const loaded = await this.load(conversationId);
    if (!loaded) throw new Error(`Session ${conversationId} does not exist.`);
    const { session, entries } = loaded;
    if (session.availability === 'read_only_degraded') {
      throw new Error(`Session ${conversationId} is read_only_degraded and rejects compaction.`);
    }

    const hideSet = new Set(input.hideEntryIds);
    for (const entry of entries) {
      if (hideSet.has(entry.id)) entry.visibleToModel = false;
    }

    const now = new Date().toISOString();
    const summaryEntry: Entry = {
      id: generateEntryId(),
      sessionId: conversationId,
      parentEntryId: session.activeLeafEntryId,
      kind: 'custom_message',
      visibleToModel: true,
      visibleToUiProjection: false,
      supersededByEntryId: null,
      createdAt: now,
      payload: input.summaryPayload,
    };
    entries.push(summaryEntry);
    session.activeLeafEntryId = summaryEntry.id;
    session.lastActivityAt = now;
    session.compactionState = input.compactionState;

    await this.writeFile(conversationId, session, entries);
    return summaryEntry;
  }

  /**
   * 切换活跃分支：只更新 Session.activeLeafEntryId 指针，不改写任何 Entry（BR2.2）。
   * 目标 Entry 必须存在于该 Session，否则返回 false。
   */
  async moveActiveLeaf(conversationId: string, targetEntryId: string | null): Promise<boolean> {
    const loaded = await this.load(conversationId);
    if (!loaded) return false;
    const { session, entries } = loaded;
    if (targetEntryId !== null && !entries.some((e) => e.id === targetEntryId)) return false;

    session.activeLeafEntryId = targetEntryId;
    session.lastActivityAt = new Date().toISOString();
    await this.writeFile(conversationId, session, entries);
    return true;
  }

  /**
   * 标记某条既有 Entry 被新 Entry 取代（编辑/重试，BR2.2）：只写 supersededByEntryId 字段，
   * 不改写该 Entry 的其余内容。
   */
  async markSuperseded(conversationId: string, entryId: string, supersededByEntryId: string): Promise<boolean> {
    const loaded = await this.load(conversationId);
    if (!loaded) return false;
    const { session, entries } = loaded;
    const target = entries.find((e) => e.id === entryId);
    if (!target) return false;

    target.supersededByEntryId = supersededByEntryId;
    session.lastActivityAt = new Date().toISOString();
    await this.writeFile(conversationId, session, entries);
    return true;
  }

  /** 把会话置为迁移失败的只读保护状态（BR1.3）。不改写任何 Entry。 */
  async markDegraded(conversationId: string): Promise<void> {
    const loaded = await this.load(conversationId);
    if (!loaded) throw new Error(`Session ${conversationId} does not exist.`);
    const { session, entries } = loaded;
    session.availability = 'read_only_degraded';
    await this.writeFile(conversationId, session, entries);
  }

  /** 删除该会话的磁盘文件（彻底销毁，不同于只读降级）。文件不存在视为成功。 */
  async remove(conversationId: string): Promise<void> {
    const path = this.pathFor(conversationId);
    if (await this.adapter.exists(path)) {
      await this.adapter.remove(path);
    }
  }
}
