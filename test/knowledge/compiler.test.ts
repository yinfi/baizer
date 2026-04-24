// test/knowledge/compiler.test.ts

import {
  buildCompilerPrompt,
  parseCompilerResponse,
  buildSummaryMarkdown,
  chunkDocument,
  mergeExtractions,
  computeContentHash,
  stripFrontmatter,
} from '../../src/knowledge/compiler';
import { CompilerExtraction, OntologySchema } from '../../src/knowledge/types';

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
  expect(md).toContain('- "Second Brain"');
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

// --- Ontology 扩展测试 ---

test('buildCompilerPrompt with ontologySchema injects categories and entity_types', () => {
  const schema: OntologySchema = {
    version: 1,
    categories: [
      { name: '心智模型', description: '可复用的思维框架' },
      { name: '方法论', description: '具体的操作方法' },
    ],
    entity_types: [
      { name: '人物', description: '文章中提到的关键人物' },
    ],
  };
  const prompt = buildCompilerPrompt('# Test', 'test.md', schema);
  expect(prompt).toContain('本体模型提取要求');
  expect(prompt).toContain('"心智模型"');
  expect(prompt).toContain('"方法论"');
  expect(prompt).toContain('"人物"');
  expect(prompt).toContain('categorized_knowledge');
  expect(prompt).toContain('entities');
});

test('buildCompilerPrompt without ontologySchema has no ontology section', () => {
  const prompt = buildCompilerPrompt('# Test', 'test.md');
  expect(prompt).toContain('知识编译器');
  expect(prompt.includes('本体模型提取要求')).toBeFalsy();
});

test('buildSummaryMarkdown includes schemaHash when provided', () => {
  const extraction: CompilerExtraction = {
    title: 'Test', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: []
  };
  const md = buildSummaryMarkdown('ksrc_x', extraction, 'test.md', 'abcd1234');
  expect(md).toContain('schema_hash: "abcd1234"');
});

test('buildSummaryMarkdown includes categorized_knowledge and entities', () => {
  const extraction: CompilerExtraction = {
    title: 'Ontology Test', author: 'Author', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
    categorized_knowledge: [
      { category: '心智模型', items: ['第一性原理', '反脆弱'] },
    ],
    entities: [
      { name: 'Nassim Taleb', type: '人物', description: '反脆弱作者' },
    ],
  };
  const md = buildSummaryMarkdown('ksrc_y', extraction, 'test.md');
  expect(md).toContain('categorized_knowledge:');
  expect(md).toContain('category: "心智模型"');
  expect(md).toContain('entities:');
  expect(md).toContain('name: "Nassim Taleb"');
  expect(md).toContain('type: "人物"');
});

// --- mergeExtractions ---

test('mergeExtractions returns empty guard for empty array', () => {
  const result = mergeExtractions([]);
  expect(result.title).toBe('');
  expect(result.review_flags.length > 0).toBeTruthy();
});

test('mergeExtractions passes through single extraction', () => {
  const ext: CompilerExtraction = {
    title: 'Only', author: 'A', source_url: '', created_at: '',
    topics: [{ slug: 'ai', label: 'AI' }], concepts: ['LLM'],
    key_claims: ['claim1'], review_flags: [],
  };
  const result = mergeExtractions([ext]);
  expect(result.title).toBe('Only');
  expect(result.concepts.length).toBe(1);
});

test('mergeExtractions takes first non-empty title/author', () => {
  const e1: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
  };
  const e2: CompilerExtraction = {
    title: 'Real Title', author: 'Author', source_url: 'url', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.title).toBe('Real Title');
  expect(result.author).toBe('Author');
});

test('mergeExtractions deduplicates topics by slug', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [{ slug: 'ai', label: 'AI' }], concepts: [], key_claims: [], review_flags: [],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [{ slug: 'ai', label: 'Artificial Intelligence' }, { slug: 'ml', label: 'ML' }],
    concepts: [], key_claims: [], review_flags: [],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.topics.length).toBe(2); // ai + ml, not 3
});

test('mergeExtractions deduplicates concepts exactly', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [], concepts: ['LLM', 'RAG'], key_claims: [], review_flags: [],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: ['LLM', 'Vector DB'], key_claims: [], review_flags: [],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.concepts.length).toBe(3); // LLM, RAG, Vector DB
});

