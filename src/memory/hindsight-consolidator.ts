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
  constructor(private store: HindsightStore) {}

  async consolidate(options: ConsolidateOptions = {}): Promise<MemoryRecord[]> {
    const bankId = options.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = options.now ?? Date.now();
    const maxEvidence = options.maxEvidence ?? 8;
    const memories = (await this.store.listMemories(bankId))
      .filter((memory) => memory.type !== 'observation')
      .sort((a, b) => b.mentionedAt - a.mentionedAt)
      .slice(0, maxEvidence);

    if (memories.length < 2) return [];

    const preference = memories.find((memory) => /prefer|preference|偏好|喜欢|local-first/i.test(memory.text));
    const project = memories.find((memory) => /project|goal|plan|memory|项目|目标|计划/i.test(memory.text));
    if (!preference && !project) return [];

    const evidenceIds = memories.map((memory) => memory.id);
    const text = this.buildObservationText(preference, project);
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

  private buildObservationText(preference?: MemoryRecord, project?: MemoryRecord): string {
    if (preference && project) {
      return `${preference.text} This matters in current work: ${project.text}`;
    }
    if (preference) return preference.text;
    return project?.text || 'User has recurring memory-related work patterns.';
  }
}
