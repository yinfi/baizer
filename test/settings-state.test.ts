import { DEFAULT_SETTINGS, PluginSettings, mergeProviderDefaults } from '../src/mcp/types';
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
} from '../src/settings';

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

    expect(statuses.connection).toEqual({ label: 'Custom', tone: 'accent' });
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

    expect(statuses.permissions).toEqual({ label: 'Risk', tone: 'danger' });
  });

  await test('marks permissions as risky when vault-wide writes are enabled', () => {
    const settings = cloneSettings();
    settings.vaultWriteScope = 'all-vault';
    settings.allowPluginControl = false;
    settings.confirmExecutions = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.permissions).toEqual({ label: 'Risk', tone: 'danger' });
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
      { label: '权限过宽', sectionId: 'permissions', tone: 'danger' },
      { label: 'Google Gemini 缺少 API Key', sectionId: 'connection', tone: 'warning' },
      { label: 'OpenAI 缺少 API Key', sectionId: 'connection', tone: 'warning' },
      { label: 'Qwen 缺少 API Key', sectionId: 'connection', tone: 'warning' },
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
}

runTests();

