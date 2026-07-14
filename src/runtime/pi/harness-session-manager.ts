import { logger } from '../../utils/logger';
import type { VaultFileAdapter } from './vault-session-fs';
import { VaultSessionFileSystem } from './vault-session-fs';
import { SUPERSEDED_LABEL } from './session-branch-projector';

/**
 * pi Session / Repo 的最小结构契约(type-only,避免静态 value import;
 * pi 是 ESM-only,运行时经动态 import 构造)。
 */
interface PiSessionTreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: { role: string; content: unknown };
  targetId?: string;
  label?: string;
}

interface PiSession {
  getMetadata(): Promise<{ id: string; path: string }>;
  getBranch(fromId?: string): Promise<PiSessionTreeEntry[]>;
  getEntries(): Promise<PiSessionTreeEntry[]>;
  getEntry(id: string): Promise<PiSessionTreeEntry | undefined>;
  getLeafId(): Promise<string | null>;
  moveTo(entryId: string | null): Promise<string | undefined>;
  appendLabel(targetId: string, label: string | undefined): Promise<string>;
  buildContext(): Promise<{ messages: unknown[] }>;
  // custom_message entry:对模型可见(buildSessionContext→convertToLlm 转成 user 消息),
  // 但 UI 的分支投影(projectBranchToMessages)只认 type==='message',会跳过它,
  // 故不会在分叉/重开时渲染成假 user 气泡。用于回灌审批执行结果(见 appendApprovalOutcome)。
  appendCustomMessageEntry(
    customType: string,
    content: string,
    display: boolean,
    details?: unknown,
  ): Promise<string>;
}

interface PiSessionRepo {
  create(options: { cwd: string; id?: string }): Promise<PiSession>;
  open(metadata: { id: string; path: string; createdAt?: string; cwd?: string }): Promise<PiSession>;
}

/** pi 压缩阈值与保留预算(对齐 pi CompactionSettings,避免 value import)。 */
interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** Harness 上「可压缩」的最小接口(只用到 compact 与是否 idle)。 */
export interface CompactableHarness {
  compact(customInstructions?: string): Promise<unknown>;
}

/** 持久化的会话引用(存进插件 data,跨重启恢复)。 */
export interface PersistedSessionRef {
  id: string;
  path: string;
  createdAt: string;
  cwd: string;
}

export interface HarnessSessionManagerOptions {
  /** 会话文件根目录(vault 相对,隐藏目录)。 */
  sessionsRoot?: string;
  /** cwd 标识,用于 pi 的会话目录分桶。单 vault 固定即可。 */
  cwd?: string;
  /** 读取某会话上次持久化的引用(跨重启恢复)。按 conversationId 分别存取。 */
  loadRef?: (conversationId: string) => Promise<PersistedSessionRef | null> | PersistedSessionRef | null;
  /** 保存某会话的当前引用,便于下次启动恢复。ref 为 null 表示清除该会话的持久引用。 */
  saveRef?: (conversationId: string, ref: PersistedSessionRef | null) => Promise<void> | void;
  /**
   * 当前模型的上下文窗口(token),用于自动压缩阈值判定。
   * 用 getter:settings 可运行期改动,每次判定取最新值。返回 0/未提供时关闭自动压缩。
   */
  contextWindow?: () => number;
  /** 压缩阈值/保留预算覆盖;缺省用 pi 的 DEFAULT_COMPACTION_SETTINGS。 */
  compactionSettings?: Partial<CompactionSettings>;
}

const DEFAULT_SESSIONS_ROOT = '.obsidian/baizer-sessions';
const DEFAULT_CWD = '/';

/** 单个会话(conversation)的活跃 session 与其持久引用。 */
interface ConversationEntry {
  session: PiSession;
  ref: PersistedSessionRef;
}

/**
 * Harness 会话生命周期管理器(取代旧的 SessionStore)。
 *
 * 与 SessionStore 的本质区别:不再自己 append 消息/自己拼摘要 prompt。
 * AgentHarness 的 prompt() 已经把 user/assistant 追加进它持有的这个 session,
 * 跨轮上下文由 Harness 从 session buildContext 派生。本管理器只负责:
 * - open-or-create:按 conversationId 恢复持久化 ref,否则新建长生命会话。
 * - getSession(conversationId):把该会话的长生命 session 交给每轮 Harness 复用。
 * - maybeCompact:每轮结束后按真实 usage 判断阈值,超了就调 harness.compact()。
 * - clear(conversationId):为该会话开一个全新会话文件(旧文件保留,便于回溯)。
 *
 * per-conversation 隔离(阶段A):内部维护 Map<conversationId, ConversationEntry>,
 * 共享同一个 JsonlSessionRepo。不同 conversationId(= UI tab.id)派生各自独立的跨轮上下文,
 * 修掉旧版「多 tab 共享单 session 串台」的隐患。
 *
 * conversationId 缺省(undefined):后台/一次性调用(file-back、/edit 等)不需要跨轮记忆,
 * 此时不落该 Map、每次新建内存临时会话,天然无持久、无跨轮上下文。
 *
 * 移动端约束:落盘走注入的 VaultFileAdapter,不碰 node fs。
 */
