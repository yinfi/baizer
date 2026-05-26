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
    expect(inferToolExecutionMode('custom_writer', { risk: 'write' } as any)).toBe('sequential');
    expect(inferToolExecutionMode('custom_reader', { risk: 'read', executionMode: 'parallel' } as any)).toBe('parallel');
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

  await test('routes normal tools through ToolRegistry', async () => {
    const registryCalls: any[] = [];
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async (name: string, args: any) => {
          registryCalls.push({ name, args });
          return { success: true, content: 'Note' };
        },
      } as any,
      workspaceEditService: null,
      skillScope: { allowedToolNames: null },
    });

    const result = await piTools[0].execute('call_1', { path: 'Notes/a.md' } as any);
    expect(registryCalls).toEqual([{ name: 'read_note', args: { path: 'Notes/a.md' } }]);
    expect(result.details.baizerResponse).toEqual({ success: true, content: 'Note' });
  });

  await test('terminates after approval-required tool responses', async () => {
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async () => ({
          approval_required: true,
          action: 'create_file',
          target: 'Notes/a.md',
        }),
      } as any,
      workspaceEditService: null,
      skillScope: { allowedToolNames: null },
    });

    const result = await piTools[0].execute('call_1', { path: 'Notes/a.md' } as any);
    expect(result.terminate).toBe(true);
    expect(result.details.baizerResponse.approval_required).toBe(true);
  });

  await test('activates skills through the use_skill pseudo-tool', async () => {
    const registryCalls: any[] = [];
    const skillScope = { allowedToolNames: null as Set<string> | null };
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'use_skill', description: 'Use skill', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async (name: string, args: any) => {
          registryCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      skillRegistry: {
        activateSkill: (name: string) => ({
          skill: { name },
          instructions: 'Search instructions',
          tools: [{ name: 'web_search' }],
        }),
      } as any,
      workspaceEditService: null,
      skillScope,
    });

    const result = await piTools[0].execute('call_1', { name: 'web-search' } as any);
    expect(registryCalls).toEqual([]);
    expect(skillScope.allowedToolNames instanceof Set).toBe(true);
    expect(Array.from(skillScope.allowedToolNames || [])).toEqual(['web_search']);
    expect(result.details.baizerResponse).toEqual({
      action_required: 'Use the returned instructions immediately with the available tools to complete the user request.',
      instructions: 'Search instructions',
      available_tools: ['web_search'],
    });
  });

  await test('blocks tools outside active skill scope', async () => {
    const workspaceCalls: any[] = [];
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'update_file', description: 'Update', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async () => ({ success: true }),
      } as any,
      workspaceEditService: {
        executeWorkspaceTool: async (name: string, args: any) => {
          workspaceCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      skillScope: {
        activeSkillName: 'web-search',
        allowedToolNames: new Set(['web_search']),
      },
    });

    const result = await piTools[0].execute('call_1', { query: 'obsidian' } as any);
    expect(workspaceCalls).toEqual([]);
    expect(result.details.baizerResponse).toEqual({
      error: 'Tool "update_file" is not available for active skill "web-search"',
    });
  });

  await test('rejects tool execution after the registered timeout', async () => {
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'slow_tool', description: 'Slow', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => ({ timeoutMs: 1 }),
        execute: async () => new Promise(() => undefined),
      } as any,
      workspaceEditService: null,
      skillScope: { allowedToolNames: null },
    });

    try {
      await piTools[0].execute('call_1', {} as any);
      throw new Error('Expected slow_tool to time out');
    } catch (e: any) {
      expect(e.message).toBe('Tool slow_tool execution timed out');
    }
  });

  await test('does not execute tools when the signal is already aborted', async () => {
    const workspaceCalls: any[] = [];
    const controller = new AbortController();
    controller.abort();
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'update_file', description: 'Update', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async () => ({ success: true }),
      } as any,
      workspaceEditService: {
        executeWorkspaceTool: async (name: string, args: any) => {
          workspaceCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      skillScope: { allowedToolNames: null },
    });

    try {
      await piTools[0].execute('call_1', { path: 'Notes/a.md', content: 'after' } as any, controller.signal);
      throw new Error('Expected update_file to abort');
    } catch (e: any) {
      expect(e.name).toBe('AbortError');
      expect(workspaceCalls).toEqual([]);
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
