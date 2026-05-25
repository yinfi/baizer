function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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
  console.log('=== Pi Tool Adapter Tests ===');
  const {
    adaptToolDefinitionsToPi,
    inferToolExecutionMode,
  } = await import('../src/runtime/pi/pi-tool-adapter');

  await test('infers read tools as parallel', () => {
    expect(inferToolExecutionMode('read_note')).toBe('parallel');
    expect(inferToolExecutionMode('search_vault')).toBe('parallel');
    expect(inferToolExecutionMode('list_notes')).toBe('parallel');
  });

  await test('infers write and plugin tools as sequential', () => {
    expect(inferToolExecutionMode('create_file')).toBe('sequential');
    expect(inferToolExecutionMode('update_note')).toBe('sequential');
    expect(inferToolExecutionMode('execute_plugin_command')).toBe('sequential');
  });

  await test('uses explicit tool execution metadata first', () => {
    expect(inferToolExecutionMode('custom_tool', { executionMode: 'parallel' } as any)).toBe('parallel');
    expect(inferToolExecutionMode('custom_tool', { executionMode: 'sequential' } as any)).toBe('sequential');
  });

  await test('routes direct write tools through WorkspaceEditService', async () => {
    const registryCalls: any[] = [];
    const workspaceCalls: any[] = [];
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'update_file', description: 'Update file', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async (name: string, args: any) => {
          registryCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      workspaceEditService: {
        executeWorkspaceTool: async (name: string, args: any) => {
          workspaceCalls.push({ name, args });
          return { success: true, path: args.path };
        },
      } as any,
      skillScope: { allowedToolNames: null },
    });

    const result = await piTools[0].execute('call_1', { path: 'Notes/a.md', content: 'after' } as any);
    expect(registryCalls).toEqual([]);
    expect(workspaceCalls).toEqual([{ name: 'update_file', args: { path: 'Notes/a.md', content: 'after' } }]);
    expect(result.details.baizerResponse).toEqual({ success: true, path: 'Notes/a.md' });
  });

  await test('blocks tools outside active skill scope', async () => {
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'search_vault', description: 'Search', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async () => ({ success: true }),
      } as any,
      workspaceEditService: null,
      skillScope: {
        activeSkillName: 'web-search',
        allowedToolNames: new Set(['web_search']),
      },
    });

    const result = await piTools[0].execute('call_1', { query: 'obsidian' } as any);
    expect(result.details.baizerResponse).toEqual({
      error: 'Tool "search_vault" is not available for active skill "web-search"',
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
