import type { ChatMessage } from '../../ui/types';
import type { Entry, MessagePayload } from './session-store/types';

/**
 * 会话分支投影：把「当前活跃分支的 Entry」投影成 UI 的 ChatMessage[]。
 *
 * 数据来源是 entities.md 定义的 Session/Entry（取代 pi 0.75.5 的 SessionTreeEntry 镜像）：
 * - 分支 = 从 Session.activeLeafEntryId 回溯到根的路径（调用方经 resolveBranch 算出后传入）。
 * - 「重试作废」不再是独立的 label 条目，而是 Entry.supersededByEntryId 字段。
 * - 可见性由 Entry.visibleToUiProjection 决定，不再靠「type 是否为 message」隐式区分。
 *
 * 投影规则（有损，符合既有定位）：
 * - user_message → role:'user' 的 ChatMessage；若该 user 在其 parent 下有多个有效 user 兄弟，
 *   附 branch:{index,count,leafIds}，供 UI 渲染 `< index/count >` 与切换。
 * - assistant_message → role:'ai'；content 里的 toolCall 块折叠为文本标记。
 * - tool_call / tool_result / approval_outcome / custom_message → 不产出独立消息
 *   （工具卡是运行态，历史分支降级；审批回灌按 BR2.1 固定对 UI 不可见）。
 * - 空文本消息跳过（如纯 toolCall 的 assistant 中间步）。
 */

/** 把消息 content 折叠成纯文本。string 原样；数组拼接 text 块，toolCall 折叠为 `[tool: name]`。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'toolCall' && typeof b.name === 'string') parts.push(`[tool: ${b.name}]`);
    // thinking / image 等在历史投影里降级忽略（既有的有损投影）。
  }
  return parts.join('').trim();
}

/** 取消息类 Entry 的文本（payload 约定见 types.ts 的 MessagePayload）。 */
function entryText(entry: Entry): string {
  const payload = entry.payload as MessagePayload | undefined;
  return contentToText(payload?.content);
}

/**
 * 从某个 Entry 沿「子代」向下走到一个叶子，返回该叶子 id。
 * 多个子代时选 createdAt 最新的一支（对齐「最近的分支」直觉）。
 * 用于兄弟分支切换：切到某个兄弟时，moveTo 的目标是它子树的叶子（恢复该分支的完整对话）。
 */
function resolveLeafId(startId: string, childrenByParent: Map<string, Entry[]>): string {
  let currentId = startId;
  // 防环：会话树是 tree，但仍设上限兜底。
  for (let guard = 0; guard < 100000; guard++) {
    const children = childrenByParent.get(currentId);
    if (!children || children.length === 0) return currentId;
    const next = children.reduce((a, b) => ((b.createdAt ?? '') >= (a.createdAt ?? '') ? b : a));
    currentId = next.id;
  }
  return currentId;
}

export function projectBranchToMessages(branch: Entry[], allEntries: Entry[]): ChatMessage[] {
  // 建 parentEntryId → 子 Entry 索引（用全量，才能看到不在当前分支上的兄弟）。
  const childrenByParent = new Map<string, Entry[]>();
  for (const entry of allEntries) {
    const key = entry.parentEntryId ?? '__root__';
    const list = childrenByParent.get(key);
    if (list) list.push(entry);
    else childrenByParent.set(key, [entry]);
  }

  const isUserMessage = (e: Entry) => e.kind === 'user_message';
  // 重试作废的旧分支不再算作有效兄弟（supersededByEntryId 非 null 即已作废）。
  const supersededIds = new Set(
    allEntries.filter((e) => e.supersededByEntryId !== null).map((e) => e.id),
  );

  const messages: ChatMessage[] = [];
  for (const entry of branch) {
    // BR2.1：对 UI 投影不可见的 Entry 一律不渲染（approval_outcome 固定为不可见）。
    if (!entry.visibleToUiProjection) continue;
    if (entry.kind !== 'user_message' && entry.kind !== 'assistant_message') continue;

    const text = entryText(entry);
    if (!text) continue; // 纯 toolCall 的 assistant 中间步、空 user 等跳过。

    const msg: ChatMessage = {
      id: `entry-${entry.id}`,
      role: entry.kind === 'user_message' ? 'user' : 'ai',
      content: text,
      timestamp: entry.createdAt ? Date.parse(entry.createdAt) || Date.now() : Date.now(),
      sessionEntryId: entry.id,
    };

    if (entry.kind === 'user_message') {
      // 兄弟 = 同 parentEntryId 的其他 user_message（含自己），排除被「重试」作废的。
      // 重试作废旧分支后，此处有效兄弟只剩新的一条 → 不产出 branch → 不显示 < n/m >。
      const parentKey = entry.parentEntryId ?? '__root__';
      const siblings = (childrenByParent.get(parentKey) ?? [])
        .filter(isUserMessage)
        .filter((s) => !supersededIds.has(s.id))
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      if (siblings.length > 1) {
        const index = siblings.findIndex((s) => s.id === entry.id);
        msg.branch = {
          index,
          count: siblings.length,
          leafIds: siblings.map((s) => resolveLeafId(s.id, childrenByParent)),
        };
      }
    }

    messages.push(msg);
  }

  return messages;
}
