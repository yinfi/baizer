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
  console.log('=== Context Controller Tests ===');
  const { ContextController } = await import('../src/ui/controllers/context-controller');

  await test('collectCommandContext expands scoped context chips through ObsidianContextService', async () => {
    const collectCalls: any[] = [];
    const controller = new ContextController({
      app: {
      } as any,
      contextManager: {
        getContexts: () => [
          { id: 'scope:current', type: 'scope', data: '@current', summary: 'Current note', scope: 'current' },
          { id: 'scope:backlinks', type: 'scope', data: '@backlinks', summary: 'Backlinks', scope: 'backlinks' },
          { id: 'ctx-1', type: 'url', data: 'https://example.com', content: 'context' },
        ],
        resolveContexts: async () => [{ id: 'ctx-1', type: 'url', data: 'https://example.com', content: 'context' }],
      } as any,
      obsidianContextService: {
        collect: async (options: any) => {
          collectCalls.push(options);
          return {
            activeNote: { path: 'active.md', title: 'active' },
            selection: { text: 'selected text' },
            activeHeading: '## 背景',
            frontmatter: {},
            tags: [],
            outgoingLinks: [],
            backlinks: [{ path: 'linked.md', summary: 'linked summary' }],
            recentNotes: [],
            explicitScopes: options.explicitScopes,
            contextItems: [
              { id: 'active-note:active.md', type: 'file', data: 'active.md', content: '## 背景\nselected text' },
              { id: 'backlinks:active.md', type: 'text', data: 'Backlinks summary for active.md', content: '- linked.md: linked summary' },
            ],
          };
        },
      } as any,
    });

    expect(await controller.collectCommandContext()).toEqual({
      contextItems: [
        { id: 'active-note:active.md', type: 'file', data: 'active.md', content: '## 背景\nselected text' },
        { id: 'backlinks:active.md', type: 'text', data: 'Backlinks summary for active.md', content: '- linked.md: linked summary' },
        { id: 'ctx-1', type: 'url', data: 'https://example.com', content: 'context' },
      ],
      selection: 'selected text',
    });

    expect(collectCalls).toEqual([{
      includeBacklinks: true,
      includeCurrent: true,
      explicitScopes: ['current', 'backlinks'],
    }]);
  });

  await test('collectCommandContext includes current note by default without a visible current chip', async () => {
    const collectCalls: any[] = [];
    const controller = new ContextController({
      app: {} as any,
      contextManager: {
        getContexts: () => [
          { id: 'scope:backlinks', type: 'scope', data: '@backlinks', summary: 'Backlinks', scope: 'backlinks' },
        ],
        resolveContexts: async () => [],
      } as any,
      obsidianContextService: {
        collect: async (options: any) => {
          collectCalls.push(options);
          return {
            selection: null,
            contextItems: [
              { id: 'active-note:active.md', type: 'file', data: 'active.md', content: 'current content' },
            ],
          };
        },
      } as any,
    });

    expect(await controller.collectCommandContext()).toEqual({
      contextItems: [
        { id: 'active-note:active.md', type: 'file', data: 'active.md', content: 'current content' },
      ],
      selection: '',
    });

    expect(collectCalls).toEqual([{
      includeBacklinks: true,
      includeCurrent: true,
      explicitScopes: ['current', 'backlinks'],
    }]);
  });

  await test('collectCommandContext excludes current note when requested by the shell', async () => {
    const collectCalls: any[] = [];
    const controller = new ContextController({
      app: {} as any,
      contextManager: {
        getContexts: () => [
          { id: 'scope:backlinks', type: 'scope', data: '@backlinks', summary: 'Backlinks', scope: 'backlinks' },
        ],
        resolveContexts: async () => [],
      } as any,
      obsidianContextService: {
        collect: async (options: any) => {
          collectCalls.push(options);
          return {
            selection: null,
            contextItems: [],
          };
        },
      } as any,
    });

    expect(await controller.collectCommandContext({ includeCurrent: false })).toEqual({
      contextItems: [],
      selection: '',
    });

    expect(collectCalls).toEqual([{
      includeBacklinks: true,
      includeCurrent: false,
      explicitScopes: ['backlinks'],
    }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
