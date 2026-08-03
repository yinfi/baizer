import { readFileSync } from 'fs';
import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import { computeSkillBodyHash, pluginSkillFilePath } from '../src/skills/skill-files';

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

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const registeredSkills: string[] = [];
const unregisteredSkills: string[] = [];

const mockSkillRegistry = {
  registerUser: (skill: any) => { registeredSkills.push(skill.name); },
  getAllSkillSummaries: () => registeredSkills.map(name => ({ name, description: '' })),
  // watcher 生成后走这条注册路径：以目录名（plugin-<id>）作为 skill 名。
  registerUserFromMd: (_md: string, filePath: string) => {
    registeredSkills.push(filePath.split('/').slice(-2)[0]);
    return true;
  },
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
    allowPluginControl: true,
  };

  const watcher = new PluginWatcher(
    mockApp,
    mockSkillRegistry as any,
    mockGenerator as any,
    settings,
    () => true,
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
      () => true,
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
      () => true,
    ) as any).initialScan();
    await (new PluginWatcher(
      app,
      mockSkillRegistry as any,
      generator as any,
      settings,
      () => true,
    ) as any).initialScan();

    expect(basicCalls).toBe(1);
  });

  // ---------- 前置条件：够用了才动，动不了就闭嘴 ----------

  /**
   * 造一个记账用的 generator：任何采集/生成入口被调用都会计数，
   * 用来证明「前置条件在信息采集之前就拦住了」，而不只是没写出文件。
   * notices 从构造参数注入，不去改 obsidian 命名空间——对 ESM 命名空间赋值
   * 在 tsx 下是静默无效的，那样断言「没弹提示」会永远为真。
   * failGeneration：让 LLM 那步抛错，这样扫描跑完磁盘上仍然没有 skill 文件，
   * 后续断言的计数就只能靠阈值判断压住，而不是靠「文件已存在」压住。
   */
  function createCountingSetup(
    initialModelReady: boolean,
    allowPluginControl: boolean,
    options: {
      autoGenerate?: boolean;
      failGeneration?: boolean;
      gate?: Promise<void>;
      /** 参与扫描的插件（默认单个），报「成功几个失败几个」需要多个 */
      plugins?: string[];
      /** 只让这些插件的生成失败，用来造「部分成功」的一轮 */
      failFor?: string[];
    } = {},
  ) {
    let modelReady = initialModelReady;
    const notices: string[] = [];
    const counters = { basic: 0, full: 0, generated: 0, written: 0 };
    const adapter = new FakeAdapter();
    const pluginIds = options.plugins ?? ['plugin-a'];
    const manifests: Record<string, any> = {};
    for (const id of pluginIds) {
      manifests[id] = { id, name: id, version: '1.0', description: '' };
    }
    const app = {
      ...mockApp,
      plugins: {
        ...(mockApp as any).plugins,
        enabledPlugins: new Set(['baizer', ...pluginIds]),
        manifests,
      },
      vault: { adapter },
    } as unknown as App;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async (id: string) => {
        counters.basic += 1;
        // gate 让扫描停在采集这一步，用来观察「扫描在途」时的行为
        if (options.gate) await options.gate;
        return mockGenerator.collectPluginInfo(id);
      },
      collectPluginInfo: async (id: string) => {
        counters.full += 1;
        return mockGenerator.collectPluginInfo(id);
      },
      generateSkillMd: async (info: any) => {
        counters.generated += 1;
        // 模拟额度耗尽：这一步失败，磁盘上就不会留下 skill 文件
        if (options.failGeneration) throw new Error('quota exceeded');
        if (options.failFor?.includes(info.id)) throw new Error(`quota exceeded for ${info.id}`);
        return `---\nname: test\ndescription: test\n---\n# Test`;
      },
      writeSkillFile: async (id: string, content: string) => {
        counters.written += 1;
        const path = `.obsidian/baizer/skills/plugin-${id}/SKILL.md`;
        await adapter.write(path, content);
        return path;
      },
    };
    const localSettings = {
      ...settings,
      autoGeneratePluginSkills: options.autoGenerate ?? true,
      allowPluginControl,
      pluginSkillExcludeList: [] as string[],
    };
    const localWatcher = new PluginWatcher(
      app,
      mockSkillRegistry as any,
      generator as any,
      localSettings,
      () => modelReady,
      (message: string) => { notices.push(message); },
    );
    return {
      counters,
      notices,
      localWatcher,
      localSettings,
      setModelReady: (ready: boolean) => { modelReady = ready; },
    };
  }

  await test('no usable model config: zero generator calls and no notice', async () => {
    const { counters, notices, localWatcher } = createCountingSetup(false, true);

    await (localWatcher as any).initialScan();

    expect(counters.basic).toBe(0);
    expect(counters.full).toBe(0);
    expect(counters.generated).toBe(0);
    expect(counters.written).toBe(0);
    expect(notices.length).toBe(0);
  });

  await test('plugin control off: zero generator calls and no notice', async () => {
    const { counters, notices, localWatcher } = createCountingSetup(true, false);

    await (localWatcher as any).initialScan();

    expect(counters.basic).toBe(0);
    expect(counters.full).toBe(0);
    expect(notices.length).toBe(0);
  });

  // 反向对照：注入的 notify 确实会被真实扫描调用，
  // 上面两条「没弹提示」才是有效断言，而不是通道从没接上。
  await test('a ready scan does speak, so the notice channel is live', async () => {
    const { notices, localWatcher } = createCountingSetup(true, true);

    await (localWatcher as any).initialScan();

    expect(notices.length).toBe(2);
  });

  await test('key absent then present triggers the skipped scan', async () => {
    const { counters, localWatcher, setModelReady } = createCountingSetup(false, true);

    await (localWatcher as any).initialScan();
    expect(counters.basic).toBe(0);

    setModelReady(true);
    await localWatcher.handleSettingsSaved();

    expect(counters.basic).toBe(1);
    expect(counters.full).toBe(1);
    expect(counters.written).toBe(1);
  });

  await test('plugin control off then on triggers the skipped scan', async () => {
    const { counters, localWatcher, localSettings } = createCountingSetup(true, false);

    await (localWatcher as any).initialScan();
    expect(counters.basic).toBe(0);

    localSettings.allowPluginControl = true;
    await localWatcher.handleSettingsSaved();

    expect(counters.basic).toBe(1);
    expect(counters.full).toBe(1);
  });

  // 生成失败 ⇒ 磁盘上没有 skill 文件 ⇒ 再次扫描本会重新采集。
  // 计数不涨只能是因为阈值没被跨过，而不是因为「文件已存在」。
  await test('an unrelated settings change triggers nothing', async () => {
    const { counters, localWatcher, localSettings } = createCountingSetup(
      true, true, { failGeneration: true },
    );
    await (localWatcher as any).initialScan();
    expect(counters.full).toBe(1);

    localSettings.pluginSkillExcludeList = ['plugin-b'];
    await localWatcher.handleSettingsSaved();
    localSettings.pluginSkillExcludeList = ['plugin-b', 'plugin-c'];
    await localWatcher.handleSettingsSaved();

    expect(counters.full).toBe(1);
  });

  // 顺序陷阱：自动生成关着的时候补了 Key，跨阈值不能被吃掉——
  // 否则之后打开开关也不会补跑，只能重启 Obsidian。
  await test('key arriving while auto-generate is off still catches up later', async () => {
    const { counters, localWatcher, localSettings, setModelReady } = createCountingSetup(
      false, true, { autoGenerate: false },
    );

    await (localWatcher as any).initialScan();
    expect(counters.basic).toBe(0);

    setModelReady(true);
    await localWatcher.handleSettingsSaved();
    expect(counters.basic).toBe(0);

    localSettings.autoGeneratePluginSkills = true;
    await localWatcher.handleSettingsSaved();

    expect(counters.basic).toBe(1);
    expect(counters.full).toBe(1);
  });

  // 补跑是分钟级的网络+LLM 工作，且由 saveSettings 非阻塞触发：
  // 在途时再次跨过阈值不能叠加第二轮，否则同一个 SKILL.md 有两个写入方。
  await test('a second crossing mid-scan does not start a second scan', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { counters, localWatcher, localSettings, setModelReady } = createCountingSetup(
      false, true, { gate },
    );

    await (localWatcher as any).initialScan();
    expect(counters.basic).toBe(0);

    setModelReady(true);
    const firstCatchUp = localWatcher.handleSettingsSaved();
    await Promise.resolve();

    // 扫描卡在采集里；期间撤销再重新授权 → 又是一次 false→true 跨越。
    // 第二次不能 inline await：没有单飞时它会等在同一个 gate 上，把测试挂死。
    localSettings.allowPluginControl = false;
    await localWatcher.handleSettingsSaved();
    localSettings.allowPluginControl = true;
    const secondCatchUp = localWatcher.handleSettingsSaved();
    await Promise.resolve();

    release();
    await Promise.all([firstCatchUp, secondCatchUp]);

    expect(counters.basic).toBe(1);
    expect(counters.full).toBe(1);
    expect(counters.written).toBe(1);
  });

  await test('settings saved while still unready triggers nothing', async () => {
    const { counters, localWatcher } = createCountingSetup(false, false);

    await (localWatcher as any).initialScan();
    await localWatcher.handleSettingsSaved();

    expect(counters.basic).toBe(0);
  });

  // ---------- 完成提示：说真实结果，不说尝试了几个 ----------

  const { setLocaleForTesting } = await import('../src/i18n/zh');
  // 断言英文原文，locale 必须钉住：机器语言不同不能改变断言结果。
  setLocaleForTesting(false);

  /** 提示是否「读起来像成功」——全失败的一轮绝不能命中这个判断。 */
  const readsAsSuccess = (message: string) =>
    /generated/i.test(message) && !/fail/i.test(message);

  // 核心诉求：2 成 1 败的一轮不能报「finished (3)」——用户会以为有 3 个技能可用。
  await test('the completion notice distinguishes succeeded from failed counts', async () => {
    const { notices, localWatcher } = createCountingSetup(true, true, {
      plugins: ['ok-one', 'ok-two', 'bad-one'],
      failFor: ['bad-one'],
    });

    await (localWatcher as any).initialScan();

    const closing = notices[notices.length - 1];
    expect(closing.includes('2')).toBe(true);
    expect(closing.includes('1')).toBe(true);
    // 尝试数量不再是被报出来的那个数
    expect(closing.includes('3')).toBe(false);
    expect(/fail/i.test(closing)).toBe(true);
  });

  await test('an all-succeeded run reads as unqualified success', async () => {
    const { notices, localWatcher } = createCountingSetup(true, true, {
      plugins: ['ok-one', 'ok-two'],
    });

    await (localWatcher as any).initialScan();

    const closing = notices[notices.length - 1];
    expect(readsAsSuccess(closing)).toBe(true);
    expect(closing.includes('2')).toBe(true);
  });

  await test('an all-failed run does not read as success', async () => {
    const { notices, localWatcher } = createCountingSetup(true, true, {
      plugins: ['bad-one', 'bad-two'],
      failGeneration: true,
    });

    await (localWatcher as any).initialScan();

    const closing = notices[notices.length - 1];
    expect(readsAsSuccess(closing)).toBe(false);
    expect(closing.includes('2')).toBe(true);
  });

  // 失败原因不能只进 console：设置页要按插件展示「谁失败、为什么」。
  await test('each failure reason is retrievable, keyed by plugin', async () => {
    const { localWatcher } = createCountingSetup(true, true, {
      plugins: ['ok-one', 'bad-one'],
      failFor: ['bad-one'],
    });

    await (localWatcher as any).initialScan();

    const failures = localWatcher.getGenerationFailures();
    expect(failures.get('bad-one')?.includes('quota exceeded')).toBe(true);
    expect(failures.has('ok-one')).toBe(false);
  });

  // 这条路径的提示必须真的走翻译层，而不是拼死的英文串。
  await test('the completion notice goes through the translation layer', async () => {
    setLocaleForTesting(true);
    const { notices, localWatcher } = createCountingSetup(true, true, { plugins: ['ok-one'] });

    await (localWatcher as any).initialScan();

    const [opening, closing] = notices;
    expect(/[一-龥]/.test(opening)).toBe(true);
    expect(/[一-龥]/.test(closing)).toBe(true);
    // 计数走 {n} 占位模板，翻译后数字仍在
    expect(closing.includes('1')).toBe(true);
    setLocaleForTesting(false);
  });

  // ---------- 派生 skill 对账：来源不在了就不再交给模型 ----------

  const REGENERATED_MD = '---\nname: regenerated\ndescription: "regen"\n---\n# 重新生成的正文';

  /** 造一份带溯源的 SKILL.md；recordedBodyHash 传与 body 不匹配的值即模拟手工编辑。 */
  function buildSkillMd(
    pluginId: string, version: string, body: string, recordedBodyHash?: string,
  ) {
    return [
      '---',
      `name: plugin-${pluginId}`,
      `description: ${JSON.stringify(pluginId)}`,
      'source:',
      `  plugin: ${JSON.stringify(pluginId)}`,
      `  version: ${JSON.stringify(version)}`,
      `  body_hash: ${JSON.stringify(recordedBodyHash ?? computeSkillBodyHash(body))}`,
      '---',
      body,
    ].join('\n');
  }

  /** 注册表替身：names 就是「当前交给模型的 skill」，对账后直接断言它。 */
  function createReconcileRegistry(initial: string[]) {
    const names = new Set(initial);
    const unregistered: string[] = [];
    const restored: string[] = [];
    return {
      names,
      unregistered,
      restored,
      registry: {
        getAllSkillSummaries: () => [...names].map(name => ({ name, description: '' })),
        listSkills: () => [...names].map(name => ({ name, description: '' })),
        unregisterSkill: (name: string) => { names.delete(name); unregistered.push(name); },
        registerUserFromMd: (_md: string, filePath: string) => {
          const name = filePath.split('/').slice(-2)[0];
          names.add(name);
          restored.push(name);
          return true;
        },
      },
    };
  }
  /**
   * 对账场景：盘上有 SKILL.md、注册表里已注册（模拟 loadUserSkills 无条件注册后的状态）。
   * skills 里每项描述一个派生 skill 的盘上事实；enabled 是插件的真实在线状态。
   * generator 的每个入口都计数——「不重新生成」必须靠零调用证明，
   * 光看文件内容没变是不够的（生成器有可能写出同样的内容）。
   */
  function createReconcileSetup(options: {
    skills: Array<{
      pluginId: string;
      recordedVersion: string;
      installedVersion?: string;
      body?: string;
      /** 传 true 则记录的 body_hash 与实际 body 不符 = 手工编辑过 */
      handEdited?: boolean;
      /** 传 false 则不放进注册表（模拟插件曾被禁用、这次要从文件恢复） */
      registered?: boolean;
      /** 无 source 块的旧版/手写文件 */
      withoutProvenance?: boolean;
      /** 传 true 则不写 manifest：插件已被卸载，只剩 skill 文件 */
      uninstalled?: boolean;
    }>;
    enabled: string[];
    allowPluginControl?: boolean;
    autoGenerate?: boolean;
    excludeList?: string[];
    modelReady?: boolean;
    failGeneration?: boolean;
  }) {
    const counters = { basic: 0, full: 0, generated: 0, written: 0 };
    const writeModes: string[] = [];
    const adapter = new FakeAdapter();
    const manifests: Record<string, any> = {};
    const initiallyRegistered: string[] = [];
    // 可变而非只读 options.failGeneration：要断言「成功后旧失败原因被清掉」，
    // 就得在同一个 watcher 上先失败一次再成功一次。
    let failGeneration = options.failGeneration ?? false;

    for (const skill of options.skills) {
      const body = skill.body ?? `# ${skill.pluginId} 用法`;
      const md = skill.withoutProvenance
        ? `---\nname: plugin-${skill.pluginId}\ndescription: "x"\n---\n${body}`
        : buildSkillMd(
          skill.pluginId, skill.recordedVersion, body,
          skill.handEdited ? computeSkillBodyHash('别的正文') : undefined,
        );
      adapter.files.set(pluginSkillFilePath(skill.pluginId), md);
      const installed = skill.installedVersion ?? skill.recordedVersion;
      if (!skill.uninstalled) {
        manifests[skill.pluginId] = { id: skill.pluginId, name: skill.pluginId, version: installed, description: '' };
        adapter.files.set(
          `.obsidian/plugins/${skill.pluginId}/manifest.json`,
          JSON.stringify({ id: skill.pluginId, version: installed }),
        );
      }
      if (skill.registered !== false) initiallyRegistered.push(`plugin-${skill.pluginId}`);
    }

    const { names, unregistered, restored, registry } = createReconcileRegistry(initiallyRegistered);
    const app = {
      ...mockApp,
      plugins: { manifests, enabledPlugins: new Set(['baizer', ...options.enabled]), getPlugin: () => null },
      vault: { adapter },
    } as unknown as App;
    const generator = {
      ...mockGenerator,
      collectBasicPluginInfo: async (id: string) => {
        counters.basic += 1;
        return mockGenerator.collectPluginInfo(id);
      },
      collectPluginInfo: async (id: string) => {
        counters.full += 1;
        return mockGenerator.collectPluginInfo(id);
      },
      generateSkillMd: async () => {
        counters.generated += 1;
        if (failGeneration) throw new Error('quota exceeded');
        return REGENERATED_MD;
      },
      writeSkillFile: async (id: string, content: string, mode: string) => {
        counters.written += 1;
        writeModes.push(mode);
        const path = pluginSkillFilePath(id);
        await adapter.write(path, content);
        return path;
      },
    };
    const localSettings = {
      ...settings,
      autoGeneratePluginSkills: options.autoGenerate ?? true,
      allowPluginControl: options.allowPluginControl ?? true,
      pluginSkillExcludeList: options.excludeList ?? [],
    };
    const localWatcher = new PluginWatcher(
      app,
      registry as any,
      generator as any,
      localSettings,
      () => options.modelReady ?? true,
      () => {},
    );
    return {
      adapter, counters, writeModes, names, unregistered, restored,
      localWatcher, localSettings, app,
      setFailGeneration: (fail: boolean) => { failGeneration = fail; },
    };
  }

  /** 从对账结果里取某个插件的状态；取不到就报错，避免 undefined 静默通过断言。 */
  function statusOf(statuses: any[], pluginId: string) {
    const found = statuses.find(s => s.pluginId === pluginId);
    if (!found) throw new Error(`No reconcile status for ${pluginId}`);
    return found;
  }
  // 表格第 2 行（前半）：插件被禁用 → 不再提供。
  await test('a disabled plugin\'s skill is not offered after reconciliation', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'kept', recordedVersion: '1.0' }, { pluginId: 'off', recordedVersion: '1.0' }],
      enabled: ['kept'],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-off')).toBe(false);
    expect(s.names.has('plugin-kept')).toBe(true);
    expect(statusOf(statuses, 'off').offered).toBe(false);
    expect(statusOf(statuses, 'off').status).toBe('withdrawn-missing');
  });

  // 表格第 2 行（后半）：插件被卸载（manifest 都没了）→ 不再提供。
  await test('an uninstalled plugin\'s skill is not offered after reconciliation', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'gone', recordedVersion: '1.0', uninstalled: true }],
      enabled: [],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-gone')).toBe(false);
    expect(statusOf(statuses, 'gone').offered).toBe(false);
    expect(statusOf(statuses, 'gone').status).toBe('withdrawn-missing');
    // 插件不在线，读不到当前版本——设置页要能区分「没漂移」和「无从判断」。
    expect(statusOf(statuses, 'gone').installedVersion).toBe(null);
  });

  // 表格第 3 行：在排除名单里 → 不再提供（插件本身还开着）。
  await test('an excluded plugin\'s skill is not offered after reconciliation', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'banned', recordedVersion: '1.0' }],
      enabled: ['banned'],
      excludeList: ['banned'],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-banned')).toBe(false);
    expect(statusOf(statuses, 'banned').status).toBe('withdrawn-excluded');
  });

  // 表格第 1 行：撤销插件控制 → 每一个派生 skill 都撤下，一个不留。
  await test('revoking plugin control withdraws every derived skill', async () => {
    const s = createReconcileSetup({
      skills: [
        { pluginId: 'one', recordedVersion: '1.0' },
        { pluginId: 'two', recordedVersion: '1.0' },
        { pluginId: 'three', recordedVersion: '1.0' },
      ],
      enabled: ['one', 'two', 'three'],
      allowPluginControl: false,
    });
    // 内置 plugin-ctrl 同前缀但不是派生 skill，不能被连带撤下。
    s.names.add('plugin-ctrl');

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(statuses.length).toBe(3);
    expect(statuses.every((st: any) => st.offered === false)).toBe(true);
    expect(statuses.every((st: any) => st.status === 'withdrawn-plugin-control')).toBe(true);
    expect([...s.names]).toEqual(['plugin-ctrl']);
  });

  // 「对账不等于生成」：自动生成关掉时，撤下照样发生。
  // 这条是最容易被悄悄写坏的——把 canGenerate() 当对账总闸就会让它失败。
  await test('withdrawal happens with auto-generate off', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'off', recordedVersion: '1.0' }],
      enabled: [],
      autoGenerate: false,
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.localSettings.autoGeneratePluginSkills).toBe(false);
    expect(s.names.has('plugin-off')).toBe(false);
    expect(statusOf(statuses, 'off').status).toBe('withdrawn-missing');
  });

  // 同一条性质的另一面：模型不可用、插件控制授权在，也照样撤下。
  await test('withdrawal happens with no usable model config', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'off', recordedVersion: '1.0' }],
      enabled: [],
      modelReady: false,
    });

    await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-off')).toBe(false);
  });

  // 「撤下不等于删除」上半：文件必须还在盘上。
  await test('a withdrawn skill\'s file is still on disk', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'paused', recordedVersion: '1.0' }],
      enabled: [],
    });
    const filePath = pluginSkillFilePath('paused');
    const before = s.adapter.files.get(filePath);

    await s.localWatcher.reconcileDerivedSkills();

    expect(s.adapter.files.has(filePath)).toBe(true);
    expect(s.adapter.files.get(filePath)).toBe(before);
  });

  // 「撤下不等于删除」下半：重新启用插件后零生成成本地恢复。
  // 停用一周不该产生一周的账单，所以这里断言的是 counters 全 0，不只是「又出现了」。
  await test('re-enabling a plugin offers its skill again with zero generator calls', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'paused', recordedVersion: '1.0' }],
      enabled: [],
    });
    await s.localWatcher.reconcileDerivedSkills();
    expect(s.names.has('plugin-paused')).toBe(false);

    (s.app as any).plugins.enabledPlugins.add('paused');
    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-paused')).toBe(true);
    expect(statusOf(statuses, 'paused').status).toBe('restored');
    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
  });

  // 撤回插件控制后重新授权：设置保存必须恢复盘上已有文件，而不是只补跑「生成缺失文件」的扫描。
  // 恢复不等于生成，所以四个 generator 入口都必须保持零调用。
  await test('re-granting plugin control restores an existing skill with zero generator calls', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'paused', recordedVersion: '1.0' }],
      enabled: ['paused'],
      allowPluginControl: false,
    });
    await s.localWatcher.reconcileDerivedSkills();
    expect(s.names.has('plugin-paused')).toBe(false);

    s.localSettings.allowPluginControl = true;
    await s.localWatcher.handleSettingsSaved();

    expect(s.names.has('plugin-paused')).toBe(true);
    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
  });

  // 表格第 4 行：版本变了、body 没被改过 → 重新生成后再提供（覆盖写）。
  await test('a version change with an unmodified body regenerates', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'bumped', recordedVersion: '1.0', installedVersion: '2.0' }],
      enabled: ['bumped'],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.counters.full).toBe(1);
    expect(s.counters.generated).toBe(1);
    expect(s.writeModes).toEqual(['replace']);
    expect(s.adapter.files.get(pluginSkillFilePath('bumped'))).toBe(REGENERATED_MD);
    expect(s.names.has('plugin-bumped')).toBe(true);
    expect(statusOf(statuses, 'bumped').status).toBe('regenerated');
    expect(statusOf(statuses, 'bumped').stale).toBe(false);
  });

  // 表格第 5 行：版本变了但 body 被手工改过 → 不生成、按用户写的样子提供、只报 staleness。
  await test('a version change with a hand-edited body does not regenerate', async () => {
    const s = createReconcileSetup({
      skills: [{
        pluginId: 'mine', recordedVersion: '1.0', installedVersion: '2.0',
        body: '# 我自己写的用法', handEdited: true,
      }],
      enabled: ['mine'],
    });
    const before = s.adapter.files.get(pluginSkillFilePath('mine'));

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
    expect(s.adapter.files.get(pluginSkillFilePath('mine'))).toBe(before);
    expect(s.names.has('plugin-mine')).toBe(true);
    expect(statusOf(statuses, 'mine').status).toBe('stale-hand-edited');
    expect(statusOf(statuses, 'mine').stale).toBe(true);
    expect(statusOf(statuses, 'mine').recordedVersion).toBe('1.0');
    expect(statusOf(statuses, 'mine').installedVersion).toBe('2.0');
  });

  // 表格最后一行：其余情况原样提供，什么都不动。
  await test('an unchanged plugin\'s skill is offered untouched', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'same', recordedVersion: '1.0' }],
      enabled: ['same'],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.names.has('plugin-same')).toBe(true);
    expect(s.unregistered.length).toBe(0);
    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
    expect(statusOf(statuses, 'same').status).toBe('offered');
    expect(statusOf(statuses, 'same').stale).toBe(false);
  });

  // 无溯源的旧文件：handEdited 未知，绝不能当成「未改过」去覆盖用户的手写 skill。
  await test('a skill without provenance is offered and never regenerated', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'legacy', recordedVersion: '1.0', installedVersion: '9.9', withoutProvenance: true }],
      enabled: ['legacy'],
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.counters.generated).toBe(0);
    expect(s.names.has('plugin-legacy')).toBe(true);
    expect(statusOf(statuses, 'legacy').handEdited).toBe(null);
    expect(statusOf(statuses, 'legacy').recordedVersion).toBe(null);
    expect(statusOf(statuses, 'legacy').status).toBe('offered');
  });

  // 版本漂移 + body 干净，但生成前置条件不满足：按原样提供并保留 staleness，零生成调用。
  await test('drift with generation unavailable offers as-is and stays stale', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'bumped', recordedVersion: '1.0', installedVersion: '2.0' }],
      enabled: ['bumped'],
      autoGenerate: false,
    });

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
    expect(s.names.has('plugin-bumped')).toBe(true);
    expect(statusOf(statuses, 'bumped').status).toBe('stale-regenerate-skipped');
    expect(statusOf(statuses, 'bumped').stale).toBe(true);
  });

  // 生成中途失败：文件与注册都不能受损，仍按原样提供。
  await test('a failed regeneration leaves the file and registration intact', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'bumped', recordedVersion: '1.0', installedVersion: '2.0' }],
      enabled: ['bumped'],
      failGeneration: true,
    });
    const before = s.adapter.files.get(pluginSkillFilePath('bumped'));

    const statuses = await s.localWatcher.reconcileDerivedSkills();

    expect(s.counters.written).toBe(0);
    expect(s.adapter.files.get(pluginSkillFilePath('bumped'))).toBe(before);
    expect(s.names.has('plugin-bumped')).toBe(true);
    expect(statusOf(statuses, 'bumped').status).toBe('stale-regenerate-failed');
  });

  // 缓存：设置页读上一次结果，不重跑对账。
  await test('getDerivedSkillStatuses returns the last run, empty before it', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'same', recordedVersion: '1.0' }],
      enabled: ['same'],
    });

    expect(s.localWatcher.getDerivedSkillStatuses().length).toBe(0);
    const statuses = await s.localWatcher.reconcileDerivedSkills();
    expect(s.localWatcher.getDerivedSkillStatuses()).toEqual(statuses);
  });

  // 「每次启动跑一次，且在 loadUserSkills 之后」：跑一次由 onload 里唯一一处调用保证，
  // 顺序由源码顺序保证——两者都只能在 main.ts 上验证。
  await test('reconciliation runs once per launch, after user skills are loaded', async () => {
    const onload = readFileSync('main.ts', 'utf8').split('async onload()')[1] ?? '';
    const calls = onload.match(/reconcileDerivedSkills\(\)/g) ?? [];

    expect(calls.length).toBe(1);
    const loadUserSkillsAt = onload.indexOf('loadUserSkills(');
    const reconcileAt = onload.indexOf('reconcileDerivedSkills()');
    expect(loadUserSkillsAt > -1).toBe(true);
    expect(reconcileAt > loadUserSkillsAt).toBe(true);
  });

  // ---------- 设置页入口：显式重新生成 / 删除单个派生 skill ----------

  // 对账拒绝覆盖手改过的正文，而用户点「重新生成」是显式请求——这是唯一的例外。
  await test('an explicit regeneration overwrites a hand-edited body', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0', handEdited: true }],
      enabled: ['mine'],
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(s.writeModes).toEqual(['replace']);
    expect(s.adapter.files.get(pluginSkillFilePath('mine'))).toBe(REGENERATED_MD);
    expect(status?.offered).toBe(true);
    expect(status?.handEdited).toBe(false);
    expect(s.names.has('plugin-mine')).toBe(true);
  });

  // 前置条件不满足时必须「静默地什么都不做」，而不是看起来像成功了。
  await test('an explicit regeneration does nothing quietly when readiness fails', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      modelReady: false,
    });
    const before = s.adapter.files.get(pluginSkillFilePath('mine'));

    const status: any = await s.localWatcher.regenerateDerivedSkill('mine');

    // 报出是哪一项不满足，设置页才能说「去配模型」而不是列举全部前置条件。
    expect(status.blocker).toBe('model-not-ready');
    expect(s.counters.generated).toBe(0);
    expect(s.counters.written).toBe(0);
    expect(s.adapter.files.get(pluginSkillFilePath('mine'))).toBe(before);
  });

  await test('an explicit regeneration is also blocked when plugin control is revoked', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      allowPluginControl: false,
    });

    const status: any = await s.localWatcher.regenerateDerivedSkill('mine');
    expect(status.blocker).toBe('plugin-control-off');
    expect(s.counters.generated).toBe(0);
  });

  await test('an explicit regeneration is blocked when auto-generate is off', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      autoGenerate: false,
    });

    const status: any = await s.localWatcher.regenerateDerivedSkill('mine');
    expect(status.blocker).toBe('auto-generate-off');
    expect(s.counters.generated).toBe(0);
  });

  // 失败时必须按盘上的真实溯源报告：谎报「生成版本未知」会让设置页显示错的东西。
  await test('a failed explicit regeneration still reports the real recorded version', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(status?.recordedVersion).toBe('1.0');
    expect(status?.status).toBe('stale-regenerate-failed');
    expect(status?.offered).toBe(true);
  });

  // 对一个并不过期的技能重新生成（嫌质量差）失败后，不该被倒打一耙标成过期。
  await test('a failed regeneration of a current skill does not mark it stale', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0', installedVersion: '1.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(status?.stale).toBe(false);
  });

  // 但真的漂移时,失败后仍应保留过期标记——否则用户以为已经修好了。
  await test('a failed regeneration of a drifted skill keeps it stale', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0', installedVersion: '2.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(status?.stale).toBe(true);
  });

  // 删除与对账的撤下不同：对账留文件，删除真的把文件删掉。
  await test('deleting a derived skill removes the file and stops offering it', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'gone', recordedVersion: '1.0' }],
      enabled: ['gone'],
    });

    const deleted = await s.localWatcher.deleteDerivedSkill('gone');

    expect(deleted).toBe(true);
    expect(s.adapter.files.has(pluginSkillFilePath('gone'))).toBe(false);
    expect(s.names.has('plugin-gone')).toBe(false);
  });

  // 删除不该受生成前置条件约束：撤回授权后仍要能清掉残留文件。
  await test('deleting works even when generation preconditions fail', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'gone', recordedVersion: '1.0' }],
      enabled: ['gone'],
      allowPluginControl: false,
      modelReady: false,
    });

    expect(await s.localWatcher.deleteDerivedSkill('gone')).toBe(true);
    expect(s.adapter.files.has(pluginSkillFilePath('gone'))).toBe(false);
  });

  // 删除后状态列表里不该再留着它，否则设置页会显示一个已经不存在的条目。
  await test('deletion drops the entry from the reported statuses', async () => {
    const s = createReconcileSetup({
      skills: [
        { pluginId: 'gone', recordedVersion: '1.0' },
        { pluginId: 'kept', recordedVersion: '1.0' },
      ],
      enabled: ['gone', 'kept'],
    });
    await s.localWatcher.reconcileDerivedSkills();

    await s.localWatcher.deleteDerivedSkill('gone');

    const ids = s.localWatcher.getDerivedSkillStatuses().map((x: any) => x.pluginId);
    expect(ids).toEqual(['kept']);
  });

  // ---------- 撤下的技能不能被别的路径悄悄放回来 ----------
  // 对账把来源已消失的技能撤下，但撤下只发生在启动那一次。若会话中途还有别的
  // 路径能重新注册，撤下就形同白做——模型又拿到一份无法执行的操作指南。

  // 决策 3 第一行 + 用户故事 17：撤回插件控制授权后，任何路径都不该再提供派生技能。
  await test('the polling pass does not re-offer a skill while plugin control is revoked', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'back', recordedVersion: '1.0' }],
      enabled: ['back'],
      allowPluginControl: false,
    });
    await s.localWatcher.reconcileDerivedSkills();
    expect(s.names.has('plugin-back')).toBe(false);

    // 插件从禁用变启用（或新装一个盘上还留着旧 SKILL.md 的插件）→ 轮询看到 added。
    await (s.localWatcher as any).checkChanges();

    expect(s.names.has('plugin-back')).toBe(false);
  });

  // 用户故事 16：加进排除名单后该技能就不再提供，不必等到下次启动对账。
  // 排除名单走的是另一条路——getEnabledPluginIds 过滤掉它，于是轮询把它当作 removed。
  await test('adding a plugin to the exclude list withdraws its skill on the next poll', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'skip', recordedVersion: '1.0' }],
      enabled: ['skip'],
    });
    await (s.localWatcher as any).checkChanges();
    expect(s.names.has('plugin-skip')).toBe(true);

    s.localSettings.pluginSkillExcludeList = ['skip'];
    await (s.localWatcher as any).checkChanges();

    expect(s.names.has('plugin-skip')).toBe(false);
  });

  // 反向对照：来源一切正常时，轮询仍然要把盘上已有的技能恢复注册（零生成成本）。
  await test('the polling pass still restores a healthy plugin\'s existing skill', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'fine', recordedVersion: '1.0', registered: false }],
      enabled: ['fine'],
    });

    await (s.localWatcher as any).checkChanges();

    expect(s.names.has('plugin-fine')).toBe(true);
    expect(s.counters.generated).toBe(0);
  });

  // 自动生成关闭只应阻止网络/LLM 生成，不能让本地撤下与恢复停止工作。
  await test('the polling pass restores an existing skill with auto-generate off', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'quiet', recordedVersion: '1.0', registered: false }],
      enabled: ['quiet'],
      autoGenerate: false,
    });

    await (s.localWatcher as any).checkChanges();

    expect(s.names.has('plugin-quiet')).toBe(true);
    expect(s.counters).toEqual({ basic: 0, full: 0, generated: 0, written: 0 });
  });

  // 决策 3 表格：来源不在了就不提供。显式「重新生成」也不能绕过这一行——
  // 否则用户花一次网络+LLM 的钱，换回一份来源已消失的技能，还被报成 offered。
  await test('an explicit regeneration is refused when the source plugin is gone', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'off', recordedVersion: '1.0' }],
      enabled: [],
    });
    await s.localWatcher.reconcileDerivedSkills();

    const status: any = await s.localWatcher.regenerateDerivedSkill('off');

    expect(status.blocker).toBe('source-missing');
    expect(s.counters.generated).toBe(0);
    expect(s.names.has('plugin-off')).toBe(false);
  });

  await test('an explicit regeneration is refused for an excluded plugin', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'skip', recordedVersion: '1.0' }],
      enabled: ['skip'],
      excludeList: ['skip'],
    });

    const status: any = await s.localWatcher.regenerateDerivedSkill('skip');
    expect(status.blocker).toBe('source-excluded');
    expect(s.counters.generated).toBe(0);
  });

  // ---------- 失败原因：所有生成路径都要留痕，成功后要清掉 ----------
  // ticket 05：失败原因必须以「另一部分应用能读到」的形式留存，键为插件 id。
  // 只有启动扫描留痕是不够的——对账与显式重新生成同样是生成，同样会失败。

  await test('a failed reconcile regeneration retains its reason, keyed by plugin', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0', installedVersion: '2.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    await s.localWatcher.reconcileDerivedSkills();

    expect(s.localWatcher.getGenerationFailures().get('mine')).toBe('quota exceeded');
  });

  await test('a failed explicit regeneration retains its reason', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    await s.localWatcher.regenerateDerivedSkill('mine');

    expect(s.localWatcher.getGenerationFailures().get('mine')).toBe('quota exceeded');
  });

  // 成功必须清掉旧原因，否则设置页在整个会话里继续展示一个已经修好的失败。
  await test('a successful regeneration clears a stale failure reason', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });
    await s.localWatcher.regenerateDerivedSkill('mine');
    expect(s.localWatcher.getGenerationFailures().has('mine')).toBe(true);

    s.setFailGeneration(false);
    await s.localWatcher.regenerateDerivedSkill('mine');

    expect(s.localWatcher.getGenerationFailures().has('mine')).toBe(false);
  });

  // 设置页据返回值决定弹「已重新生成」还是「暂时无法重新生成」。
  // 失败的一轮不能返回一个看起来成功的对象——那会变成一句纯粹的假成功提示。
  await test('a failed explicit regeneration is reported as a failure, not a success', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
      failGeneration: true,
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(status?.regenerated).toBe(false);
    expect(status?.failureReason).toBe('quota exceeded');
  });

  // 成功的一轮同样要能被区分出来。
  await test('a successful explicit regeneration is reported as regenerated', async () => {
    const s = createReconcileSetup({
      skills: [{ pluginId: 'mine', recordedVersion: '1.0' }],
      enabled: ['mine'],
    });

    const status = await s.localWatcher.regenerateDerivedSkill('mine');

    expect(status?.regenerated).toBe(true);
    expect(status?.failureReason).toBe(null);
  });
}

runTests().catch(console.error);
