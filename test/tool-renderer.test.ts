import { FakeElement } from './ui-fakes';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
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
  const { ToolRenderer, getToolSummary } = await import('../src/ui/renderers/tool-renderer');

  await test('tool summaries show file basenames for path-heavy operations', () => {
    expect(getToolSummary('edit_file', {
      path: 'Study/财经理论入门课程/01_course_materials/02_supply_demand_price.md',
    })).toBe('Edit: 02_supply_demand_price.md');
  });

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
