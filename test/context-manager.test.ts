import { ContextManager } from '../src/services/context-manager';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error('Expected truthy'); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}"`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

console.log('=== ContextManager Tests ===');

test('constructor takes no arguments', async () => {
  const cm = new ContextManager();
  expect(cm.getContexts().length).toBe(0);
});

test('addContext accepts a ContextItem object', async () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'img1', type: 'image', data: 'base64data' });
  expect(cm.getContexts().length).toBe(1);
  expect(cm.getContexts()[0].type).toBe('image');
  expect(cm.getContexts()[0].id).toBe('img1');
});

test('addContext avoids duplicates by id', async () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'f1', type: 'file', data: '/path/a.md' });
  cm.addContext({ id: 'f1', type: 'file', data: '/path/a.md' });
  expect(cm.getContexts().length).toBe(1);
});

test('removeContext by string id', async () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'a', type: 'text', data: 'hello' });
  cm.addContext({ id: 'b', type: 'text', data: 'world' });
  cm.removeContext('a');
  expect(cm.getContexts().length).toBe(1);
  expect(cm.getContexts()[0].id).toBe('b');
});

test('clearContexts removes all', async () => {
  const cm = new ContextManager();
  cm.addContext({ id: 'x', type: 'url', data: 'https://example.com' });
  cm.clearContexts();
  expect(cm.getContexts().length).toBe(0);
});

test('resolveContexts uses the shared video transcript fetcher for youtube contexts', async () => {
  const cm = new (ContextManager as any)({
    fetchWebContent: async (_url: string) => '',
    fetchVideoTranscript: async (url: string) => `Shared transcript for ${url}`,
  });
  cm.addContext({ id: 'yt', type: 'youtube', data: 'https://youtu.be/demo' });

  const resolved = await cm.resolveContexts();
  expect(resolved[0].content).toContain('Shared transcript');
});

test('resolveContexts returns an explicit error marker for failed url fetches', async () => {
  const cm = new (ContextManager as any)({
    fetchWebContent: async (_url: string) => '[Error fetching content from https://example.com]',
    fetchVideoTranscript: async (_url: string) => '',
  });
  cm.addContext({ id: 'url', type: 'url', data: 'https://example.com' });

  const resolved = await cm.resolveContexts();
  expect(resolved[0].content).toContain('[Error fetching content');
});

console.log('All ContextManager tests passed!');
