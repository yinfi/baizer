/**
 * 声明式设置页（Obsidian >= 1.13 的 getSettingDefinitions）回归测试。
 *
 * 设置页本身是 DOM 渲染，但「哪些页面/控件/键存在」是纯结构，可以在 Node 里断言；
 * 这层正是迁移最容易悄悄漏东西的地方（漏一个键 = 该设置从界面上消失）。
 */
import { App } from 'obsidian';
import { readFileSync } from 'fs';
import { DEFAULT_SETTINGS, IPlugin, PluginSettings } from '../src/mcp/types';
import { setLocaleForTesting } from '../src/i18n/zh';
import { SettingTab } from '../src/settings';
import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';

setLocaleForTesting(false);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
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

function scenarioSettings(): PluginSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
  settings.activeProvider = 'opencode';
  settings.providers = {
    cch: {
      type: 'openai-compatible',
      label: 'cch',
      apiKey: 'sk-cch',
      baseUrl: 'http://127.0.0.1:8082/v1',
      model: 'gpt-5.6-sol',
    },
    opencode: {
      type: 'openai-compatible',
      label: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-v4.1-flash',
      customHeaders: { 'x-opencode-session': '{{conversationId}}' },
    },
    anthropic: {
      type: 'anthropic',
      label: 'Anthropic',
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
    },
  };
  settings.disabledSkills = [];
  return settings;
}

interface FakePlugin {
  settings: PluginSettings;
  saves: string[];
  languageChanges: string[];
  saveSettings(): Promise<void>;
  saveSettingsLight(): Promise<void>;
  applyLanguageChange(locale: string): Promise<void>;
  modelService: {
    getSkillList(): Array<{ name: string; description: string; commands?: string[] }>;
    updateSettings(): Promise<void>;
    switchProvider(id: string, save?: () => Promise<void>): Promise<void>;
    switchModel(): Promise<void>;
    getAvailableModelsWithStatus(): Promise<unknown>;
  };
  pluginWatcher: null;
  knowledgeRuntime: null;
}

function fakePlugin(): FakePlugin {
  const settings = scenarioSettings();
  const plugin: FakePlugin = {
    settings,
    saves: [],
    languageChanges: [],
    async saveSettings() { plugin.saves.push('heavy'); },
    async saveSettingsLight() { plugin.saves.push('light'); },
    async applyLanguageChange(locale: string) {
      plugin.languageChanges.push(locale);
      settings.language = locale as PluginSettings['language'];
    },
    modelService: {
      getSkillList: () => [
        { name: 'vault-ops', description: 'Read and write notes.', commands: ['/new'] },
        { name: 'web-search', description: 'Search the web.' },
      ],
      updateSettings: async () => { /* no-op */ },
      switchProvider: async (id, save) => {
        settings.activeProvider = id;
        if (save) await save();
      },
      switchModel: async () => { /* no-op */ },
      getAvailableModelsWithStatus: async () => ({ models: [], listed: false, listingUnsupported: false }),
    },
    pluginWatcher: null,
    knowledgeRuntime: null,
  };
  return plugin;
}

function createTab(plugin: FakePlugin): SettingTab {
  return new SettingTab({} as App, plugin as unknown as IPlugin);
}

function pagesOf(items: SettingDefinitionItem[]): SettingDefinitionPage[] {
  return items.filter((item): item is SettingDefinitionPage => item.type === 'page');
}

function pageByName(items: SettingDefinitionItem[], name: string): SettingDefinitionPage {
  const page = pagesOf(items).find(candidate => candidate.name === name);
  if (!page) throw new Error(`missing page: ${name} (have: ${pagesOf(items).map(p => p.name).join(', ')})`);
  return page;
}

function itemsOf(page: SettingDefinitionPage): SettingDefinitionItem[] {
  return page.items ?? [];
}

function groupItems(page: SettingDefinitionPage, heading: string): SettingGroupItem[] {
  for (const item of itemsOf(page)) {
    if ('type' in item && item.type === 'group' && item.heading === heading) {
      return item.items ?? [];
    }
  }
  throw new Error(`missing group "${heading}" on page "${page.name}"`);
}

