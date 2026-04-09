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
