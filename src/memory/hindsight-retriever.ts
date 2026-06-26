import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryType,
  tokenizeForRetrieval,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

const TYPE_WEIGHT: Record<MemoryType, number> = {
  observation: 1.25,
  world: 1.1,
  experience: 1,
};

// BM25 tuning constants.
// k1 controls term-frequency saturation: higher = slower saturation.
// b controls document-length normalization: 1 = full normalization, 0 = none.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Field boost weights used when building the per-document term-frequency bag.
// These preserve the same relative intent as the original +2/+3/+1.5 additive weights.
const FIELD_BOOST_TEXT = 2;
const FIELD_BOOST_ENTITY = 3;
const FIELD_BOOST_TAG = 1.5;

/**
 * Corpus-level statistics computed once per recall() call over the in-memory
 * set of candidate records. No persistent index — fully mobile-safe.
 */
interface CorpusStats {
  /** Number of records in the corpus. */
  N: number;
  /** Average field-boosted document length (sum of weighted tf values). */
  avgdl: number;
  /** Document frequency: how many records contain each term at least once. */
  df: Map<string, number>;
}

export class HindsightRetriever {
  constructor(private store: HindsightStore) {}

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const bankId = request.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = request.now ?? Date.now();
    const maxRecords = request.maxRecords ?? 6;
    const maxChars = request.maxChars ?? 2500;
    const includeTypes = new Set<MemoryType>(request.includeTypes || ['observation', 'world', 'experience']);
    // Use the new bigram-aware tokenizer for retrieval
    const queryTerms = tokenizeForRetrieval(request.query);
    const records = (await this.store.listMemories(bankId))
      .filter((record) => includeTypes.has(record.type));

    // Build corpus stats once over the full candidate set before scoring
    const stats = this.buildCorpusStats(records);

    const ranked = records
      .map((record) => ({ record, score: this.score(record, queryTerms, stats, now) }))
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

  /**
   * Build field-boosted term-frequency map for a single record.
   *
   * Each occurrence of a term is weighted by its field:
   *   text tokens  × FIELD_BOOST_TEXT   (×2)
   *   entity tokens × FIELD_BOOST_ENTITY (×3)
   *   tag tokens   × FIELD_BOOST_TAG    (×1.5)
   *
   * The result is a Map<term, weighted_count> used as tf(term, doc).
   * docLen = sum of all weighted counts (used for BM25 length normalization).
   */
  private termFreqs(record: MemoryRecord): Map<string, number> {
    const tf = new Map<string, number>();

    const add = (tokens: string[], boost: number) => {
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + boost);
      }
    };

    add(tokenizeForRetrieval(record.text), FIELD_BOOST_TEXT);
    for (const entity of record.entities) {
      add(tokenizeForRetrieval(entity), FIELD_BOOST_ENTITY);
    }
    for (const tag of record.tags) {
      // Tags are typically short ASCII strings; bigram tokenizer handles them fine
      add(tokenizeForRetrieval(tag), FIELD_BOOST_TAG);
    }

    return tf;
  }

  /**
   * Compute corpus-level statistics needed by BM25 from the candidate records.
   * Called once per recall() — O(records × unique_terms), acceptable for a
   * personal vault memory store.
   */
  private buildCorpusStats(records: MemoryRecord[]): CorpusStats {
    const N = records.length;
    const df = new Map<string, number>();
    let totalDocLen = 0;

    for (const record of records) {
      const tf = this.termFreqs(record);
      // docLen = sum of weighted tf values for this record
      let docLen = 0;
      for (const weight of tf.values()) {
        docLen += weight;
      }
      totalDocLen += docLen;

      // Each term present in the doc contributes 1 to its df
      for (const term of tf.keys()) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const avgdl = N > 0 ? totalDocLen / N : 1;
    return { N, avgdl, df };
  }

  /**
   * Score a single record against the query using field-boosted BM25.
   *
   * BM25 formula per query term t:
   *   idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
   *   tf_norm(t,d) = tf(t,d) * (k1+1) / (tf(t,d) + k1*(1 - b + b*(dl/avgdl)))
   *   contribution(t,d) = idf(t) * tf_norm(t,d)
   *
   * The raw BM25 sum is used as lexScore, then fused with the existing outer
   * formula: (lexScore * TYPE_WEIGHT[type]) + recency + access + confidence.
   *
   * A scale factor is applied so BM25 magnitudes stay in a range comparable
   * to the old additive scores (≈2–5), keeping recency/access/confidence as
   * gentle tie-breakers rather than dominators.
   *
   * Empty-query and score===0 fallbacks are preserved unchanged.
   */
  private score(
    record: MemoryRecord,
    queryTerms: string[],
    stats: CorpusStats,
    now: number,
  ): number {
    const { N, avgdl, df } = stats;

    // Empty-query fallback: same behaviour as before
    if (queryTerms.length === 0) {
      const baseline = record.type !== 'experience' ? 0.5 : 0;
      if (baseline === 0) return 0;
      const ageMs = Math.max(0, now - record.mentionedAt);
      const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 14));
      const access = Math.min(record.accessCount, 10) * 0.05;
      return (baseline * TYPE_WEIGHT[record.type]) + recency + access + record.confidence;
    }

    const tf = this.termFreqs(record);
    let docLen = 0;
    for (const weight of tf.values()) {
      docLen += weight;
    }

    let bm25 = 0;
    for (const term of queryTerms) {
      const termTf = tf.get(term) ?? 0;
      if (termTf === 0) continue;

      const termDf = df.get(term) ?? 0;
      // Smooth IDF: always positive even when df === N
      const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
      const tfNorm = (termTf * (BM25_K1 + 1)) /
        (termTf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgdl)));
      bm25 += idf * tfNorm;
    }

    if (bm25 === 0) return 0;

    // Scale BM25 output to ≈2–5 range so recency/access/confidence remain
    // gentle tie-breakers (same intent as original additive weights of +2/+3).
    // Empirically a factor of ~1.5 achieves this for typical short memories.
    const lexScore = bm25 * 1.5;

    const ageMs = Math.max(0, now - record.mentionedAt);
    const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 14));
    const access = Math.min(record.accessCount, 10) * 0.05;
    return (lexScore * TYPE_WEIGHT[record.type]) + recency + access + record.confidence;
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
