# Knowledge Wiki Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a knowledge wiki system that compiles notes from watched folders into structured summary pages, then surfaces that knowledge in Shell Q&A (via function calling) and Guardian completions (via context pre-injection).

**Architecture:** New `src/knowledge/` subsystem with 9 modules. Compilation uses stateless AI calls separate from Shell chat. Consumption adds `query_knowledge` and `file_back_knowledge` tools to the existing function calling pipeline. Guardian gets lightweight keyword-based knowledge injection. Shell messages get thumbs up/down buttons for file-back feedback.

**Tech Stack:** TypeScript, Obsidian Plugin API, existing ModelService/ToolManager, Markdown frontmatter, JSON registry, `tsx` for contract tests.

---

## Chunk 1: Types, Registry, and Topic Utils

### Task 1: Create Knowledge Types and Constants

**Files:**
- Create: `src/knowledge/types.ts`
- Create: `test/knowledge/types.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/types.test.ts

import {
  KNOWLEDGE_REGISTRY_STATUSES,
  KNOWLEDGE_ARTIFACT_TYPES,
  KnowledgeRegistryStatus,
  KnowledgeArtifactType,
  KnowledgeRegistryRecord,
  KnowledgeRegistry,
  TopicRef,
  CompilerExtraction,
  VALID_STATUS_TRANSITIONS,
  isValidTransition,
  normalizeTopicSlug
} from '../../src/knowledge/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy but got ${actual}`);
    },
    toBeFalsy: () => {
      if (actual) throw new Error(`Expected falsy but got ${actual}`);
    },
    toContain: (expected: any) => {
      if (!actual.includes(expected)) throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Knowledge Types Tests ===');

test('KNOWLEDGE_REGISTRY_STATUSES has all 7 statuses', () => {
  expect(KNOWLEDGE_REGISTRY_STATUSES.length).toBe(7);
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('pending');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('processing');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('done');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('stale');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('failed');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('partial');
  expect(KNOWLEDGE_REGISTRY_STATUSES).toContain('missing_source');
});

test('KNOWLEDGE_ARTIFACT_TYPES has all 5 types', () => {
  expect(KNOWLEDGE_ARTIFACT_TYPES.length).toBe(5);
  expect(KNOWLEDGE_ARTIFACT_TYPES).toContain('summary');
  expect(KNOWLEDGE_ARTIFACT_TYPES).toContain('topic_page');
  expect(KNOWLEDGE_ARTIFACT_TYPES).toContain('global_index');
  expect(KNOWLEDGE_ARTIFACT_TYPES).toContain('health_report');
  expect(KNOWLEDGE_ARTIFACT_TYPES).toContain('file_back');
});

test('normalizeTopicSlug handles standard cases', () => {
  expect(normalizeTopicSlug('Second Brain')).toBe('second-brain');
  expect(normalizeTopicSlug('LLM Wiki!')).toBe('llm-wiki');
  expect(normalizeTopicSlug('  Hello   World  ')).toBe('hello-world');
  expect(normalizeTopicSlug('AI/ML & Data')).toBe('aiml-data');
  expect(normalizeTopicSlug('中文标签')).toBe('中文标签');
});

test('isValidTransition allows valid transitions', () => {
  expect(isValidTransition('pending', 'processing')).toBeTruthy();
  expect(isValidTransition('processing', 'done')).toBeTruthy();
  expect(isValidTransition('processing', 'failed')).toBeTruthy();
  expect(isValidTransition('done', 'stale')).toBeTruthy();
  expect(isValidTransition('stale', 'pending')).toBeTruthy();
  expect(isValidTransition('failed', 'pending')).toBeTruthy();
});

test('isValidTransition rejects invalid transitions', () => {
  expect(isValidTransition('pending', 'done')).toBeFalsy();
  expect(isValidTransition('done', 'processing')).toBeFalsy();
  expect(isValidTransition('failed', 'done')).toBeFalsy();
});

test('any status can transition to missing_source', () => {
  expect(isValidTransition('pending', 'missing_source')).toBeTruthy();
  expect(isValidTransition('processing', 'missing_source')).toBeTruthy();
  expect(isValidTransition('done', 'missing_source')).toBeTruthy();
  expect(isValidTransition('stale', 'missing_source')).toBeTruthy();
  expect(isValidTransition('failed', 'missing_source')).toBeTruthy();
});

console.log('All types tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/types.test.ts`

- [ ] **Step 2: Write the types file**

```typescript
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

export const KNOWLEDGE_REGISTRY_PATH = '.obsidian/baizer/knowledge-registry.json';
export const DEFAULT_WIKI_FOLDER = 'Knowledge Wiki';
export const WIKI_ARTICLES_SUBFOLDER = 'Articles';
export const WIKI_TOPICS_SUBFOLDER = 'Topics';
export const WIKI_HEALTH_SUBFOLDER = 'Health';
export const WIKI_INDEX_FILENAME = 'index.md';
export const KNOWLEDGE_GENERATED_MARKER = 'knowledge_generated';
```

Run: `cmd /c npx.cmd tsx test/knowledge/types.test.ts`

- [ ] **Step 3: Verify build**

Run: `cmd /c npm.cmd run build`

- [ ] **Step 4: Commit**

```
git add src/knowledge/types.ts test/knowledge/types.test.ts
git commit -m "feat(knowledge): add types, constants, and topic normalization"
```

---

### Task 2: Create Knowledge Registry

**Files:**
- Create: `src/knowledge/registry.ts`
- Create: `test/knowledge/registry.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/registry.test.ts

import { KnowledgeRegistryManager } from '../../src/knowledge/registry';
import { KnowledgeRegistry, KnowledgeRegistryRecord } from '../../src/knowledge/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy but got ${actual}`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy but got ${actual}`); },
    toBeDefined: () => { if (actual === undefined) throw new Error(`Expected defined`); },
    toBeNull: () => { if (actual !== null) throw new Error(`Expected null but got ${actual}`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    },
    toThrow: () => {
      // actual should be a function
      let threw = false;
      try { actual(); } catch { threw = true; }
      if (!threw) throw new Error('Expected function to throw');
    }
  };
}

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    result.then(() => console.log(`  ✓ ${name}`))
      .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); });
  } else {
    try { console.log(`  ✓ ${name}`); }
    catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
  }
}

// Mock vault adapter
function createMockAdapter() {
  let storage: Record<string, string> = {};
  return {
    storage,
    exists: async (path: string) => path in storage,
    read: async (path: string) => {
      if (!(path in storage)) throw new Error('File not found');
      return storage[path];
    },
    write: async (path: string, data: string) => { storage[path] = data; },
    mkdir: async (path: string) => { /* no-op for test */ }
  };
}

console.log('=== Knowledge Registry Tests ===');

test('generateId produces ksrc_ prefixed IDs', () => {
  const id = KnowledgeRegistryManager.generateId();
  expect(id.startsWith('ksrc_')).toBeTruthy();
  expect(id.length > 10).toBeTruthy();
});

test('generateId produces unique IDs', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(KnowledgeRegistryManager.generateId());
  expect(ids.size).toBe(100);
});

test('empty registry initializes correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const all = mgr.getAllRecords();
  expect(Object.keys(all).length).toBe(0);
});

test('register creates a pending record', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('Clippings/test.md');
  expect(record.status).toBe('pending');
  expect(record.path).toBe('Clippings/test.md');
  expect(record.id.startsWith('ksrc_')).toBeTruthy();
  expect(record.summary_path).toBeNull();
  expect(record.error).toBeNull();
});

test('transition updates status correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('test.md');
  mgr.transition(record.id, 'processing');
  expect(mgr.getRecord(record.id)!.status).toBe('processing');
  mgr.transition(record.id, 'done');
  expect(mgr.getRecord(record.id)!.status).toBe('done');
});

test('invalid transition throws', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const record = mgr.register('test.md');
  // pending -> done is invalid
  expect(() => mgr.transition(record.id, 'done')).toThrow();
});

test('findByPath returns correct record', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  mgr.register('Clippings/a.md');
  mgr.register('Clippings/b.md');
  const found = mgr.findByPath('Clippings/a.md');
  expect(found).toBeDefined();
  expect(found!.path).toBe('Clippings/a.md');
});

test('getByStatus filters correctly', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r1 = mgr.register('a.md');
  const r2 = mgr.register('b.md');
  mgr.transition(r1.id, 'processing');
  mgr.transition(r1.id, 'done');
  const pending = mgr.getByStatus('pending');
  expect(pending.length).toBe(1);
  expect(pending[0].path).toBe('b.md');
  const done = mgr.getByStatus('done');
  expect(done.length).toBe(1);
  expect(done[0].path).toBe('a.md');
});

test('resetProcessingOnStartup resets processing to pending', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r = mgr.register('test.md');
  mgr.transition(r.id, 'processing');
  mgr.resetProcessingOnStartup();
  expect(mgr.getRecord(r.id)!.status).toBe('pending');
});

test('save and load round-trip', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  mgr.register('test.md');
  await mgr.save();

  const mgr2 = new KnowledgeRegistryManager(adapter as any);
  await mgr2.load();
  const found = mgr2.findByPath('test.md');
  expect(found).toBeDefined();
  expect(found!.path).toBe('test.md');
});

test('updatePath changes record path', async () => {
  const adapter = createMockAdapter();
  const mgr = new KnowledgeRegistryManager(adapter as any);
  await mgr.load();
  const r = mgr.register('old.md');
  mgr.updatePath(r.id, 'new.md');
  expect(mgr.getRecord(r.id)!.path).toBe('new.md');
  expect(mgr.findByPath('old.md')).toBeNull();
  expect(mgr.findByPath('new.md')).toBeDefined();
});

console.log('All registry tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/registry.test.ts`

- [ ] **Step 2: Write the registry module**

```typescript
// src/knowledge/registry.ts

import {
  KnowledgeRegistry,
  KnowledgeRegistryRecord,
  KnowledgeRegistryStatus,
  KNOWLEDGE_REGISTRY_PATH,
  isValidTransition
} from './types';

/**
 * 知识注册表管理器
 * 跟踪哪些笔记已进入知识管线及其当前状态
 * 存储位置：.obsidian/baizer/knowledge-registry.json
 */
export class KnowledgeRegistryManager {
  private registry: KnowledgeRegistry = { schema_version: 1, records: {} };
  private pathIndex: Map<string, string> = new Map(); // path -> id 快速查找

  constructor(private adapter: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
  }) {}

  static generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 12; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `ksrc_${suffix}`;
  }

  async load(): Promise<void> {
    try {
      if (await this.adapter.exists(KNOWLEDGE_REGISTRY_PATH)) {
        const raw = await this.adapter.read(KNOWLEDGE_REGISTRY_PATH);
        this.registry = JSON.parse(raw);
      } else {
        this.registry = { schema_version: 1, records: {} };
      }
    } catch {
      this.registry = { schema_version: 1, records: {} };
    }
    this.rebuildPathIndex();
  }

  async save(): Promise<void> {
    const dir = KNOWLEDGE_REGISTRY_PATH.split('/').slice(0, -1).join('/');
    try { await this.adapter.mkdir(dir); } catch { /* already exists */ }
    await this.adapter.write(KNOWLEDGE_REGISTRY_PATH, JSON.stringify(this.registry, null, 2));
  }

  private rebuildPathIndex(): void {
    this.pathIndex.clear();
    for (const [id, record] of Object.entries(this.registry.records)) {
      this.pathIndex.set(record.path, id);
    }
  }

  register(path: string): KnowledgeRegistryRecord {
    // 检查是否已注册
    const existing = this.findByPath(path);
    if (existing) return existing;

    const id = KnowledgeRegistryManager.generateId();
    // 检查 ID 冲突
    if (this.registry.records[id]) {
      throw new Error(`Registry ID collision: ${id}`);
    }

    const now = new Date().toISOString();
    const record: KnowledgeRegistryRecord = {
      id,
      path,
      status: 'pending',
      created_at: now,
      updated_at: now,
      summary_path: null,
      error: null
    };

    this.registry.records[id] = record;
    this.pathIndex.set(path, id);
    return record;
  }

  transition(id: string, to: KnowledgeRegistryStatus, error?: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    if (!isValidTransition(record.status, to)) {
      throw new Error(`Invalid transition: ${record.status} -> ${to} for ${id}`);
    }
    record.status = to;
    record.updated_at = new Date().toISOString();
    record.error = error ?? null;
  }

  setSummaryPath(id: string, summaryPath: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    record.summary_path = summaryPath;
    record.updated_at = new Date().toISOString();
  }

  getRecord(id: string): KnowledgeRegistryRecord | null {
    return this.registry.records[id] ?? null;
  }

  findByPath(path: string): KnowledgeRegistryRecord | null {
    const id = this.pathIndex.get(path);
    if (!id) return null;
    return this.registry.records[id] ?? null;
  }

  getAllRecords(): Record<string, KnowledgeRegistryRecord> {
    return { ...this.registry.records };
  }

  getByStatus(status: KnowledgeRegistryStatus): KnowledgeRegistryRecord[] {
    return Object.values(this.registry.records).filter(r => r.status === status);
  }

  updatePath(id: string, newPath: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    this.pathIndex.delete(record.path);
    record.path = newPath;
    record.updated_at = new Date().toISOString();
    this.pathIndex.set(newPath, id);
  }

  /**
   * 插件重启时，processing 状态重置为 pending
   */
  resetProcessingOnStartup(): void {
    for (const record of Object.values(this.registry.records)) {
      if (record.status === 'processing') {
        record.status = 'pending';
        record.updated_at = new Date().toISOString();
      }
    }
  }

  /**
   * 获取所有已完成编译且有 summary 的记录（用于索引构建）
   */
  getCompletedRecords(): KnowledgeRegistryRecord[] {
    return Object.values(this.registry.records)
      .filter(r => r.status === 'done' && r.summary_path);
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/registry.test.ts`

- [ ] **Step 3: Verify build**

Run: `cmd /c npm.cmd run build`

- [ ] **Step 4: Commit**

```
git add src/knowledge/registry.ts test/knowledge/registry.test.ts
git commit -m "feat(knowledge): add registry manager with state machine"
```

---

### Task 3: Topic Utilities (buildTopicPage, removeOrphanTopics)

**Files:**
- Create: `src/knowledge/topic-utils.ts`
- Create: `test/knowledge/topic-utils.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/topic-utils.test.ts

import { normalizeTopicSlug, TopicRef } from '../../src/knowledge/types';
import {
  buildTopicPageContent,
  parseTopicPageEntries,
  collectAllTopics
} from '../../src/knowledge/topic-utils';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Topic Utils Tests ===');

test('buildTopicPageContent generates valid markdown', () => {
  const entries = [
    { title: 'Article A', summaryPath: 'Knowledge Wiki/Articles/ksrc_aaa.md' },
    { title: 'Article B', summaryPath: 'Knowledge Wiki/Articles/ksrc_bbb.md' }
  ];
  const content = buildTopicPageContent('second-brain', 'Second Brain', entries);
  expect(content).toContain('knowledge_generated: true');
  expect(content).toContain('knowledge_artifact_type: "topic_page"');
  expect(content).toContain('# Second Brain');
  expect(content).toContain('[[Knowledge Wiki/Articles/ksrc_aaa.md|Article A]]');
  expect(content).toContain('[[Knowledge Wiki/Articles/ksrc_bbb.md|Article B]]');
});

test('buildTopicPageContent with empty entries', () => {
  const content = buildTopicPageContent('empty', 'Empty', []);
  expect(content).toContain('# Empty');
  expect(content).toContain('暂无相关文章');
});

test('collectAllTopics deduplicates by slug', () => {
  const topicSets: TopicRef[][] = [
    [{ slug: 'ai', label: 'AI' }, { slug: 'ml', label: 'ML' }],
    [{ slug: 'ai', label: 'Artificial Intelligence' }, { slug: 'data', label: 'Data' }]
  ];
  const result = collectAllTopics(topicSets);
  expect(result.size).toBe(3);
  expect(result.has('ai')).toBeTruthy();
  expect(result.has('ml')).toBeTruthy();
  expect(result.has('data')).toBeTruthy();
});

console.log('All topic utils tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/topic-utils.test.ts`

- [ ] **Step 2: Write the topic-utils module**

```typescript
// src/knowledge/topic-utils.ts

import { TopicRef } from './types';

export interface TopicPageEntry {
  title: string;
  summaryPath: string;
}

/**
 * 生成 topic 页的 Markdown 内容
 */
export function buildTopicPageContent(
  slug: string,
  label: string,
  entries: TopicPageEntry[]
): string {
  const now = new Date().toISOString();
  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "topic_page"\ntopic_slug: "${slug}"\ncompiled_at: "${now}"\n---\n# ${label}\n\n`;

  if (entries.length === 0) {
    md += '暂无相关文章。\n';
  } else {
    md += '## 相关文章\n\n';
    for (const entry of entries) {
      md += `- [[${entry.summaryPath}|${entry.title}]]\n`;
    }
  }
  return md;
}

/**
 * 从 topic 页内容中解析出已有的条目链接（用于增量更新判断）
 */
export function parseTopicPageEntries(content: string): TopicPageEntry[] {
  const entries: TopicPageEntry[] = [];
  const regex = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ summaryPath: match[1], title: match[2] });
  }
  return entries;
}

