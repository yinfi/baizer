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
