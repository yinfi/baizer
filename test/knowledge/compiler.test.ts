// test/knowledge/compiler.test.ts

import {
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
