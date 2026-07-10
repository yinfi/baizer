export type MemoryType = 'world' | 'experience' | 'observation';

export interface MemoryBank {
  id: string;
  name: string;
  mission: string;
  directives: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  kind: 'chat' | 'tool' | 'profile-migration' | 'summary-migration' | 'manual';
  messageId?: string;
  action?: string;
  target?: string;
}

export interface MemoryRecord {
  id: string;
  bankId: string;
  type: MemoryType;
  text: string;
  normalizedText: string;
  entities: string[];
  tags: string[];
  source: MemorySource;
  confidence: number;
  /**
   * 记忆极性:
   * - 'positive' 用户认可的做法(可强化);
   * - 'negative' 用户否定的做法,召回时渲染为「应避免」以约束生成;
   * - 缺省(undefined)= 中性,等价于旧数据,向后兼容。
   */
  polarity?: 'positive' | 'negative';
  createdAt: number;
  updatedAt: number;
  mentionedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  supersedes?: string[];
  evidenceIds?: string[];
}

export interface MemoryRecallRequest {
  bankId?: string;
  query: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  maxRecords?: number;
  maxChars?: number;
  includeTypes?: MemoryType[];
  now?: number;
}

export interface MemoryRecallResult {
  records: MemoryRecord[];
  promptBlock: string;
}

export interface RetainTurnInput {
  bankId?: string;
  userMessage: string;
  assistantMessage: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  contextPaths?: string[];
  toolResults?: Array<{ name: string; result: unknown }>;
  now?: number;
}

/**
 * 用户点踩(负反馈)时提炼一条「应避免」教训的输入。
 * userInput 决定该教训未来被哪些相似提问召回;reason 是用户给出的不满意原因。
 */
export interface RetainLessonInput {
  bankId?: string;
  userInput: string;
  rejectedOutput: string;
  reason: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  now?: number;
}

export const DEFAULT_MEMORY_BANK_ID = 'default';

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 记忆入库前的密钥脱敏。纯函数、无副作用,供 retain 热路径与迁移导入共用,
 * 确保任何写入 memories.json 的文本都不残留 token/key/password。
 */
export function sanitizeMemoryText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
    .replace(/\b(api\s*key|token|password|secret)\s*(?:is|=|:)\s*([^\s,;]+)/gi, '$1 is [REDACTED]');
}

export function tokenizeMemoryText(value: string): string[] {
  return normalizeMemoryText(value)
    .split(/[^a-z0-9\u4e00-\u9fff_.:/-]+/i)
    .filter((token) => token.length >= 2);
}

/**
 * Retrieval tokenizer: extends tokenizeMemoryText by expanding every contiguous
 * CJK run into overlapping character bigrams (Lucene CJKBigram approach).
 *
 * \u300c\u8bb0\u5fc6\u8bed\u4e49\u53ec\u56de\u300d -> \u8bb0\u5fc6, \u5fc6\u8bed, \u8bed\u4e49, \u4e49\u53ec, \u53ec\u56de
 *
 * This lets a query \u300c\u8bb0\u5fc6\u53ec\u56de\u300d(tokens: \u8bb0\u5fc6, \u53ec\u56de) overlap with a document
 * containing \u300c\u8bb0\u5fc6\u8bed\u4e49\u53ec\u56de\u300d on both terms, whereas the original tokenizer
 * would produce a single token \u300c\u8bb0\u5fc6\u8bed\u4e49\u53ec\u56de\u300d that never matches \u300c\u8bb0\u5fc6\u53ec\u56de\u300d.
 *
 * Latin/alphanumeric tokens are kept as-is (min length 2 unchanged).
 * CJK single-character runs emit a unigram so length-1 words are not lost.
 * All bigrams are length 2, satisfying the >=2 filter naturally.
 *
 * No new imports \u2014 pure Map/string/Array, mobile-safe.
 */
export function tokenizeForRetrieval(value: string): string[] {
  const raw = normalizeMemoryText(value)
    .split(/[^a-z0-9\u4e00-\u9fff_.:/-]+/i)
    .filter((token) => token.length >= 1);

  const result: string[] = [];
  // Track bigrams already emitted to avoid duplicates within the same value
  const seen = new Set<string>();

  for (const token of raw) {
    // Detect whether the token is a pure CJK run
    const isCjk = /^[\u4e00-\u9fff]+$/.test(token);

    if (!isCjk) {
      // Keep latin / mixed tokens with the same min-length-2 rule as the original
      if (token.length >= 2) {
        if (!seen.has(token)) {
          seen.add(token);
          result.push(token);
        }
      }
    } else if (token.length === 1) {
      // Single CJK character: emit as unigram (no bigram possible)
      if (!seen.has(token)) {
        seen.add(token);
        result.push(token);
      }
    } else {
      // Multi-character CJK run: emit overlapping bigrams
      for (let i = 0; i < token.length - 1; i += 1) {
        const bigram = token[i] + token[i + 1];
        if (!seen.has(bigram)) {
          seen.add(bigram);
          result.push(bigram);
        }
      }
    }
  }

  return result;
}

export function createMemoryId(input: {
  bankId: string;
  type: MemoryType;
  text: string;
  sourceKind: string;
}): string {
  const raw = `${input.bankId}|${input.type}|${input.sourceKind}|${normalizeMemoryText(input.text)}`;
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(index);
    hash |= 0;
  }
  return `mem_${Math.abs(hash).toString(36)}`;
}

export function createDefaultMemoryBank(now: number = Date.now()): MemoryBank {
  return {
    id: DEFAULT_MEMORY_BANK_ID,
    name: 'Default Vault Memory',
    mission: 'Help Baizer personalize answers and remember durable user preferences, projects, decisions, and prior work.',
    directives: [
      'Prefer facts grounded in user messages or approved operations.',
      'Do not store secrets, API keys, tokens, passwords, or long private note excerpts.',
      'Prefer concise, reusable memories over raw transcript dumps.',
    ],
    createdAt: now,
    updatedAt: now,
  };
}
