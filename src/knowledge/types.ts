// src/knowledge/types.ts

// ===== Status & Artifact Enums =====

export const KNOWLEDGE_REGISTRY_STATUSES = [
  'pending', 'processing', 'done', 'stale', 'failed', 'partial', 'missing_source'
] as const;

export type KnowledgeRegistryStatus = typeof KNOWLEDGE_REGISTRY_STATUSES[number];

export const KNOWLEDGE_ARTIFACT_TYPES = [
  'summary', 'topic_page', 'global_index', 'health_report', 'file_back'
] as const;

export type KnowledgeArtifactType = typeof KNOWLEDGE_ARTIFACT_TYPES[number];

// ===== State Machine =====

export const VALID_STATUS_TRANSITIONS: Record<KnowledgeRegistryStatus, KnowledgeRegistryStatus[]> = {
  pending:        ['processing', 'missing_source'],
  processing:     ['done', 'failed', 'partial', 'missing_source'],
  done:           ['stale', 'missing_source'],
  stale:          ['pending', 'missing_source'],
  failed:         ['pending', 'missing_source'],
  partial:        ['pending', 'missing_source'],
  missing_source: ['pending']
};

export function isValidTransition(from: KnowledgeRegistryStatus, to: KnowledgeRegistryStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// ===== Topic Normalization =====

export interface TopicRef {
  slug: string;
  label: string;
}

/**
 * 标准化 topic slug：小写化、去首尾空格、去标点、内部连续空格转 `-`
 * 例：`"Second Brain"` → `second-brain`，`"LLM Wiki!"` → `llm-wiki`
 */
export function normalizeTopicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')  // 去标点，保留 Unicode 字母/数字/空格/连字符
    .replace(/\s+/g, '-')               // 空格转连字符
    .replace(/-+/g, '-')                // 合并连续连字符
    .replace(/^-|-$/g, '');             // 去首尾连字符
}

// ===== Registry Record =====

export interface KnowledgeRegistryRecord {
  id: string;                           // ksrc_<random>
  path: string;                         // 原始笔记路径
  status: KnowledgeRegistryStatus;
  created_at: string;                   // ISO 8601
  updated_at: string;                   // ISO 8601
  summary_path: string | null;          // wiki summary 页路径
  error: string | null;                 // 最近一次错误信息
}

export interface KnowledgeRegistry {
  schema_version: number;
  records: Record<string, KnowledgeRegistryRecord>;
}

// ===== Compiler Extraction =====

export interface CompilerExtraction {
  title: string;
  author: string;
  source_url: string;
  created_at: string;
  topics: TopicRef[];
  concepts: string[];
  key_claims: string[];
  review_flags: string[];
}

// ===== File-Back Metadata =====

export interface FileBackMetadata {
  title: string;
  content: string;
  source_queries: string[];
  related_sources: string[];
}

// ===== Constants =====

export const KNOWLEDGE_REGISTRY_PATH = '.obsidian/obsidian-cli/knowledge-registry.json';
export const DEFAULT_WIKI_FOLDER = 'Knowledge Wiki';
export const WIKI_ARTICLES_SUBFOLDER = 'Articles';
export const WIKI_TOPICS_SUBFOLDER = 'Topics';
export const WIKI_HEALTH_SUBFOLDER = 'Health';
export const WIKI_INDEX_FILENAME = 'index.md';
export const KNOWLEDGE_GENERATED_MARKER = 'knowledge_generated';
