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

  await test('collectCommandContext merges active file, resolved contexts, and editor selection', async () => {
    const controller = new ContextController({
      app: {
        workspace: {
          getActiveFile: () => ({ path: 'active.md' }),
          getMostRecentLeaf: () => ({
            view: {
              editor: {
                getSelection: () => 'selected text',
              },
            },
          }),
        },
        vault: {
          read: async () => '# Active file',
        },
      } as any,
      contextManager: {
        resolveContexts: async () => [{ id: 'ctx-1', type: 'url', data: 'https://example.com', content: 'context' }],
      } as any,
    });

    expect(await controller.collectCommandContext()).toEqual({
      contextItems: [
        { id: 'ctx-1', type: 'url', data: 'https://example.com', content: 'context' },
        { id: 'active-file', type: 'file', data: 'active.md', content: '# Active file' },
      ],
      selection: 'selected text',
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
