import type { PriorChatMessage } from '../../models/interfaces';
import { logger } from '../../utils/logger';
import { VaultSessionFileSystem, type VaultFileAdapter } from './vault-session-fs';

/**
 * pi 的 Session 与 AgentMessage 的最小结构契约（type-only，避免静态 value import）。
 * 运行时实例由 JsonlSessionRepo 经动态 import 构造。
 */
interface PiAgentMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

interface PiSessionContext {
  messages: PiAgentMessage[];
}

interface PiSession {
  getMetadata(): Promise<{ id: string; path: string }>;
  appendMessage(message: PiAgentMessage): Promise<string>;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): Promise<string>;
  buildContext(): Promise<PiSessionContext>;
  getBranch(fromId?: string): Promise<unknown[]>;
}

interface PiSessionRepo {
  create(options: { cwd: string; id?: string }): Promise<PiSession>;
  open(metadata: { id: string; path: string; createdAt?: string; cwd?: string }): Promise<PiSession>;
}

/** pi 压缩阈值与保留预算（与 pi 的 CompactionSettings 结构对齐，避免 value import）。 */
interface CompactionSettings {
  /** 是否启用自动压缩。 */
  enabled: boolean;
  /** 为摘要 prompt 与输出预留的 token。 */
  reserveTokens: number;
  /** 压缩后大致保留的近期 token 数。 */
  keepRecentTokens: number;
}

/**
 * pi 压缩工具集（经动态 import 取得，复用 pi 成熟的 cut-point/token 估算逻辑）。
 * 摘要文本的生成不走 pi 的 compact()（它会绕过 bridge 直连 provider），
 * 而是把待压缩消息序列化后交给注入的 summarize 回调（=上层自己的 provider）。
 */
interface PiCompactionHelpers {
  buildSessionContext(entries: unknown[]): { messages: unknown[] };
  estimateTokens(message: unknown): number;
  shouldCompact(tokens: number, contextWindow: number, settings: CompactionSettings): boolean;
  prepareCompaction(
    entries: unknown[],
    settings: CompactionSettings,
  ): { ok: true; value?: PiCompactionPreparation } | { ok: false; error: unknown };
  convertToLlm(messages: unknown[]): unknown[];
  serializeConversation(messages: unknown[]): string;
  defaultSettings: CompactionSettings;
}

interface PiCompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
}

/** 摘要器：把待压缩对话文本交给上层 provider，返回结构化摘要。 */
export type SessionSummarizer = (prompt: string, systemPrompt?: string) => Promise<string>;

const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Read the conversation between a user and an AI assistant, '
  + 'then produce a concise structured checkpoint summary. Do NOT continue the conversation and do NOT '
  + 'answer any question inside it. Output ONLY the summary.';

/** 把序列化后的对话包成摘要 prompt（含上一轮摘要以支持迭代更新）。 */
function buildSummarizationPrompt(conversationText: string, previousSummary?: string): string {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary?.trim()) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  prompt +=
    'Summarize the conversation above into a concise checkpoint another assistant can use to continue '
    + 'the work. Preserve the goal, key decisions, constraints, exact file paths, function names, error '
    + 'messages, and next steps. Output only the summary.';
  return prompt;
}

/** SessionStore 持久化所需的元信息，由插件 data 跨重启保存。 */
export interface PersistedSessionRef {
  id: string;
  path: string;
  createdAt: string;
  cwd: string;
}

