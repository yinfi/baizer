import { App } from 'obsidian';

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
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected))
        throw new Error(`Expected string not to contain "${expected}"`);
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

/** 写入/读取测试用的 adapter 假件，只实现 skill-files 需要的四个方法。 */
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

  const generator = new PluginSkillGenerator(
    mockApp, mockModelService as any,
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

  await test('generateSkillMd documents plugin workflow preconditions before command execution', async () => {
    const skillMd = await generator.generateSkillMd({
      id: 'obsidian-tasks-plugin',
      name: 'Tasks',
      description: 'Task management for Obsidian',
      version: '7.14.0',
      commands: [
        { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task', aiUsable: true },
      ],
      settingsKeys: ['globalFilter'],
      syntaxHints: [],
      webContext: '',
    });

    expect(skillMd).toContain('## Preconditions');
    expect(skillMd).toContain('Open the target note before execution.');
    expect(skillMd).toContain('Confirm the relevant editor pane or selection is focused before execution.');
    expect(skillMd).notToContain('execute_plugin_command(commandId, path)');
  });

  // ---------- 溯源（source 块）与写入模式 ----------

  const {
    USER_SKILLS_DIR,
    computeSkillBodyHash,
    readPluginSkillProvenance,
    readSkillProvenanceFromFile,
    readSkillProvenanceFromText,
    splitSkillFrontmatter,
  } = await import('../src/skills/skill-files');
  const { parseBuiltinSkill } = await import('../src/skills/pi-skill-source');

  const tasksInfo = {
    id: 'obsidian-tasks-plugin',
    name: 'Tasks',
    description: 'Task management for Obsidian',
    version: '7.14.0',
    commands: [
      { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task', aiUsable: true },
    ],
    settingsKeys: ['globalFilter'],
    syntaxHints: [] as string[],
    webContext: '',
  };

  await test('generateSkillMd records source plugin, version and body hash', async () => {
    const skillMd = await generator.generateSkillMd({ ...tasksInfo });

    expect(skillMd).toContain('source:');
    const report = readSkillProvenanceFromText(skillMd);
    expect(report.present).toBe(true);
    expect(report.provenance!.plugin).toBe('obsidian-tasks-plugin');
    expect(report.provenance!.version).toBe('7.14.0');
    expect(report.provenance!.bodyHash.length).toBe(8);
  });

  await test('recorded body hash recomputes over the written body, and differs after a hand-edit', async () => {
    const skillMd = await generator.generateSkillMd({ ...tasksInfo });
    const report = readSkillProvenanceFromText(skillMd);

    const { body } = splitSkillFrontmatter(skillMd);
    expect(computeSkillBodyHash(body)).toBe(report.provenance!.bodyHash);
    expect(report.handEdited).toBe(false);

    const handEdited = readSkillProvenanceFromText(`${skillMd}\n\n手工补充的一段说明。`);
    expect(handEdited.present).toBe(true);
    expect(handEdited.handEdited).toBe(true);
  });

  await test('reading provenance from a skill without a source block reports absence', async () => {
    const adapter = new FakeAdapter();
    const handWritten = [
      '---',
      'name: my-own-skill',
      'description: 手写的 skill，没有 source 块',
      '---',
      '',
      '# My own skill',
    ].join('\n');
    adapter.files.set('skills/my-own-skill/SKILL.md', handWritten);

    const written = await readSkillProvenanceFromFile(adapter, 'skills/my-own-skill/SKILL.md');
    expect(written.present).toBe(false);
    expect(written.provenance).toBe(null);
    expect(written.handEdited).toBe(null);

    const missing = await readSkillProvenanceFromFile(adapter, 'skills/absent/SKILL.md');
    expect(missing.present).toBe(false);
    expect(missing.handEdited).toBe(null);
  });

  await test('provenance reads back by plugin id from the plugin- prefixed dir', async () => {
    const adapter = new FakeAdapter();
    const writer = new PluginSkillGenerator(
      { vault: { adapter } } as unknown as App, mockModelService as any,
    );
    const skillMd = await writer.generateSkillMd({ ...tasksInfo });
    await writer.writeSkillFile('obsidian-tasks-plugin', skillMd, 'replace');

    expect(
      adapter.files.has(`${USER_SKILLS_DIR}/plugin-obsidian-tasks-plugin/SKILL.md`),
    ).toBe(true);

    const report = await readPluginSkillProvenance(adapter, 'obsidian-tasks-plugin');
    expect(report.present).toBe(true);
    expect(report.provenance!.plugin).toBe('obsidian-tasks-plugin');
    expect(report.handEdited).toBe(false);
  });

  await test('each absent report is a fresh object, so a caller cannot poison later reads', async () => {
    const adapter = new FakeAdapter();
    const first = await readPluginSkillProvenance(adapter, 'never-generated');
    (first as any).handEdited = false;

    const second = await readPluginSkillProvenance(adapter, 'never-generated');
    expect(second.handEdited).toBe(null);
    expect(readSkillProvenanceFromText('# 没有 frontmatter 的手写 skill').handEdited).toBe(null);
  });

  await test('a failed read reports absence instead of throwing', async () => {
    const lockedAdapter = {
      exists: async () => true,
      read: async () => { throw new Error('EACCES'); },
    };

    const report = await readSkillProvenanceFromFile(lockedAdapter, 'skills/locked/SKILL.md');
    expect(report.present).toBe(false);
    expect(report.provenance).toBe(null);
    expect(report.handEdited).toBe(null);
  });

  await test('a description containing ": " keeps frontmatter parseable and provenance readable', async () => {
    const colonDescGenerator = new PluginSkillGenerator(mockApp, {
      generate: async () => `<!-- DESC: 任务管理: 截止日期与重复任务 -->

# Tasks
## 操作指南
1. 用 append_to_note 追加任务`,
    } as any);
    const skillMd = await colonDescGenerator.generateSkillMd({ ...tasksInfo });

    const report = readSkillProvenanceFromText(skillMd);
    expect(report.present).toBe(true);
    expect(report.provenance!.plugin).toBe('obsidian-tasks-plugin');
    expect(report.handEdited).toBe(false);

    const loaded = parseBuiltinSkill(skillMd, 'plugin-obsidian-tasks-plugin/SKILL.md');
    expect(loaded?.skill.description).toBe('任务管理: 截止日期与重复任务');
  });

  await test('replace overwrites an existing skill file, first-write leaves it alone', async () => {
    const adapter = new FakeAdapter();
    const writer = new PluginSkillGenerator(
      { vault: { adapter } } as unknown as App, mockModelService as any,
    );
    const filePath = writer.skillFilePath('obsidian-tasks-plugin');

    await writer.writeSkillFile('obsidian-tasks-plugin', 'first', 'first-write');
    expect(adapter.files.get(filePath)).toBe('first');

    await writer.writeSkillFile('obsidian-tasks-plugin', 'second', 'first-write');
    expect(adapter.files.get(filePath)).toBe('first');

    await writer.writeSkillFile('obsidian-tasks-plugin', 'third', 'replace');
    expect(adapter.files.get(filePath)).toBe('third');
  });
}

runTests().catch(console.error);
