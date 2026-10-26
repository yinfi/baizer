/**
 * session-store/conversation-session.ts
 *
 * 一个会话（conversationId = UI tab id）的读写句柄，是 HarnessSessionManager 与
 * runtime 消费持久化层的唯一门面。取代 pi 0.75.5 的 `Session` 对象（1.3.0 已移除）。
 *
 * 职责边界：
 * - 读：活跃分支（root→activeLeafEntryId 的回溯路径）、全量 Entry、单条 Entry。
 * - 写：追加 Entry、切换活跃叶子（BR2.2：只改指针）、标记取代。
 * - 投影输入：把模型可见的 Entry 折叠成发往模型的消息序列（供 runtime 组装 transcript
 *   与 maybeCompact 的 token 估算共用，保证「估算口径 = 实际发出口径」）。
 *
 * 不持有 pi 任何类型——分支/可见性语义全部来自 entities.md 的 Session/Entry。
 */

import { SessionStore, type NewEntryInput } from './store';
import { createInMemoryVaultAdapter } from './memory-adapter';
import {
  type Entry,
  type EntryKind,
  type Session,
  type SessionAvailability,
} from './types';
import type { EstimableMessage } from './compaction';

/** 会话文件默认根目录(vault 相对,隐藏目录)。 */
export const DEFAULT_SESSIONS_ROOT = '.obsidian/baizer-sessions';

/** 临时会话(无 conversationId)的内存 store 内部使用的会话键,只在一份内存 adapter 内有效。 */
const EPHEMERAL_CONVERSATION_ID = '__ephemeral__';

/** 发往模型的最小消息形状（pi 形态的 content + 真实 usage）。 */
export interface ModelMessage extends EstimableMessage {
  role: string;
  content: unknown;
  /** provider 报错时的原始错误文本（随消息透传，不参与 token 估算）。 */
  errorMessage?: string;
}

/** 消息类 Entry 的 kind → pi 消息 role。 */
const MESSAGE_ROLE_BY_KIND: Partial<Record<EntryKind, string>> = {
  user_message: 'user',
  assistant_message: 'assistant',
  tool_result: 'toolResult',
};

/**
 * 规范化消息 content 的形状。
 * 迁移来的旧条目里 assistant/toolResult 的 content 可能是纯字符串（pi 0.75.5 的旧消息形态），
 * 而 provider 侧要求它们是有序的 block 数组，故补成单个 text 块。
 */
function normalizeContent(role: string, content: unknown): unknown {
  if (typeof content !== 'string') return content;
  if (role === 'assistant' || role === 'toolResult') return [{ type: 'text', text: content }];
  return content;
}

/** 把 payload 读成带外文本（approval_outcome / custom_message 用）。 */
function readTextPayload(entry: Entry): string {
  const payload = entry.payload;
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return typeof payload === 'string' ? payload : '';
}

/**
 * 从 activeLeafEntryId 回溯到根，返回该路径上的 Entry（root→leaf 顺序）。
 *
 * 这是 entities.md 定义的分支读取方式：分支不是独立实体，而是读取时算出的路径。
 * activeLeafEntryId 为 null（空会话）或指向不存在的 Entry 时返回空数组。
 */
export function resolveBranch(entries: Entry[], activeLeafEntryId: string | null): Entry[] {
  if (!activeLeafEntryId) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Entry[] = [];
  const seen = new Set<string>();
  let currentId: string | null = activeLeafEntryId;
  while (currentId) {
    if (seen.has(currentId)) break; // 防御损坏文件里的环
    seen.add(currentId);
    const entry: Entry | undefined = byId.get(currentId);
    if (!entry) break;
    path.push(entry);
    currentId = entry.parentEntryId;
  }
  return path.reverse();
}

/** 一个会话的读写句柄。 */
export class ConversationSession {
  constructor(
    private readonly store: SessionStore,
    private readonly conversationId: string,
    private session: Session,
  ) {}

  get conversationIdValue(): string {
    return this.conversationId;
  }

  /** 当前会话的可用性状态（BR1.3：read_only_degraded 时只可读、拒绝新 Entry）。 */
  get availability(): SessionAvailability {
    return this.session.availability;
  }

  get createdAt(): string {
    return this.session.createdAt;
  }

  getActiveLeafEntryId(): string | null {
    return this.session.activeLeafEntryId;
  }

  /**
   * 全量 Entry（供投影枚举兄弟分支）。
   * 不刷新缓存的 Session：本句柄是单进程内该会话的唯一写者，指针由 append/moveActiveLeaf 维护；
   * 而重读出的 Session 可能因文件损坏而残缺（如缺 availability），刷新反而会把只读降级态冲掉。
   */
  async getAllEntries(): Promise<Entry[]> {
    const loaded = await this.store.load(this.conversationId);
    return loaded ? loaded.entries : [];
  }

  /** 当前活跃分支（root→leaf 顺序）。 */
  async getBranch(): Promise<Entry[]> {
    const entries = await this.getAllEntries();
    return resolveBranch(entries, this.session.activeLeafEntryId);
  }

  async getEntry(entryId: string): Promise<Entry | undefined> {
    const entries = await this.getAllEntries();
    return entries.find((entry) => entry.id === entryId);
  }

  /** 追加一条 Entry（会随即将 activeLeafEntryId 指向它）。只读降级态会抛错。 */
  async append(input: NewEntryInput): Promise<Entry> {
    const entry = await this.store.appendEntry(this.conversationId, input);
    this.session.activeLeafEntryId = entry.id;
    return entry;
  }

