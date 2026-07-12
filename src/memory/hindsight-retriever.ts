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

// 负反馈教训的召回加权:相同相关度下,「应避免」的教训比普通经验更该被模型看见,
// 否则进化信号会被海量中性记忆淹没。1.5 是经验值,与 TYPE_WEIGHT 同量级、不至于压垮相关性。
const POLARITY_BOOST: Record<NonNullable<MemoryRecord['polarity']>, number> = {
  negative: 1.5,
  positive: 1.2,
};

function polarityBoost(record: MemoryRecord): number {
  return record.polarity ? POLARITY_BOOST[record.polarity] : 1;
}

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
    const all = await this.store.listMemories(bankId);
    // 退役集合:任何记录经 supersedes 声明取代的旧 id 都不再召回(留库不删,可审计/可恢复)。
    // 这是矛盾更新(#4)与 consolidate 收敛(#3)的共同前置——新的取代旧的,旧的从检索中消失。
    const superseded = new Set<string>();
    for (const record of all) {
      if (record.supersedes) {
        for (const id of record.supersedes) superseded.add(id);
      }
    }
    const records = all.filter((record) =>
      includeTypes.has(record.type) && !superseded.has(record.id));

    // Build corpus stats once over the full candidate set before scoring
    const stats = this.buildCorpusStats(records);

    const scoredSeeds = records
      .map((record) => ({ record, score: this.score(record, queryTerms, stats, now) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    let ranked = scoredSeeds.map((entry) => entry.record);

    // 一跳实体图检索:用 BM25 种子的实体作钩子,把共享实体的邻居(即便 BM25=0)以衰减分带出,
    // 追加到种子之后。纯内存、即时倒排,带停用实体+上限防噪声。
    if (request.graphRecall) {
      ranked = this.expandByEntityGraph(scoredSeeds, records);
    }

    const selected = this.applyBudget(ranked, maxRecords, maxChars);
    // 更新访问元数据:store 内部已把磁盘落盘 fire-and-forget(void scheduleWrite),
    // 这里 await 的只是廉价的内存计数更新,不阻塞在磁盘 I/O 上,同时保证读到最新计数。
    await this.store.markMemoriesAccessed(selected.map((record) => record.id), now);
    return {
      records: selected,
      promptBlock: this.formatPromptBlock(selected, maxChars),
    };
  }

  /**
   * 一跳实体图检索。种子 = BM25 命中(已按分降序)。
   * 即时构建 entity→记忆倒排(仅本次候选集,纯内存),用种子的实体作钩子取共享实体的邻居,
   * 邻居即便 BM25=0 也带出,给衰减分,追加在所有种子之后(保证不越过同等相关的种子)。
   *
   * 防噪声:
   * - 停用实体:出现在 >30% 候选记忆里的 entity 不作钩子(类比高频词无区分度)。
   * - 三重上限:每种子最多 3 个钩子实体、每实体最多 3 个邻居、图邻居总数 ≤ 5。
   */
  private expandByEntityGraph(
    scoredSeeds: Array<{ record: MemoryRecord; score: number }>,
    allRecords: MemoryRecord[],
  ): MemoryRecord[] {
    const seeds = scoredSeeds.map((e) => e.record);
    if (seeds.length === 0) return seeds;

    // 即时倒排:entity(lowercase)→ 含该实体的记忆列表。
    const invertedIndex = new Map<string, MemoryRecord[]>();
    for (const record of allRecords) {
      for (const entity of record.entities) {
        const key = entity.toLowerCase();
        const list = invertedIndex.get(key);
        if (list) list.push(record); else invertedIndex.set(key, [record]);
      }
    }

    // 停用实体:命中过多记忆的实体无链接区分度,跳过。
    const stopThreshold = Math.max(2, Math.floor(allRecords.length * 0.3));

    const seedIds = new Set(seeds.map((r) => r.id));
    const neighborScore = new Map<string, { record: MemoryRecord; score: number }>();
    const MAX_HOOKS_PER_SEED = 3;
    const MAX_NEIGHBORS_PER_ENTITY = 3;
    const MAX_GRAPH_NEIGHBORS = 5;

    for (const { record: seed, score: seedScore } of scoredSeeds) {
      let hooksUsed = 0;
      for (const entity of seed.entities) {
        if (hooksUsed >= MAX_HOOKS_PER_SEED) break;
        const key = entity.toLowerCase();
        const bucket = invertedIndex.get(key);
        if (!bucket || bucket.length > stopThreshold) continue; // 停用实体跳过
        hooksUsed += 1;

        let added = 0;
        for (const neighbor of bucket) {
          if (added >= MAX_NEIGHBORS_PER_ENTITY) break;
          if (seedIds.has(neighbor.id)) continue; // 已是种子,跳过
          // 衰减分:0.5×种子分,再按共享实体数微增;取遇到的最高分(可能经多个种子命中)。
          const candidate = seedScore * 0.5;
          const prev = neighborScore.get(neighbor.id);
          if (!prev || candidate > prev.score) {
            neighborScore.set(neighbor.id, { record: neighbor, score: candidate });
          }
          added += 1;
        }
      }
    }

    const neighbors = [...neighborScore.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_GRAPH_NEIGHBORS)
      .map((e) => e.record);

    return [...seeds, ...neighbors];
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
      return ((baseline * TYPE_WEIGHT[record.type]) + recency + access + record.confidence) * polarityBoost(record);
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
    return ((lexScore * TYPE_WEIGHT[record.type]) + recency + access + record.confidence) * polarityBoost(record);
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
    // 极性记忆用明确的指令性前缀渲染,让模型在生成时直接据此取舍:
    //   negative -> 「avoid」(用户否定过的做法,应规避)
    //   positive -> 「prefer」(用户认可过的做法,应延续)
    //   中性     -> 维持原始 `type` 前缀,兼容旧记忆。
    if (record.polarity === 'negative') {
      return `- avoid: ${record.text} (confidence: ${record.confidence.toFixed(2)})\n`;
    }
    if (record.polarity === 'positive') {
      return `- prefer: ${record.text} (confidence: ${record.confidence.toFixed(2)})\n`;
    }
    return `- ${record.type}: ${record.text} (confidence: ${record.confidence.toFixed(2)})\n`;
  }
}
