import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  normalizeMemoryText,
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

    const observation: MemoryRecord = {
      id: createMemoryId({ bankId, type: 'observation', text, sourceKind: 'manual' }),
      bankId,
      type: 'observation',
      text,
      normalizedText: normalizeMemoryText(text),
      entities: [...new Set(memories.flatMap((memory) => memory.entities))].slice(0, 8),
      tags: ['observation'],
      source: { kind: 'manual' },
      confidence: 0.75,
      createdAt: now,
      updatedAt: now,
      mentionedAt: now,
      accessCount: 0,
      evidenceIds,
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
      + '一句话,不超过 60 字。若无法归纳出有意义的高层模式,只回复 NONE。不要输出解释。';
    const prompt = memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
    try {
      const raw = (await this.generate(prompt, system)).trim();
      if (!raw || /^none$/i.test(raw)) return null;
      return raw.slice(0, 200);
    } catch {
      return null;
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
