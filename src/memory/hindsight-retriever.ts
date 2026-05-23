import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryType,
  tokenizeMemoryText,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

const TYPE_WEIGHT: Record<MemoryType, number> = {
  observation: 1.25,
  world: 1.1,
  experience: 1,
};

export class HindsightRetriever {
  constructor(private store: HindsightStore) {}

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const bankId = request.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = request.now ?? Date.now();
    const maxRecords = request.maxRecords ?? 6;
    const maxChars = request.maxChars ?? 2500;
    const includeTypes = new Set<MemoryType>(request.includeTypes || ['observation', 'world', 'experience']);
    const queryTokens = new Set(tokenizeMemoryText(request.query));
    const records = (await this.store.listMemories(bankId))
      .filter((record) => includeTypes.has(record.type));

    const ranked = records
      .map((record) => ({ record, score: this.score(record, queryTokens, now) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.record);

    const selected = this.applyBudget(ranked, maxRecords, maxChars);
    await this.store.markMemoriesAccessed(selected.map((record) => record.id), now);
    return {
      records: selected,
      promptBlock: this.formatPromptBlock(selected, maxChars),
    };
  }

  private score(record: MemoryRecord, queryTokens: Set<string>, now: number): number {
    const memoryTokens = new Set(tokenizeMemoryText(record.text));
    const entityTokens = new Set(record.entities.flatMap((entity) => tokenizeMemoryText(entity)));
    let score = 0;

    for (const token of queryTokens) {
      if (memoryTokens.has(token)) score += 2;
      if (entityTokens.has(token)) score += 3;
      if (record.tags.some((tag) => tag.toLowerCase().includes(token))) score += 1.5;
    }

    if (queryTokens.size === 0 && record.type !== 'experience') score += 0.5;
    if (score === 0) return 0;

    const ageMs = Math.max(0, now - record.mentionedAt);
    const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 14));
    const access = Math.min(record.accessCount, 10) * 0.05;
    return (score * TYPE_WEIGHT[record.type]) + recency + access + record.confidence;
  }

  private applyBudget(records: MemoryRecord[], maxRecords: number, maxChars: number): MemoryRecord[] {
    const selected: MemoryRecord[] = [];
    let used = '[Relevant Memory]\n'.length;

    for (const record of records) {
      if (selected.length >= maxRecords) break;
      const line = this.formatLine(record);
      if (selected.length > 0 && used + line.length > maxChars) continue;
      if (selected.length === 0 && used + line.length > maxChars) {
        selected.push(record);
        break;
      }
      selected.push(record);
      used += line.length;
      if (used >= maxChars) break;
    }

    return selected;
  }

  private formatPromptBlock(records: MemoryRecord[], maxChars: number): string {
    if (records.length === 0) return '';
    const text = `[Relevant Memory]\n${records.map((record) => this.formatLine(record)).join('')}`;
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private formatLine(record: MemoryRecord): string {
    return `- ${record.type}: ${record.text} (confidence: ${record.confidence.toFixed(2)})\n`;
  }
}
