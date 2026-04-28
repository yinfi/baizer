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

  await test('ShellView keeps only genuinely local slash commands in its hardcoded suggestions', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    const labels = ((view as any).localCommandSuggestions as Array<{ label: string }>)
      .map(command => command.label)
      .sort();

    expect(labels.includes('/save')).toBe(false);
    expect(labels.includes('/file-back')).toBe(true);
    expect(labels.includes('/help')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
