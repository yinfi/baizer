// test/context-manager.test.ts

import { ContextManager, ContextItem } from '../src/services/context-manager';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== ContextManager Tests ===');

test('constructor takes no arguments', () => {
  const cm = new ContextManager();
  expect(cm.getContexts().length).toBe(0);
});

test('addContext accepts a ContextItem object', () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'img1', type: 'image', data: 'base64data' });
  expect(cm.getContexts().length).toBe(1);
  expect(cm.getContexts()[0].type).toBe('image');
  expect(cm.getContexts()[0].id).toBe('img1');
});

test('addContext avoids duplicates by id', () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'f1', type: 'file', data: '/path/a.md' });
  cm.addContext({ id: 'f1', type: 'file', data: '/path/a.md' });
  expect(cm.getContexts().length).toBe(1);
});

test('removeContext by string id', () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'a', type: 'text', data: 'hello' });
  cm.addContext({ id: 'b', type: 'text', data: 'world' });
  cm.removeContext('a');
  expect(cm.getContexts().length).toBe(1);
  expect(cm.getContexts()[0].id).toBe('b');
});

test('clearContexts removes all', () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'x', type: 'url', data: 'https://example.com' });
  cm.clearContexts();
  expect(cm.getContexts().length).toBe(0);
});

console.log('All ContextManager tests passed!');
