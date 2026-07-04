import { logger } from '../../utils/logger';
import type { VaultFileAdapter } from './vault-session-fs';
import { VaultSessionFileSystem } from './vault-session-fs';

/**
 * pi Session / Repo 的最小结构契约(type-only,避免静态 value import;
 * pi 是 ESM-only,运行时经动态 import 构造)。
 */
interface PiSession {
  getMetadata(): Promise<{ id: string; path: string }>;
  getBranch(fromId?: string): Promise<unknown[]>;
  buildContext(): Promise<{ messages: unknown[] }>;
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
  /** 读取上次持久化的会话引用(跨重启恢复)。 */
  loadRef?: () => Promise<PersistedSessionRef | null> | PersistedSessionRef | null;
  /** 保存当前会话引用,便于下次启动恢复。 */
  saveRef?: (ref: PersistedSessionRef | null) => Promise<void> | void;
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

/**
 * Harness 会话生命周期管理器(取代旧的 SessionStore)。
 *
 * 与 SessionStore 的本质区别:不再自己 append 消息/自己拼摘要 prompt。
 * AgentHarness 的 prompt() 已经把 user/assistant 追加进它持有的这个 session,
 * 跨轮上下文由 Harness 从 session buildContext 派生。本管理器只负责:
 * - open-or-create:启动时按持久化 ref 恢复,否则新建长生命会话。
 * - getSession:把这个长生命 session 交给每轮构造的 Harness 复用(探针已验证跨实例可见历史)。
 * - maybeCompact:每轮结束后按真实 usage 判断阈值,超了就调 harness.compact()
 *   (pi 的 compact() 用真实 provider,复用 Harness 的 getApiKeyAndHeaders,无需自己拼摘要)。
 * - clear:开一个全新会话文件(旧文件保留,便于回溯)。
 *
 * 移动端约束:落盘走注入的 VaultFileAdapter,不碰 node fs。
 */
export class HarnessSessionManager {
  private readonly fileSystem: VaultSessionFileSystem;
  private readonly sessionsRoot: string;
  private readonly cwd: string;
  private repoPromise: Promise<PiSessionRepo> | null = null;
  private compactionHelpersPromise: Promise<any> | null = null;
  private session: PiSession | null = null;
  private ref: PersistedSessionRef | null = null;

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

  /** 确保有一个活跃会话:优先恢复持久化 ref,失败则新建。幂等。 */
  async ready(): Promise<void> {
    if (this.session) return;
    const repo = await this.getRepo();

    const savedRef = await this.resolveSavedRef();
    if (savedRef) {
      try {
        this.session = await repo.open({
          id: savedRef.id,
          path: savedRef.path,
          createdAt: savedRef.createdAt,
          cwd: savedRef.cwd,
        });
        this.ref = savedRef;
        return;
      } catch {
        logger.warn(
          `Failed to reopen persisted session ${savedRef.path}; creating a fresh one.`,
          'HarnessSessionManager.ready',
        );
      }
    }
    await this.createFreshSession(repo);
  }

  /** 返回长生命 session,交给每轮 Harness 复用。调用前保证 ready()。 */
  async getSession(): Promise<PiSession> {
    await this.ready();
    return this.session!;
  }

  /** 当前会话引用(诊断/外部持久化)。 */
  getRef(): PersistedSessionRef | null {
    return this.ref;
  }

  /**
   * 会话是否已有跨轮历史(至少一条消息)。供短确认/延续判定使用。
   * 出错时保守返回 false(视为无历史,不剔除上下文)。
   */
  async hasHistory(): Promise<boolean> {
    try {
      await this.ready();
      const context = await this.session!.buildContext();
      return (context.messages?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** 清空会话:开一个全新会话文件(旧文件保留)。 */
  async clear(): Promise<void> {
    const repo = await this.getRepo();
    await this.createFreshSession(repo);
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
  async maybeCompact(harness: CompactableHarness): Promise<void> {
    const contextWindow = this.options.contextWindow?.() ?? 0;
    if (contextWindow <= 0 || !this.session) return;

    try {
      const mod = await this.getCompactionHelpers();
      const settings: CompactionSettings = {
        ...mod.DEFAULT_COMPACTION_SETTINGS,
        ...this.options.compactionSettings,
      };
      if (!settings.enabled) return;

      const entries = await this.session.getBranch();
      const messages = mod.buildSessionContext(entries).messages;
      const estimate = mod.estimateContextTokens(messages);
      const tokens = typeof estimate === 'number' ? estimate : estimate?.tokens ?? 0;
      if (!mod.shouldCompact(tokens, contextWindow, settings)) return;

      await harness.compact();
      logger.info(
        `Auto-compacted session: ${tokens} ctx tokens > window ${contextWindow}.`,
        'HarnessSessionManager.maybeCompact',
      );
    } catch {
      // compact() 在无可压缩内容时会抛 "Nothing to compact";或阈值边界估算偏差。
      // 压缩是优化,静默降级。
      logger.warn('Auto-compaction skipped due to an error.', 'HarnessSessionManager.maybeCompact');
    }
  }

  private async resolveSavedRef(): Promise<PersistedSessionRef | null> {
    if (!this.options.loadRef) return null;
    try {
      return (await this.options.loadRef()) ?? null;
    } catch {
      return null;
    }
  }

  private async createFreshSession(repo: PiSessionRepo): Promise<void> {
    const session = await repo.create({ cwd: this.cwd });
    const meta = await session.getMetadata();
    this.session = session;
    this.ref = {
      id: meta.id,
      path: meta.path,
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
    };
    await this.persistRef();
  }

  private async persistRef(): Promise<void> {
    if (!this.options.saveRef) return;
    try {
      await this.options.saveRef(this.ref);
    } catch {
      logger.warn('Failed to persist session ref', 'HarnessSessionManager.persistRef');
    }
  }
}
