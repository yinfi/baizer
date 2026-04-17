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
  };
}

const registeredSkills: string[] = [];
const unregisteredSkills: string[] = [];

const mockSkillRegistry = {
  registerUser: (skill: any) => { registeredSkills.push(skill.name); },
  unregisterSkill: (name: string) => { unregisteredSkills.push(name); },
  listSkills: () => registeredSkills.map(n => ({ name: n, description: '' })),
};

const generatedPlugins: string[] = [];
const mockGenerator = {
  collectPluginInfo: (id: string) => ({
    id, name: id, description: '', version: '1.0',
    commands: [{ id: `${id}:cmd`, name: 'cmd' }],
    settings: {},
  }),
  shouldSkipPlugin: () => false,
  generateSkillMd: async () => `---\nname: test\ndescription: test\n---\n# Test`,
  writeSkillFile: async (id: string) => {
    generatedPlugins.push(id);
    return `.obsidian/obsidian-cli/skills/plugin-${id}/SKILL.md`;
  },
  skillFilePath: (id: string) => `.obsidian/obsidian-cli/skills/plugin-${id}/SKILL.md`,
};

const enabledPlugins = new Set(['plugin-a', 'plugin-b']);

const mockApp = {
  plugins: {
    manifests: {
      'plugin-a': { id: 'plugin-a', name: 'A', version: '1.0', description: '' },
      'plugin-b': { id: 'plugin-b', name: 'B', version: '1.0', description: '' },
    },
    enabledPlugins,
    getPlugin: () => null,
  },
  commands: { listCommands: () => [] },
  vault: {
    getAbstractFileByPath: mockFn(() => null),
    createFolder: mockFn(),
    create: mockFn(),
    read: mockFn(),
  },
} as unknown as App;

async function runTests() {
  console.log('Plugin Watcher Tests');
  const { PluginWatcher } = await import(
    '../src/skills/builtin/plugin-ctrl/plugin-watcher'
  );

  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✅ ${name}`); }
    catch (e: any) { console.error(`  ❌ ${name}: ${e.message}`); process.exit(1); }
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: [] as string[],
  };

  const watcher = new PluginWatcher(
    mockApp,
    mockSkillRegistry as any,
    mockGenerator as any,
    settings,
  );

  await test('getEnabledPluginIds excludes obsidian-cli', async () => {
    const ids = watcher.getEnabledPluginIds();
    expect(ids.includes('obsidian-cli')).toBe(false);
  });

  await test('diffPlugins detects added plugins', async () => {
    const oldSet = new Set(['plugin-a']);
    const newSet = new Set(['plugin-a', 'plugin-b']);
    const diff = watcher.diffPlugins(oldSet, newSet);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0]).toBe('plugin-b');
    expect(diff.removed.length).toBe(0);
  });

  await test('diffPlugins detects removed plugins', async () => {
    const oldSet = new Set(['plugin-a', 'plugin-b']);
    const newSet = new Set(['plugin-a']);
    const diff = watcher.diffPlugins(oldSet, newSet);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0]).toBe('plugin-b');
  });
}

runTests().catch(console.error);
