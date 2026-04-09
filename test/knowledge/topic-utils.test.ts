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
