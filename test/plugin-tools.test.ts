import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
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
  console.log('=== Plugin Tool Tests ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { registerTools } = await import('../src/skills/builtin/plugin-ctrl/executor');

  const executeCalls: string[] = [];
  const mockApp = {
    plugins: {
      manifests: {
        'obsidian-kanban': {
          id: 'obsidian-kanban',
          name: 'Kanban',
          version: '1.5.3',
          description: 'Create markdown-backed Kanban boards.',
        },
      },
      enabledPlugins: new Set(['obsidian-kanban']),
      getPlugin: (_id: string) => ({ settings: { folder: 'Kanban' } }),
    },
    commands: {
      listCommands: () => [
        { id: 'obsidian-kanban:create-new-board', name: 'Kanban: Create new board' },
      ],
      executeCommandById: (id: string) => {
        executeCalls.push(id);
        return true;
      },
    },
    vault: {
      adapter: {
        exists: async () => false,
      },
    },
  } as unknown as App;

  await test('execute_plugin_command returns approval_required when confirmExecutions is enabled', async () => {
    executeCalls.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowPluginControl: true,
      confirmExecutions: true,
    });
    registerTools(registry);

    const result = await registry.execute('execute_plugin_command', {
      commandId: 'obsidian-kanban:create-new-board',
    });

    expect(result).toEqual({
      approval_required: true,
      action: 'execute_plugin_command',
      target: 'obsidian-kanban:create-new-board',
      args: {
        commandId: 'obsidian-kanban:create-new-board',
      },
      message: 'Approval required to execute plugin command: obsidian-kanban:create-new-board',
      preview: {
        kind: 'plugin-command',
        target: 'obsidian-kanban:create-new-board',
        summary: 'Execute plugin command',
        commandId: 'obsidian-kanban:create-new-board',
        preconditions: [
          'Open the target note before execution.',
          'Confirm the relevant editor pane or selection is focused before execution.',
        ],
        risk: 'medium',
        supportsPartialApply: false,
        undoable: false,
      },
    });
    expect(executeCalls.length).toBe(0);
  });

  await test('execute_plugin_command executes immediately when confirmations are disabled', async () => {
    executeCalls.length = 0;
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowPluginControl: true,
      confirmExecutions: false,
    });
    registerTools(registry);

    const result = await registry.execute('execute_plugin_command', {
      commandId: 'obsidian-kanban:create-new-board',
    });

    expect(result).toEqual({
      success: true,
      message: '✅ Executed: obsidian-kanban:create-new-board',
    });
    expect(executeCalls).toEqual(['obsidian-kanban:create-new-board']);
  });
}

runTests().catch(console.error);
