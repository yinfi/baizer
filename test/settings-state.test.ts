import { DEFAULT_SETTINGS, PluginSettings, mergeProviderDefaults } from '../src/mcp/types';
import { setLocaleForTesting } from '../src/i18n/zh';
import {
  getConnectionTestStatusPresentation,
  getProviderCardMeta,
  getProviderListSummary,
  getProviderDeletionState,
  getMatchingSettingsSections,
  getSettingsSectionStatuses,
  getSettingsFallbackCss,
  getSettingsOverviewActions,
  getRenderableSettingsSections,
  getDerivedSkillRows,
  getRegenerateOutcomeMessage,
} from '../src/settings';

// 断言用英文原文 key(t() 在非中文环境返回原文),固定 locale 保证与运行环境无关。
setLocaleForTesting(false);

function cloneSettings(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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

async function runTests() {
  console.log('=== Settings State Tests ===');

  await test('marks the active connection as needing a key when the provider is unconfigured', () => {
    const settings = cloneSettings();
    settings.activeProvider = 'deepseek';
    settings.providers.deepseek.apiKey = '';

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.connection).toEqual({ label: 'Needs key', tone: 'warning' });
  });

  await test('marks a configured custom provider as custom', () => {
    const settings = cloneSettings();
    settings.providers['custom-local'] = {
      type: 'openai-compatible',
      label: 'Local Gateway',
      apiKey: 'sk-local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };
    settings.activeProvider = 'custom-local';

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.connection).toEqual({ label: 'Custom provider', tone: 'accent' });
  });

  await test('marks Guardian as off only when disabled', () => {
    const settings = cloneSettings();
    settings.enableGuardian = false;

    let statuses = getSettingsSectionStatuses(settings);
    expect(statuses.guardian).toEqual({ label: 'Off', tone: 'muted' });

    settings.enableGuardian = true;
    statuses = getSettingsSectionStatuses(settings);
    expect(statuses.guardian).toEqual(undefined);
  });

  await test('settings search exposes the Memory section', () => {
    expect(getMatchingSettingsSections('memory')).toEqual(['memory']);
  });

  await test('settings search exposes ontology controls under Knowledge', () => {
    expect(getMatchingSettingsSections('ontology')).toEqual(['knowledge']);
  });

  await test('marks Memory as private when privacy mode is enabled', () => {
    const settings = cloneSettings();
    settings.privacyMode = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.memory).toEqual({ label: 'Private', tone: 'accent' });
  });

  await test('marks permissions as risky when plugin control is enabled', () => {
    const settings = cloneSettings();
    settings.allowPluginControl = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.permissions).toEqual({ label: 'Broad access', tone: 'danger' });
  });

  await test('marks permissions as risky when vault-wide writes are enabled', () => {
    const settings = cloneSettings();
    settings.vaultWriteScope = 'all-vault';
    settings.allowPluginControl = false;
    settings.confirmExecutions = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.permissions).toEqual({ label: 'Broad access', tone: 'danger' });
  });

  await test('enables provider deletion for built-in providers when alternatives remain', () => {
    const settings = cloneSettings();
    settings.activeProvider = 'openai';

    const deletion = getProviderDeletionState(settings);

    expect(deletion).toEqual({
      canDelete: true,
      helperText: 'Remove the selected provider from this workspace.',
      label: 'Delete Provider',
    });
  });

  await test('prevents deleting the final remaining provider', () => {
    const settings = cloneSettings();
    settings.activeProvider = 'openai';
    settings.providers = {
      openai: settings.providers.openai,
    };

    const deletion = getProviderDeletionState(settings);

    expect(deletion).toEqual({
      canDelete: false,
      helperText: 'At least one provider must remain configured.',
      label: 'Delete Provider',
    });
  });

  await test('enables provider deletion for custom providers', () => {
    const settings = cloneSettings();
    settings.providers['custom-local'] = {
      type: 'openai-compatible',
      label: 'Local Gateway',
      apiKey: 'sk-local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };
    settings.activeProvider = 'custom-local';

    const deletion = getProviderDeletionState(settings);

    expect(deletion).toEqual({
      canDelete: true,
      helperText: 'Remove the selected provider from this workspace.',
      label: 'Delete Provider',
    });
  });

  await test('maps connection test states to visible in-page feedback', () => {
    expect(getConnectionTestStatusPresentation({
      state: 'testing',
      message: 'Testing connection to DeepSeek...',
    })).toEqual({
      tone: 'accent',
      label: 'Testing connection to DeepSeek...',
    });

    expect(getConnectionTestStatusPresentation({
      state: 'success',
      message: 'Connection successful.',
    })).toEqual({
      tone: 'success',
      label: 'Connection successful.',
    });

    expect(getConnectionTestStatusPresentation({
      state: 'error',
      message: 'Connection failed.',
    })).toEqual({
      tone: 'danger',
      label: 'Connection failed.',
    });
  });

  await test('builds provider list summary counts for the connection workspace', () => {
    const settings = cloneSettings();
    settings.providers.gemini.apiKey = 'gm-key';
    settings.providers.deepseek.apiKey = 'ds-key';
    settings.providers.openai.apiKey = '';
    settings.providers.qwen.apiKey = '';

    expect(getProviderListSummary(settings)).toEqual({
      total: 4,
      configured: 2,
      missingKey: 2,
      label: '4 providers / 2 configured / 2 missing key',
    });
  });

  await test('builds provider card metadata for active and missing-key providers', () => {
    const settings = cloneSettings();
    settings.activeProvider = 'openai';
    settings.providers.openai.apiKey = '';
    settings.providers.openai.model = 'gpt-4o';

    expect(getProviderCardMeta(settings, 'openai')).toEqual({
      id: 'openai',
      label: 'OpenAI',
      protocolLabel: 'OpenAI-compatible',
      endpointSummary: 'api.openai.com/v1',
      modelSummary: 'Model: gpt-4o',
      statusLabel: 'No API key',
      statusTone: 'warning',
      isActive: true,
      compactMeta: 'Model: gpt-4o',
      protocolGlyph: '◎',
      statusGlyph: '!',
    });
  });

  await test('restores missing default providers unless they were deliberately deleted', () => {
    const settings = cloneSettings();

    const restored = mergeProviderDefaults({
      gemini: settings.providers.gemini,
    }, ['openai', 'deepseek']);

    expect(Object.keys(restored)).toEqual(['gemini', 'qwen']);
  });

  await test('exposes an explicit vault write scope default for permission controls', () => {
    const settings = cloneSettings();

    expect({
      vaultWriteScope: (settings as any).vaultWriteScope,
      vaultWriteAllowedFolders: (settings as any).vaultWriteAllowedFolders,
    }).toEqual({
      vaultWriteScope: 'all-vault',
      vaultWriteAllowedFolders: [],
    });
  });

  await test('exposes ontology defaults for knowledge schema controls', () => {
    const settings = cloneSettings();

    expect({
      knowledgeOntologyEnabled: (settings as any).knowledgeOntologyEnabled,
      knowledgeOntologyUpdateMode: (settings as any).knowledgeOntologyUpdateMode,
      knowledgeOntologyMinArticles: (settings as any).knowledgeOntologyMinArticles,
      knowledgeOntologyMinTopicFrequency: (settings as any).knowledgeOntologyMinTopicFrequency,
      knowledgeOntologyMinConceptFrequency: (settings as any).knowledgeOntologyMinConceptFrequency,
      knowledgeOntologyAutoRecompileStale: (settings as any).knowledgeOntologyAutoRecompileStale,
    }).toEqual({
      knowledgeOntologyEnabled: true,
      knowledgeOntologyUpdateMode: 'suggest',
      knowledgeOntologyMinArticles: 10,
      knowledgeOntologyMinTopicFrequency: 3,
      knowledgeOntologyMinConceptFrequency: 2,
      knowledgeOntologyAutoRecompileStale: false,
    });
  });

  await test('settings search exposes the Overview section by default', () => {
    expect(getMatchingSettingsSections('')).toEqual([
      'overview',
      'connection',
      'behavior',
      'memory',
      'permissions',
      'skills',
      'capture',
      'knowledge',
      'guardian',
      'appearance',
      'plugin-skills',
    ]);
  });

  await test('overview actions surface only actionable configuration issues', () => {
    const settings = cloneSettings();
    settings.providers.gemini.apiKey = '';
    settings.providers.deepseek.apiKey = 'ds-key';
    settings.activeProvider = 'deepseek';
    settings.allowPluginControl = true;

    expect(getSettingsOverviewActions(settings)).toEqual([
      { label: 'Permissions too broad', sectionId: 'permissions', tone: 'danger' },
      { label: 'Google Gemini missing API key', sectionId: 'connection', tone: 'warning' },
      { label: 'OpenAI missing API key', sectionId: 'connection', tone: 'warning' },
      { label: 'Qwen missing API key', sectionId: 'connection', tone: 'warning' },
    ]);
  });

  await test('collapsed settings sections do not render heavy section content', () => {
    expect(getRenderableSettingsSections([
      'overview',
      'connection',
      'memory',
      'knowledge',
    ], new Set(['connection']))).toEqual(['connection']);
  });

  await test('settings fallback CSS covers the accordion configuration layout', () => {
    const css = getSettingsFallbackCss();

    expect({
      hasRoot: css.includes('.baizer-settings-page'),
      hasAccordion: css.includes('.baizer-settings-accordion'),
      hasSectionSummary: css.includes('.baizer-settings-section-summary'),
      hasInlineProviderDetail: css.includes('.baizer-settings-provider-detail-inline'),
      hasConnectionDetailGrid: css.includes('.baizer-settings-connection-detail-grid'),
      hasCompactSectionRow: css.includes('grid-template-columns: minmax(0, 1fr) auto 18px'),
      hasNarrowOnlyBreakpoint: css.includes('@container (max-width: 560px)'),
      removedSectionIcon: css.includes('.baizer-settings-section-icon'),
      removedWideBreakpoint: css.includes('@container (max-width: 900px)'),
      removedNavLayout: css.includes('.baizer-settings-nav-list'),
      removedWorkspaceSplit: css.includes('.baizer-settings-workspace {'),
      removedMetricCards: css.includes('.baizer-settings-metric'),
    }).toEqual({
      hasRoot: true,
      hasAccordion: true,
      hasSectionSummary: true,
      hasInlineProviderDetail: true,
      hasConnectionDetailGrid: true,
      hasCompactSectionRow: true,
      hasNarrowOnlyBreakpoint: true,
      removedSectionIcon: false,
      removedWideBreakpoint: false,
      removedNavLayout: false,
      removedWorkspaceSplit: false,
      removedMetricCards: false,
    });
  });
  await test('exposes thinkingLevel default for behavior controls', () => {
    const settings = cloneSettings();

    expect({ thinkingLevel: (settings as any).thinkingLevel }).toEqual({
      thinkingLevel: 'medium',
    });
  });

  await test('settings search exposes the Behavior section for thinking', () => {
    const matches = getMatchingSettingsSections('thinking');
    expect({ hasBehavior: matches.includes('behavior') }).toEqual({ hasBehavior: true });
  });

  // ── 派生技能列表（设置页展示行）──
  // 这里测的是「显示什么」这个纯函数，DOM 只消费它；状态判定本身归 PluginWatcher。

  const derived = (over: Record<string, any> = {}) => ({
    skillName: 'plugin-tasks',
    pluginId: 'tasks',
    offered: true,
    status: 'offered',
    recordedVersion: '1.0',
    installedVersion: '1.0',
    handEdited: false,
    stale: false,
    ...over,
  });

  await test('lists a derived skill with its source plugin and generated-from version', () => {
    expect(getDerivedSkillRows([derived()] as any, new Map())).toEqual([{
      pluginId: 'tasks',
      skillName: 'plugin-tasks',
      versionLabel: 'Generated from v1.0',
      badges: [],
      failureReason: null,
      offered: true,
    }]);
  });

  await test('marks a stale derived skill and names the version it drifted to', () => {
    const [row] = getDerivedSkillRows(
      [derived({ stale: true, installedVersion: '2.0' })] as any, new Map(),
    );

    expect({ badges: row.badges, versionLabel: row.versionLabel }).toEqual({
      badges: ['Stale'],
      versionLabel: 'Generated from v1.0 · plugin now v2.0',
    });
  });

  await test('marks a hand-edited derived skill', () => {
    const [row] = getDerivedSkillRows([derived({ handEdited: true })] as any, new Map());

    expect(row.badges).toEqual(['Edited by you']);
  });

  // 两者同时为真是最要紧的情形：源头动了，而用户在文件里有活儿。
  await test('marks a skill that is both stale and hand-edited', () => {
    const [row] = getDerivedSkillRows(
      [derived({ stale: true, handEdited: true, installedVersion: '2.0' })] as any, new Map(),
    );

    expect(row.badges).toEqual(['Stale', 'Edited by you']);
  });

  await test('marks a withdrawn derived skill as not offered', () => {
    const [row] = getDerivedSkillRows(
      [derived({ offered: false, status: 'withdrawn-missing' })] as any, new Map(),
    );

    expect({ badges: row.badges, offered: row.offered }).toEqual({
      badges: ['Not offered'],
      offered: false,
    });
  });

  await test('reports an unknown generated-from version rather than inventing one', () => {
    const [row] = getDerivedSkillRows(
      [derived({ recordedVersion: null, handEdited: null })] as any, new Map(),
    );

    expect(row.versionLabel).toEqual('Generated from an unknown version');
  });

  await test('surfaces the last generation failure for a plugin', () => {
    const [row] = getDerivedSkillRows(
      [derived()] as any, new Map([['tasks', 'quota exceeded']]),
    );

    expect(row.failureReason).toEqual('quota exceeded');
  });

  await test('an empty derived skill list yields no rows', () => {
    expect(getDerivedSkillRows([], new Map())).toEqual([]);
  });

  // ── 显式重新生成的结局提示 ──
  // 三种结局必须各说各的：没做、试了没成、成了。把中间那种说成成功就是假成功提示。

  // 被拒时必须点明是哪一项不满足。笼统列举全部前置条件会指向与本次无关的事:
  // 关掉自动生成开关后点重新生成,却被告知去授权、配模型、检查插件启用状态。
  await test('a refused regeneration names the one thing to change', () => {
    const messages = ([
      'auto-generate-off', 'plugin-control-off', 'model-not-ready',
      'source-missing', 'source-excluded',
    ] as const).map(blocker => getRegenerateOutcomeMessage('tasks', { blocker }));

    // 每种成因给出不同的一句话,且都不读成成功。
    expect(new Set(messages).size).toEqual(5);
    expect(messages.every(m => /cannot regenerate/i.test(m))).toEqual(true);
    expect(messages.some(m => /^regenerated the skill/i.test(m))).toEqual(false);
  });

  await test('a refused regeneration points at the exclude list when that is the cause', () => {
    const message = getRegenerateOutcomeMessage('tasks', { blocker: 'source-excluded' });

    expect(message.includes('exclude list')).toEqual(true);
  });

  await test('a failed regeneration names the plugin and the reason', () => {
    const message = getRegenerateOutcomeMessage(
      'tasks', { regenerated: false, failureReason: 'quota exceeded' },
    );

    expect({
      names: message.includes('tasks'),
      reason: message.includes('quota exceeded'),
      // 不能读成成功——设置页此前正是在这里撒谎。
      readsAsSuccess: /^regenerated the skill/i.test(message),
    }).toEqual({ names: true, reason: true, readsAsSuccess: false });
  });

  await test('a failed regeneration without a reason still does not read as success', () => {
    const message = getRegenerateOutcomeMessage(
      'tasks', { regenerated: false, failureReason: null },
    );

    expect(/^regenerated the skill/i.test(message)).toEqual(false);
  });

  // 失败原因来自 provider 的异常消息,是任意外部文本。$& / $' 在 replace 的替换位
  // 有特殊语义,直接拼进去会把文案吃掉——用户就看不到真正的原因了。
  await test('a failure reason containing replacement patterns survives intact', () => {
    const message = getRegenerateOutcomeMessage(
      'tasks', { regenerated: false, failureReason: 'bad $& and $\' token' },
    );

    expect(message.includes('bad $& and $\' token')).toEqual(true);
  });

  await test('a successful regeneration reads as unqualified success', () => {
    const message = getRegenerateOutcomeMessage(
      'tasks', { regenerated: true, failureReason: null },
    );

    expect(message).toEqual('Regenerated the skill for tasks.');
  });
}

runTests();

