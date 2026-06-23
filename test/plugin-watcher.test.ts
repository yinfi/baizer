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

class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
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
  collectPluginInfo: async (id: string) => ({
    id, name: id, description: '', version: '1.0',
    commands: [{ id: `${id}:cmd`, name: 'cmd', aiUsable: true }],
    settingsKeys: [],
    syntaxHints: [],
    webContext: '',
  }),
  shouldSkipPlugin: () => false,
  generateSkillMd: async () => `---\nname: test\ndescription: test\n---\n# Test`,
  writeSkillFile: async (id: string) => {
    generatedPlugins.push(id);
    return `.obsidian/baizer/skills/plugin-${id}/SKILL.md`;
  },
  skillFilePath: (id: string) => `.obsidian/baizer/skills/plugin-${id}/SKILL.md`,
};

const enabledPlugins = new Set(['baizer', 'plugin-a', 'plugin-b']);

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
    adapter: new FakeAdapter(),
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

  await test('getEnabledPluginIds excludes baizer', async () => {
    const ids = watcher.getEnabledPluginIds();
    expect(ids.includes('baizer')).toBe(false);
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

  await test('initial scan skips plugins without using full skill generation context', async () => {
    let basicCalls = 0;
    let fullCalls = 0;
    const adapter = new FakeAdapter();
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'skip-only']),
        manifests: {
          'skip-only': { id: 'skip-only', name: 'Skip Only', version: '1.0.0', description: '' },
        },
      },
      vault: { adapter },
    } as unknown as App;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async (id: string) => {
        basicCalls += 1;
        return {
          id, name: id, description: '', version: '1.0.0',
          commands: [], settingsKeys: [], syntaxHints: [], webContext: '',
        };
      },
      collectPluginInfo: async (id: string) => {
        fullCalls += 1;
        return mockGenerator.collectPluginInfo(id);
      },
      shouldSkipPlugin: (info: any) =>
        info.commands.length === 0 && info.settingsKeys.length === 0,
    };
    const localWatcher = new PluginWatcher(
      app,
      mockSkillRegistry as any,
      generator as any,
      settings,
    );

    await (localWatcher as any).initialScan();

    expect(basicCalls).toBe(1);
    expect(fullCalls).toBe(0);
  });

  await test('initial scan remembers skipped plugin versions across restarts', async () => {
    let basicCalls = 0;
    const adapter = new FakeAdapter();
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'skip-cached']),
        manifests: {
          'skip-cached': { id: 'skip-cached', name: 'Skip Cached', version: '1.0.0', description: '' },
        },
      },
      vault: { adapter },
    } as unknown as App;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async (id: string) => {
        basicCalls += 1;
        return {
          id, name: id, description: '', version: '1.0.0',
          commands: [], settingsKeys: [], syntaxHints: [], webContext: '',
        };
      },
      shouldSkipPlugin: (info: any) =>
        info.commands.length === 0 && info.settingsKeys.length === 0,
    };

    await (new PluginWatcher(
      app,
      mockSkillRegistry as any,
      generator as any,
      settings,
    ) as any).initialScan();
    await (new PluginWatcher(
      app,
      mockSkillRegistry as any,
      generator as any,
      settings,
    ) as any).initialScan();

    expect(basicCalls).toBe(1);
  });
}

runTests().catch(console.error);
