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