/**
 * 从多组 topics 中收集所有唯一的 slug，返回 slug -> label 映射
 * 同一 slug 出现多次时，保留第一次遇到的 label
 */
export function collectAllTopics(topicSets: TopicRef[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const topics of topicSets) {
    for (const t of topics) {
      if (!map.has(t.slug)) {
        map.set(t.slug, t.label);
      }
    }
  }
  return map;
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/topic-utils.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/topic-utils.ts test/knowledge/topic-utils.test.ts
git commit -m "feat(knowledge): add topic page utilities"
```

---

## Chunk 2: Compiler and Indexer

### Task 4: Create Knowledge Compiler

**Files:**
- Create: `src/knowledge/compiler.ts`
- Create: `test/knowledge/compiler.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/compiler.test.ts

import {
  KnowledgeCompiler,
  buildCompilerPrompt,
  parseCompilerResponse,
  buildSummaryMarkdown
} from '../../src/knowledge/compiler';
import { CompilerExtraction } from '../../src/knowledge/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); },
    toBeDefined: () => { if (actual === undefined) throw new Error(`Expected defined`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Knowledge Compiler Tests ===');

test('buildCompilerPrompt includes note content and path', () => {
  const prompt = buildCompilerPrompt('# Hello\nSome content', 'Clippings/test.md');
  expect(prompt).toContain('# Hello');
  expect(prompt).toContain('Some content');
  expect(prompt).toContain('Clippings/test.md');
});

test('parseCompilerResponse extracts valid JSON', () => {
  const response = `Here is the extraction:
\`\`\`json
{
  "title": "Test Article",
  "author": "Author",
  "source_url": "https://example.com",
  "created_at": "2026-04-08T00:00:00Z",
  "topics": [{"slug": "test", "label": "Test"}],
  "concepts": ["concept1"],
  "key_claims": ["claim1"],
  "review_flags": []
}
\`\`\``;
  const result = parseCompilerResponse(response);
  expect(result).toBeDefined();
  expect(result!.title).toBe('Test Article');
  expect(result!.author).toBe('Author');
  expect(result!.topics.length).toBe(1);
  expect(result!.concepts.length).toBe(1);
});

test('parseCompilerResponse handles raw JSON without code fence', () => {
  const response = `{"title":"Raw","author":"","source_url":"","created_at":"","topics":[],"concepts":[],"key_claims":[],"review_flags":[]}`;
  const result = parseCompilerResponse(response);
  expect(result).toBeDefined();
  expect(result!.title).toBe('Raw');
});

test('parseCompilerResponse returns null for invalid response', () => {
  const result = parseCompilerResponse('This is not JSON at all');
  expect(result === null).toBeTruthy();
});

test('buildSummaryMarkdown generates correct frontmatter and body', () => {
  const extraction: CompilerExtraction = {
    title: 'Karpathy 的第二大脑',
    author: '新智元',
    source_url: 'https://mp.weixin.qq.com/test',
    created_at: '2026-04-05T09:46:50Z',
    topics: [
      { slug: 'second-brain', label: 'Second Brain' },
      { slug: 'llm-wiki', label: 'LLM Wiki' }
    ],
    concepts: ['知识编译', 'LLM Wiki', '第二大脑'],
    key_claims: ['原始文件保持本地可控', 'AI 编译成结构化知识层'],
    review_flags: []
  };
  const md = buildSummaryMarkdown('ksrc_abc123', extraction, 'Clippings/test.md');
  expect(md).toContain('knowledge_generated: true');
  expect(md).toContain('knowledge_source_id: "ksrc_abc123"');
  expect(md).toContain('title: "Karpathy 的第二大脑"');
  expect(md).toContain('author: "新智元"');
  expect(md).toContain('source_url: "https://mp.weixin.qq.com/test"');
  expect(md).toContain('slug: "second-brain"');
  expect(md).toContain('# Karpathy 的第二大脑');
  expect(md).toContain('## 核心观点');
  expect(md).toContain('- 原始文件保持本地可控');
  expect(md).toContain('## 关键概念');
  expect(md).toContain('- 知识编译');
  expect(md).toContain('## 原始来源');
  expect(md).toContain('[[Clippings/test.md]]');
});

test('buildSummaryMarkdown handles missing_source', () => {
  const extraction: CompilerExtraction = {
    title: 'Test', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: []
  };
  const md = buildSummaryMarkdown('ksrc_x', extraction, null);
  expect(md).toContain('原始来源已删除');
});

console.log('All compiler tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/compiler.test.ts`

- [ ] **Step 2: Write the compiler module**

```typescript
// src/knowledge/compiler.ts

import { App, TFile } from 'obsidian';
import { CompilerExtraction, TopicRef, normalizeTopicSlug } from './types';
import { KnowledgeRegistryManager } from './registry';

/**
 * 构建编译器 prompt：让 AI 从原始笔记中提取结构化字段
 * 无状态调用，不走 function calling 循环
 */
export function buildCompilerPrompt(noteContent: string, notePath: string): string {
  return `你是一个知识编译器。请从以下笔记中提取结构化信息。

笔记路径: ${notePath}

笔记内容:
---
${noteContent.substring(0, 30000)}
---

请提取以下字段，以 JSON 格式返回（不要添加任何其他文字）：

\`\`\`json
{
  "title": "文章标题",
  "author": "作者（如果能识别）",
  "source_url": "来源 URL（如果 frontmatter 中有 source 字段）",
  "created_at": "创建时间（ISO 8601，如果能识别）",
  "topics": [
    {"slug": "标准化的-slug", "label": "显示标签"}
  ],
  "concepts": ["关键概念1", "关键概念2"],
  "key_claims": ["核心观点1", "核心观点2"],
  "review_flags": ["低置信度提取说明（如有）"]
}
\`\`\`

规则：
- topics 的 slug 必须是小写、连字符分隔的英文或中文
- 如果无法确定某个字段，留空字符串或空数组
- review_flags 用于标记你不确定的提取结果
- 不要编造信息，只提取笔记中实际存在的内容`;
}

/**
 * 解析 AI 返回的编译结果
 */
export function parseCompilerResponse(response: string): CompilerExtraction | null {
  try {
    // 尝试从 code fence 中提取 JSON
    const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();

    const parsed = JSON.parse(jsonStr);

    // 验证必要字段存在
    if (typeof parsed.title !== 'string') return null;

    // 标准化 topics slug
    const topics: TopicRef[] = (parsed.topics || []).map((t: any) => ({
      slug: normalizeTopicSlug(t.slug || t.label || ''),
      label: t.label || t.slug || ''
    })).filter((t: TopicRef) => t.slug.length > 0);

    return {
      title: parsed.title || '',
      author: parsed.author || '',
      source_url: parsed.source_url || '',
      created_at: parsed.created_at || '',
      topics,
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      key_claims: Array.isArray(parsed.key_claims) ? parsed.key_claims : [],
      review_flags: Array.isArray(parsed.review_flags) ? parsed.review_flags : []
    };
  } catch {
    return null;
  }
}

/**
 * 生成 summary 页的 Markdown 内容
 * @param sourceId - registry 中的 ID
 * @param extraction - AI 提取的结构化数据
 * @param sourcePath - 原始笔记路径，null 表示 missing_source
 */
export function buildSummaryMarkdown(
  sourceId: string,
  extraction: CompilerExtraction,
  sourcePath: string | null
): string {
  const now = new Date().toISOString();

  // 构建 frontmatter
  let fm = '---\n';
  fm += 'knowledge_generated: true\n';
  fm += `knowledge_source_id: "${sourceId}"\n`;
  fm += `title: "${extraction.title.replace(/"/g, '\\"')}"\n`;
  if (extraction.source_url) fm += `source_url: "${extraction.source_url}"\n`;
  if (extraction.author) fm += `author: "${extraction.author.replace(/"/g, '\\"')}"\n`;
  if (extraction.created_at) fm += `created_at: "${extraction.created_at}"\n`;
  fm += `compiled_at: "${now}"\n`;

  if (extraction.topics.length > 0) {
    fm += 'topics:\n';
    for (const t of extraction.topics) {
      fm += `  - slug: "${t.slug}"\n    label: "${t.label}"\n`;
    }
  }

  if (extraction.concepts.length > 0) {
    fm += `concepts: ${JSON.stringify(extraction.concepts)}\n`;
  }

  if (extraction.key_claims.length > 0) {
    fm += 'key_claims:\n';
    for (const claim of extraction.key_claims) {
      fm += `  - "${claim.replace(/"/g, '\\"')}"\n`;
    }
  }

  if (extraction.review_flags.length > 0) {
    fm += `review_flags: ${JSON.stringify(extraction.review_flags)}\n`;
  } else {
    fm += 'review_flags: []\n';
  }

  fm += '---\n';

  // 构建正文
  let body = `# ${extraction.title}\n\n`;

  // 摘要区（由 AI 在 key_claims 基础上生成简要描述）
  body += '## 摘要\n\n';
  if (extraction.key_claims.length > 0) {
    body += extraction.key_claims.map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无核心观点提取）\n';
  }

  body += '\n## 核心观点\n\n';
  if (extraction.key_claims.length > 0) {
    body += extraction.key_claims.map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无）\n';
  }

  body += '\n## 关键概念\n\n';
  if (extraction.concepts.length > 0) {
    body += extraction.concepts.map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无）\n';
  }

  body += '\n## 原始来源\n\n';
  if (sourcePath) {
    body += `[[${sourcePath}]]\n`;
  } else {
    body += '原始来源已删除。\n';
  }

  return fm + body;
}

/**
 * 编译器主类：协调 registry、AI 调用、文件写入
 */
export class KnowledgeCompiler {
  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private generateFn: (prompt: string) => Promise<string>,
    private wikiFolder: string
  ) {}

  /**
   * 编译单篇笔记
   * @returns summary 文件路径，或 null（失败时）
   */
  async compileNote(sourceId: string): Promise<string | null> {
    const record = this.registry.getRecord(sourceId);
    if (!record) throw new Error(`Record not found: ${sourceId}`);

    // 检查源文件是否存在
    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!file || !(file instanceof TFile)) {
      this.registry.transition(sourceId, 'missing_source');
      await this.registry.save();
      return null;
    }

    this.registry.transition(sourceId, 'processing');
    await this.registry.save();

    try {
      // 读取原始笔记
      const content = await this.app.vault.read(file);

      // AI 提取
      const prompt = buildCompilerPrompt(content, record.path);
      const response = await this.generateFn(prompt);
      const extraction = parseCompilerResponse(response);

      if (!extraction) {
        this.registry.transition(sourceId, 'failed', 'Failed to parse AI response');
        await this.registry.save();
        return null;
      }

      // 生成 summary 页
      const summaryPath = `${this.wikiFolder}/Articles/${sourceId}.md`;
      const summaryContent = buildSummaryMarkdown(sourceId, extraction, record.path);

      // 确保目录存在
      const articlesDir = `${this.wikiFolder}/Articles`;
      if (!this.app.vault.getAbstractFileByPath(articlesDir)) {
        await this.app.vault.createFolder(articlesDir);
      }

      // 写入（幂等：覆盖已有的 knowledge_generated 文件）
      const existingFile = this.app.vault.getAbstractFileByPath(summaryPath);
      if (existingFile && existingFile instanceof TFile) {
        // 检查是否是 knowledge_generated 文件
        const existingContent = await this.app.vault.read(existingFile);
        if (!existingContent.includes('knowledge_generated: true')) {
          this.registry.transition(sourceId, 'failed', 'Target file exists and is not a generated file');
          await this.registry.save();
          return null;
        }
        await this.app.vault.modify(existingFile, summaryContent);
      } else {
        await this.app.vault.create(summaryPath, summaryContent);
      }

      // 更新 registry
      this.registry.setSummaryPath(sourceId, summaryPath);
      this.registry.transition(sourceId, 'done');
      await this.registry.save();

      return summaryPath;
    } catch (e: any) {
      try {
        this.registry.transition(sourceId, 'failed', e.message);
      } catch { /* 状态可能已经不允许转换 */ }
      await this.registry.save();
      return null;
    }
  }

  /**
   * 批量编译所有 pending 和 stale 项
   * stale 先转为 pending 再处理
   */
  async compileAllPending(maxBatch: number = 10): Promise<{ success: number; failed: number }> {
    // stale -> pending
    const staleRecords = this.registry.getByStatus('stale');
    for (const r of staleRecords) {
      this.registry.transition(r.id, 'pending');
    }
    await this.registry.save();

    const pendingRecords = this.registry.getByStatus('pending').slice(0, maxBatch);
    let success = 0;
    let failed = 0;

    for (const record of pendingRecords) {
      const result = await this.compileNote(record.id);
      if (result) { success++; } else { failed++; }
    }

    return { success, failed };
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/compiler.test.ts`

- [ ] **Step 3: Verify build**

Run: `cmd /c npm.cmd run build`

- [ ] **Step 4: Commit**

```
git add src/knowledge/compiler.ts test/knowledge/compiler.test.ts
git commit -m "feat(knowledge): add compiler with AI extraction and summary generation"
```

---

### Task 5: Create Wiki Indexer

**Files:**
- Create: `src/knowledge/indexer.ts`
- Create: `test/knowledge/indexer.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/indexer.test.ts

import {
  buildGlobalIndexContent,
  IndexArticleEntry,
  IndexTopicEntry
} from '../../src/knowledge/indexer';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    },
    not: {
      toContain: (expected: string) => {
        if (typeof actual === 'string' && actual.includes(expected))
          throw new Error(`Expected NOT to contain "${expected}"`);
      }
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Wiki Indexer Tests ===');

test('buildGlobalIndexContent generates valid frontmatter', () => {
  const content = buildGlobalIndexContent([], []);
  expect(content).toContain('knowledge_generated: true');
  expect(content).toContain('knowledge_artifact_type: "global_index"');
  expect(content).toContain('# Knowledge Wiki');
});

test('buildGlobalIndexContent lists articles sorted by compiled_at desc', () => {
  const articles: IndexArticleEntry[] = [
    { title: 'Old Article', summaryPath: 'KW/Articles/old.md', compiledAt: '2026-04-01T00:00:00Z', sourceId: 'ksrc_old' },
    { title: 'New Article', summaryPath: 'KW/Articles/new.md', compiledAt: '2026-04-08T00:00:00Z', sourceId: 'ksrc_new' }
  ];
  const content = buildGlobalIndexContent(articles, []);
  const oldIdx = content.indexOf('Old Article');
  const newIdx = content.indexOf('New Article');
  // New should come before Old (descending)
  expect(newIdx < oldIdx).toBeTruthy();
});

test('buildGlobalIndexContent lists topics alphabetically', () => {
  const topics: IndexTopicEntry[] = [
    { slug: 'zzz', label: 'ZZZ', topicPagePath: 'KW/Topics/zzz.md' },
    { slug: 'aaa', label: 'AAA', topicPagePath: 'KW/Topics/aaa.md' }
  ];
  const content = buildGlobalIndexContent([], topics);
  const aaaIdx = content.indexOf('AAA');
  const zzzIdx = content.indexOf('ZZZ');
  expect(aaaIdx < zzzIdx).toBeTruthy();
});

test('buildGlobalIndexContent does not include missing_source entries', () => {
  // missing_source entries should be filtered before calling this function
  // This test verifies the function only renders what it receives
  const articles: IndexArticleEntry[] = [
    { title: 'Valid', summaryPath: 'KW/Articles/v.md', compiledAt: '2026-04-08T00:00:00Z', sourceId: 'ksrc_v' }
  ];
  const content = buildGlobalIndexContent(articles, []);
  expect(content).toContain('Valid');
});

test('empty index shows placeholder messages', () => {
  const content = buildGlobalIndexContent([], []);
  expect(content).toContain('暂无已编译的文章');
});

console.log('All indexer tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/indexer.test.ts`

- [ ] **Step 2: Write the indexer module**

```typescript
// src/knowledge/indexer.ts

import { App, TFile } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_ARTICLES_SUBFOLDER,
  WIKI_TOPICS_SUBFOLDER,
  WIKI_INDEX_FILENAME,
  TopicRef
} from './types';
import { buildTopicPageContent, TopicPageEntry, collectAllTopics } from './topic-utils';

export interface IndexArticleEntry {
  sourceId: string;
  title: string;
  summaryPath: string;
  compiledAt: string;
}

export interface IndexTopicEntry {
  slug: string;
  label: string;
  topicPagePath: string;
}

/**
 * 生成全局索引页 Markdown 内容
 */
export function buildGlobalIndexContent(
  articles: IndexArticleEntry[],
  topics: IndexTopicEntry[]
): string {
  const now = new Date().toISOString();

  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "global_index"\ncompiled_at: "${now}"\n---\n# Knowledge Wiki\n\n`;

  // Articles 区：按 compiled_at 倒序
  md += '## Articles\n\n';
  if (articles.length === 0) {
    md += '暂无已编译的文章。\n\n';
  } else {
    const sorted = [...articles].sort((a, b) =>
      new Date(b.compiledAt).getTime() - new Date(a.compiledAt).getTime()
    );
    for (const a of sorted) {
      md += `- [[${a.summaryPath}|${a.title}]] (${a.compiledAt.split('T')[0]})\n`;
    }
    md += '\n';
  }

  // Topics 区：按字母序
  md += '## Topics\n\n';
  if (topics.length === 0) {
    md += '暂无主题分类。\n\n';
  } else {
    const sorted = [...topics].sort((a, b) => a.slug.localeCompare(b.slug));
    for (const t of sorted) {
      md += `- [[${t.topicPagePath}|${t.label}]]\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * 索引器主类：编译完成后维护全局索引和 topic 索引页
 */
export class WikiIndexer {
  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  /**
   * 重建全局索引和所有 topic 页
   * 读取所有 done 状态的 summary 页 frontmatter，生成索引
   */
  async rebuildIndex(): Promise<void> {
    const completedRecords = this.registry.getCompletedRecords();

    const articles: IndexArticleEntry[] = [];
    const allTopicSets: TopicRef[][] = [];
    // summaryPath -> { title, topics } 用于 topic 页构建
    const summaryMeta: Map<string, { title: string; topics: TopicRef[] }> = new Map();

    for (const record of completedRecords) {
      if (!record.summary_path) continue;

      const file = this.app.vault.getAbstractFileByPath(record.summary_path);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fm = this.parseFrontmatter(content);
        if (!fm) continue;

        const title = fm.title || record.path.split('/').pop()?.replace('.md', '') || 'Untitled';
        const compiledAt = fm.compiled_at || record.updated_at;
        const topics: TopicRef[] = fm.topics || [];

        articles.push({
          sourceId: record.id,
          title,
          summaryPath: record.summary_path,
          compiledAt
        });

        allTopicSets.push(topics);
        summaryMeta.set(record.summary_path, { title, topics });
      } catch {
        // 跳过无法读取的文件
        continue;
      }
    }

    // 构建 topic 映射
    const topicMap = collectAllTopics(allTopicSets);

    // 确保目录存在
    await this.ensureFolder(`${this.wikiFolder}`);
    await this.ensureFolder(`${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}`);

    // 生成 topic 页
    const topicEntries: IndexTopicEntry[] = [];
    const activeTopicSlugs = new Set<string>();

    for (const [slug, label] of topicMap) {
      // 收集属于该 topic 的所有 summary
      const entries: TopicPageEntry[] = [];
      for (const [summaryPath, meta] of summaryMeta) {
        if (meta.topics.some(t => t.slug === slug)) {
          entries.push({ title: meta.title, summaryPath });
        }
      }

      if (entries.length === 0) continue; // topic 失去最后一个 summary 时不生成页面

      activeTopicSlugs.add(slug);
      const topicPagePath = `${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}/${slug}.md`;
      const topicContent = buildTopicPageContent(slug, label, entries);

      await this.writeGeneratedFile(topicPagePath, topicContent);

      topicEntries.push({ slug, label, topicPagePath });
    }

    // 删除不再有 summary 的 topic 页
    await this.removeOrphanTopicPages(activeTopicSlugs);

    // 生成全局索引
    const indexContent = buildGlobalIndexContent(articles, topicEntries);
    const indexPath = `${this.wikiFolder}/${WIKI_INDEX_FILENAME}`;
    await this.writeGeneratedFile(indexPath, indexContent);
  }

  /**
   * 简易 frontmatter 解析（不依赖外部库）
   */
  private parseFrontmatter(content: string): Record<string, any> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const fm: Record<string, any> = {};
    const lines = match[1].split('\n');
    let currentKey = '';
    let currentArray: any[] | null = null;

    for (const line of lines) {
      // 简单的 key: value 解析
      const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
      if (kvMatch) {
        if (currentArray && currentKey) {
          fm[currentKey] = currentArray;
          currentArray = null;
        }
        currentKey = kvMatch[1];
        const value = kvMatch[2].trim();
        if (value === '') {
          // 可能是数组开始
          currentArray = [];
        } else {
          fm[currentKey] = value.replace(/^["']|["']$/g, '');
          currentKey = '';
        }
      } else if (currentArray !== null && line.trim().startsWith('- ')) {
        // 数组项
        const item = line.trim().substring(2).trim();
        if (item.startsWith('{') || item.startsWith('slug:')) {
          // 对象数组项 - 简化处理
          const slugMatch = item.match(/slug:\s*"([^"]+)"/);
          const labelMatch = item.match(/label:\s*"([^"]+)"/);
          if (slugMatch) {
            const obj: any = { slug: slugMatch[1] };
            if (labelMatch) obj.label = labelMatch[1];
            currentArray.push(obj);
          }
        } else {
          currentArray.push(item.replace(/^["']|["']$/g, ''));
        }
      } else if (currentArray !== null) {
        // 续行（如 topic 对象的 label 行）
        const labelMatch = line.match(/\s+label:\s*"([^"]+)"/);
        if (labelMatch && currentArray.length > 0) {
          const last = currentArray[currentArray.length - 1];
          if (typeof last === 'object') last.label = labelMatch[1];
        }
      }
    }

    if (currentArray && currentKey) {
      fm[currentKey] = currentArray;
    }

    // 处理 JSON 数组格式的字段（如 concepts: ["a", "b"]）
    for (const [key, value] of Object.entries(fm)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        try { fm[key] = JSON.parse(value); } catch { /* keep as string */ }
      }
    }

    return fm;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try { await this.app.vault.createFolder(path); } catch { /* already exists */ }
    }
  }

  /**
   * 写入 knowledge_generated 文件（幂等）
   */
  private async writeGeneratedFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && existing instanceof TFile) {
      const existingContent = await this.app.vault.read(existing);
      if (existingContent.includes('knowledge_generated: true')) {
        await this.app.vault.modify(existing, content);
        return;
      }
      // 用户手写文件，不覆盖
      console.warn(`[WikiIndexer] Skipping ${path}: not a generated file`);
      return;
    }
    await this.app.vault.create(path, content);
  }

  /**
   * 删除不再有 summary 的 topic 页
   */
  private async removeOrphanTopicPages(activeSlugs: Set<string>): Promise<void> {
    const topicsDir = `${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}`;
    const folder = this.app.vault.getAbstractFileByPath(topicsDir);
    if (!folder) return;

    const files = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(topicsDir + '/') && f.extension === 'md'
    );

    for (const file of files) {
      const slug = file.basename;
      if (!activeSlugs.has(slug)) {
        const content = await this.app.vault.read(file);
        if (content.includes('knowledge_generated: true')) {
          await this.app.vault.trash(file, true);
        }
      }
    }
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/indexer.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/indexer.ts test/knowledge/indexer.test.ts
git commit -m "feat(knowledge): add wiki indexer with global index and topic pages"
```

---

## Chunk 3: Linter and Watcher

### Task 6: Create Knowledge Linter

**Files:**
- Create: `src/knowledge/linter.ts`
- Create: `test/knowledge/linter.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/linter.test.ts

import {
  LintIssue,
  LintIssueSeverity,
  buildHealthReportContent,
  checkMissingSummaries,
  checkLowConfidenceExtractions,
  checkOrphanConcepts
} from '../../src/knowledge/linter';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Knowledge Linter Tests ===');

test('checkMissingSummaries detects records without summary files', () => {
  const records = [
    { id: 'ksrc_a', path: 'a.md', status: 'done' as const, summary_path: 'KW/Articles/ksrc_a.md', created_at: '', updated_at: '', error: null },
    { id: 'ksrc_b', path: 'b.md', status: 'done' as const, summary_path: 'KW/Articles/ksrc_b.md', created_at: '', updated_at: '', error: null }
  ];
  const existingFiles = new Set(['KW/Articles/ksrc_a.md']); // ksrc_b.md missing
  const issues = checkMissingSummaries(records, existingFiles);
  expect(issues.length).toBe(1);
  expect(issues[0].recordId).toBe('ksrc_b');
  expect(issues[0].type).toBe('missing_summary');
});

test('checkLowConfidenceExtractions detects review_flags', () => {
  const summaries = [
    { sourceId: 'ksrc_a', title: 'A', reviewFlags: ['uncertain author'] },
    { sourceId: 'ksrc_b', title: 'B', reviewFlags: [] }
  ];
  const issues = checkLowConfidenceExtractions(summaries);
  expect(issues.length).toBe(1);
  expect(issues[0].recordId).toBe('ksrc_a');
  expect(issues[0].type).toBe('low_confidence');
});

test('checkOrphanConcepts finds concepts appearing only once', () => {
  const conceptMap: Record<string, string[]> = {
    'AI': ['ksrc_a', 'ksrc_b'],       // appears in 2 summaries
    'Quantum': ['ksrc_c']              // appears in 1 summary only
  };
  const issues = checkOrphanConcepts(conceptMap);
  expect(issues.length).toBe(1);
  expect(issues[0].message).toContain('Quantum');
});

test('buildHealthReportContent generates valid markdown', () => {
  const issues: LintIssue[] = [
    { type: 'missing_summary', severity: 'error', recordId: 'ksrc_x', message: 'Summary file missing' },
    { type: 'low_confidence', severity: 'warning', recordId: 'ksrc_y', message: 'Uncertain author' }
  ];
  const content = buildHealthReportContent(issues);
  expect(content).toContain('knowledge_generated: true');
  expect(content).toContain('knowledge_artifact_type: "health_report"');
  expect(content).toContain('## Errors');
  expect(content).toContain('Summary file missing');
  expect(content).toContain('## Warnings');
  expect(content).toContain('Uncertain author');
});

test('buildHealthReportContent with no issues shows clean report', () => {
  const content = buildHealthReportContent([]);
  expect(content).toContain('知识库健康状况良好');
});

console.log('All linter tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/linter.test.ts`

- [ ] **Step 2: Write the linter module**

```typescript
// src/knowledge/linter.ts

import { App, TFile } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import { KnowledgeRegistryRecord, WIKI_HEALTH_SUBFOLDER } from './types';

export type LintIssueType =
  | 'missing_summary'
  | 'low_confidence'
  | 'orphan_concept'
  | 'duplicate_topic'
  | 'stale_missing_source';

export type LintIssueSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  type: LintIssueType;
  severity: LintIssueSeverity;
  recordId?: string;
  message: string;
}

/**
 * 检查：registry 中 done 状态但无对应 summary 文件
 */
export function checkMissingSummaries(
  records: KnowledgeRegistryRecord[],
  existingFiles: Set<string>
): LintIssue[] {
  return records
    .filter(r => r.status === 'done' && r.summary_path && !existingFiles.has(r.summary_path!))
    .map(r => ({
      type: 'missing_summary' as const,
      severity: 'error' as const,
      recordId: r.id,
      message: `Summary file missing for "${r.path}" (expected: ${r.summary_path})`
    }));
}

/**
 * 检查：summary 中有 review_flags 的低置信度提取
 */
export function checkLowConfidenceExtractions(
  summaries: { sourceId: string; title: string; reviewFlags: string[] }[]
): LintIssue[] {
  return summaries
    .filter(s => s.reviewFlags.length > 0)
    .map(s => ({
      type: 'low_confidence' as const,
      severity: 'warning' as const,
      recordId: s.sourceId,
      message: `Low confidence extraction in "${s.title}": ${s.reviewFlags.join(', ')}`
    }));
}

/**
 * 检查：某 concept 只出现在一篇 summary 中（孤立概念）
 */
export function checkOrphanConcepts(
  conceptMap: Record<string, string[]>
): LintIssue[] {
  return Object.entries(conceptMap)
    .filter(([_, sources]) => sources.length === 1)
    .map(([concept, sources]) => ({
      type: 'orphan_concept' as const,
      severity: 'info' as const,
      recordId: sources[0],
      message: `Orphan concept "${concept}" only appears in one summary`
    }));
}

/**
 * 生成健康报告 Markdown
 */
export function buildHealthReportContent(issues: LintIssue[]): string {
  const now = new Date().toISOString();
  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "health_report"\ngenerated_at: "${now}"\n---\n# Knowledge Wiki Health Report\n\n`;

  if (issues.length === 0) {
    md += '知识库健康状况良好，未发现问题。\n';
    return md;
  }

  md += `共发现 ${issues.length} 个问题。\n\n`;

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  if (errors.length > 0) {
    md += '## Errors\n\n';
    for (const e of errors) {
      md += `- **[${e.type}]** ${e.message}${e.recordId ? ` (${e.recordId})` : ''}\n`;
    }
    md += '\n';
  }

  if (warnings.length > 0) {
    md += '## Warnings\n\n';
    for (const w of warnings) {
      md += `- **[${w.type}]** ${w.message}${w.recordId ? ` (${w.recordId})` : ''}\n`;
    }
    md += '\n';
  }

  if (infos.length > 0) {
    md += '## Info\n\n';
    for (const i of infos) {
      md += `- **[${i.type}]** ${i.message}${i.recordId ? ` (${i.recordId})` : ''}\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Linter 主类：运行所有检查，生成报告
 */
export class KnowledgeLinter {
  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private wikiFolder: string
  ) {}

  async runLint(): Promise<LintIssue[]> {
    const allIssues: LintIssue[] = [];

    // 1. 检查缺失 summary
    const doneRecords = this.registry.getByStatus('done');
    const existingFiles = new Set(
      this.app.vault.getFiles().map(f => f.path)
    );
    allIssues.push(...checkMissingSummaries(doneRecords, existingFiles));

    // 2. 检查低置信度提取
    const summaries: { sourceId: string; title: string; reviewFlags: string[] }[] = [];
    const conceptMap: Record<string, string[]> = {};

    for (const record of doneRecords) {
      if (!record.summary_path) continue;
      const file = this.app.vault.getAbstractFileByPath(record.summary_path);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fmText = fmMatch[1];

        // 提取 review_flags
        const flagsMatch = fmText.match(/review_flags:\s*(\[.*\])/);
        let reviewFlags: string[] = [];
        if (flagsMatch) {
          try { reviewFlags = JSON.parse(flagsMatch[1]); } catch {}
        }

        // 提取 title
        const titleMatch = fmText.match(/title:\s*"([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : record.path;

        summaries.push({ sourceId: record.id, title, reviewFlags });

        // 提取 concepts 用于孤立概念检查
        const conceptsMatch = fmText.match(/concepts:\s*(\[.*\])/);
        if (conceptsMatch) {
          try {
            const concepts: string[] = JSON.parse(conceptsMatch[1]);
            for (const c of concepts) {
              if (!conceptMap[c]) conceptMap[c] = [];
              conceptMap[c].push(record.id);
            }
          } catch {}
        }
      } catch { continue; }
    }

    allIssues.push(...checkLowConfidenceExtractions(summaries));
    allIssues.push(...checkOrphanConcepts(conceptMap));

    // 3. 检查 missing_source 状态的过期编译
    const missingRecords = this.registry.getByStatus('missing_source');
    for (const r of missingRecords) {
      if (r.summary_path && existingFiles.has(r.summary_path)) {
        allIssues.push({
          type: 'stale_missing_source',
          severity: 'warning',
          recordId: r.id,
          message: `Source deleted but summary still exists: ${r.summary_path}`
        });
      }
    }

    return allIssues;
  }

  async generateReport(): Promise<string> {
    const issues = await this.runLint();
    const reportContent = buildHealthReportContent(issues);

    // 写入报告文件
    const reportDir = `${this.wikiFolder}/${WIKI_HEALTH_SUBFOLDER}`;
    const reportPath = `${reportDir}/report.md`;

    if (!this.app.vault.getAbstractFileByPath(reportDir)) {
      try { await this.app.vault.createFolder(reportDir); } catch {}
    }

    const existing = this.app.vault.getAbstractFileByPath(reportPath);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, reportContent);
    } else {
      await this.app.vault.create(reportPath, reportContent);
    }

    return reportPath;
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/linter.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/linter.ts test/knowledge/linter.test.ts
git commit -m "feat(knowledge): add linter with health check and report generation"
```

---

### Task 7: Create Folder Watcher

**Files:**
- Create: `src/knowledge/watcher.ts`
- Create: `test/knowledge/watcher.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/watcher.test.ts

import {
  isInWatchedFolder,
  shouldEnqueueFile
} from '../../src/knowledge/watcher';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Folder Watcher Tests ===');

test('isInWatchedFolder matches exact folder', () => {
  expect(isInWatchedFolder('Clippings/test.md', ['Clippings'])).toBeTruthy();
  expect(isInWatchedFolder('Clippings/sub/test.md', ['Clippings'])).toBeTruthy();
});

test('isInWatchedFolder rejects non-watched paths', () => {
  expect(isInWatchedFolder('Notes/test.md', ['Clippings'])).toBeFalsy();
  expect(isInWatchedFolder('test.md', ['Clippings'])).toBeFalsy();
});

test('isInWatchedFolder handles multiple folders', () => {
  const folders = ['Clippings', 'Reading Notes'];
  expect(isInWatchedFolder('Clippings/a.md', folders)).toBeTruthy();
  expect(isInWatchedFolder('Reading Notes/b.md', folders)).toBeTruthy();
  expect(isInWatchedFolder('Other/c.md', folders)).toBeFalsy();
});

test('isInWatchedFolder handles trailing slashes', () => {
  expect(isInWatchedFolder('Clippings/test.md', ['Clippings/'])).toBeTruthy();
});

test('shouldEnqueueFile filters non-markdown files', () => {
  expect(shouldEnqueueFile('test.md', ['Clippings'])).toBeFalsy(); // not in watched folder
  expect(shouldEnqueueFile('Clippings/test.md', ['Clippings'])).toBeTruthy();
  expect(shouldEnqueueFile('Clippings/test.txt', ['Clippings'])).toBeFalsy();
  expect(shouldEnqueueFile('Clippings/test.png', ['Clippings'])).toBeFalsy();
});

test('shouldEnqueueFile excludes wiki output folder', () => {
  expect(shouldEnqueueFile('Knowledge Wiki/Articles/ksrc_a.md', ['Knowledge Wiki'])).toBeFalsy();
});

console.log('All watcher tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/watcher.test.ts`

- [ ] **Step 2: Write the watcher module**

```typescript
// src/knowledge/watcher.ts

import { App, TFile, debounce } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import { DEFAULT_WIKI_FOLDER, KNOWLEDGE_GENERATED_MARKER } from './types';

/**
 * 检查文件路径是否在监听文件夹列表中
 */
export function isInWatchedFolder(filePath: string, watchedFolders: string[]): boolean {
  return watchedFolders.some(folder => {
    const normalized = folder.endsWith('/') ? folder : folder + '/';
    return filePath.startsWith(normalized);
  });
}

/**
 * 判断文件是否应该入队编译
 * - 必须是 .md 文件
 * - 必须在监听文件夹中
 * - 不能是 wiki 输出文件夹中的文件
 */
export function shouldEnqueueFile(
  filePath: string,
  watchedFolders: string[],
  wikiFolder: string = DEFAULT_WIKI_FOLDER
): boolean {
  if (!filePath.endsWith('.md')) return false;
  if (filePath.startsWith(wikiFolder + '/')) return false;
  return isInWatchedFolder(filePath, watchedFolders);
}

/**
 * 文件夹监听器：监听指定文件夹，将新建/修改的笔记自动入队
 */
export class KnowledgeWatcher {
  private debouncedHandlers: Map<string, () => void> = new Map();

  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private watchedFolders: string[],
    private wikiFolder: string = DEFAULT_WIKI_FOLDER,
    private debounceMs: number = 60000 // 1 分钟防抖
  ) {}

  /**
   * 处理文件创建事件
   * 新建文件 → 立即入队为 pending
   */
  async onFileCreate(file: TFile): Promise<void> {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;

    const existing = this.registry.findByPath(file.path);
    if (existing) return; // 已注册

    this.registry.register(file.path);
    await this.registry.save();
    console.log(`[KnowledgeWatcher] Registered new file: ${file.path}`);
  }

  /**
   * 处理文件修改事件（带防抖）
   * 修改文件 → 如果已编译过（done），标记为 stale
   */
  onFileModify(file: TFile): void {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;

    // 防抖：同一文件 1 分钟内只处理一次
    const key = file.path;
    if (this.debouncedHandlers.has(key)) return;

    const handler = debounce(async () => {
      const record = this.registry.findByPath(file.path);
      if (record && record.status === 'done') {
        this.registry.transition(record.id, 'stale');
        await this.registry.save();
        console.log(`[KnowledgeWatcher] Marked stale: ${file.path}`);
      }
      this.debouncedHandlers.delete(key);
    }, this.debounceMs, true);

    this.debouncedHandlers.set(key, handler);
    handler();
  }

  /**
   * 处理文件删除事件
   * 文件删除 → 标记 missing_source
   */
  async onFileDelete(filePath: string): Promise<void> {
    const record = this.registry.findByPath(filePath);
    if (!record) return;

    if (record.status !== 'missing_source') {
      try {
        this.registry.transition(record.id, 'missing_source');
        await this.registry.save();
        console.log(`[KnowledgeWatcher] Marked missing_source: ${filePath}`);
      } catch {
        // 状态转换不合法，忽略
      }
    }
  }

  /**
   * 处理文件重命名事件
   * 文件重命名 → 更新 registry 中的路径
   */
  async onFileRename(oldPath: string, newPath: string): Promise<void> {
    const record = this.registry.findByPath(oldPath);
    if (!record) {
      // 如果新路径在监听文件夹中，注册为新文件
      if (shouldEnqueueFile(newPath, this.watchedFolders, this.wikiFolder)) {
        this.registry.register(newPath);
        await this.registry.save();
      }
      return;
    }

    this.registry.updatePath(record.id, newPath);
    await this.registry.save();
    console.log(`[KnowledgeWatcher] Updated path: ${oldPath} -> ${newPath}`);
  }

  /**
   * 更新监听文件夹列表（设置变更时调用）
   */
  updateWatchedFolders(folders: string[]): void {
    this.watchedFolders = folders;
  }

  /**
   * 清理防抖处理器
   */
  cleanup(): void {
    this.debouncedHandlers.clear();
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/watcher.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/watcher.ts test/knowledge/watcher.test.ts
git commit -m "feat(knowledge): add folder watcher with debounced file monitoring"
```

---

## Chunk 4: Consumption Layer - query_knowledge and file_back_knowledge

### Task 8: Create query_knowledge Tool

**Files:**
- Create: `src/knowledge/query.ts`
- Create: `test/knowledge/query.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/query.test.ts

import {
  buildQueryResult,
  QueryKnowledgeResult
} from '../../src/knowledge/query';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== query_knowledge Tests ===');

test('buildQueryResult formats index content with query', () => {
  const indexContent = '# Knowledge Wiki\n\n## Articles\n\n- [[KW/Articles/a.md|Article A]]\n';
  const result = buildQueryResult('AI', indexContent, 3);
  expect(result.query).toBe('AI');
  expect(result.indexContent).toContain('Article A');
  expect(result.maxResults).toBe(3);
  expect(result.instruction).toContain('read_note');
});

test('buildQueryResult handles empty index', () => {
  const result = buildQueryResult('test', '', 3);
  expect(result.indexContent).toBe('');
  expect(result.instruction).toContain('知识库为空');
});

test('buildQueryResult uses default maxResults', () => {
  const result = buildQueryResult('test', 'some content', undefined);
  expect(result.maxResults).toBe(3);
});

console.log('All query_knowledge tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/query.test.ts`

- [ ] **Step 2: Write the query module**

```typescript
// src/knowledge/query.ts

import { App, TFile } from 'obsidian';
import { DEFAULT_WIKI_FOLDER, WIKI_INDEX_FILENAME } from './types';

export interface QueryKnowledgeResult {
  query: string;
  indexContent: string;
  maxResults: number;
  instruction: string;
}

/**
 * 构建 query_knowledge 工具的返回结果
 * 将 index 内容连同 query 一起返回给外层 AI，
 * AI 根据 query 与 index 内容判断哪些 summary 相关，发起后续 read_note 调用
 */
export function buildQueryResult(
  query: string,
  indexContent: string,
  maxResults?: number
): QueryKnowledgeResult {
  const max = maxResults ?? 3;

  if (!indexContent || indexContent.trim().length === 0) {
    return {
      query,
      indexContent: '',
      maxResults: max,
      instruction: '知识库为空，暂无可检索的内容。可以建议用户先编译一些笔记。'
    };
  }

  return {
    query,
    indexContent,
    maxResults: max,
    instruction: `以上是知识库索引。请根据用户的问题"${query}"，从索引中找出最相关的文章（最多 ${max} 篇），然后使用 read_note 工具读取这些 summary 的全文来回答用户问题。回答时请引用具体来源。`
  };
}

/**
 * query_knowledge 工具执行器
 */
export class QueryKnowledgeExecutor {
  constructor(
    private app: App,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  async execute(args: { query: string; max_results?: number }): Promise<QueryKnowledgeResult> {
    const indexPath = `${this.wikiFolder}/${WIKI_INDEX_FILENAME}`;
    const file = this.app.vault.getAbstractFileByPath(indexPath);

    let indexContent = '';
    if (file && file instanceof TFile) {
      indexContent = await this.app.vault.read(file);
    }

    return buildQueryResult(args.query, indexContent, args.max_results);
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/query.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/query.ts test/knowledge/query.test.ts
git commit -m "feat(knowledge): add query_knowledge tool executor"
```

---

### Task 9: Create file_back_knowledge Tool

**Files:**
- Create: `src/knowledge/file-back.ts`
- Create: `test/knowledge/file-back.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// test/knowledge/file-back.test.ts

import {
  buildFileBackMarkdown,
  generateFileBackId
} from '../../src/knowledge/file-back';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== file_back_knowledge Tests ===');

test('generateFileBackId produces fb_ prefixed IDs', () => {
  const id = generateFileBackId();
  expect(id.startsWith('fb_')).toBeTruthy();
  expect(id.length > 8).toBeTruthy();
});

test('buildFileBackMarkdown generates correct frontmatter', () => {
  const md = buildFileBackMarkdown(
    'fb_abc123',
    '知识编译 vs RAG 对比分析',
    '## 对比\n\n知识编译更适合个人知识管理...',
    ['知识编译和 RAG 的区别是什么？'],
    ['ksrc_abc123', 'ksrc_def456']
  );
  expect(md).toContain('knowledge_generated: true');
  expect(md).toContain('knowledge_artifact_type: "file_back"');
  expect(md).toContain('title: "知识编译 vs RAG 对比分析"');
  expect(md).toContain('source_queries:');
  expect(md).toContain('知识编译和 RAG 的区别是什么？');
  expect(md).toContain('related_sources:');
  expect(md).toContain('ksrc_abc123');
  expect(md).toContain('ksrc_def456');
  expect(md).toContain('# 知识编译 vs RAG 对比分析');
  expect(md).toContain('知识编译更适合个人知识管理');
});

test('buildFileBackMarkdown handles empty related sources', () => {
  const md = buildFileBackMarkdown('fb_x', 'Test', 'Content', ['q1'], []);
  expect(md).toContain('related_sources: []');
});

console.log('All file_back_knowledge tests passed!');
```

Run: `cmd /c npx.cmd tsx test/knowledge/file-back.test.ts`

- [ ] **Step 2: Write the file-back module**

```typescript
// src/knowledge/file-back.ts

import { App, TFile } from 'obsidian';
import { DEFAULT_WIKI_FOLDER, WIKI_ARTICLES_SUBFOLDER } from './types';
import { WikiIndexer } from './indexer';

/**
 * 生成 file-back ID
 */
export function generateFileBackId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 12; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `fb_${suffix}`;
}

/**
 * 生成回填页的 Markdown 内容
 */
export function buildFileBackMarkdown(
  fileBackId: string,
  title: string,
  content: string,
  sourceQueries: string[],
  relatedSources: string[]
): string {
  const now = new Date().toISOString();

  let fm = '---\n';
  fm += 'knowledge_generated: true\n';
  fm += 'knowledge_artifact_type: "file_back"\n';
  fm += `title: "${title.replace(/"/g, '\\"')}"\n`;
  fm += `compiled_at: "${now}"\n`;

  fm += 'source_queries:\n';
  for (const q of sourceQueries) {
    fm += `  - "${q.replace(/"/g, '\\"')}"\n`;
  }

  if (relatedSources.length > 0) {
    fm += 'related_sources:\n';
    for (const s of relatedSources) {
      fm += `  - "${s}"\n`;
    }
  } else {
    fm += 'related_sources: []\n';
  }

  fm += '---\n';

  return `${fm}# ${title}\n\n${content}\n`;
}

/**
 * file_back_knowledge 工具执行器
 */
export class FileBackExecutor {
  constructor(
    private app: App,
    private indexer: WikiIndexer,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  async execute(args: {
    title: string;
    content: string;
    source_queries: string[];
    related_sources: string[];
  }): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const fileBackId = generateFileBackId();
      const filePath = `${this.wikiFolder}/${WIKI_ARTICLES_SUBFOLDER}/${fileBackId}.md`;

      const markdown = buildFileBackMarkdown(
        fileBackId,
        args.title,
        args.content,
        args.source_queries || [],
        args.related_sources || []
      );

      // 确保目录存在
      const articlesDir = `${this.wikiFolder}/${WIKI_ARTICLES_SUBFOLDER}`;
      if (!this.app.vault.getAbstractFileByPath(articlesDir)) {
        try { await this.app.vault.createFolder(articlesDir); } catch {}
      }

      await this.app.vault.create(filePath, markdown);

      // 重建索引以包含新的回填页
      await this.indexer.rebuildIndex();

      return { success: true, path: filePath };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}
```

Run: `cmd /c npx.cmd tsx test/knowledge/file-back.test.ts`

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/knowledge/file-back.ts test/knowledge/file-back.test.ts
git commit -m "feat(knowledge): add file_back_knowledge tool for wiki enrichment"
```

---

## Chunk 5: Integration - Settings, ToolManager, Shell, Guardian, Runtime

### Task 10: Add Settings and ModelService.generate()

**Files:**
- Modify: `src/mcp/types.ts`
- Modify: `src/services/model-service.ts`
- Modify: `src/settings.ts`

- [ ] **Step 1: Add knowledge settings to GeminiSettings interface**

In `src/mcp/types.ts`, add 4 new fields to the `GeminiSettings` interface after the `mcpServers` field:

```typescript
// src/mcp/types.ts - ADD to GeminiSettings interface (after mcpServers)

    // --- 📚 Knowledge Compiler ---
    knowledgeSourceFolders: string[];      // 监听的文件夹列表
    knowledgeAutoCompile: boolean;         // 自动编译开关
    knowledgeWikiFolder: string;           // wiki 输出目录
    knowledgeMaxCompileBatch: number;      // 单次批量编译上限
```

In `src/mcp/types.ts`, add defaults to `DEFAULT_SETTINGS` (after `mcpServers: {}`):

```typescript
// src/mcp/types.ts - ADD to DEFAULT_SETTINGS (after mcpServers: {})

    // Knowledge Compiler
    knowledgeSourceFolders: [],
    knowledgeAutoCompile: false,
    knowledgeWikiFolder: 'Knowledge Wiki',
    knowledgeMaxCompileBatch: 10
```

- [ ] **Step 2: Add stateless generate method to ModelService**

In `src/services/model-service.ts`, add a new `generate()` method after the `chat()` method. This is a stateless single-turn call that does NOT use MemoryManager or function calling:

```typescript
// src/services/model-service.ts - ADD after the chat() method (around line 247)

    /**
     * 无状态单次生成：不走 MemoryManager，不走 function calling
     * 用于 Knowledge Compiler 等需要独立 AI 调用的场景
     */
    async generate(prompt: string, systemPrompt?: string): Promise<string> {
        if (!this.hasValidConfig()) {
            throw new Error(`${this.provider.name} API Key not configured`);
        }

        try {
            // 如果有自定义 system prompt，临时重新配置 provider
            if (systemPrompt) {
                const currentConfig = this.getCurrentConfig();
                this.provider.configure({ ...currentConfig, systemPrompt });
            }

            const result = await this.provider.generateContent(prompt);

            // 恢复原始配置
            if (systemPrompt) {
                const currentConfig = this.getCurrentConfig();
                this.provider.configure({ ...currentConfig, systemPrompt: this.settings.systemPrompt });
            }

            return result.text;
        } catch (e: any) {
            logger.error('Stateless generation failed', e, 'ModelService.generate');
            throw e;
        }
    }

    private getCurrentConfig(): ModelConfig {
        switch (this.settings.provider) {
            case 'gemini':
                return {
                    apiKey: this.settings.apiKey,
                    modelName: this.settings.primaryModel,
                    systemPrompt: this.settings.systemPrompt,
                    contextWindow: this.settings.contextWindow
                };
            case 'openai':
                return {
                    apiKey: this.settings.openaiApiKey,
                    baseUrl: this.settings.openaiBaseUrl,
                    modelName: this.settings.openaiModel,
                    systemPrompt: this.settings.systemPrompt
                };
            case 'deepseek':
                return {
                    apiKey: this.settings.deepseekApiKey,
                    baseUrl: this.settings.deepseekBaseUrl,
                    modelName: this.settings.deepseekModel,
                    systemPrompt: this.settings.systemPrompt
                };
            case 'qwen':
                return {
                    apiKey: this.settings.qwenApiKey,
                    baseUrl: this.settings.qwenBaseUrl,
                    modelName: this.settings.qwenModel,
                    systemPrompt: this.settings.systemPrompt
                };
            default:
                return {
                    apiKey: this.settings.apiKey,
                    modelName: this.settings.primaryModel,
                    systemPrompt: this.settings.systemPrompt
                };
        }
    }
```

Note: also add `import { ModelConfig } from '../models/interfaces';` at the top if not already imported (it is already imported on line 7).

- [ ] **Step 3: Add Knowledge Compiler settings section to settings UI**

In `src/settings.ts`, add a new section before the MCP Servers section (before line 445 `// 7. 🔌 MCP Servers`):

```typescript
// src/settings.ts - ADD before the MCP Servers section

        // ============================================================
        // 7. 📚 Knowledge Compiler
        // ============================================================
        containerEl.createEl('h3', { text: '📚 Knowledge Compiler', cls: 'gemini-settings-header' });

        const knowledgeDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
        knowledgeDesc.setText('Compile notes from watched folders into a structured knowledge wiki.');

        new Setting(containerEl)
            .setName('Auto Compile')
            .setDesc('Automatically compile notes when they are created or modified in watched folders.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeAutoCompile)
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeAutoCompile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Wiki Output Folder')
            .setDesc('The folder where compiled wiki pages are stored.')
            .addText(text => text
                .setPlaceholder('Knowledge Wiki')
                .setValue(this.plugin.settings.knowledgeWikiFolder)
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeWikiFolder = value || 'Knowledge Wiki';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Compile Batch')
            .setDesc('Maximum number of notes to compile in a single batch.')
            .addSlider(slider => slider
                .setLimits(1, 50, 1)
                .setValue(this.plugin.settings.knowledgeMaxCompileBatch)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeMaxCompileBatch = value;
                    await this.plugin.saveSettings();
                }));

        // Source Folders list
        new Setting(containerEl)
            .setName('Source Folders')
            .setDesc('Folders to watch for notes to compile (one per line).')
            .setClass('gemini-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Clippings\nReading Notes')
                .setValue((this.plugin.settings.knowledgeSourceFolders || []).join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeSourceFolders = value
                        .split('\n')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                    await this.plugin.saveSettings();
                }));
```

- [ ] **Step 4: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/mcp/types.ts src/services/model-service.ts src/settings.ts
git commit -m "feat(knowledge): add settings fields, generate() method, and settings UI"
```

---

### Task 11: Register Tools in ToolManager

**Files:**
- Modify: `src/mcp/tools.ts`

- [ ] **Step 1: Add tool definitions to getToolsDefinitions()**

In `src/mcp/tools.ts`, add two new tool definitions in the `getToolsDefinitions()` method, right before the `web_search` tool push (before line 241 `tools.push({`):

```typescript
// src/mcp/tools.ts - ADD before the web_search tool push

        // Knowledge Wiki tools (always registered, executor checks if wiki exists)
        tools.push(
            {
                name: 'query_knowledge',
                description: '从个人知识库中检索相关知识。先读取全局索引了解有哪些文章和主题，再根据需要读取具体的 summary 全文。当用户的问题可能与已积累的知识相关时使用此工具。',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        query: { type: SchemaType.STRING, description: '检索关键词或问题' },
                        max_results: { type: SchemaType.INTEGER, description: '最多返回几篇 summary，默认 3' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'file_back_knowledge',
                description: '将当前对话中产出的高质量知识回答存回知识库 Wiki，让知识库随使用不断增长。只对综合了多个知识来源、产出有价值新洞察的回答使用。',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        title: { type: SchemaType.STRING, description: '回填文章的标题' },
                        content: { type: SchemaType.STRING, description: '要归档的内容（Markdown 格式）' },
                        source_queries: {
                            type: SchemaType.ARRAY,
                            items: { type: SchemaType.STRING },
                            description: '触发这次回答的问题列表'
                        },
                        related_sources: {
                            type: SchemaType.ARRAY,
                            items: { type: SchemaType.STRING },
                            description: '引用的 knowledge_source_id 列表'
                        }
                    },
                    required: ['title', 'content', 'source_queries']
                }
            }
        );
```

- [ ] **Step 2: Add executor references and execute cases**

In `src/mcp/tools.ts`, add imports and new fields to the ToolManager class:

```typescript
// src/mcp/tools.ts - ADD imports at top
import { QueryKnowledgeExecutor } from '../knowledge/query';
import { FileBackExecutor } from '../knowledge/file-back';
```

Add optional executor fields to the class:

```typescript
// src/mcp/tools.ts - ADD fields to ToolManager class (after line 20)
    private queryExecutor: QueryKnowledgeExecutor | null = null;
    private fileBackExecutor: FileBackExecutor | null = null;
```

Add setter methods:

```typescript
// src/mcp/tools.ts - ADD methods to ToolManager class
    setKnowledgeExecutors(
        queryExecutor: QueryKnowledgeExecutor,
        fileBackExecutor: FileBackExecutor
    ): void {
        this.queryExecutor = queryExecutor;
        this.fileBackExecutor = fileBackExecutor;
    }
```

Add cases to the `execute()` switch statement (before `case 'web_search':`):

```typescript
// src/mcp/tools.ts - ADD to execute() switch (before case 'web_search':)

                case 'query_knowledge':
                    if (!this.queryExecutor) {
                        return { error: 'Knowledge system not initialized' };
                    }
                    return await this.queryExecutor.execute(args);

                case 'file_back_knowledge':
                    if (!this.fileBackExecutor) {
                        return { error: 'Knowledge system not initialized' };
                    }
                    return await this.fileBackExecutor.execute(args);
```

- [ ] **Step 3: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/mcp/tools.ts
git commit -m "feat(knowledge): register query_knowledge and file_back_knowledge in ToolManager"
```

---

### Task 12: Shell Thumbs Up/Down, System Prompt, and Guardian Knowledge Injection

**Files:**
- Modify: `src/ui/shell-view.ts`
- Modify: `src/ui/chat-controller.ts`
- Modify: `main.ts` (Guardian knowledge injection)
- Modify: `styles.css`

- [ ] **Step 1: Extend ChatMessage with feedback field**

In `src/ui/chat-controller.ts`, add a `feedback` field to the `ChatMessage` interface:

```typescript
// src/ui/chat-controller.ts - MODIFY ChatMessage interface (line 5-10)

export interface ChatMessage {
    id: string;
    role: 'user' | 'ai' | 'system';
    content: string;
    timestamp: number;
    feedback?: 'up' | 'down' | null;  // 点赞/点踩状态
}
```

- [ ] **Step 2: Add thumbs up/down buttons to AI messages in shell-view**

In `src/ui/shell-view.ts`, modify the `appendMessage` method. After the AI message rendering block (after the `requestAnimationFrame` scroll call around line 503), add feedback buttons:

```typescript
// src/ui/shell-view.ts - ADD inside appendMessage(), after MarkdownRenderer.render().then() block
// Insert this INSIDE the .then() callback, after the requestAnimationFrame block (line ~503)

                // Add feedback buttons for AI messages
                const feedbackBar = entry.createDiv({ cls: 'shell-feedback-bar' });

                const thumbsUpBtn = feedbackBar.createEl('button', {
                    cls: 'shell-feedback-btn shell-thumbs-up',
                    title: 'Useful - save to knowledge wiki'
                });
                thumbsUpBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>';

                const thumbsDownBtn = feedbackBar.createEl('button', {
                    cls: 'shell-feedback-btn shell-thumbs-down',
                    title: 'Not useful'
                });
                thumbsDownBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>';

                thumbsUpBtn.addEventListener('click', () => {
                    msg.feedback = 'up';
                    thumbsUpBtn.addClass('active');
                    thumbsDownBtn.removeClass('active');
                    // Trigger file-back via chat controller
                    this.chatController.processCommand(
                        `/file-back ${msg.id}`,
                        [], ''
                    );
                });

                thumbsDownBtn.addEventListener('click', () => {
                    msg.feedback = 'down';
                    thumbsDownBtn.addClass('active');
                    thumbsUpBtn.removeClass('active');
                });
```

- [ ] **Step 3: Handle /file-back command in ChatController**

In `src/ui/chat-controller.ts`, add a case in `handleSlashCommand` for `/file-back`:

```typescript
// src/ui/chat-controller.ts - ADD to handleSlashCommand switch (after case '/tools':)

            case '/file-back':
                const targetMsgId = argStr.trim();
                const targetMsg = this.messages.find(m => m.id === targetMsgId && m.role === 'ai');
                if (targetMsg) {
                    this.setResponding(true);
                    try {
                        // 让 AI 判断内容并调用 file_back_knowledge
                        const fileBackPrompt = `用户对以下回答点赞，请将其归档到知识库。使用 file_back_knowledge 工具，提取标题和核心内容。\n\n回答内容：\n${targetMsg.content}`;
                        await this.api.chat(fileBackPrompt, [], '');
                        this.addMessage('system', '已归档到知识库。');
                    } catch (error: any) {
                        this.addMessage('system', `归档失败: ${error.message}`);
                    } finally {
                        this.setResponding(false);
                    }
                }
                break;
```

- [ ] **Step 4: Append knowledge guidance to system prompt**

In `src/mcp/types.ts`, append knowledge guidance to the default `systemPrompt` in `DEFAULT_SETTINGS`:

```typescript
// src/mcp/types.ts - APPEND to the end of DEFAULT_SETTINGS.systemPrompt string (before the closing backtick)

你有一个个人知识库可用。当用户的问题可能与你之前积累的知识相关时，
使用 query_knowledge 工具查阅知识库。回答时引用具体来源。
如果知识库中没有相关内容，正常回答即可，不要强行引用。
知识库检索不足时，可以用 search_vault 搜索整个 vault 补充。

当你的回答综合了多个知识来源、产出了有价值的新洞察或对比分析时，
使用 file_back_knowledge 工具将回答归档到知识库。
不要对简单的事实查询做回填，只回填有综合价值的内容。
注意：如果用户对回答点赞，无论你的判断如何都执行回填；
如果用户点踩，则不回填。用户反馈优先于你的判断。
```

- [ ] **Step 5: Add Guardian knowledge injection**

In `main.ts`, modify the `runGuardianCheck` method to inject knowledge context before the AI call. Add this block before the `const response = await this.modelService.chat(...)` call (around line 250):

```typescript
// main.ts - ADD inside runGuardianCheck(), before the modelService.chat() call

            // Knowledge injection for Guardian
            let knowledgeContext = '';
            if (this.knowledgeRuntime) {
                try {
                    knowledgeContext = await this.knowledgeRuntime.getGuardianKnowledgeContext(contextText);
                } catch {
                    // 知识注入失败不影响 Guardian 正常工作
                }
            }

            if (knowledgeContext) {
                prompt = `${knowledgeContext}\n\n${prompt}`;
            }
```

- [ ] **Step 6: Add CSS styles for feedback buttons**

In `styles.css`, add styles for the feedback bar:

```css
/* styles.css - ADD at the end */

/* Knowledge Wiki - Feedback Buttons */
.shell-feedback-bar {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    opacity: 0;
    transition: opacity 0.2s ease;
}

.shell-entry.ai:hover .shell-feedback-bar {
    opacity: 1;
}

.shell-feedback-btn {
    background: transparent;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 2px 6px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    transition: all 0.15s ease;
}

.shell-feedback-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
}

.shell-feedback-btn.active {
    border-color: var(--interactive-accent);
    color: var(--interactive-accent);
}

.shell-thumbs-up.active {
    color: var(--color-green);
    border-color: var(--color-green);
}

.shell-thumbs-down.active {
    color: var(--color-red);
    border-color: var(--color-red);
}
```

- [ ] **Step 7: Verify build and commit**

Run: `cmd /c npm.cmd run build`

```
git add src/ui/shell-view.ts src/ui/chat-controller.ts src/mcp/types.ts main.ts styles.css
git commit -m "feat(knowledge): add thumbs up/down, system prompt guidance, and Guardian injection"
```

---

### Task 13: Create KnowledgeRuntime and Wire into main.ts

**Files:**
- Create: `src/knowledge/runtime.ts`
- Modify: `main.ts`

- [ ] **Step 1: Write the KnowledgeRuntime module**

```typescript
// src/knowledge/runtime.ts

import { App, TFile, Notice, debounce } from 'obsidian';
import { GeminiSettings } from '../mcp/types';
import { ModelService } from '../services/model-service';
import { ToolManager } from '../mcp/tools';
import { KnowledgeRegistryManager } from './registry';
import { KnowledgeCompiler } from './compiler';
import { WikiIndexer } from './indexer';
import { KnowledgeLinter } from './linter';
import { KnowledgeWatcher } from './watcher';
import { QueryKnowledgeExecutor } from './query';
import { FileBackExecutor } from './file-back';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_INDEX_FILENAME
} from './types';

/**
 * Knowledge Wiki 生命周期管理器
 * main.ts 只做一件事：实例化 KnowledgeRuntime 并委托生命周期
 */
export class KnowledgeRuntime {
  private registry: KnowledgeRegistryManager;
  private compiler: KnowledgeCompiler;
  private indexer: WikiIndexer;
  private linter: KnowledgeLinter;
  private watcher: KnowledgeWatcher;
  private queryExecutor: QueryKnowledgeExecutor;
  private fileBackExecutor: FileBackExecutor;

  constructor(
    private app: App,
    private settings: GeminiSettings,
    private modelService: ModelService,
    private toolManager: ToolManager
  ) {
    const wikiFolder = settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;

    // 初始化 registry（使用 vault adapter）
    this.registry = new KnowledgeRegistryManager(app.vault.adapter as any);

    // 初始化编译器（使用 ModelService.generate 做无状态 AI 调用）
    this.compiler = new KnowledgeCompiler(
      app,
      this.registry,
      (prompt: string) => modelService.generate(prompt, '你是一个知识编译器，请严格按照要求提取结构化信息。'),
      wikiFolder
    );

    // 初始化索引器
    this.indexer = new WikiIndexer(app, this.registry, wikiFolder);

    // 初始化 linter
    this.linter = new KnowledgeLinter(app, this.registry, wikiFolder);

    // 初始化 watcher
    this.watcher = new KnowledgeWatcher(
      app,
      this.registry,
      settings.knowledgeSourceFolders || [],
      wikiFolder
    );

    // 初始化消费层执行器
    this.queryExecutor = new QueryKnowledgeExecutor(app, wikiFolder);
    this.fileBackExecutor = new FileBackExecutor(app, this.indexer, wikiFolder);

    // 注入到 ToolManager
    toolManager.setKnowledgeExecutors(this.queryExecutor, this.fileBackExecutor);
  }

  /**
   * 插件启动时调用
   */
  async initialize(): Promise<void> {
    // 加载 registry
    await this.registry.load();

    // 重置 processing 状态
    this.registry.resetProcessingOnStartup();
    await this.registry.save();

    console.log('[KnowledgeRuntime] Initialized');
  }

  /**
   * 注册 Obsidian 命令
   */
  registerCommands(plugin: any): void {
    // Compile this note
    plugin.addCommand({
      id: 'knowledge-compile-this',
      name: 'Knowledge: Compile this note',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice('Please open a note first.');
          return;
        }

        new Notice(`Compiling: ${file.path}...`);

        // 注册（如果未注册）
        let record = this.registry.findByPath(file.path);
        if (!record) {
          record = this.registry.register(file.path);
          await this.registry.save();
        } else if (record.status === 'done') {
          // 已编译，标记为 stale 再重编译
          this.registry.transition(record.id, 'stale');
          this.registry.transition(record.id, 'pending');
          await this.registry.save();
        } else if (record.status === 'stale') {
          this.registry.transition(record.id, 'pending');
          await this.registry.save();
        }

        const result = await this.compiler.compileNote(record.id);
        if (result) {
          await this.indexer.rebuildIndex();
          new Notice(`Compiled: ${result}`);
        } else {
          const updated = this.registry.getRecord(record.id);
          new Notice(`Compilation failed: ${updated?.error || 'Unknown error'}`);
        }
      }
    });

    // Compile all pending
    plugin.addCommand({
      id: 'knowledge-compile-all',
      name: 'Knowledge: Compile all pending',
      callback: async () => {
        new Notice('Compiling all pending notes...');
        const maxBatch = this.settings.knowledgeMaxCompileBatch || 10;
        const result = await this.compiler.compileAllPending(maxBatch);
        if (result.success > 0) {
          await this.indexer.rebuildIndex();
        }
        new Notice(`Compiled: ${result.success} success, ${result.failed} failed`);
      }
    });

    // Open knowledge index
    plugin.addCommand({
      id: 'knowledge-open-index',
      name: 'Knowledge: Open knowledge index',
      callback: async () => {
        const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
        const indexPath = `${wikiFolder}/${WIKI_INDEX_FILENAME}`;
        const file = this.app.vault.getAbstractFileByPath(indexPath);
        if (file && file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        } else {
          new Notice('Knowledge index not found. Compile some notes first.');
        }
      }
    });

    // Run knowledge lint
    plugin.addCommand({
      id: 'knowledge-lint',
      name: 'Knowledge: Run knowledge lint',
      callback: async () => {
        new Notice('Running knowledge lint...');
        const reportPath = await this.linter.generateReport();
        new Notice(`Health report generated: ${reportPath}`);
        // 打开报告
        const file = this.app.vault.getAbstractFileByPath(reportPath);
        if (file && file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        }
      }
    });
  }

  /**
   * 注册文件事件监听
   */
  registerEvents(plugin: any): void {
    // 文件创建
    plugin.registerEvent(
      this.app.vault.on('create', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.settings.knowledgeAutoCompile) {
            this.watcher.onFileCreate(file);
          }
        }
      })
    );

    // 文件修改（使用 watcher 内部的防抖）
    plugin.registerEvent(
      this.app.vault.on('modify', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.settings.knowledgeAutoCompile) {
            this.watcher.onFileModify(file);
          }
        }
      })
    );

    // 文件删除
    plugin.registerEvent(
      this.app.vault.on('delete', (file: any) => {
        if (file instanceof TFile) {
          this.watcher.onFileDelete(file.path);
        }
      })
    );

    // 文件重命名
    plugin.registerEvent(
      this.app.vault.on('rename', (file: any, oldPath: string) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.watcher.onFileRename(oldPath, file.path);
        }
      })
    );
  }

  /**
   * Guardian 知识注入：从 index 中做关键词匹配，返回知识上下文
   */
  async getGuardianKnowledgeContext(editorContext: string): Promise<string> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const indexPath = `${wikiFolder}/${WIKI_INDEX_FILENAME}`;
    const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
    if (!indexFile || !(indexFile instanceof TFile)) return '';

    const indexContent = await this.app.vault.read(indexFile);

    // 从编辑器上下文中提取关键词（简单分词）
    const keywords = editorContext
      .split(/[\s,，。！？、；：""''（）\[\]{}]+/)
      .filter(w => w.length >= 2)
      .slice(0, 10);

    if (keywords.length === 0) return '';

    // 从 index 中匹配包含关键词的文章链接
    const matchedArticles: string[] = [];
    const lines = indexContent.split('\n');
    for (const line of lines) {
      const linkMatch = line.match(/\[\[([^\]|]+)\|([^\]]+)\]\]/);
      if (!linkMatch) continue;
      const [, path, title] = linkMatch;
      const titleLower = title.toLowerCase();
      if (keywords.some(kw => titleLower.includes(kw.toLowerCase()))) {
        matchedArticles.push(path);
      }
    }

    if (matchedArticles.length === 0) return '';

    // 读取匹配文章的 frontmatter（最多 3 篇）
    let context = '[知识库参考]\n';
    for (const articlePath of matchedArticles.slice(0, 3)) {
      const file = this.app.vault.getAbstractFileByPath(articlePath);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const titleMatch = fm.match(/title:\s*"([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : articlePath;

        // 提取 key_claims
        const claims: string[] = [];
        const claimRegex = /^\s+-\s+"([^"]+)"/gm;
        let claimMatch;
        const claimSection = fm.includes('key_claims:');
        if (claimSection) {
          const afterClaims = fm.substring(fm.indexOf('key_claims:'));
          while ((claimMatch = claimRegex.exec(afterClaims)) !== null) {
            claims.push(claimMatch[1]);
            if (claims.length >= 3) break;
          }
        }

        // 提取 concepts
        const conceptsMatch = fm.match(/concepts:\s*(\[.*\])/);
        let concepts: string[] = [];
        if (conceptsMatch) {
          try { concepts = JSON.parse(conceptsMatch[1]); } catch {}
        }

        context += `来自《${title}》：\n`;
        if (claims.length > 0) {
          context += `- 核心观点：${claims.join('；')}\n`;
        }
        if (concepts.length > 0) {
          context += `- 关键概念：${concepts.join('、')}\n`;
        }
        context += '\n';
      } catch { continue; }
    }

    context += '请在补全建议中自然融入上述个人知识，而不是给出通用回答。\n';
    return context;
  }

  /**
   * 设置变更时更新
   */
  updateSettings(settings: GeminiSettings): void {
    this.watcher.updateWatchedFolders(settings.knowledgeSourceFolders || []);
  }

  /**
   * 插件卸载时清理
   */
  cleanup(): void {
    this.watcher.cleanup();
  }
}
```

- [ ] **Step 2: Wire KnowledgeRuntime into main.ts**

In `main.ts`, add import and instantiation:

```typescript
// main.ts - ADD import at top (after existing imports)
import { KnowledgeRuntime } from './src/knowledge/runtime';
```

Add field to the plugin class:

```typescript
// main.ts - ADD field to GeminiShellPlugin class (after toolManager field, line 16)
    knowledgeRuntime: KnowledgeRuntime | null = null;
```

In `onload()`, after `this.toolManager.setGeminiApi(this.modelService);` (line 29), add:

```typescript
// main.ts - ADD in onload() after toolManager.setGeminiApi()

        // Initialize Knowledge Runtime
        this.knowledgeRuntime = new KnowledgeRuntime(
            this.app,
            this.settings,
            this.modelService,
            this.toolManager
        );
        await this.knowledgeRuntime.initialize();
        this.knowledgeRuntime.registerCommands(this);
        this.knowledgeRuntime.registerEvents(this);
```

In `onunload()`, add cleanup:

```typescript
// main.ts - ADD in onunload() before modelService.shutdown()

        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.cleanup();
        }
```

In `saveSettings()`, add settings update:

```typescript
// main.ts - ADD in saveSettings() after modelService.updateSettings()

        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.updateSettings(this.settings);
        }
```

- [ ] **Step 3: Verify build**

Run: `cmd /c npm.cmd run build`

- [ ] **Step 4: Final commit**

```
git add src/knowledge/runtime.ts main.ts
git commit -m "feat(knowledge): add KnowledgeRuntime and wire into plugin lifecycle"
```

---

## Final Verification

- [ ] **Step 1: Run all tests**

```bash
cmd /c npx.cmd tsx test/knowledge/types.test.ts
cmd /c npx.cmd tsx test/knowledge/registry.test.ts
cmd /c npx.cmd tsx test/knowledge/topic-utils.test.ts
cmd /c npx.cmd tsx test/knowledge/compiler.test.ts
cmd /c npx.cmd tsx test/knowledge/indexer.test.ts
cmd /c npx.cmd tsx test/knowledge/linter.test.ts
cmd /c npx.cmd tsx test/knowledge/watcher.test.ts
cmd /c npx.cmd tsx test/knowledge/query.test.ts
cmd /c npx.cmd tsx test/knowledge/file-back.test.ts
```

- [ ] **Step 2: Verify production build**

Run: `cmd /c npm.cmd run build`

- [ ] **Step 3: Verify file structure**

Expected new files:
```
src/knowledge/
├── types.ts           # 类型定义、常量、状态枚举
├── registry.ts        # 注册表读写、状态管理
├── topic-utils.ts     # Topic 页工具函数
├── compiler.ts        # 无状态 AI 编译（笔记 → summary）
├── indexer.ts         # index.md 和 topic 页维护
├── linter.ts          # 健康检查和报告
├── watcher.ts         # 文件夹监听和入队
├── query.ts           # query_knowledge 工具实现
├── file-back.ts       # file_back_knowledge 回填工具实现
└── runtime.ts         # 生命周期管理、命令注册、事件监听

test/knowledge/
├── types.test.ts
├── registry.test.ts
├── topic-utils.test.ts
├── compiler.test.ts
├── indexer.test.ts
├── linter.test.ts
├── watcher.test.ts
├── query.test.ts
└── file-back.test.ts
```

Modified files:
```
src/mcp/types.ts          # +4 settings fields + system prompt knowledge guidance
src/mcp/tools.ts          # +2 tool definitions + 2 execute cases + executor injection
src/services/model-service.ts  # +generate() method + getCurrentConfig()
src/settings.ts            # +Knowledge Compiler settings section
src/ui/shell-view.ts       # +thumbs up/down buttons on AI messages
src/ui/chat-controller.ts  # +feedback field + /file-back command
main.ts                    # +KnowledgeRuntime instantiation + Guardian injection
styles.css                 # +feedback button styles
```

- [ ] **Step 4: Final integration commit**

```
git add -A
git commit -m "feat(knowledge): complete Knowledge Wiki system implementation"
```