test('mergeExtractions deduplicates key_claims', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: ['claim A', 'claim B'], review_flags: [],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: ['claim B', 'claim C'], review_flags: [],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.key_claims.length).toBe(3);
});

test('mergeExtractions deduplicates entities by name+type, keeps longest desc', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
    entities: [{ name: 'Karpathy', type: '人物', description: 'AI researcher' }],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
    entities: [{ name: 'Karpathy', type: '人物', description: 'AI researcher and former Tesla AI director' }],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.entities!.length).toBe(1);
  expect(result.entities![0].description).toContain('Tesla');
});

test('mergeExtractions merges categorized_knowledge by category', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
    categorized_knowledge: [{ category: '心智模型', items: ['第一性原理'] }],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
    categorized_knowledge: [{ category: '心智模型', items: ['反脆弱', '第一性原理'] }],
  };
  const result = mergeExtractions([e1, e2]);
  expect(result.categorized_knowledge!.length).toBe(1);
  expect(result.categorized_knowledge![0].items.length).toBe(2); // deduped
});

test('mergeExtractions adds compiled_from_N_chunks flag', () => {
  const e1: CompilerExtraction = {
    title: 'T', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: ['flag1'],
  };
  const e2: CompilerExtraction = {
    title: '', author: '', source_url: '', created_at: '',
    topics: [], concepts: [], key_claims: [], review_flags: [],
  };
  const result = mergeExtractions([e1, e2]);
  const hasChunkFlag = result.review_flags.some(f => f.includes('compiled_from_2_chunks'));
  expect(hasChunkFlag).toBeTruthy();
  const hasFlag1 = result.review_flags.some(f => f === 'flag1');
  expect(hasFlag1).toBeTruthy();
});

// --- stripFrontmatter ---

test('stripFrontmatter removes frontmatter block', () => {
  const content = '---\ntitle: test\nstatus: done\n---\nBody here';
  expect(stripFrontmatter(content)).toBe('Body here');
});

test('stripFrontmatter returns content as-is when no frontmatter', () => {
  const content = 'No frontmatter here';
  expect(stripFrontmatter(content)).toBe('No frontmatter here');
});

// --- computeContentHash ---

test('computeContentHash strips frontmatter before hashing', () => {
  const h1 = computeContentHash('---\ntitle: a\n---\nBody');
  const h2 = computeContentHash('---\ntitle: b\n---\nBody');
  expect(h1).toBe(h2); // same body, different frontmatter → same hash
});

test('computeContentHash returns 8-char hex', () => {
  const h = computeContentHash('some content');
  expect(h.length).toBe(8);
});

test('computeContentHash differs for different body', () => {
  const h1 = computeContentHash('Body A');
  const h2 = computeContentHash('Body B');
  expect(h1 !== h2).toBeTruthy();
});

// --- chunkDocument ---

test('chunkDocument returns single chunk for short content', () => {
  const chunks = chunkDocument('Short content');
  expect(chunks.length).toBe(1);
  expect(chunks[0]).toBe('Short content');
});

test('chunkDocument returns single chunk at 30000 boundary', () => {
  const content = 'x'.repeat(30000);
  const chunks = chunkDocument(content);
  expect(chunks.length).toBe(1);
});

test('chunkDocument splits long content into multiple chunks', () => {
  let content = '---\ntitle: t\n---\n';
  content += '## Section 1\n' + 'a'.repeat(20000) + '\n\n';
  content += '## Section 2\n' + 'b'.repeat(20000);
  const chunks = chunkDocument(content);
  expect(chunks.length >= 2).toBeTruthy();
});

test('chunkDocument preserves context prefix in each chunk', () => {
  let content = '---\ntitle: test\n---\n';
  content += '## S1\n' + 'a'.repeat(20000) + '\n\n';
  content += '## S2\n' + 'b'.repeat(20000);
  const chunks = chunkDocument(content);
  for (const chunk of chunks) {
    expect(chunk).toContain('---');
  }
});

test('chunkDocument handles content without headings via paragraph split', () => {
  const content = ('paragraph one\n\n').repeat(3000); // ~45000 chars, no headings
  const chunks = chunkDocument(content);
  expect(chunks.length >= 2).toBeTruthy();
});

console.log('All compiler tests passed!');
