function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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
  console.log('=== Change Preview Tests ===');
  const {
    buildSelectionPreview,
    cloneChangePreview,
  } = await import('../src/ui/diff/change-preview');

  await test('cloneChangePreview preserves preview payloads without sharing nested arrays', () => {
    const original = {
      kind: 'note-create',
      target: 'Plans/Native-AI.md',
      summary: 'Create rollout note',
      newContent: '# Native AI',
      preconditions: ['Target folder exists'],
      risk: 'medium',
      supportsPartialApply: false,
      undoable: true,
    } as const;

    const cloned = cloneChangePreview(original as any);
    cloned?.preconditions?.push('Extra check');

    expect(original).toEqual({
      kind: 'note-create',
      target: 'Plans/Native-AI.md',
      summary: 'Create rollout note',
      newContent: '# Native AI',
      preconditions: ['Target folder exists'],
      risk: 'medium',
      supportsPartialApply: false,
      undoable: true,
    });
    expect(cloned).toEqual({
      kind: 'note-create',
      target: 'Plans/Native-AI.md',
      summary: 'Create rollout note',
      newContent: '# Native AI',
      preconditions: ['Target folder exists', 'Extra check'],
      risk: 'medium',
      supportsPartialApply: false,
      undoable: true,
    });
  });

  await test('buildSelectionPreview creates an editor replacement preview', () => {
    const preview = buildSelectionPreview({
      target: 'current-selection',
      oldContent: 'before',
      newContent: 'after',
    });

    expect(preview).toEqual({
      kind: 'editor-selection-replace',
      target: 'current-selection',
      summary: 'Replace the current editor selection',
      oldContent: 'before',
      newContent: 'after',
      risk: 'medium',
      supportsPartialApply: true,
      undoable: true,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
