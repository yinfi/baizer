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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
