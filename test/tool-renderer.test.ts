import { FakeElement } from './ui-fakes';

function expect(actual: any) {
  return {
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
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
  console.log('=== Tool Renderer Tests ===');
  const { ToolRenderer } = await import('../src/ui/renderers/tool-renderer');

  await test('tool renderer appends tool results onto the matching node', () => {
    const timeline = new FakeElement();
    const renderer = new ToolRenderer(timeline as any);

    renderer.addToolCall('search_vault', { query: 'obsidian' });
    renderer.updateToolResult('search_vault', { matches: ['a.md'] });

    const detail = timeline.querySelector('.think-node-detail');
    expect((detail as any).textContent).toContain('Result');
    expect((detail as any).textContent).toContain('a.md');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
