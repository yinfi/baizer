import { DEFAULT_SETTINGS, PluginSettings } from '../src/mcp/types';
import {
  getConnectionTestStatusPresentation,
  getProviderDeletionState,
  getSettingsSectionStatuses,
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

  await test('marks permissions as risky when plugin control is enabled', () => {
    const settings = cloneSettings();
    settings.allowPluginControl = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.permissions).toEqual({ label: 'Risk', tone: 'danger' });
  });

  await test('disables provider deletion for built-in providers with an explicit reason', () => {
    const settings = cloneSettings();
    settings.activeProvider = 'deepseek';

    const deletion = getProviderDeletionState(settings);

    expect(deletion).toEqual({
      canDelete: false,
      helperText: 'Built-in providers cannot be deleted.',
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
      helperText: 'Remove the selected custom provider from this workspace.',
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
}

runTests();