export interface SessionStoreOptions {
  /** 会话文件根目录（vault 相对，隐藏目录）。 */
  sessionsRoot?: string;
  /** cwd 标识，用于 pi 的会话目录分桶。单 vault 固定即可。 */
  cwd?: string;
  /** 读取上次持久化的会话引用（跨重启恢复）。 */
  loadRef?: () => Promise<PersistedSessionRef | null> | PersistedSessionRef | null;
  /** 保存当前会话引用，便于下次启动恢复。 */
  saveRef?: (ref: PersistedSessionRef | null) => Promise<void> | void;
  /**
   * 当前模型的上下文窗口（token），用于自动压缩阈值判定。
   * 用 getter 而非定值：settings 可在运行期改动（切模型/改配置），每次判定取最新值。
   * 返回 0/未提供时关闭自动压缩。
   */
  contextWindow?: () => number;
  /**
   * 摘要生成器：把待压缩对话交给上层 provider 生成摘要。
   * 不提供时关闭自动压缩（pi 自带的 compact() 会绕过 bridge，不复用）。
   */
  summarize?: SessionSummarizer;
  /** 压缩阈值/保留预算覆盖；缺省用 pi 的 DEFAULT_COMPACTION_SETTINGS。 */
  compactionSettings?: Partial<CompactionSettings>;
}

const DEFAULT_SESSIONS_ROOT = '.obsidian/baizer-sessions';
const DEFAULT_CWD = '/';

/**
 * Session 持久化层：把每条聊天落盘为一个 JSONL 会话文件，跨轮上下文与压缩在此闭环。
 *
 * 核心职责：
 * - open-or-create：启动时根据持久化的 ref 恢复会话，否则新建。
 * - appendTurn：每轮把 user / assistant 原文落盘（串行化，防并发交错损坏 JSONL）。
 * - buildPriorMessages：从会话派生跨轮历史，替代 UI 手工回灌。
 * - clearSession：开新会话文件（旧文件保留，便于历史回溯）。
 *
 * 移动端约束：所有落盘走注入的 VaultFileAdapter（app.vault.adapter），不碰 node fs。
 * pi 的 JsonlSessionRepo 经动态 import 构造（pi 仅暴露 ESM import 条件）。
 */