export class HarnessSessionManager {
  private readonly fileSystem: VaultSessionFileSystem;
  private readonly sessionsRoot: string;
  private readonly cwd: string;
  private repoPromise: Promise<PiSessionRepo> | null = null;
  private compactionHelpersPromise: Promise<any> | null = null;
  /** 每个 conversationId 对应的活跃 session。 */
  private readonly conversations = new Map<string, ConversationEntry>();
  /** 同一 conversationId 的并发 ready 去重(同会话两轮竞态时只建一次)。 */
  private readonly readyPromises = new Map<string, Promise<ConversationEntry>>();

  constructor(
    adapter: VaultFileAdapter,
    private readonly options: HarnessSessionManagerOptions = {},
  ) {
    this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.fileSystem = new VaultSessionFileSystem(adapter, this.cwd);
  }

  private async getRepo(): Promise<PiSessionRepo> {
    if (!this.repoPromise) {
      this.repoPromise = (async () => {
        const mod = (await import('@earendil-works/pi-agent-core')) as any;
        return new mod.JsonlSessionRepo({ fs: this.fileSystem, sessionsRoot: this.sessionsRoot }) as PiSessionRepo;
      })();
    }
    return this.repoPromise;
  }

  private async getCompactionHelpers(): Promise<any> {
    if (!this.compactionHelpersPromise) {
      this.compactionHelpersPromise = import('@earendil-works/pi-agent-core');
    }
    return this.compactionHelpersPromise;
  }

  /**
   * 确保某会话有一个活跃 session:优先按 conversationId 恢复持久化 ref,失败则新建。幂等。
   * 同 conversationId 的并发调用共享同一 Promise,避免竞态下重复建会话。
   */
  private async ensureConversation(conversationId: string): Promise<ConversationEntry> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;

