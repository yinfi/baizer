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

  await test('ShellView suggests scoped note context entries before matching files for @ mentions', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({
      app: {
        vault: {
          getFiles: () => [
            { basename: 'Backlog', path: 'Projects/Backlog.md' },
            { basename: 'Background', path: 'Notes/Background.md' },
          ],
        },
      },
    } as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      vault: {
        getFiles: () => [
          { basename: 'Backlog', path: 'Projects/Backlog.md' },
          { basename: 'Background', path: 'Notes/Background.md' },
        ],
      },
    };
    (view as any).suggestionContainer = {
      empty: () => {},
      style: { display: 'none' },
    };
    (view as any).commandDropdown = {
      update: () => {},
      hide: () => {},
    };

    view.showSuggestions('file', 'bac');

    expect((view as any).inputController.getSuggestions()).toEqual([
      {
        label: '@backlinks',
        desc: 'Add notes linking to the current note',
        value: '@backlinks',
        source: 'scope',
        kind: 'scope',
        scope: 'backlinks',
      },
      {
        label: 'Backlog',
        desc: 'Projects/Backlog.md',
        value: '[[Projects/Backlog.md]]',
        source: 'file',
      },
      {
        label: 'Background',
        desc: 'Notes/Background.md',
        value: '[[Notes/Background.md]]',
        source: 'file',
      },
    ]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
