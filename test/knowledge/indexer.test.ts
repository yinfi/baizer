// test/knowledge/indexer.test.ts

import { buildBaseFileContent } from '../../src/knowledge/indexer';

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

test('buildBaseFileContent generates filters matching articlesFolder', () => {
  const content = buildBaseFileContent('Knowledge Wiki/Articles');
  expect(content).toContain('file.folder == "Knowledge Wiki/Articles"');
});

test('buildBaseFileContent includes property definitions', () => {
  const content = buildBaseFileContent('KW/Articles');
  expect(content).toContain('properties:');
  expect(content).toContain('title:');
  expect(content).toContain('topics:');
  expect(content).toContain('concepts:');
  expect(content).toContain('compiled_at:');
  expect(content).toContain('source_url:');
  expect(content).toContain('author:');
});

test('buildBaseFileContent includes views definitions', () => {
  const content = buildBaseFileContent('KW/Articles');
  expect(content).toContain('views:');
  expect(content).toContain('type: table');
  expect(content).toContain('所有文章');
  expect(content).toContain('按主题');
});

test('buildBaseFileContent uses custom folder path in filter', () => {
  const content = buildBaseFileContent('My Notes/Wiki/Articles');
  expect(content).toContain('file.folder == "My Notes/Wiki/Articles"');
  expect(content).not.toContain('Knowledge Wiki/Articles');
});

console.log('All indexer tests passed!');
