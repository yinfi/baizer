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

  await test('initial scan preserves a user-authored plugin skill without provenance', async () => {
    const adapter = new FakeAdapter();
    const skillPath = '.obsidian/baizer/skills/plugin-custom/SKILL.md';
    adapter.files.set(skillPath, 'user-authored');
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'custom']),
        manifests: { custom: { id: 'custom', name: 'Custom', version: '2.0.0' } },
      },
      vault: { adapter },
    } as unknown as App;
    let generationCalls = 0;
    const generator = {
      ...mockGenerator,
      collectPluginInfo: async () => {
        generationCalls += 1;
        return mockGenerator.collectPluginInfo('custom');
      },
      skillFilePath: () => skillPath,
    };

    await (new PluginWatcher(app, mockSkillRegistry as any, generator as any, settings) as any).initialScan();

    expect(generationCalls).toBe(0);
    expect(await adapter.read(skillPath)).toBe('user-authored');
  });

  await test('stale generated skill is replaced before its provenance version advances', async () => {
    const adapter = new FakeAdapter();
    const dir = '.obsidian/baizer/skills/plugin-stale';
    const skillPath = `${dir}/SKILL.md`;
    const markerPath = `${dir}/generated-from.json`;
    adapter.files.set(skillPath, 'old-content');
    adapter.files.set(markerPath, JSON.stringify({ pluginVersion: '1.0.0' }));
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'stale']),
        manifests: { stale: { id: 'stale', name: 'Stale', version: '2.0.0' } },
      },
      vault: { adapter },
    } as unknown as App;
    let replacedContent = '';
    const registry = {
      registerUserFromMd: () => false,
      replaceUserFromMd: (content: string) => {
        replacedContent = content;
        return true;
      },
      unregisterSkill: () => {},
    };
    const generator = {
      ...mockGenerator,
      collectPluginInfo: async () => ({
        ...(await mockGenerator.collectPluginInfo('stale')),
        version: '2.0.0',
      }),
      generateSkillMd: async () => 'new-content',
      writeSkillFile: async (_id: string, content: string, options?: { overwrite?: boolean }) => {
        expect(options?.overwrite).toBe(true);
        await adapter.write(skillPath, content);
        return skillPath;
      },
      skillFilePath: () => skillPath,
    };

    await (new PluginWatcher(app, registry as any, generator as any, settings) as any).initialScan();

    expect(await adapter.read(skillPath)).toBe('new-content');
    expect(replacedContent).toBe('new-content');
    const marker = JSON.parse(await adapter.read(markerPath));
    expect(marker.pluginVersion).toBe('2.0.0');
  });

  await test('failed generation is attempted at most three times across polls', async () => {
    const adapter = new FakeAdapter();
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'retry']),
        manifests: { retry: { id: 'retry', name: 'Retry', version: '1.0.0' } },
      },
      vault: { adapter },
    } as unknown as App;
    let attempts = 0;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async () => ({
        id: 'retry', name: 'Retry', description: '', version: '1.0.0',
        commands: [{ id: 'retry:cmd', name: 'Command', aiUsable: true }],
        settingsKeys: [], syntaxHints: [], webContext: '',
      }),
      collectPluginInfo: async () => {
        attempts += 1;
        throw new Error('generation failed');
      },
    };
    const localWatcher = new PluginWatcher(app, mockSkillRegistry as any, generator as any, settings);

    await (localWatcher as any).initialScan();
    await (localWatcher as any).checkChanges();
    await (localWatcher as any).checkChanges();
    await (localWatcher as any).checkChanges();

    expect(attempts).toBe(3);
  });

  await test('retry replaces an unmarked file left by a failed registration', async () => {
    const adapter = new FakeAdapter();
    const dir = '.obsidian/baizer/skills/plugin-recover';
    const skillPath = `${dir}/SKILL.md`;
    const markerPath = `${dir}/generated-from.json`;
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'recover']),
        manifests: { recover: { id: 'recover', name: 'Recover', version: '1.0.0' } },
      },
      vault: { adapter },
    } as unknown as App;
    let generationAttempt = 0;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async () => ({
        id: 'recover', name: 'Recover', description: '', version: '1.0.0',
        commands: [{ id: 'recover:cmd', name: 'Command', aiUsable: true }],
        settingsKeys: [], syntaxHints: [], webContext: '',
      }),
      collectPluginInfo: async () => ({
        ...(await mockGenerator.collectPluginInfo('recover')),
        version: '1.0.0',
      }),
      generateSkillMd: async () => {
        generationAttempt += 1;
        return generationAttempt === 1 ? 'invalid-content' : 'valid-content';
      },
      writeSkillFile: async (_id: string, content: string, options?: { overwrite?: boolean }) => {
        if (!await adapter.exists(skillPath) || options?.overwrite) {
          await adapter.write(skillPath, content);
        }
        return skillPath;
      },
      skillFilePath: () => skillPath,
    };
    const registry = {
      registerUserFromMd: (content: string) => content === 'valid-content',
      replaceUserFromMd: (content: string) => content === 'valid-content',
      unregisterSkill: () => {},
    };
    const localWatcher = new PluginWatcher(app, registry as any, generator as any, settings);

    await (localWatcher as any).initialScan();
    await (localWatcher as any).checkChanges();

    expect(generationAttempt).toBe(2);
    expect(await adapter.read(skillPath)).toBe('valid-content');
    expect(JSON.parse(await adapter.read(markerPath)).pluginVersion).toBe('1.0.0');
  });

  await test('retry does not claim a user skill created after a pre-write failure', async () => {
    const adapter = new FakeAdapter();
    const skillPath = '.obsidian/baizer/skills/plugin-race/SKILL.md';
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', 'race']),
        manifests: { race: { id: 'race', name: 'Race', version: '1.0.0' } },
      },
      vault: { adapter },
    } as unknown as App;
    let attempts = 0;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async () => ({
        id: 'race', name: 'Race', description: '', version: '1.0.0',
        commands: [{ id: 'race:cmd', name: 'Command', aiUsable: true }],
        settingsKeys: [], syntaxHints: [], webContext: '',
      }),
      collectPluginInfo: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('failed before write');
        return mockGenerator.collectPluginInfo('race');
      },
      generateSkillMd: async () => 'generated-content',
      writeSkillFile: async (_id: string, content: string, options?: { overwrite?: boolean }) => {
        if (await adapter.exists(skillPath) && !options?.overwrite) {
          throw new Error('refusing user file overwrite');
        }
        await adapter.write(skillPath, content);
        return skillPath;
      },
      skillFilePath: () => skillPath,
    };
    const registry = {
      registerUserFromMd: () => false,
      replaceUserFromMd: () => false,
      unregisterSkill: () => {},
    };
    const localWatcher = new PluginWatcher(app, registry as any, generator as any, settings);

    await (localWatcher as any).initialScan();
    await adapter.write(skillPath, 'user-authored-during-retry');
    await (localWatcher as any).checkChanges();

    expect(await adapter.read(skillPath)).toBe('user-authored-during-retry');
  });
}

runTests().catch(console.error);