export class SessionStore {
  private readonly fileSystem: VaultSessionFileSystem;
  private readonly sessionsRoot: string;
  private readonly cwd: string;
  private repoPromise: Promise<PiSessionRepo> | null = null;
  private compactionPromise: Promise<PiCompactionHelpers> | null = null;
  private session: PiSession | null = null;
  private ref: PersistedSessionRef | null = null;
  /** 每会话写入互斥：串行化 appendMessage / appendCompaction，避免并发交错。 */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    adapter: VaultFileAdapter,
    private readonly options: SessionStoreOptions = {},
  ) {
    this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.fileSystem = new VaultSessionFileSystem(adapter, this.cwd);
  }

  /** 懒加载 pi 的 JsonlSessionRepo（动态 import 规避 CJS/ESM 解析问题）。 */
  private async getRepo(): Promise<PiSessionRepo> {
    if (!this.repoPromise) {
      this.repoPromise = (async () => {
        const mod = await import('@earendil-works/pi-agent-core');
        const Repo = (mod as any).JsonlSessionRepo;
        return new Repo({ fs: this.fileSystem, sessionsRoot: this.sessionsRoot }) as PiSessionRepo;
      })();
    }
    return this.repoPromise;
  }

  /** 懒加载 pi 的压缩工具集（cut-point/token 估算/序列化），动态 import 规避 CJS/ESM 解析。 */
  private async getCompactionHelpers(): Promise<PiCompactionHelpers> {
    if (!this.compactionPromise) {
      this.compactionPromise = (async () => {
        const mod = (await import('@earendil-works/pi-agent-core')) as any;
        return {
          buildSessionContext: mod.buildSessionContext,
          estimateTokens: mod.estimateTokens,
          shouldCompact: mod.shouldCompact,
          prepareCompaction: mod.prepareCompaction,
          convertToLlm: mod.convertToLlm,
          serializeConversation: mod.serializeConversation,
          defaultSettings: mod.DEFAULT_COMPACTION_SETTINGS,
        } as PiCompactionHelpers;
      })();
    }
    return this.compactionPromise;
  }

  /**
   * 确保有一个活跃会话：优先恢复持久化的 ref，恢复失败则新建。
   * 幂等：已就绪时直接返回。
   */
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
      } catch (error) {
        // 文件被删/损坏：降级为新建，不阻断聊天。
        logger.warn(
          `Failed to reopen persisted session ${savedRef.path}; creating a fresh one.`,
          'SessionStore.ready',
        );
      }
    }

    await this.createFreshSession(repo);
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
    } catch (error) {
      logger.warn('Failed to persist session ref', 'SessionStore.persistRef');
    }
  }

  /** 当前会话引用（用于诊断 / 外部持久化）。 */
  getRef(): PersistedSessionRef | null {
    return this.ref;
  }

  /** 串行化写入，保证同一会话的 append 顺序与原子性。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    // 链上吞掉错误，避免一次失败卡死后续写入；调用方仍能拿到本次的 rejection。
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 追加一条用户消息（落盘）。 */
  async appendUserMessage(content: string): Promise<void> {
    if (!content?.trim()) return;
    await this.ready();
    await this.enqueue(async () => {
      await this.session!.appendMessage(toUserMessage(content));
    });
  }

  /** 追加一条助手回答（落盘）。 */
  async appendAssistantMessage(content: string): Promise<void> {
    if (!content?.trim()) return;
    await this.ready();
    await this.enqueue(async () => {
      await this.session!.appendMessage(toAssistantMessage(content));
    });
  }

  /**
   * 轮次结束时追加 user + assistant 一对消息（落盘）。
   * 在 base-chat-runtime 的 retainCompletedTurn 钩子里调用。
   * 落盘后尝试自动压缩：上下文超过窗口预算时，把早期历史摘要成一条压缩条目。
   */
  async appendTurn(userMessage: string, assistantMessage: string): Promise<void> {
    await this.appendUserMessage(userMessage);
    await this.appendAssistantMessage(assistantMessage);
    await this.maybeCompact();
  }

  /**
   * 从会话派生跨轮历史，作为下一轮 priorMessages。
   * 经 buildContext() 取得压缩视图（摘要 + 保留尾部），过滤为 user/model 纯文本。
   */
  async buildPriorMessages(): Promise<PriorChatMessage[]> {
    await this.ready();
    const context = await this.session!.buildContext();
    return mapContextToPriorMessages(context.messages);
  }

  /**
   * 清空会话：开一个全新的会话文件。
   * 旧文件保留在磁盘上（便于历史回溯），仅切换活跃会话与持久化 ref。
   */
  async clearSession(): Promise<void> {
    const repo = await this.getRepo();
    // 等待在途写入完成，避免新旧会话写入交错。
    await this.writeChain.catch(() => undefined);
    await this.createFreshSession(repo);
  }

  /**
   * 追加一条压缩条目（摘要 + 保留起点），落盘。
   * 摘要由上层用自己的 provider 生成后传入（pi 的 compact() 会绕过 bridge，不复用）。
   */
  async appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<void> {
    await this.ready();
    await this.enqueue(async () => {
      await this.session!.appendCompaction(summary, firstKeptEntryId, tokensBefore);
    });
  }

  /** 取当前分支的原始 entry 列表（供压缩判定使用）。 */
  async getBranchEntries(): Promise<unknown[]> {
    await this.ready();
    return this.session!.getBranch();
  }

  /**
   * 自动压缩：上下文 token 超过 (contextWindow - reserveTokens) 时，
   * 把早期历史交给上层 provider 摘要，落盘为一条压缩条目，保留近期尾部。
   *
   * 复用 pi 的 prepareCompaction 做 cut-point 与 token 估算，
   * 但摘要文本用注入的 summarize 回调生成（pi 的 compact() 直连 provider、绕过 bridge，不复用）。
   *
   * 任一前置条件缺失（无 contextWindow / 无 summarize）即关闭，静默跳过。
   * 失败不抛出：压缩是优化而非正确性前提，失败仅记告警，下一轮会再尝试。
   */
  private async maybeCompact(): Promise<void> {
    const contextWindow = this.options.contextWindow?.() ?? 0;
    const summarize = this.options.summarize;
    if (!summarize || contextWindow <= 0) return;

    try {
      const helpers = await this.getCompactionHelpers();
      const settings: CompactionSettings = {
        ...helpers.defaultSettings,
        ...this.options.compactionSettings,
      };
      if (!settings.enabled) return;

      const entries = await this.getBranchEntries();
      const messages = helpers.buildSessionContext(entries).messages;
      // 注意：不用 pi 的 estimateContextTokens——它优先信任 assistant.usage.totalTokens，
      // 而我们的 bridge 落盘的 usage 全为 0（无真实 provider 计数），会让阈值判定恒为假。
      // 改用 pi 的 estimateTokens 逐条按内容字符估算（保守且与 bridge 现实一致）。
      const tokens = messages.reduce((sum, msg) => sum + helpers.estimateTokens(msg), 0);
      if (!helpers.shouldCompact(tokens, contextWindow, settings)) return;

      const prepared = helpers.prepareCompaction(entries, settings);
      if (!prepared.ok || !prepared.value) return;

      const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, tokensBefore, previousSummary } =
        prepared.value;
      const toSummarize = [...messagesToSummarize, ...turnPrefixMessages];
      if (toSummarize.length === 0) return;

      const conversationText = helpers.serializeConversation(helpers.convertToLlm(toSummarize));
      const summary = (
        await summarize(buildSummarizationPrompt(conversationText, previousSummary), SUMMARIZATION_SYSTEM_PROMPT)
      )?.trim();
      if (!summary) return;

      await this.appendCompaction(summary, firstKeptEntryId, tokensBefore);
      logger.info(
        `Auto-compacted session: ${tokens} ctx tokens > window ${contextWindow}; kept from ${firstKeptEntryId}.`,
        'SessionStore.maybeCompact',
      );
    } catch (error) {
      logger.warn('Auto-compaction skipped due to an error.', 'SessionStore.maybeCompact');
    }
  }
}

