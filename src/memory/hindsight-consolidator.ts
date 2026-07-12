import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  normalizeMemoryText,
  tokenizeForRetrieval,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

interface ConsolidateOptions {
  bankId?: string;
  now?: number;
  maxEvidence?: number;
}

export class HindsightConsolidator {
  constructor(
    private store: HindsightStore,
    // 无状态 LLM 生成回调(可选)。提供时优先 LLM 归纳,失败回退规则拼接。
    private generate?: (prompt: string, systemPrompt?: string) => Promise<string>,
  ) {}

  async consolidate(options: ConsolidateOptions = {}): Promise<MemoryRecord[]> {
    const bankId = options.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = options.now ?? Date.now();
    const maxEvidence = options.maxEvidence ?? 8;
    const memories = (await this.store.listMemories(bankId))
      .filter((memory) => memory.type !== 'observation')
      .sort((a, b) => b.mentionedAt - a.mentionedAt)
      .slice(0, maxEvidence);

    if (memories.length < 2) return [];

    // 优先 LLM 归纳:把 N 条零散经历/事实真正合成一条更高层 observation。
    const llmText = await this.summarizeWithLlm(memories);

    let text: string;
    let evidenceIds: string[];
    if (llmText) {
      text = llmText;
      evidenceIds = memories.map((memory) => memory.id);
    } else {
      // 回退:规则拼接(需至少命中一条 preference 或 project,否则不产出)。
      const preference = memories.find((memory) => /prefer|preference|偏好|喜欢|local-first/i.test(memory.text));
      const project = memories.find((memory) => /project|goal|plan|memory|项目|目标|计划/i.test(memory.text));
      if (!preference && !project) return [];
      evidenceIds = memories.map((memory) => memory.id);
      text = this.buildObservationText(preference, project);
    }

    const entities = [...new Set(memories.flatMap((memory) => memory.entities))].slice(0, 8);
    const id = createMemoryId({ bankId, type: 'observation', text, sourceKind: 'manual' });
    // 收敛:同主题的旧 observation 被新的退役,画像每主题只留最新一条,避免堆积/漂移。
    // 同主题判据:与新 observation 共享实体,或(都无实体时)文本高相似。仅退役已存 observation。
    // 排除自身 id(同文本→同 id 时是原地更新,不能自我退役)。
    const supersedes = (await this.findStaleObservations(bankId, entities, normalizeMemoryText(text), now))
      .filter((sid) => sid !== id);

    const observation: MemoryRecord = {
      id,
      bankId,
      type: 'observation',
      text,
      normalizedText: normalizeMemoryText(text),
      entities,
      tags: ['observation'],
      source: { kind: 'manual' },
      confidence: 0.75,
      createdAt: now,
      updatedAt: now,
      mentionedAt: now,
      accessCount: 0,
      evidenceIds,
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };

    await this.store.upsertMemory(observation);
    return [observation];
  }

  /**
   * LLM 归纳:把 N 条零散记忆合成一条更高层的持久观察(一句话)。
   * 未注入 generate 返回 null;失败/空/无实质结论也返回 null,交给规则回退。
   */
  private async summarizeWithLlm(memories: MemoryRecord[]): Promise<string | null> {
    if (typeof this.generate !== 'function') return null;
    const system = '你是记忆归纳器。阅读若干条零散记忆,归纳出一条更高层、可复用的用户观察(偏好/工作模式/长期目标),'
      + '一句话,不超过 60 字。若无法归纳出有意义的高层模式,只回复 NONE。不要输出解释。'
      + await this.directivesHint();
    const prompt = memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
    try {
      const raw = (await this.generate(prompt, system)).trim();
      if (!raw || /^none$/i.test(raw)) return null;
      return raw.slice(0, 200);
    } catch {
      return null;
    }
  }

  /**
   * 找出与新 observation 同主题的已存 observation(应被退役)。
   * 同主题判据:共享至少一个实体;或(新 observation 无实体时)文本 token 相似度 ≥ 0.4。
   * 只作用于已存 observation,不碰 world/experience。
   */
  private async findStaleObservations(
    bankId: string,
    newEntities: string[],
    newNormalizedText: string,
    _now: number,
  ): Promise<string[]> {
    const existing = (await this.store.listMemories(bankId))
      .filter((m) => m.type === 'observation');
    if (existing.length === 0) return [];

    const newEntitySet = new Set(newEntities.map((e) => e.toLowerCase()));
    const newTokens = new Set(tokenizeForRetrieval(newNormalizedText));

    const stale: string[] = [];
    for (const obs of existing) {
      const sharesEntity = obs.entities.some((e) => newEntitySet.has(e.toLowerCase()));
      let sameTopic = sharesEntity;
      // 双方都无实体时,退化到文本相似度判同主题。
      if (!sameTopic && newEntitySet.size === 0 && obs.entities.length === 0) {
        const t = new Set(tokenizeForRetrieval(obs.normalizedText));
        let inter = 0;
        for (const x of t) if (newTokens.has(x)) inter += 1;
        const union = t.size + newTokens.size - inter;
        sameTopic = union > 0 && inter / union >= 0.4;
      }
      if (sameTopic) stale.push(obs.id);
    }
    return stale;
  }

  /** 记忆库 directives 拼成 system prompt 追加文本,让归纳也遵守"精炼可复用"等准则。取不到返回空串。 */
  private async directivesHint(): Promise<string> {
    try {
      const banks = await this.store.listBanks();
      const bank = banks.find((b) => b.id === DEFAULT_MEMORY_BANK_ID) || banks[0];
      const directives = bank?.directives?.filter((d) => d.trim()) ?? [];
      if (directives.length === 0) return '';
      return `\n遵守以下记忆准则:\n${directives.map((d) => `- ${d}`).join('\n')}`;
    } catch {
      return '';
    }
  }

  private buildObservationText(preference?: MemoryRecord, project?: MemoryRecord): string {
    if (preference && project) {
      return `${preference.text} This matters in current work: ${project.text}`;
    }
    if (preference) return preference.text;
    return project?.text || 'User has recurring memory-related work patterns.';
  }
}