    const inFlight = this.readyPromises.get(conversationId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const repo = await this.getRepo();
      const savedRef = await this.resolveSavedRef(conversationId);
      if (savedRef) {
        try {
          const session = await repo.open({
            id: savedRef.id,
            path: savedRef.path,
            createdAt: savedRef.createdAt,
            cwd: savedRef.cwd,
          });
          const entry: ConversationEntry = { session, ref: savedRef };
          this.conversations.set(conversationId, entry);
          return entry;
        } catch {
          logger.warn(
            `Failed to reopen persisted session ${savedRef.path} for conversation ${conversationId}; creating a fresh one.`,
            'HarnessSessionManager.ensureConversation',
          );
        }
      }
      return this.createFreshSession(repo, conversationId);
    })();

    this.readyPromises.set(conversationId, promise);
    try {
      return await promise;
    } finally {
      this.readyPromises.delete(conversationId);
    }
  }

  /**
   * 返回该会话的长生命 session,交给每轮 Harness 复用。
   * conversationId 缺省时返回一个不持久、不入 Map 的内存临时会话(后台/一次性调用)。
   */
  async getSession(conversationId?: string): Promise<PiSession> {
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
   * 某会话是否已有跨轮历史(至少一条消息)。供短确认/延续判定使用。
   * conversationId 缺省(临时会话)恒为 false。出错时保守返回 false(视为无历史,不剔除上下文)。
   */
  async hasHistory(conversationId?: string): Promise<boolean> {
    if (!conversationId) return false;
    try {
      const entry = await this.ensureConversation(conversationId);
      const context = await entry.session.buildContext();
      return (context.messages?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** 清空某会话:开一个全新会话文件(旧文件保留)。conversationId 缺省时无操作。 */
  async clear(conversationId?: string): Promise<void> {
    if (!conversationId) return;
    const repo = await this.getRepo();
    await this.createFreshSession(repo, conversationId);
  }

  /** 释放某会话的内存态(如关闭 tab)。不删磁盘文件,持久 ref 保留,下次可恢复。 */
  release(conversationId: string): void {
    this.conversations.delete(conversationId);
    this.readyPromises.delete(conversationId);
  }

  /**
   * 彻底销毁某会话:删磁盘 JSONL session 文件 + 清持久 ref + 释放内存态。
   * 用于「删除历史对话」——与 release(仅释放内存、保留可回溯)、clear(开新文件、旧文件留存)不同,
   * 这是用户显式删除,不应在盘上留孤儿文件或残留 ref(既是磁盘泄漏,也是隐私:JSONL 存对话原文)。
   *
   * 优先用当前活跃/持久 ref 的 path 定位文件;取不到 ref 时静默跳过删文件(仍清 ref、释放内存)。
   * 删文件失败不抛——尽力而为,ref 已清则重启不会再引用它。
   * conversationId 缺省时无操作(临时会话无持久文件)。
   */
  async purge(conversationId: string | undefined): Promise<void> {
    if (!conversationId) return;
    // 先解析出该会话的持久 ref(内存有就用,没有走 loadRef 兜底),拿到磁盘 path。
    const ref = this.conversations.get(conversationId)?.ref
      ?? await this.resolveSavedRef(conversationId);

    // 释放内存态,避免后续再被 getSession 复用到已删文件。
    this.conversations.delete(conversationId);
    this.readyPromises.delete(conversationId);

    if (ref?.path) {
      try {
        const result = await this.fileSystem.remove(ref.path, { force: true });
        if (!result.ok) {
          logger.warn(
            `Failed to remove session file ${ref.path} for conversation ${conversationId}.`,
            'HarnessSessionManager.purge',
          );
        }
      } catch {
        logger.warn(
          `Error removing session file ${ref.path} for conversation ${conversationId}.`,
          'HarnessSessionManager.purge',
        );
      }
    }

    // 清持久 ref(ref=null 表示删除该会话的引用),使重启后不再尝试恢复。
    await this.persistRef(conversationId, null);
  }

  /**
   * 把一次「用户批准并已执行」的动作结果回灌进该会话的 pi session。
   *
   * 背景:审批轮在 afterToolCall 里 terminate 结束,session 中只留下
   * assistant(tool_call) + toolResult(approval_required 占位);用户随后点批准是在
   * runtime 之外直执工具,结果此前只进 UI,从不入 session。由于跨轮上下文的唯一真相源
   * 是 session(UI 历史不再回灌),下一轮模型因此看不到「批准了、文件已建/失败」而失忆。
   *
   * 用 appendCustomMessageEntry 追加(而非再补一条 toolResult):原 tool_call 已有配对的
   * 占位 toolResult,不能对同一 call 再给第二个结果。custom_message 对模型可见(转成 user 消息)、
   * 对 UI 分支投影不可见(不渲染假气泡),正好承载这条带外的执行结果。
   *
   * conversationId 缺省(临时会话)或会话未建立时:无持久 session 可写,静默跳过。
   * 任何异常吞掉——回灌是增强,不能让「已成功执行的动作」因记账失败而看起来失败。
   */
  async appendApprovalOutcome(conversationId: string | undefined, text: string): Promise<void> {
    if (!conversationId) return;
    const trimmed = text?.trim();
    if (!trimmed) return;
    const entry = this.conversations.get(conversationId);
    if (!entry) return;
    try {
      await entry.session.appendCustomMessageEntry('approval_outcome', trimmed, false);
    } catch {
      logger.warn(
        `Failed to append approval outcome to session for conversation ${conversationId}.`,
        'HarnessSessionManager.appendApprovalOutcome',
      );
    }
  }

  // ---- 阶段C:分支导航原语(都基于该会话持有的 session 对象)----

  /**
   * 取该会话「当前活跃分支」的 entries(root→leaf)与全量 entries,供 projector 投影。
   * 无 conversationId 或未建立时返回空。
   */
  async getBranchEntries(
    conversationId?: string,
  ): Promise<{ branch: PiSessionTreeEntry[]; all: PiSessionTreeEntry[] }> {
    if (!conversationId) return { branch: [], all: [] };
    const entry = await this.ensureConversation(conversationId);
    const [branch, all] = await Promise.all([
      entry.session.getBranch(),
      entry.session.getEntries(),
    ]);
    return { branch, all };
  }

  /**
   * 切换活跃分支:把 leaf 移到 targetLeafEntryId(某兄弟子树的叶子)。不生成分支摘要。
   * 返回是否成功(目标不存在时 false)。切换后跨轮上下文即从新分支派生。
   */
  async moveToBranch(conversationId: string, targetLeafEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(targetLeafEntryId);
    if (!target) return false;
    await entry.session.moveTo(targetLeafEntryId);
    return true;
  }

  /**
   * 为「从某条 user 消息重跑/编辑」定位:把 leaf 移到该 user entry 的 parentId
   * (即该 user 之前)。之后走正常 chatStream,新的 prompt 会在同一 parent 下 append,
   * 与原 user 成为兄弟分支,原分支完整保留。
   *
   * 首条 user 消息的 parentId 为 null → moveTo(null) 回到 root(空历史),符合「编辑首条消息」语义。
   * 返回是否成功(entry 不存在或非 user 消息时 false)。
   */
  async prepareForkAtUser(conversationId: string, userEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(userEntryId);
    if (!target || target.type !== 'message' || target.message?.role !== 'user') return false;
    await entry.session.moveTo(target.parentId);
    return true;
  }

  /**
   * 给某条 user 消息打「重试作废」标记(阶段C 语义:重试=换掉旧答案、不保留旧分支)。
   * projector 枚举兄弟分支时会过滤掉被标记者,于是重试后有效兄弟只剩新的一条。
   * 与 prepareForkAtUser 配合:重试 = supersede 旧 user + prepareForkAtUser + 重跑。
   */
  async supersedeUserEntry(conversationId: string, userEntryId: string): Promise<boolean> {
    const entry = await this.ensureConversation(conversationId);
    const target = await entry.session.getEntry(userEntryId);
    if (!target || target.type !== 'message' || target.message?.role !== 'user') return false;
    await entry.session.appendLabel(userEntryId, SUPERSEDED_LABEL);
    return true;
  }

  /** 构造一个不持久、不入 Map 的内存临时会话(供 conversationId 缺省的一次性调用)。 */
  private async createEphemeralSession(): Promise<PiSession> {
    const pi = (await import('@earendil-works/pi-agent-core')) as any;
    return new pi.InMemorySessionRepo().create({}) as Promise<PiSession>;
  }

  /**
   * 每轮结束后的自动压缩:上下文 token 超过 (contextWindow - reserveTokens) 时,
   * 调 harness.compact() 把早期历史摘要成一条压缩条目。
   *
   * 复用 pi 的 shouldCompact + estimateContextTokens(优先真实 provider usage,
   * Harness 落盘的 assistant 消息带真实 usage,故估算准确)。
   * compact() 本身不自检阈值,故必须在此先判定;空历史时 compact() 会抛,故仅在 shouldCompact 为真时调。
   * 失败不抛出:压缩是优化而非正确性前提,失败仅记告警,下一轮再试。
   */
  async maybeCompact(harness: CompactableHarness, conversationId?: string): Promise<void> {
    const contextWindow = this.options.contextWindow?.() ?? 0;
    if (contextWindow <= 0) return;
    // 临时会话不压缩(无持久、无跨轮);未建立的会话跳过。
    const entry = conversationId ? this.conversations.get(conversationId) : undefined;
    if (!entry) return;

    try {
      const mod = await this.getCompactionHelpers();
      const settings: CompactionSettings = {
        ...mod.DEFAULT_COMPACTION_SETTINGS,
        ...this.options.compactionSettings,
      };
      if (!settings.enabled) return;

      // 防呆:pi shouldCompact = tokens > (contextWindow - reserveTokens)。若用户配置的
      // contextWindow 小于等于 reserveTokens,阈值为负/零,会让压缩每轮无意义触发。
      // 此时直接跳过(这么小的窗口下压缩无收益,只会反复摘要极小上下文)。
      if (contextWindow <= settings.reserveTokens) return;

      const entries = await entry.session.getBranch();
      const messages = mod.buildSessionContext(entries).messages;
      const estimate = mod.estimateContextTokens(messages);
      const tokens = typeof estimate === 'number' ? estimate : estimate?.tokens ?? 0;
      if (!mod.shouldCompact(tokens, contextWindow, settings)) return;

      await harness.compact();
      logger.info(
        `Auto-compacted session for conversation ${conversationId}: ${tokens} ctx tokens > window ${contextWindow}.`,
        'HarnessSessionManager.maybeCompact',
      );
    } catch {
      // compact() 在无可压缩内容时会抛 "Nothing to compact";或阈值边界估算偏差。
      // 压缩是优化,静默降级。
      logger.warn('Auto-compaction skipped due to an error.', 'HarnessSessionManager.maybeCompact');
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

  private async createFreshSession(repo: PiSessionRepo, conversationId: string): Promise<ConversationEntry> {
    const session = await repo.create({ cwd: this.cwd });
    const meta = await session.getMetadata();
    const ref: PersistedSessionRef = {
      id: meta.id,
      path: meta.path,
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
    };
    const entry: ConversationEntry = { session, ref };
    this.conversations.set(conversationId, entry);
    await this.persistRef(conversationId, ref);
    return entry;
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
