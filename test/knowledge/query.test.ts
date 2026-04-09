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
