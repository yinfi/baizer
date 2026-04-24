function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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
  console.log('=== Context Budget Tests ===');
  const { budgetContextItems, budgetTextBlock } = await import('../src/services/context-budget');

  await test('budgetContextItems trims oversized content and prefers higher priority items', () => {
    const result = budgetContextItems([
      { id: 'url-1', type: 'url', data: 'https://a', content: 'u'.repeat(2000) },
      { id: 'file-1', type: 'file', data: 'note.md', content: 'f'.repeat(2000) },
      { id: 'text-1', type: 'text', data: 'note', content: 't'.repeat(400) },
    ], {
      maxItems: 2,
      maxChars: 1800,
      perItemChars: 900,
    });

    expect(result.length).toBe(2);
    expect(result[0].id).toBe('file-1');
    expect((result[0].content || '').length <= 900).toBe(true);
    expect((result[1].content || '').length <= 900).toBe(true);
  });

  await test('budgetTextBlock truncates long text with an ellipsis marker', () => {
    const result = budgetTextBlock('x'.repeat(100), 20);
    expect(result.length <= 20).toBe(true);
    expect(result).toContain('...');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
