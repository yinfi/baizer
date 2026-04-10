// test/knowledge/query.test.ts

import { QueryKnowledgeExecutor } from '../../src/knowledge/query';

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

function test(name: string, fn: () => Promise<void> | void) {
  const result = fn();
  if (result instanceof Promise) {
    result.then(() => console.log(`  ✓ ${name}`))
      .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); });
  } else {
    console.log(`  ✓ ${name}`);
  }
}

// Mock MetadataIndex — 需要 buildSmartIndex 方法
function createMockIndex(totalCount: number, indexStr: string, filtered: boolean = false) {
  return {
    buildSmartIndex: (_query: string) => ({
      index: indexStr,
      totalCount,
      filtered
    })
  } as any;
}

const sampleIndex = `知识库共 2 篇文章：

[1] AI Basics | 主题: AI/Machine Learning | 路径: [[KW/Articles/ai-basics.md]]
[2] Second Brain | 主题: PKM | 观点: 知识管理的核心是连接 | 路径: [[KW/Articles/second-brain.md]]
`;

console.log('=== query_knowledge Tests ===');

test('empty knowledge base returns correct instruction', async () => {
  const executor = new QueryKnowledgeExecutor(createMockIndex(0, ''));
  const result = await executor.execute({ query: 'nonexistent' });
  expect(result.query).toBe('nonexistent');
  expect(result.indexContent).toBe('');
  expect(result.instruction).toContain('知识库为空');
});

test('returns compact index for AI to judge relevance', async () => {
  const executor = new QueryKnowledgeExecutor(createMockIndex(2, sampleIndex));
  const result = await executor.execute({ query: 'AI' });
  expect(result.query).toBe('AI');
  expect(result.indexContent).toContain('AI Basics');
  expect(result.indexContent).toContain('Second Brain');
  expect(result.instruction).toContain('read_note');
  expect(result.instruction).toContain('全部 2 篇');
});

test('filtered mode shows correct scope description', async () => {
  const executor = new QueryKnowledgeExecutor(createMockIndex(150, sampleIndex, true));
  const result = await executor.execute({ query: 'AI' });
  expect(result.instruction).toContain('从 150 篇文章中初筛');
});

test('max_results defaults to 5', async () => {
  const executor = new QueryKnowledgeExecutor(createMockIndex(0, ''));
  const result = await executor.execute({ query: 'test' });
  expect(result.maxResults).toBe(5);
});

test('max_results parameter is passed through', async () => {
  const executor = new QueryKnowledgeExecutor(createMockIndex(0, ''));
  const result = await executor.execute({ query: 'test', max_results: 10 });
  expect(result.maxResults).toBe(10);
});

console.log('All query_knowledge tests passed!');
