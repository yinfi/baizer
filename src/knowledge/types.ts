// src/knowledge/types.ts

// ===== Artifact Enums =====

export const KNOWLEDGE_ARTIFACT_TYPES = [
  'summary', 'topic_page', 'global_index', 'health_report', 'file_back', 'ontology_schema'
] as const;

export type KnowledgeArtifactType = typeof KNOWLEDGE_ARTIFACT_TYPES[number];

export const KNOWLEDGE_REGISTRY_STATUSES = [
  'pending',
  'processing',
  'done',
  'stale',
  'failed',
  'partial',
  'missing_source',
] as const;

export type KnowledgeRegistryStatus = typeof KNOWLEDGE_REGISTRY_STATUSES[number];

export interface KnowledgeRegistryRecord {
  id: string;
  path: string;
  status: KnowledgeRegistryStatus;
  summary_path: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export interface KnowledgeRegistry {
  records: Record<string, KnowledgeRegistryRecord>;
}

export const VALID_STATUS_TRANSITIONS: Record<KnowledgeRegistryStatus, KnowledgeRegistryStatus[]> = {
  pending: ['processing', 'missing_source'],
  processing: ['done', 'failed', 'partial', 'missing_source'],
  done: ['stale', 'missing_source'],
  stale: ['pending', 'missing_source'],
  failed: ['pending', 'missing_source'],
  partial: ['pending', 'missing_source'],
  missing_source: ['pending'],
};

export function isValidTransition(
  from: KnowledgeRegistryStatus,
  to: KnowledgeRegistryStatus,
): boolean {
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
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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

  // Ontology extraction（可选，无 schema 时为 undefined）
  categorized_knowledge?: {
    category: string;
    items: string[];
  }[];
  entities?: {
    name: string;
    type: string;
    description: string;
  }[];
}

// ===== MetadataIndex Article =====

export interface ArticleMeta {
  sourceId: string;
  title: string;
  summaryPath: string;
  topics: string[];
  concepts: string[];
  keyClaims: string[];
  compiledAt: string;
  sourceUrl?: string;
  author?: string;
  // Ontology 扩展
  categorizedKnowledge?: { category: string; items: string[] }[];
  entities?: { name: string; type: string; description: string }[];
  schemaHash?: string;
}

// ===== Ontology Schema =====

export interface OntologyCategory {
  name: string;
  description: string;
}

export interface OntologyEntityType {
  name: string;
  description: string;
}

export interface OntologySchema {
  version: number;
  categories: OntologyCategory[];
  entity_types: OntologyEntityType[];
}

// ===== Constants =====

export const DEFAULT_WIKI_FOLDER = 'Knowledge Wiki';
export const WIKI_ARTICLES_SUBFOLDER = 'Articles';
export const WIKI_TOPICS_SUBFOLDER = 'Topics';
export const WIKI_HEALTH_SUBFOLDER = 'Health';
export const WIKI_INDEX_FILENAME = 'index.md';
export const WIKI_INDEX_BASE_FILENAME = 'index.base';
export const KNOWLEDGE_GENERATED_MARKER = 'knowledge_generated';
export const ONTOLOGY_SCHEMA_FILENAME = '_ontology.md';
