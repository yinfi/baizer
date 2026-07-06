import type { ChatMessage } from '../../ui/types';

/**
 * 「重试」时给被替换的旧问答分支打的 label(阶段C 语义修正)。
 * 重试 = 同一问题重新生成、新答案替换旧答案、不保留旧分支;
 * 实现上给旧 user entry 打此标记,projector 枚举兄弟分支时过滤掉被标记者,
 * 于是重试后有效兄弟只剩新的一条(不显示 < n/m >),而分叉/编辑不打标记、兄弟可累积切换。
 */
export const SUPERSEDED_LABEL = 'baizer:superseded';

/**
 * pi 会话树 entry 的最小结构契约(投影只读这些字段,避免依赖 pi value import)。
 * 与 pi SessionTreeEntry 对齐;此处只声明投影用到的 message / 通用字段。
 */
export interface ProjectorEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: {
    role: 'user' | 'assistant' | 'toolResult' | string;
    content: unknown;
  };
  // label entry:targetId 指向被标记的 entry,label 为标记值(如 SUPERSEDED_LABEL)。
  targetId?: string;
  label?: string;
  // tool 结果类 entry 可能直接带这些(不同 pi 版本);投影按存在性宽松读取。
  toolName?: string;
}

/**
 * 把 pi AgentMessage 的 content 折叠成纯文本。
 * - string:原样。
 * - 数组:拼接 text 块;toolCall 折叠为 `[tool: name]`;其余忽略。
 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as any;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'toolCall' && typeof b.name === 'string') parts.push(`[tool: ${b.name}]`);
    // thinking / image 等在历史投影里降级忽略(阶段C 已接受的有损投影)。
  }
  return parts.join('').trim();
}

/**
 * 从某个 entry 沿「子代」向下走到一个叶子,返回该叶子 id。
 * 多个子代时选 timestamp 最新的一支(对齐「最近的分支」直觉)。
 * 用于兄弟分支切换:切到某个兄弟时,moveTo 的目标是它子树的叶子(恢复该分支的完整对话)。
 */
function resolveLeafId(startId: string, childrenByParent: Map<string, ProjectorEntry[]>): string {
  let currentId = startId;
  // 防环:会话树是 DAG-free tree,但仍设上限兜底。
  for (let guard = 0; guard < 100000; guard++) {
    const children = childrenByParent.get(currentId);
    if (!children || children.length === 0) return currentId;
    const next = children.reduce((a, b) => ((b.timestamp ?? '') >= (a.timestamp ?? '') ? b : a));
    currentId = next.id;
  }
  return currentId;
}

/**
 * 会话分支投影(阶段C):把「当前活跃分支的 entries」投影成 UI 的 ChatMessage[]。
 *
 * @param branch 当前分支(root→leaf 顺序)的 entries,来自 session.getBranch()。
 * @param allEntries 会话全量 entries,来自 session.getEntries();用于枚举兄弟分支。
 *
 * 投影规则(有损,符合阶段C 定位):
 * - user message → role:'user' 的 ChatMessage;若该 user 在其 parent 下有多个 user 兄弟,
 *   附 branch:{index,count,leafIds},供 UI 渲染 `< index/count >` 与切换。
 * - assistant message → role:'ai';toolCall 折叠为文本标记。
 * - toolResult / 其他 → 不产出独立消息(工具卡是运行态,历史分支降级)。
 * - 空文本消息跳过(如纯 toolCall 的 assistant 中间步)。
 */
export function projectBranchToMessages(
  branch: ProjectorEntry[],
  allEntries: ProjectorEntry[],
): ChatMessage[] {
  // 建 parentId → 子 entries 索引(用全量,才能看到不在当前分支上的兄弟)。
  const childrenByParent = new Map<string, ProjectorEntry[]>();
  // 每个 targetId 的「最新」label(pi label 为 append 语义,后写覆盖前写)。
  const latestLabelByTarget = new Map<string, string | undefined>();
  for (const entry of allEntries) {
    const key = entry.parentId ?? '__root__';
    const list = childrenByParent.get(key);
    if (list) list.push(entry);
    else childrenByParent.set(key, [entry]);

    if (entry.type === 'label' && entry.targetId) {
      latestLabelByTarget.set(entry.targetId, entry.label);
    }
  }

  // 被「重试」标记作废的分支(其 user entry 最新 label 为 SUPERSEDED_LABEL)。
  const isSuperseded = (entryId: string) => latestLabelByTarget.get(entryId) === SUPERSEDED_LABEL;
  const isUserMessage = (e: ProjectorEntry) => e.type === 'message' && e.message?.role === 'user';

  const messages: ChatMessage[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = contentToText(entry.message.content);
    if (!text) continue; // 纯 toolCall 的 assistant 中间步、空 user 等跳过。

    const msg: ChatMessage = {
      id: `entry-${entry.id}`,
      role: role === 'user' ? 'user' : 'ai',
      content: text,
      timestamp: entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now(),
      sessionEntryId: entry.id,
    };

    if (role === 'user') {
      // 兄弟 = 同 parentId 的其他 user message entry(含自己),排除被「重试」标记作废的。
      // 重试作废旧分支后,此处兄弟只剩新的一条 → 不产出 branch → 不显示 < n/m >。
      const parentKey = entry.parentId ?? '__root__';
      const siblings = (childrenByParent.get(parentKey) ?? [])
        .filter(isUserMessage)
        .filter((s) => !isSuperseded(s.id))
        .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
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