/** 某一行（含组内行）是否以给定名称出现；render 行没有 control.key，只能按名字断言。 */
function hasRowNamed(page: SettingDefinitionPage, name: string): boolean {
  const visit = (list: SettingDefinitionItem[]): boolean => list.some(item => {
    if ('name' in item && item.name === name) return true;
    if ('items' in item && item.items) return visit(item.items as SettingDefinitionItem[]);
    return false;
  });
  return visit(itemsOf(page));
}

async function runTests() {
  console.log('=== Declarative Settings Tests ===');

  await test('every former section is a declarative page (and the tab has no display())', () => {
    const tab = createTab(fakePlugin());
    const items = tab.getSettingDefinitions();
    const names = pagesOf(items).map(page => page.name);
    expect(names).toEqual([
      'Connection',
      'Behavior',
      'Memory',
      'Permissions',
      'Skills',
      'Capture',
      'Knowledge',
      'Guardian',
      'Appearance',
      'Plugin Skills',
    ]);
    assert(items.every(item => item.type === 'page' || item.type === 'group'), 'top level must be pages + the attention group only');

    const source = readFileSync('src/settings.ts', 'utf8');
    const tabClass = source.slice(source.indexOf('export class SettingTab'), source.indexOf('class MemoryBrowserPage'));
    assert(source.includes('getSettingDefinitions()'), 'the tab must implement the declarative API');
    assert(!/\bdisplay\s*\(\s*\)\s*:\s*void/.test(tabClass), 'display() must be gone once minAppVersion is >= 1.13');
    // 记忆浏览是异步列表，按官方指引保留为 imperative SettingPage —— 它自己的 display() 不是被废弃的 tab display()。
    assert(source.includes('class MemoryBrowserPage extends SettingPage'), 'the async memory list must stay a SettingPage');
  });

  await test('attention rows are the overview replacement and list actionable issues', () => {
    const plugin = fakePlugin();
    plugin.settings.providers.cch.apiKey = '';
    plugin.settings.providers.anthropic.apiKey = '';
    const tab = createTab(plugin);

    const groups = tab.getSettingDefinitions().filter(item => item.type === 'group') as SettingGroupItem[] extends never ? never : any[];
    const attention = groups.find(group => group.heading === 'Needs attention');
    assert(Boolean(attention), 'missing the Needs attention group');
    const labels = (attention.items as Array<{ name: string }>).map(item => item.name);
    assert(labels.some(label => label.includes('cch')), 'a missing provider key must be surfaced');
    assert(labels.some(label => label.includes('Anthropic')), 'a missing provider key must be surfaced');
  });

  await test('the connection page lists every provider as a sub-page', () => {
    const tab = createTab(fakePlugin());
    const connection = pageByName(tab.getSettingDefinitions(), 'Connection');
    const list = itemsOf(connection)[0] as { type: 'list'; items?: SettingGroupItem[]; addItem?: { name: string } };
    expect(list.type).toEqual('list');
    expect((list.items ?? []).map(item => item.name)).toEqual(['cch', 'opencode', 'Anthropic']);
    assert(Boolean(list.addItem), 'the provider list must offer an add affordance');

    const opencode = (list.items ?? []).find(item => item.name === 'opencode') as SettingDefinitionPage;
    const controls = itemsOf(opencode).map(item => ('control' in item ? item.control?.key : undefined)).filter(Boolean);
    assert(controls.includes('provider.opencode.label'), 'provider name must be a declarative control');
    assert(controls.includes('provider.opencode.type'), 'protocol must be a declarative control');
    assert(controls.includes('provider.opencode.apiFlavor'), 'API type must be a declarative control');
  });

  await test('the API-type control is only visible for OpenAI-compatible providers', () => {
    const tab = createTab(fakePlugin());
    const connection = pageByName(tab.getSettingDefinitions(), 'Connection');
    const list = itemsOf(connection)[0] as { items?: SettingItem[] };
    const openaiPage = (list.items ?? []).find(item => item.name === 'opencode') as SettingDefinitionPage;
    const anthropicPage = (list.items ?? []).find(item => item.name === 'Anthropic') as SettingDefinitionPage;
    const apiType = (page: SettingDefinitionPage) => page.items?.find(item => 'name' in item && item.name?.startsWith('API type')) as any;

    expect({ openai: apiType(openaiPage).visible(), anthropic: apiType(anthropicPage).visible() })
      .toEqual({ openai: true, anthropic: false });
  });

  await test('scalar settings round-trip through the tab storage adapter', async () => {
    const plugin = fakePlugin();
    const tab = createTab(plugin);

    await tab.setControlValue('contextWindow', 200000);
    expect(plugin.settings.contextWindow).toEqual(200000);
    expect(tab.getControlValue('contextWindow')).toEqual(200000);

    await tab.setControlValue('knowledgeSourceFolders', 'Clippings\nReading Notes');
    expect(plugin.settings.knowledgeSourceFolders).toEqual(['Clippings', 'Reading Notes']);
    expect(tab.getControlValue('knowledgeSourceFolders')).toEqual('Clippings\nReading Notes');

    await tab.setControlValue('pluginSkillExcludeList', 'a, b');
    expect(plugin.settings.pluginSkillExcludeList).toEqual(['a', 'b']);
    expect(tab.getControlValue('pluginSkillExcludeList')).toEqual('a, b');

    await tab.setControlValue('privacyMode', true);
    expect(plugin.settings.privacyMode).toEqual(true);
  });

  await test('skill toggles invert into the disabledSkills denylist', async () => {
    const plugin = fakePlugin();
    const tab = createTab(plugin);

    expect(tab.getControlValue('skill.vault-ops')).toEqual(true);
    await tab.setControlValue('skill.vault-ops', false);
    expect(plugin.settings.disabledSkills).toEqual(['vault-ops']);
    expect(tab.getControlValue('skill.vault-ops')).toEqual(false);

    await tab.setControlValue('skill.vault-ops', true);
    expect(plugin.settings.disabledSkills).toEqual([]);
  });

  await test('switching a provider protocol migrates the address and drops the OpenAI-only flavor', async () => {
    const plugin = fakePlugin();
    const tab = createTab(plugin);

    plugin.settings.providers.opencode.baseUrl = '';
    await tab.setControlValue('provider.opencode.type', 'anthropic');
    expect(plugin.settings.providers.opencode.type).toEqual('anthropic');
    expect(plugin.settings.providers.opencode.baseUrl).toEqual('https://api.anthropic.com');
    expect(plugin.settings.providers.opencode.apiFlavor).toEqual(undefined);

    plugin.settings.providers.opencode.baseUrl = 'https://gateway.example.com';
    await tab.setControlValue('provider.opencode.type', 'openai-compatible');
    expect(plugin.settings.providers.opencode.baseUrl).toEqual('https://gateway.example.com');
  });

  await test('the language control delegates to the plugin language switch', async () => {
    const plugin = fakePlugin();
    const tab = createTab(plugin);

    await tab.setControlValue('language', 'en');
    expect(plugin.languageChanges).toEqual(['en']);
    expect(plugin.settings.language).toEqual('en');
  });

  await test('behavior/memory/permissions pages expose the expected declarative keys', () => {
    const tab = createTab(fakePlugin());
    const items = tab.getSettingDefinitions();

    const keys = (page: SettingDefinitionPage): string[] => {
      const collect = (list: SettingDefinitionItem[]): string[] => list.flatMap(item => {
        if ('control' in item && item.control) return [String(item.control.key)];
        if ('items' in item && item.items) return collect(item.items as SettingDefinitionItem[]);
        return [];
      });
      return collect(itemsOf(page));
    };

    const behavior = keys(pageByName(items, 'Behavior'));
    assert(behavior.includes('contextWindow'), 'behavior page must expose the context budget');
    assert(behavior.includes('thinkingLevel'), 'behavior page must expose the thinking level');
    assert(behavior.includes('customizePrompt'), 'behavior page must expose the prompt toggle');
    // 多行系统提示词用 render 行（整行 textarea），仍是可搜索的设置行。
    assert(hasRowNamed(pageByName(items, 'Behavior'), 'System prompt'), 'behavior page must expose the system prompt row');

    const memory = keys(pageByName(items, 'Memory'));
    for (const key of ['privacyMode', 'memoryQueryExpansion', 'memoryGraphRecall', 'memoryConflictUpdate']) {
      assert(memory.includes(key), `memory page must expose ${key}`);
    }

    const permissions = keys(pageByName(items, 'Permissions'));
    for (const key of ['vaultWriteScope', 'allowFileCreation', 'allowFileModification', 'allowPluginConfigValues']) {
      assert(permissions.includes(key), `permissions page must expose ${key}`);
    }
  });

  await test('capture/knowledge/guardian/appearance/plugin-skills pages keep their keys', () => {
    const tab = createTab(fakePlugin());
    const items = tab.getSettingDefinitions();
    const allKeys = (page: SettingDefinitionPage): string[] => {
      const collect = (list: SettingDefinitionItem[]): string[] => list.flatMap(item => {
        if ('control' in item && item.control) return [String(item.control.key)];
        if ('items' in item && item.items) return collect(item.items as SettingDefinitionItem[]);
        return [];
      });
      return collect(itemsOf(page));
    };

    const capture = allKeys(pageByName(items, 'Capture'));
    for (const key of ['asrBaseUrl', 'asrModel', 'asrLanguage', 'wechatInboxPath', 'wechatStoragePath']) {
      assert(capture.includes(key), `capture page must expose ${key}`);
    }

    const knowledge = allKeys(pageByName(items, 'Knowledge'));
    for (const key of ['knowledgeWikiFolder', 'knowledgeAutoCompile',
      'knowledgeOntologyEnabled', 'knowledgeOntologyUpdateMode', 'knowledgeOntologyMinArticles']) {
      assert(knowledge.includes(key), `knowledge page must expose ${key}`);
    }
    assert(hasRowNamed(pageByName(items, 'Knowledge'), 'Source Folders'),
      'knowledge page must expose the source-folders row (stacked textarea)');

    const guardian = allKeys(pageByName(items, 'Guardian'));
    for (const key of ['enableSelectionMenu', 'enableGuardian', 'guardianAutoMode', 'guardianUIStyle',
      'guardianSensitivity']) {
      assert(guardian.includes(key), `guardian page must expose ${key}`);
    }
    assert(hasRowNamed(pageByName(items, 'Guardian'), 'Ignored Folders'),
      'guardian page must expose the ignored-folders row (stacked textarea)');

    const appearance = allKeys(pageByName(items, 'Appearance'));
    for (const key of ['language', 'terminalTheme', 'terminalFontSize', 'terminalOpacity']) {
      assert(appearance.includes(key), `appearance page must expose ${key}`);
    }

    const pluginSkills = allKeys(pageByName(items, 'Plugin Skills'));
    for (const key of ['autoGeneratePluginSkills', 'pluginSkillExcludeList']) {
      assert(pluginSkills.includes(key), `plugin-skills page must expose ${key}`);
    }
  });

  await test('guardian details are hidden while Guardian is off', () => {
    const plugin = fakePlugin();
    plugin.settings.enableGuardian = false;
    const tab = createTab(plugin);
    const guardian = pageByName(tab.getSettingDefinitions(), 'Guardian');
    const find = (name: string) => {
      for (const item of guardian.items ?? []) {
        if ('items' in item && item.items) {
          const hit = (item.items as SettingDefinitionItem[]).find(child => 'name' in child && child.name === name);
          if (hit) return hit as any;
        }
      }
      return undefined;
    };
    const autoMode = find('Auto Mode');
    assert(Boolean(autoMode), 'Auto Mode row must exist (visibility is a predicate)');
    expect(autoMode.visible()).toEqual(false);
    plugin.settings.enableGuardian = true;
    expect(autoMode.visible()).toEqual(true);
  });

  await test('provider page names stay unique when two providers share a label', () => {
    const plugin = fakePlugin();
    plugin.settings.providers.cch.label = 'opencode';
    const tab = createTab(plugin);
    const connection = pageByName(tab.getSettingDefinitions(), 'Connection');
    const list = itemsOf(connection)[0] as { items?: SettingGroupItem[] };
    const names = (list.items ?? []).map(item => item.name);
    expect(new Set(names).size).toEqual(names.length);
  });
}

runTests();