  /** 切换活跃叶子（BR2.2：只改指针，不复制/改写任何 Entry）。 */
  async moveActiveLeaf(targetEntryId: string | null): Promise<boolean> {
    const ok = await this.store.moveActiveLeaf(this.conversationId, targetEntryId);
    if (ok) this.session.activeLeafEntryId = targetEntryId;
    return ok;
  }

  /** 标记某条 Entry 被取代（编辑/重试作废）。 */
  async markSuperseded(entryId: string, supersededByEntryId: string): Promise<boolean> {
    return await this.store.markSuperseded(this.conversationId, entryId, supersededByEntryId);
  }

  /**
   * 把活跃分支上「模型可见」的 Entry 折叠成发往模型的消息序列。
   *
   * visibleToModel = false 的 Entry 不计入（BR2.1）。approval_outcome / custom_message
   * 转成 user 消息——它们对模型可见（这正是回灌的目的），只是不进 UI 投影。
   *
   * 保真原则：消息类 Entry 的 payload 就是落盘时那条 pi 消息对象本身（含 content/usage/
   * stopReason 以及 api/provider/model/timestamp 等字段），故这里**原样透传**该对象，
   * 而不是逐字段重建——重建会丢掉 provider 需要的字段，也会丢掉 assistant 消息里
   * 与 toolResult 配对所需的 toolCall 块（缺了配对的 toolCall 会被 provider 拒绝）。
   * 迁移来的旧条目 payload 只有 {role, content}，故对缺失字段做最小补齐。
   */
  async buildModelMessages(): Promise<ModelMessage[]> {
    return (await this.buildModelView()).messages;
  }

  /**
   * 同 buildModelMessages，但同时给出每条消息对应的 Entry（下标一一对应）。
   * 压缩动作（applyCompaction）据此把「被摘要折叠」的那一段消息精确映射回要隐藏的 Entry id。
   */
  async buildModelView(): Promise<{ entries: Entry[]; messages: ModelMessage[] }> {
    const branch = await this.getBranch();
    const entries: Entry[] = [];
    const messages: ModelMessage[] = [];
    for (const entry of branch) {
      if (!entry.visibleToModel) continue;
      switch (entry.kind) {
        case 'user_message':
        case 'assistant_message':
        case 'tool_result': {
          const role = MESSAGE_ROLE_BY_KIND[entry.kind]!;
          const payload = entry.payload && typeof entry.payload === 'object'
            ? entry.payload as Record<string, unknown>
            : { content: entry.payload };
          if (payload.role === role) {
            // 落盘的 payload 就是 pi 消息对象本身 → 原样透传（保留 api/provider/model/timestamp 等字段）。
            messages.push({ ...payload, role, content: normalizeContent(role, payload.content) } as ModelMessage);
          } else {
            // 迁移来的旧 payload 只有 {role, content}（tool_result 连 toolCallId 都没有）→ 按最小字段补齐。
            const content = 'result' in payload ? payload.result : payload.content;
            messages.push({
              role,
              content: normalizeContent(role, content),
              ...(typeof payload.name === 'string' ? { toolName: payload.name } : {}),
              ...(typeof payload.toolCallId === 'string' ? { toolCallId: payload.toolCallId } : {}),
            } as ModelMessage);
          }
          entries.push(entry);
          break;
        }
        case 'tool_call': {
          // 目前没有写入方产生该 kind（pi 的 toolCall 块留在 assistant 消息里，见上）。
          // 保留分支是为了让投影对 EntryKind 完整（新增写入方时不会静默漏掉消息）。
          const payload = (entry.payload ?? {}) as { name?: string; args?: unknown; toolCallId?: string };
          messages.push({
            role: 'assistant',
            content: [{ type: 'toolCall', name: payload.name, args: payload.args, id: payload.toolCallId }],
          });
          entries.push(entry);
          break;
        }
        case 'approval_outcome':
        case 'custom_message':
          messages.push({ role: 'user', content: readTextPayload(entry) });
          entries.push(entry);
          break;
      }
    }
    return { entries, messages };
  }

  /** 活跃分支上是否已有模型可见的历史（短确认/延续判定用）。 */
  async hasHistory(): Promise<boolean> {
    return (await this.buildModelMessages()).length > 0;
  }

  /**
   * 执行一次压缩动作:把调用方挑选出的旧消息折叠成一条摘要(模型可见、UI 不可见),
   * 原 Entry 保留在存储里(UI 历史不受影响),只是不再计入下一轮发往模型的消息。
   *
   * @param hideEntryIds 要折叠隐藏的 Entry id(由调用方按 keepRecentTokens 预算挑选)。
   * @param summaryText 摘要正文(由调用方走应用自己的 provider 生成)。
   */
  async applyCompaction(hideEntryIds: string[], summaryText: string): Promise<Entry> {
    const entry = await this.store.applyCompaction(this.conversationId, {
      hideEntryIds,
      summaryPayload: { customType: 'compaction_summary', text: summaryText },
      compactionState: { lastCompactedAt: new Date().toISOString(), tokensSinceCompaction: 0 },
    });
    this.session.activeLeafEntryId = entry.id;
    return entry;
  }
}

/**
 * 构造一个不持久化的内存会话：不落盘、每次调用全新（无跨轮上下文）。
 * 供 conversationId 缺省的一次性调用（file-back、/edit 等）与无 sessionManager 的纯单测使用。
 */
export async function createInMemoryConversationSession(
  sessionsRoot: string = DEFAULT_SESSIONS_ROOT,
): Promise<ConversationSession> {
  const store = new SessionStore(createInMemoryVaultAdapter(), sessionsRoot);
  const session = await store.create(EPHEMERAL_CONVERSATION_ID);
  return new ConversationSession(store, EPHEMERAL_CONVERSATION_ID, session);
}
