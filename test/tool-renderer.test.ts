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

  await test('tool renderer handles NodeList-style querySelectorAll results from the browser', () => {
    const detail = new FakeElement();
    detail.className = 'think-node-detail';
    detail.textContent = JSON.stringify({ query: 'obsidian' }, null, 2);

    const toolNode = new FakeElement();
    toolNode.className = 'think-node is-tool';
    toolNode.dataset.toolName = 'search_vault';
    toolNode.querySelector = (_selector: string) => detail as any;

    const timeline = {
      querySelectorAll: (_selector: string) => ({
        0: toolNode,
        length: 1,
        item: (index: number) => (index === 0 ? toolNode : null),
        [Symbol.iterator]: function* () {
          yield toolNode;
        },
      }),
    };

    const renderer = new ToolRenderer(timeline as any);
    renderer.updateToolResult('search_vault', { matches: ['a.md'] });

    expect(detail.textContent).toContain('Result');
    expect(detail.textContent).toContain('a.md');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
