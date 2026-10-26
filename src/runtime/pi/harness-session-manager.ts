import { logger } from '../../utils/logger';
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  pickCompactionCutoff,
  shouldCompact,
  type CompactionSettings,
  type EstimableMessage,
} from './session-store/compaction';
import {
  ConversationSession,
  DEFAULT_SESSIONS_ROOT,
  createInMemoryConversationSession,
  resolveBranch,
} from './session-store/conversation-session';
import { SessionStore } from './session-store/store';
import {
  SUPERSEDED_PENDING_MARKER,
  type ApprovalOutcomePayload,
  type Entry,
  type SessionAvailability,
} from './session-store/types';
import type { VaultFileAdapter } from './vault-session-fs';

/** 持久化的会话引用（存进插件 data，跨重启恢复）。 */
export interface PersistedSessionRef {
  id: string;
  path: string;
  createdAt: string;
  cwd: string;
}

/** `maybeCompact` 的结果：是否真的执行了压缩动作（供 runtime 决定是否产出 compaction StreamEvent）。 */
export interface MaybeCompactResult {
  compacted: boolean;
  /** 压缩动作折叠隐藏的 Entry 数量；仅 `compacted: true` 时有意义。 */
  foldedEntryCount?: number;
}

export interface HarnessSessionManagerOptions {
  /** 会话文件根目录(vault 相对,隐藏目录)。 */
  sessionsRoot?: string;
  /** cwd 标识(仅随 ref 记录;会话文件路径由 conversationId 直接派生)。 */
  cwd?: string;
  /**
   * 读取某会话上次持久化的引用。**升级后的唯一用途**：定位该会话在 pi 0.75.5 时代
   * 写下的旧格式文件（文件名由 pi 生成，与本层的 `<conversationId>.jsonl` 命名不同），
   * 作为 BR1.2 迁移的入口。取不到时该会话按新建处理。
   */
  loadRef?: (conversationId: string) => Promise<PersistedSessionRef | null> | PersistedSessionRef | null;
  /** 保存某会话的当前引用,便于下次启动恢复。ref 为 null 表示清除该会话的持久引用。 */
  saveRef?: (conversationId: string, ref: PersistedSessionRef | null) => Promise<void> | void;
  /**
   * 当前模型的上下文窗口(token),用于自动压缩阈值判定。
   * 用 getter:settings 可运行期改动,每次判定取最新值。返回 0/未提供时关闭自动压缩。
   */
  contextWindow?: () => number;
  /** 压缩阈值/保留预算覆盖;缺省用自建压缩模块的默认值(逐值对齐 pi 0.75.5)。 */
  compactionSettings?: Partial<CompactionSettings>;
  /**
   * 压缩动作用的摘要生成器:走应用自己的 provider(无状态生成),与旧实现一致。
   * 生产由 ModelService 提供(复用 generate() 的无状态路径);未提供时压缩只做阈值判定、
   * 不执行动作(按能力缺口记告警,见 maybeCompact)。
   */
  summarize?: (prompt: string) => Promise<string>;
}

const DEFAULT_CWD = '/';

/** 单个会话(conversation)的活跃 session 与其持久引用。 */
interface ConversationEntry {
  session: ConversationSession;
  ref: PersistedSessionRef;
}

/**
 * Harness 会话生命周期管理器(取代旧的 SessionStore)。
 *
 * 职责：per-conversation 隔离的会话生命周期与分支原语。持久化全部委托给自建持久化层
 * (`session-store/*`)——取代 pi 0.75.5 已移除的 `JsonlSessionRepo`/`SessionRepo`/`Session`。
 * 对外方法签名与可观察行为保持与升级前一致(FR2.1 行为保真度)。
 *
 * - open-or-create:按 conversationId 打开(必要时迁移旧格式文件),否则新建。
 * - getSession(conversationId):把该会话的读写句柄交给每轮 runtime 复用。
 * - maybeCompact:每轮结束后按真实 usage 判断阈值,超了就调 harness.compact()。
 * - clear(conversationId):重置该会话(原地写一个空会话)。
 *
 * per-conversation 隔离:内部维护 Map<conversationId, ConversationEntry>。不同 conversationId
 * (= UI tab.id)派生各自独立的跨轮上下文,不同 tab 互不串台。
 *
 * conversationId 缺省(后台/一次性调用)时返回一个基于内存 adapter 的临时会话:不落盘、
 * 不入 Map、每次调用全新,天然无持久、无跨轮上下文。
 *
 * 移动端约束:落盘走注入的 VaultFileAdapter,不碰 node fs。
 */
