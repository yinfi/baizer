function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
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
  console.log('=== Input Controller Tests ===');
  const {
    detectSuggestionTrigger,
    InputController,
  } = await import('../src/ui/controllers/input-controller');

  await test('detectSuggestionTrigger identifies slash and file triggers', () => {
    expect(detectSuggestionTrigger('/sa', 3)).toEqual({ type: 'command', query: 'sa' });
    expect(detectSuggestionTrigger('see @rea', 8)).toEqual({ type: 'file', query: 'rea' });
    expect(detectSuggestionTrigger('use $web', 8)).toEqual({ type: 'skill', query: 'web' });
    expect(detectSuggestionTrigger('hello world', 11)).toBe(null);
  });

  await test('InputController replaces the active trigger token with the selected suggestion', () => {
    const controller = new InputController();
    controller.setSuggestions('command', [
      { label: '/save', desc: 'Save webpage' },
    ]);

    const result = controller.selectSuggestion('please /sa now', 10);

    expect(result).toEqual({
      text: 'please /save  now',
      cursor: 13,
    });
  });

  await test('InputController returns a scope context item instead of inline text for scoped note mentions', () => {
    const controller = new InputController();
    controller.setSuggestions('file', [
      {
        label: '@backlinks',
        desc: 'Add notes linking to the current note',
        value: '@backlinks',
        source: 'scope',
        kind: 'scope',
        scope: 'backlinks',
      } as any,
    ]);

    const result = controller.selectSuggestion('compare @bac later', 12);

    expect(result).toEqual({
      text: 'compare later',
      cursor: 8,
      contextItem: {
        id: 'scope:backlinks',
        type: 'scope',
        data: '@backlinks',
        summary: 'Add notes linking to the current note',
        scope: 'backlinks',
      },
    });
  });

  await test('InputController returns a file context item instead of inserting a wiki link', () => {
    const controller = new InputController();
    controller.setSuggestions('file', [
      {
        label: '核心看板',
        desc: 'Projects/核心看板.md',
        value: '[[Projects/核心看板.md]]',
        source: 'file',
      } as any,
    ]);

    const result = controller.selectSuggestion('use @kanban today', 12);

    expect(result).toEqual({
      text: 'use today',
      cursor: 4,
      contextItem: {
        id: 'file:Projects/核心看板.md',
        type: 'file',
        data: 'Projects/核心看板.md',
        summary: '核心看板',
      },
    });
  });

  await test('InputController leaves incomplete tag scope text in place', () => {
    const controller = new InputController();
    controller.setSuggestions('file', [
      {
        label: '@tag:',
        desc: 'Add notes matching a tag',
        value: '@tag:',
        source: 'scope',
        kind: 'scope',
        scope: 'tag',
      } as any,
    ]);

    const result = controller.selectSuggestion('@tag:', 5);

    expect(result).toEqual({
      text: '@tag:',
      cursor: 5,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
