import { SelectionActionContext } from './action-registry';

/** 最小依赖接口(便于 mock,不耦合具体类)。任一为 null 表示该源不可用。 */
export interface SelectionContextDeps {
  knowledgeRuntime: { getGuardianDeepKnowledgeContext(query: string): Promise<string> } | null;
  modelService: { recallGuardianMemory(query: string, maxChars?: number): Promise<string> } | null;
  contextService: { collect(): Promise<{ contextItems?: Array<{ id?: string; content?: string }> }> } | null;
}

const KNOWLEDGE_TIMEOUT_MS = 2500;
const MEMORY_TIMEOUT_MS = 1500;
const ACTIVE_NOTE_TIMEOUT_MS = 800;

/** 给一个 promise 套超时;超时或抛错都 resolve 空串,绝不 reject。 */
function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(''); } }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v || ''); } })
     .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(''); } });
  });
}

/**
 * 上下文装配器:按动作的 context 声明,并发预取声明了的源,
 * 把非空片段拼成前缀 + 原 prompt。全空则返回裸 prompt。
 */
export class SelectionContextBuilder {
  constructor(private deps: SelectionContextDeps) {}

  async build(need: SelectionActionContext, selection: string, basePrompt: string): Promise<string> {
    const query = selection.trim();
    if (!query) return basePrompt;

    const [note, knowledge, memory] = await Promise.all([
      need.activeNote ? this.fetchActiveNote() : Promise.resolve(''),
      need.knowledge && this.deps.knowledgeRuntime
        ? withTimeout(this.deps.knowledgeRuntime.getGuardianDeepKnowledgeContext(query), KNOWLEDGE_TIMEOUT_MS)
        : Promise.resolve(''),
      need.memory && this.deps.modelService
        ? withTimeout(this.deps.modelService.recallGuardianMemory(query, 500), MEMORY_TIMEOUT_MS)
        : Promise.resolve(''),
    ]);

    const blocks = [note, knowledge, memory].map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) return basePrompt;
    return `${blocks.join('\n\n')}\n\n---\n\n${basePrompt}`;
  }

  /** 取活动笔记当前小节正文(来自 contextService 快照的 active-note contextItem)。 */
  private async fetchActiveNote(): Promise<string> {
    if (!this.deps.contextService) return '';
    const task = (async () => {
      const snap = await this.deps.contextService!.collect();
      const item = (snap.contextItems || []).find((i) => i.id?.startsWith('active-note:'));
      const body = (item?.content || '').trim();
      return body ? `[当前笔记片段]\n${body}` : '';
    })();
    return withTimeout(task, ACTIVE_NOTE_TIMEOUT_MS);
  }
}
