// test/knowledge/watcher.test.ts

import {
  isInWatchedFolder,
  shouldEnqueueFile
} from '../../src/knowledge/watcher';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Folder Watcher Tests ===');

test('isInWatchedFolder matches exact folder', () => {
  expect(isInWatchedFolder('Clippings/test.md', ['Clippings'])).toBeTruthy();
  expect(isInWatchedFolder('Clippings/sub/test.md', ['Clippings'])).toBeTruthy();
});

test('isInWatchedFolder rejects non-watched paths', () => {
  expect(isInWatchedFolder('Notes/test.md', ['Clippings'])).toBeFalsy();
  expect(isInWatchedFolder('test.md', ['Clippings'])).toBeFalsy();
});

test('isInWatchedFolder handles multiple folders', () => {
  const folders = ['Clippings', 'Reading Notes'];
  expect(isInWatchedFolder('Clippings/a.md', folders)).toBeTruthy();
  expect(isInWatchedFolder('Reading Notes/b.md', folders)).toBeTruthy();
  expect(isInWatchedFolder('Other/c.md', folders)).toBeFalsy();
});

test('isInWatchedFolder handles trailing slashes', () => {
  expect(isInWatchedFolder('Clippings/test.md', ['Clippings/'])).toBeTruthy();
});

test('shouldEnqueueFile filters non-markdown files', () => {
  expect(shouldEnqueueFile('test.md', ['Clippings'])).toBeFalsy();
  expect(shouldEnqueueFile('Clippings/test.md', ['Clippings'])).toBeTruthy();
  expect(shouldEnqueueFile('Clippings/test.txt', ['Clippings'])).toBeFalsy();
  expect(shouldEnqueueFile('Clippings/test.png', ['Clippings'])).toBeFalsy();
});

test('shouldEnqueueFile excludes wiki output folder', () => {
  expect(shouldEnqueueFile('Knowledge Wiki/Articles/ksrc_a.md', ['Knowledge Wiki'])).toBeFalsy();
});

console.log('All watcher tests passed!');
