import { FakeElement } from './ui-fakes';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Thinking Renderer Tests ===');
  const { ThinkingRenderer } = await import('../src/ui/renderers/thinking-renderer');

  await test('appendThinking creates and updates a thinking node with a truncated label', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any);

    renderer.appendThinking('This is a very long thought message for testing label truncation.');

    const label = timeline.querySelector('.think-node-label');
    expect(!!label).toBe(true);
    expect((label as any).textContent.endsWith('...')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
