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

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Command Suggestion Tests ===');
  const { buildCommandSuggestions } = await import('../src/ui/command-suggestions');

  await test('buildCommandSuggestions merges local and dynamic skill commands without duplicates', async () => {
    const suggestions = buildCommandSuggestions(
      [
        { label: '/clear', desc: 'Clear session history' },
        { label: '/save', desc: 'Old local save description' },
      ],
      [
        { command: '/save', description: 'Save webpage to vault' },
        { command: '/wiki:query', description: 'Query knowledge wiki' },
      ],
      '',
    );

    expect(suggestions).toEqual([
      { label: '/clear', desc: 'Clear session history' },
      { label: '/save', desc: 'Save webpage to vault' },
      { label: '/wiki:query', desc: 'Query knowledge wiki' },
    ]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
