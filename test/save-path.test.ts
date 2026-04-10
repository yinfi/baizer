import { resolveSavedNotePath } from '../src/mcp/save-path';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
      }
    }
  };
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

console.log('=== save-path Tests ===');

test('uses clipping folder when filename has no explicit path', () => {
  const result = resolveSavedNotePath('Article Title.md', 'Clippings', () => false);
  expect(result).toBe('Clippings/Article Title.md');
});

test('keeps explicit path when filename already specifies a folder', () => {
  const result = resolveSavedNotePath('Manual/Article Title.md', 'Clippings', () => false);
  expect(result).toBe('Manual/Article Title.md');
});

test('deduplicates inside clipping folder', () => {
  const existing = new Set(['Clippings/Article Title.md']);
  const result = resolveSavedNotePath('Article Title.md', 'Clippings', (path) => existing.has(path));
  expect(result).toBe('Clippings/Article Title (1).md');
});

test('falls back to vault root when clipping folder is empty', () => {
  const result = resolveSavedNotePath('Article Title.md', '', () => false);
  expect(result).toBe('Article Title.md');
});

console.log('All save-path tests passed!');