export class HarnessSessionManager {
  private readonly adapter: VaultFileAdapter;
  private readonly store: SessionStore;
  private readonly sessionsRoot: string;
  private readonly cwd: string;
  /** 每个 conversationId 对应的活跃 session。 */
  private readonly conversations = new Map<string, ConversationEntry>();
  /** 同一 conversationId 的并发 ready 去重(同会话两轮竞态时只建一次)。 */
  private readonly readyPromises = new Map<string, Promise<ConversationEntry>>();

  constructor(
    adapter: VaultFileAdapter,
    private readonly options: HarnessSessionManagerOptions = {},
  ) {
    this.adapter = adapter;
    this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.store = new SessionStore(adapter, this.sessionsRoot);
  }

  /**
   * 确保某会话有一个活跃 session:打开(必要时迁移旧格式文件)或新建。幂等。
   * 同 conversationId 的并发调用共享同一 Promise,避免竞态下重复建会话。
   */
  private async ensureConversation(conversationId: string): Promise<ConversationEntry> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;

    const inFlight = this.readyPromises.get(conversationId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const savedRef = await this.resolveSavedRef(conversationId);
      let opened;
      try {
        opened = await this.store.open(conversationId, { legacyPath: savedRef?.path ?? null });
      } catch (error) {
        // open 抛错属意外情形(读取失败已由持久化层内部降级处理)。此处**不新建**:
        // 新建会覆盖该会话已有的文件,把用户历史清成空会话;改为只读降级,一个字节都不写。
        logger.warn(
          `Failed to open session for conversation ${conversationId} (${error instanceof Error ? error.message : String(error)}); degrading to read-only.`,
          'HarnessSessionManager.ensureConversation',
        );
        const degraded = this.store.openDegraded(conversationId);
        opened = { ...degraded, migrated: false, legacyMigratedPath: null };
      }

      if (opened.migrated) {
        logger.info(
          `Migrated legacy session file for conversation ${conversationId}${opened.legacyMigratedPath ? ` from ${opened.legacyMigratedPath}` : ''}.`,
          'HarnessSessionManager.ensureConversation',
        );
      }
      if (opened.session.availability === 'read_only_degraded') {
        // BR1.3:迁移失败 → 只读保护。原文件零写入,该会话仅可查看历史。
        logger.warn(
          `Session for conversation ${conversationId} is read_only_degraded (migration failed); new entries are rejected.`,
          'HarnessSessionManager.ensureConversation',
        );
      }

      const session = new ConversationSession(this.store, conversationId, opened.session);
      const ref: PersistedSessionRef = {
        id: conversationId,
        path: this.store.pathFor(conversationId),
        createdAt: opened.session.createdAt,
        cwd: this.cwd,
      };
      const entry: ConversationEntry = { session, ref };
      this.conversations.set(conversationId, entry);
      await this.persistRef(conversationId, ref);
      return entry;
    })();

    this.readyPromises.set(conversationId, promise);
    try {
      return await promise;
    } finally {
      this.readyPromises.delete(conversationId);
    }
  }

  /**
   * 返回该会话的读写句柄,交给每轮 runtime 复用。
   * conversationId 缺省时返回一个不持久、不入 Map 的内存临时会话(后台/一次性调用)。
   */
  async getSession(conversationId?: string): Promise<ConversationSession> {
    if (!conversationId) {
      return this.createEphemeralSession();
    }
    const entry = await this.ensureConversation(conversationId);
    return entry.session;
  }

  /** 某会话当前的引用(诊断/外部持久化)。未建立或临时会话时为 null。 */
  getRef(conversationId?: string): PersistedSessionRef | null {
    if (!conversationId) return null;
    return this.conversations.get(conversationId)?.ref ?? null;
  }

  /**
   * 某会话的可用性状态(BR1.3 的 UI 提示依据)。
   * conversationId 缺省(临时会话)时为 null;未建立时会先打开/新建(与 getSession 同语义)。
   */
  async getAvailability(conversationId?: string): Promise<SessionAvailability | null> {
    if (!conversationId) return null;
    const entry = await this.ensureConversation(conversationId);
    return entry.session.availability;
  }

  /**
   * 某会话是否已有跨轮历史(至少一条模型可见消息)。供短确认/延续判定使用。
   * conversationId 缺省(临时会话)恒为 false。出错时保守返回 false(视为无历史,不剔除上下文)。
   */
  async hasHistory(conversationId?: string): Promise<boolean> {
    if (!conversationId) return false;
    try {
      const entry = await this.ensureConversation(conversationId);
      return await entry.session.hasHistory();
    } catch {
      return false;
    }
  }

  /**
   * 重置某会话:原地写一个空会话,使跨轮上下文从零开始。conversationId 缺省时无操作。
   *
   * 与升级前的差异(见 code-summary):升级前是「开一个全新文件、旧文件留存」,而本层
   * 「一个 conversationId 对应一个 Session/文件」(entities.md),旧语义无法表达。用户可见
   * 行为不变(历史清空、上下文从零);差异仅在磁盘不再留孤儿文件。
   *
   * 只读降级会话不重置:BR1.3 要求原文件零写入,而那份文件是该会话历史唯一的副本,
   * 清掉就真丢了。用户若要彻底删除,走 purge(显式删除语义)。
   */
  async clear(conversationId?: string): Promise<void> {
    if (!conversationId) return;
    const existing = this.conversations.get(conversationId);
    if (existing?.session.availability === 'read_only_degraded') {
      logger.warn(
        `Refused to reset read_only_degraded session for conversation ${conversationId}.`,
        'HarnessSessionManager.clear',
      );
      return;
    }
    const session = await this.store.create(conversationId);
    const ref: PersistedSessionRef = {
      id: conversationId,
      path: this.store.pathFor(conversationId),
      createdAt: session.createdAt,
      cwd: this.cwd,
    };
    this.conversations.set(conversationId, { session: new ConversationSession(this.store, conversationId, session), ref });
    await this.persistRef(conversationId, ref);
  }

  /** 释放某会话的内存态(如关闭 tab)。不删磁盘文件,持久 ref 保留,下次可恢复。 */
  release(conversationId: string): void {
    this.conversations.delete(conversationId);
    this.readyPromises.delete(conversationId);
  }

  /**
   * 彻底销毁某会话:删磁盘会话文件 + 清持久 ref + 释放内存态。
   * 用于「删除历史对话」——与 release(仅释放内存、保留可回溯)、clear(原地重置)不同,
   * 这是用户显式删除,不应在盘上留孤儿文件或残留 ref(既是磁盘泄漏,也是隐私:JSONL 存对话原文)。
   *
   * 删除范围含该会话在旧命名规则下的文件(ref.path),否则升级前留下的旧文件会带着
   * 对话原文永远留在盘上。删文件失败不抛——尽力而为,ref 已清则重启不会再引用它。
   * conversationId 缺省时无操作(临时会话无持久文件)。
   */
  async purge(conversationId: string | undefined): Promise<void> {
    if (!conversationId) return;
    // 先解析出该会话的持久 ref(内存有就用,没有走 loadRef 兜底),拿到可能的旧文件路径。
    const ref = this.conversations.get(conversationId)?.ref
      ?? await this.resolveSavedRef(conversationId);

    // 释放内存态,避免后续再被 getSession 复用到已删文件。
    this.conversations.delete(conversationId);
    this.readyPromises.delete(conversationId);

    const paths = new Set<string>([this.store.pathFor(conversationId)]);
    if (ref?.path) paths.add(ref.path);
    for (const path of paths) {
      try {
        await this.adapter.remove(path);
      } catch {
        logger.warn(
          `Failed to remove session file ${path} for conversation ${conversationId}.`,
          'HarnessSessionManager.purge',
        );
      }
    }

    // 清持久 ref(ref=null 表示删除该会话的引用),使重启后不再尝试恢复。
    await this.persistRef(conversationId, null);
  }

  /**
   * 把一次「用户批准并已执行」的动作结果回灌进该会话。
   *
   * 背景:审批轮在 afterToolCall 里 terminate 结束,会话中只留下
   * assistant(tool_call) + toolResult(approval_required 占位);用户随后点批准是在
   * runtime 之外直执工具,结果此前只进 UI,从不入会话。由于跨轮上下文的唯一真相源
   * 是会话(UI 历史不再回灌),下一轮模型因此看不到「批准了、文件已建/失败」而失忆。
   *
   * 写一条 approval_outcome Entry:对模型可见(计入发往模型的消息)、对 UI 分支投影不可见
   * (不渲染假气泡),正好承载这条带外的执行结果(BR2.1 的固定可见性组合由持久化层强制)。
   *
   * conversationId 缺省(临时会话)或会话未建立时:无持久会话可写,静默跳过。
   * 任何异常吞掉——回灌是增强,不能让「已成功执行的动作」因记账失败而看起来失败。
   */
  async appendApprovalOutcome(conversationId: string | undefined, text: string): Promise<void> {
    if (!conversationId) return;
    const trimmed = text?.trim();
    if (!trimmed) return;
    const entry = this.conversations.get(conversationId);
    if (!entry) return;
    try {
      const payload: ApprovalOutcomePayload = { text: trimmed };
      await entry.session.append({
        kind: 'approval_outcome',
        parentEntryId: entry.session.getActiveLeafEntryId(),
        payload,
      });
    } catch {
      logger.warn(
        `Failed to append approval outcome to session for conversation ${conversationId}.`,
        'HarnessSessionManager.appendApprovalOutcome',
      );
    }
  }

  // ---- 阶段C:分支导航原语(都基于该会话持有的会话句柄)----

  /**
   * 取该会话「当前活跃分支」的 Entry(root→leaf)与全量 Entry,供 projector 投影。
   * 无 conversationId 或未建立时返回空。
   */
  async getBranchEntries(
    conversationId?: string,
  ): Promise<{ branch: Entry[]; all: Entry[] }> {
    if (!conversationId) return { branch: [], all: [] };
    const entry = await this.ensureConversation(conversationId);
    const all = await entry.session.getAllEntries();
    return { branch: resolveBranch(all, entry.session.getActiveLeafEntryId()), all };
  }

  /**
   * 切换活跃分支:把活跃叶子移到 targetLeafEntryId(某兄弟子树的叶子)。不生成分支摘要。
   * 返回是否成功(目标不存在时 false)。切换后跨轮上下文即从新分支派生。
   */
  async moveToBranch(conversationId: string, targetLeafEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(targetLeafEntryId);
    if (!target) return false;
    return await entry.session.moveActiveLeaf(targetLeafEntryId);
  }

  /**
   * 为「从某条 user 消息重跑/编辑」定位:把活跃叶子移到该 user Entry 的 parentEntryId
   * (即该 user 之前)。之后走正常 chatStream,新的 prompt 会在同一 parent 下 append,
   * 与原 user 成为兄弟分支,原分支完整保留。
   *
   * 首条 user 消息的 parentEntryId 为 null → 移回 root(空历史),符合「编辑首条消息」语义。
   * 返回是否成功(Entry 不存在或非 user 消息时 false)。
   */
  async prepareForkAtUser(conversationId: string, userEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(userEntryId);
    if (!target || target.kind !== 'user_message') return false;
    return await entry.session.moveActiveLeaf(target.parentEntryId);
  }

  /**
   * 给某条 user 消息打「重试作废」标记(阶段C 语义:重试=换掉旧答案、不保留旧分支)。
   * projector 枚举兄弟分支时会过滤掉被标记者,于是重试后有效兄弟只剩新的一条。
   * 与 prepareForkAtUser 配合:重试 = supersede 旧 user + prepareForkAtUser + 重跑。
   *
   * 作废时刻取代它的新 Entry 还没产生(新文本要等下一轮才落盘),故写入
   * SUPERSEDED_PENDING_MARKER 占位;投影只判定「非 null 即已作废」。
   */
  async supersedeUserEntry(conversationId: string, userEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(userEntryId);
    if (!target || target.kind !== 'user_message') return false;
    return await entry.session.markSuperseded(userEntryId, SUPERSEDED_PENDING_MARKER);
  }

  /** 构造一个不持久、不入 Map 的内存临时会话(供 conversationId 缺省的一次性调用)。 */
  private async createEphemeralSession(): Promise<ConversationSession> {
    return await createInMemoryConversationSession(this.sessionsRoot);
  }

  /**
   * 每轮结束后的自动压缩:上下文 token 超过 (contextWindow - reserveTokens) 时,
   * 把超出 keepRecentTokens 预算的旧消息摘要折叠成一条 Entry。
   *
   * 阈值判定用自建压缩模块(逐值对齐 pi 0.75.5 的 DEFAULT_COMPACTION_SETTINGS /
   * estimateContextTokens / shouldCompact),token 估算优先取真实 provider usage——
   * 落盘的 assistant 消息带真实 usage,故估算准确,判定结果与升级前一致。
   *
   * 动作取代 pi 0.75.5 已移除的 harness.compact():1.3.0 的 Agent 不再提供它,
   * 本层自建为「保留最近 keepRecentTokens,其余摘要折叠(ConversationSession.applyCompaction)」——
   * 只改写 visibleToModel,原 Entry 继续完整出现在 UI 历史里,从不删除/改写用户历史。
   * 摘要走注入的 summarize(与旧实现一致,用应用自己的 provider);未提供时只做判定、
   * 记告警而非静默跳过动作(避免真正的能力缺口被掩盖)。失败不抛出:压缩是优化而非
   * 正确性前提,失败仅记告警,下一轮再试。
   *
   * 返回值供调用方(runtime)判断是否要产出 compaction 类 StreamEvent(functional-spec.md
   * §4 决策表:压缩事件「映射」—— pi 1.3.0 本身不发压缩事件,故改为本方法返回结果,
   * 让 UI 能感知压缩发生,不再是纯内部副作用)。
   */
  async maybeCompact(conversationId?: string): Promise<MaybeCompactResult> {
    const notCompacted: MaybeCompactResult = { compacted: false };
    const contextWindow = this.options.contextWindow?.() ?? 0;
    if (contextWindow <= 0) return notCompacted;
    // 临时会话不压缩(无持久、无跨轮);未建立的会话跳过。
    const entry = conversationId ? this.conversations.get(conversationId) : undefined;
    if (!entry) return notCompacted;

    try {
      const settings: CompactionSettings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        ...this.options.compactionSettings,
      };
      if (!settings.enabled) return notCompacted;

      // 防呆:阈值 = contextWindow - reserveTokens。若用户配置的 contextWindow 小于等于
      // reserveTokens,阈值为负/零,会让压缩每轮无意义触发。此时直接跳过。
      if (contextWindow <= settings.reserveTokens) return notCompacted;

      const { entries, messages } = await entry.session.buildModelView();
      const estimate = estimateContextTokens(messages);
      if (!shouldCompact(estimate.tokens, contextWindow, settings)) return notCompacted;

      if (!this.options.summarize) {
        logger.warn(
          `Compaction threshold crossed (${estimate.tokens} > ${contextWindow - settings.reserveTokens}) but no summarize() was configured; compaction action skipped.`,
          'HarnessSessionManager.maybeCompact',
        );
        return notCompacted;
      }

      const cutoff = pickCompactionCutoff(messages as EstimableMessage[], settings.keepRecentTokens);
      const toHide = entries.slice(0, cutoff);
      if (toHide.length === 0) {
        // 整段都在 keepRecentTokens 预算内(如单条巨型消息):没有可折叠的旧内容。
        logger.warn('Compaction threshold crossed but nothing old enough to fold; skipped.', 'HarnessSessionManager.maybeCompact');
        return notCompacted;
      }

      const summaryText = await this.options.summarize(buildCompactionPrompt(messages.slice(0, cutoff)));
      await entry.session.applyCompaction(toHide.map((e) => e.id), summaryText);
      logger.info(
        `Auto-compacted session for conversation ${conversationId}: folded ${toHide.length} entries (${estimate.tokens} ctx tokens > window ${contextWindow}).`,
        'HarnessSessionManager.maybeCompact',
      );
      return { compacted: true, foldedEntryCount: toHide.length };
    } catch {
      // summarize() 失败、或阈值边界估算偏差。压缩是优化,静默降级。
      logger.warn('Auto-compaction skipped due to an error.', 'HarnessSessionManager.maybeCompact');
      return notCompacted;
    }
  }

  private async resolveSavedRef(conversationId: string): Promise<PersistedSessionRef | null> {
    if (!this.options.loadRef) return null;
    try {
      return (await this.options.loadRef(conversationId)) ?? null;
    } catch {
      return null;
    }
  }

  private async persistRef(conversationId: string, ref: PersistedSessionRef | null): Promise<void> {
    if (!this.options.saveRef) return;
    try {
      await this.options.saveRef(conversationId, ref);
    } catch {
      logger.warn('Failed to persist session ref', 'HarnessSessionManager.persistRef');
    }
  }
}

/** 把消息内容折叠成纯文本,供摘要 prompt 拼接(与 projector 的折叠规则一致)。 */
function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'toolCall' && typeof b.name === 'string') parts.push(`[tool: ${b.name}]`);
  }
  return parts.join('');
}

/** 构造压缩摘要的 prompt(与升级前「摘要走应用自己的 provider」一致,不引入新依赖)。 */
function buildCompactionPrompt(messages: Array<{ role: string; content: unknown }>): string {
  const transcript = messages
    .map((message) => `${message.role}: ${messageContentToText(message.content)}`)
    .filter((line) => line.trim().length > 0)
    .join('\n');
  return [
    '请把以下对话历史压缩成一段简洁的摘要,保留关键事实、已做出的决定与尚未完成的事项,',
    '供后续对话继续引用(不要加入这段指令之外的额外内容)：',
    '',
    transcript,
  ].join('\n');
}
