// test/knowledge/metadata-index.test.ts
// 回归：metadataCache frontmatter 是外部数据（旧文章/手改 YAML 形状不可信），
// 索引构建必须对坏字段做窄化，不能把非字符串塞进 ArticleMeta 或直接抛错。

import { TFile } from 'obsidian';
import { MetadataIndex } from '../../src/knowledge/metadata-index';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${JSON.stringify(actual)}"`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
    toBeTruthy: () => { if (!actual) throw new Error('Expected truthy'); },
    toBeFalsy: () => { if (actual) throw new Error('Expected falsy'); },
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

function createApp(entries: Record<string, Record<string, any>>) {
  const files = new Map<string, { file: TFile; frontmatter: Record<string, any> }>();
  for (const [path, frontmatter] of Object.entries(entries)) {
    const file = new TFile();
    file.path = path;
    file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
    file.extension = 'md';
    files.set(path, { file, frontmatter });
  }

  return {
    vault: {
      getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const entry = files.get(file.path);
        return entry ? { frontmatter: entry.frontmatter } : null;
      },
    },
  } as any;
}

function buildIndex(entries: Record<string, Record<string, any>>): MetadataIndex {
  const index = new MetadataIndex(createApp(entries), 'Knowledge Wiki');
  index.rebuild();
  return index;
}

console.log('=== Metadata Index Tests ===');

async function runTests() {
  await test('rebuild indexes generated articles and skips non-generated files', () => {
    const index = buildIndex({
      'Knowledge Wiki/Articles/a.md': {
        knowledge_generated: true,
        knowledge_source_id: 'ksrc_a',
        title: 'Article A',
        topics: ['AI'],
        compiled_at: '2026-01-01T00:00:00Z',
      },
      'Knowledge Wiki/Articles/b.md': {
        knowledge_generated: 'true',
        knowledge_source_id: 'ksrc_b',
        title: 'Article B',
        compiled_at: '2026-01-02T00:00:00Z',
      },
      'Knowledge Wiki/Articles/notes.md': { title: 'Not generated' },
      'Elsewhere/c.md': { knowledge_generated: true, title: 'Outside articles folder' },
    });

    const articles = index.getAllArticles();
    expect(articles.length).toBe(2);
    expect(index.size).toBe(2);
    expect(articles.some((a) => a.sourceId === 'ksrc_a')).toBe(true);
    expect(articles.some((a) => a.sourceId === 'ksrc_b')).toBe(true);
  });

  await test('malformed topics/concepts/claims/entities/categories are narrowed or dropped', () => {
    const index = buildIndex({
      'Knowledge Wiki/Articles/a.md': {
        knowledge_generated: true,
        knowledge_source_id: 'ksrc_malformed',
        title: 'Malformed',
        topics: ['AI', { label: 'ML' }, { slug: 'no-label' }, null, 7, { label: 42 }],
        concepts: '["c1","c2"]',
        key_claims: '["claim1"]',
        categorized_knowledge: [
          { category: 'cat-a', items: ['item-a', 3] },
          { category: 'cat-b', items: '["item-b"]' },
          { items: ['orphan'] },
          null,
        ],
        entities: [
          { name: 'E1', type: 'T1' },
          { name: 'E2', type: 5 },
          { name: 'E3', type: 'T3', description: 42 },
          null,
        ],
        compiled_at: '2026-02-01T00:00:00Z',
      },
    });

    const [meta] = index.getAllArticles();
    expect(meta.topics).toEqual(['AI', 'ML']);
    expect(meta.concepts).toEqual(['c1', 'c2']);
    expect(meta.keyClaims).toEqual(['claim1']);
    expect(meta.categorizedKnowledge!.length).toBe(2);
    expect(meta.categorizedKnowledge![0]).toEqual({ category: 'cat-a', items: ['item-a', '3'] });
    expect(meta.categorizedKnowledge![1]).toEqual({ category: 'cat-b', items: ['item-b'] });
    expect(meta.entities!.length).toBe(2);
    expect(meta.entities![0]).toEqual({ name: 'E1', type: 'T1', description: '' });
    expect(meta.entities![1]).toEqual({ name: 'E3', type: 'T3', description: '' });
  });

  await test('non-array JSON strings for list fields degrade predictably', () => {
    const index = buildIndex({
      'Knowledge Wiki/Articles/a.md': {
        knowledge_generated: true,
        knowledge_source_id: 'ksrc_scalar',
        title: 'Scalar',
        concepts: '42', // JSON 合法但不是数组 → 回退成原文单条
        key_claims: 'not-json', // 解析失败 → 回退成原文单条
        topics: 'AI', // 非数组 → 空
      },
    });

    const [meta] = index.getAllArticles();
    expect(meta.concepts).toEqual(['42']);
    expect(meta.keyClaims).toEqual(['not-json']);
    expect(meta.topics.length).toBe(0);
  });

  await test('search/getByTopic still work on narrowed metadata', () => {
    const index = buildIndex({
      'Knowledge Wiki/Articles/a.md': {
        knowledge_generated: true,
        knowledge_source_id: 'ksrc_search',
        title: 'Second Brain',
        topics: ['Second Brain'],
        concepts: '["LLM"]',
        key_claims: '["claim"]',
        compiled_at: '2026-03-01T00:00:00Z',
      },
    });

    expect(index.getByTopic('second-brain').length).toBe(1);
    expect(index.search('brain').length).toBe(1);
    expect(index.search('nothing-matches-here').length).toBe(0);
    expect(index.getTopicSummary()[0]).toEqual({ topic: 'Second Brain', count: 1 });
  });

  await test('incremental onFileChanged/onFileDeleted update the index', () => {
    const app = createApp({
      'Knowledge Wiki/Articles/a.md': {
        knowledge_generated: true,
        knowledge_source_id: 'ksrc_a',
        title: 'A',
        compiled_at: '2026-01-01T00:00:00Z',
      },
    });
    const index = new MetadataIndex(app, 'Knowledge Wiki');
    index.rebuild();
    const file = app.vault.getMarkdownFiles()[0];

    expect(index.size).toBe(1);
    index.onFileDeleted(file.path);
    expect(index.size).toBe(0);
    index.onFileChanged(file);
    expect(index.size).toBe(1);
  });

  console.log('All metadata index tests passed!');
}

void runTests();