/** 构造 pi 的 UserMessage（content 用纯字符串，timestamp 必填）。 */
function toUserMessage(content: string): PiAgentMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * 构造 pi 的 AssistantMessage。content 必须是结构化块数组；
 * 这里只承载文本块，工具调用细节按既有契约丢弃（与当前跨轮行为一致）。
 * api/provider/model/usage/stopReason 为 pi schema 必填字段，填入中性占位值。
 */
function toAssistantMessage(content: string): PiAgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'baizer-bridge',
    provider: 'baizer',
    model: 'baizer-bridge',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/**
 * 把 pi 的 AgentMessage[] 映射为干净的 PriorChatMessage[]。
 * - user -> user，assistant -> model（对齐 provider 角色命名）。
 * - 压缩摘要消息（role: compactionSummary / branchSummary / custom）由 buildContext 注入，
 *   在此折叠为前导 user 文本，使摘要进入下一轮上下文。
 * - toolResult 等非对话消息丢弃。
 */
export function mapContextToPriorMessages(messages: PiAgentMessage[]): PriorChatMessage[] {
  const prior: PriorChatMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const text = extractText(message.content);
        if (text.trim()) prior.push({ role: 'user', content: text });
        break;
      }
      case 'assistant': {
        const text = extractText(message.content);
        if (text.trim()) prior.push({ role: 'model', content: text });
        break;
      }
      case 'compactionSummary':
      case 'branchSummary': {
        // 摘要类消息文本在 .summary 字段（非 .content），以 user 角色前置注入。
        const summary = typeof message.summary === 'string' ? message.summary : '';
        if (summary.trim()) prior.push({ role: 'user', content: summary });
        break;
      }
      case 'custom': {
        const text = extractText(message.content);
        if (text.trim()) prior.push({ role: 'user', content: text });
        break;
      }
      default:
        break;
    }
  }
  return prior;
}

/** 从 pi 消息 content 中抽取纯文本（兼容 string 与 (Text|Image)[] 结构）。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('');
  }
  return '';
}

