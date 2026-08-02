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

  await test('classifies plugin-control tools as sequential plugin-control risk', async () => {
    const registry = new ToolRegistry(mockApp, {
      ...DEFAULT_SETTINGS,
      allowPluginControl: true,
    });
    registerTools(registry);

    for (const name of [
      'list_plugins',
      'get_plugin_commands',
      'get_plugin_settings',
      'execute_plugin_command',
    ]) {
      const tool = registry.get(name);
      expect(!!tool).toBe(true);
      expect(tool!.executionMode).toBe('sequential');
      expect(tool!.risk).toBe('plugin-control');
    }
  });

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

  // ---- F0-1: 配置脱敏 ----

  const secretApp = {
    plugins: {
      getPlugin: (_id: string) => ({
        settings: {
          folder: 'Kanban',
          apiKey: 'sk-secret-abc123',
          authToken: undefined,
          nested: { token: 'tok-xyz', theme: 'dark' },
          password: 'p@ssw0rd',
          items: ['a', 'b'],
          capital: 'Beijing',
          rapidMode: true,
        },
      }),
    },
  } as unknown as App;

  await test('get_plugin_settings redacts sensitive keys and omits values by default', async () => {
    const registry = new ToolRegistry(secretApp, {
      ...DEFAULT_SETTINGS,
      allowPluginControl: true,
      allowPluginConfigValues: false,
    });
    registerTools(registry);

    const result = await registry.execute('get_plugin_settings', { pluginId: 'obsidian-kanban' });

    const serialized = JSON.stringify(result);
    expect(serialized.includes('sk-secret-abc123')).toBe(false);
    expect(serialized.includes('tok-xyz')).toBe(false);
    expect(serialized.includes('p@ssw0rd')).toBe(false);

    // 敏感键被替换为 redacted 标记
    const settings = (result as any).settings;
    expect(settings.apiKey.redacted).toBe(true);
    expect(settings.authToken.redacted).toBe(true);
    expect(settings.password.redacted).toBe(true);
    expect(settings.nested.token.redacted).toBe(true);
    // 非敏感键：未开 allowValues 时也只给类型不给值
    expect(settings.folder).toEqual({ type: 'string' });
    expect(settings.nested.theme).toEqual({ type: 'string' });
    expect(settings.items).toEqual({ type: 'array', itemTypes: ['string'] });
    expect(settings.capital).toEqual({ type: 'string' });
    expect(settings.rapidMode).toEqual({ type: 'boolean' });
    expect(serialized.includes('Kanban')).toBe(false);
    expect(serialized.includes('dark')).toBe(false);
    expect(serialized.includes('Beijing')).toBe(false);
  });

  await test('get_plugin_settings returns scalar values when allowPluginConfigValues is on, sensitive keys still redacted', async () => {
    const registry = new ToolRegistry(secretApp, {
      ...DEFAULT_SETTINGS,
      allowPluginControl: true,
      allowPluginConfigValues: true,
    });
    registerTools(registry);

    const result = await registry.execute('get_plugin_settings', { pluginId: 'obsidian-kanban' });
    const serialized = JSON.stringify(result);
    expect(serialized.includes('sk-secret-abc123')).toBe(false);
    expect(serialized.includes('tok-xyz')).toBe(false);
    // 非敏感标量值可读
    expect((result as any).settings.folder).toEqual('Kanban');
    expect((result as any).settings.nested.theme).toEqual('dark');
    expect((result as any).settings.capital).toEqual('Beijing');
    expect((result as any).settings.rapidMode).toEqual(true);
  });
}

runTests().catch(console.error);
