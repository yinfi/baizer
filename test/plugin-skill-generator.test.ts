import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function mockFn(impl?: Function) {
  const fn: any = impl ? (...args: any[]) => impl(...args) : () => {};
  fn.mock = { calls: [] as any[] };
  const wrapper: any = (...args: any[]) => {
    fn.mock.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  wrapper.mock = fn.mock;
  return wrapper;
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected string to contain "${expected}"`);
    },
    toInclude: (expected: any) => {
      if (!Array.isArray(actual) || !actual.includes(expected))
        throw new Error(`Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
    },
    notToInclude: (expected: any) => {
      if (Array.isArray(actual) && actual.includes(expected))
        throw new Error(`Expected ${JSON.stringify(actual)} not to include ${JSON.stringify(expected)}`);
    },
  };
}

function parseKeywords(skillMd: string): string[] {
  const match = skillMd.match(/keywords:\s*(\[[^\n]+\])/);
  if (!match) throw new Error('Could not find keywords frontmatter');
  return JSON.parse(match[1]);
}

const mockApp = {
  plugins: {
    manifests: {
      'obsidian-tasks-plugin': {
        id: 'obsidian-tasks-plugin', name: 'Tasks',
        version: '7.14.0', description: 'Task management for Obsidian',
      },
      'obsidian-minimal-settings': {
        id: 'obsidian-minimal-settings', name: 'Minimal Theme Settings',
        version: '1.0.0', description: 'Settings for Minimal theme',
      },
    },
    enabledPlugins: new Set([
      'obsidian-tasks-plugin', 'obsidian-minimal-settings',
    ]),
    getPlugin: (id: string) => {
      if (id === 'obsidian-tasks-plugin')
        return { settings: { globalFilter: '', defaultFolder: 'Tasks' } };
      return null;
    },
  },
  commands: {
    listCommands: () => [
      { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task' },
      { id: 'obsidian-tasks-plugin:toggle-done', name: 'Tasks: Toggle done' },
      { id: 'editor:toggle-bold', name: 'Toggle bold' },
    ],
    executeCommandById: mockFn(() => true),
  },
  vault: {
    getAbstractFileByPath: mockFn(() => null),
    createFolder: mockFn(),
    create: mockFn(),
    read: mockFn(async () => ''),
  },
} as unknown as App;

async function runTests() {
  console.log('Plugin Skill Generator Tests');
  const { PluginSkillGenerator } = await import(
    '../src/skills/builtin/plugin-ctrl/skill-generator'
  );

  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✅ ${name}`); }
    catch (e: any) { console.error(`  ❌ ${name}: ${e.message}`); process.exit(1); }
  }

  const mockModelService = {
    generate: async () => `<!-- DESC: 管理待办任务，支持截止日期和完成状态 -->

# Tasks
## 操作指南
1. 用 append_to_note 追加任务`,
  };

  const settings = {
    ...DEFAULT_SETTINGS,
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: [] as string[],
  };
  const generator = new PluginSkillGenerator(
    mockApp, mockModelService as any, settings,
  );

  await test('collectPluginInfo returns correct data', async () => {
    const info = await generator.collectPluginInfo('obsidian-tasks-plugin');
    expect(info.id).toBe('obsidian-tasks-plugin');
    expect(info.name).toBe('Tasks');
    expect(info.commands.length).toBe(2);
    expect(info.commands[0].id).toBe('obsidian-tasks-plugin:edit-task');
  });

  await test('collectPluginInfo returns empty for unknown plugin', async () => {
    const info = await generator.collectPluginInfo('nonexistent');
    expect(info.commands.length).toBe(0);
  });

  await test('shouldSkipPlugin true for no-command no-settings', async () => {
    const info = await generator.collectPluginInfo('obsidian-minimal-settings');
    expect(generator.shouldSkipPlugin(info)).toBe(true);
  });

  await test('shouldSkipPlugin false for plugins with commands', async () => {
    const info = await generator.collectPluginInfo('obsidian-tasks-plugin');
    expect(generator.shouldSkipPlugin(info)).toBe(false);
  });

  await test('generateSkillMd adds command phrases to routing keywords', async () => {
    const skillMd = await generator.generateSkillMd({
      id: 'obsidian-tasks-plugin',
      name: 'Tasks',
      description: 'Task management for Obsidian',
      version: '7.14.0',
      commands: [
        { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task', aiUsable: true },
        { id: 'obsidian-tasks-plugin:toggle-done', name: 'Tasks: Toggle done', aiUsable: true },
      ],
      settingsKeys: ['globalFilter', 'defaultFolder'],
      syntaxHints: [],
      webContext: '',
    });

    const keywords = parseKeywords(skillMd);
    expect(keywords).toInclude('edit task');
    expect(keywords).toInclude('toggle done');
  });

  await test('generateSkillMd keeps plugin keywords free of fake slash commands', async () => {
    const skillMd = await generator.generateSkillMd({
      id: 'obsidian-tasks-plugin',
      name: 'Tasks',
      description: 'Task management for Obsidian',
      version: '7.14.0',
      commands: [
        { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task', aiUsable: true },
      ],
      settingsKeys: [],
      syntaxHints: [],
      webContext: '',
    });

    const keywords = parseKeywords(skillMd);
    expect(keywords).notToInclude('/tasks');
    expect(keywords).notToInclude('/edit-task');
  });
}

runTests().catch(console.error);
