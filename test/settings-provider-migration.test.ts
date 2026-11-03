/**
 * test/settings-provider-migration.test.ts
 *
 * 「移除 Gemini 协议」这条迁移的回归测试。
 *
 * 被测行为（main.ts loadSettings，见下方为什么它只能被间接测到）：
 *   1. 旧扁平格式（data.json 里没有 providers、只有 provider + 各家 xxxApiKey）
 *      不再合成 gemini 条目，也不再迁移 Google 凭证（old.apiKey / old.primaryModel）。
 *   2. providers map 里 type 已不受支持的条目（历史 'gemini'）在内存里被丢弃。
 *   3. activeProvider 若指向被丢弃的条目，修到仍存在的第一个 provider 上。
 *   4. 丢弃只发生在内存：不写回 data.json（降级回旧版本还能拿回配置），也没有 Notice。
 *   5. map key 叫 'my-gemini' 但 type 是 'openai-compatible' 的条目必须留下 ——
 *      判据是每个条目自己的 type，不是它的名字。
 *
 * 为什么不是直接 import main.ts 跑 loadSettings：main.ts 顶层 import 了 7 个
 * SKILL.md（走 esbuild 的 text loader，见 esbuild.config.mjs），tsx 在测试环境
 * 下无法解析这些 .md 导入。故这里用同一份纯函数按 loadSettings 的**同序**重放
 * 那条流水线，并对 main.ts 的源码顺序做结构性断言（防止有人把 prune 挪到
 * activeProvider 修复之后、或把它改回会落盘的写法）。
 *
 * 运行：npx tsx --tsconfig tsconfig.test.json test/settings-provider-migration.test.ts
 */

import { readFileSync } from 'fs';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  ProviderConfig,
  isSupportedProviderType,
  mergeProviderDefaults,
  pruneUnsupportedProviders,
} from '../src/mcp/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy but got ${JSON.stringify(actual)}`);
    },
    toBeFalsy: () => {
      if (actual) throw new Error(`Expected falsy but got ${JSON.stringify(actual)}`);
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

/** 一份「升级前」的 data.json：默认的 gemini 条目 + 一个改过 type 的自定义条目。 */
function persistedWithLegacyGemini(): Record<string, any> {
  return {
    activeProvider: 'gemini',
    providers: {
      gemini: {
        type: 'gemini',
        label: 'Google Gemini',
        apiKey: 'google-key-still-on-disk',
        baseUrl: '',
        model: 'gemini-2.5-flash',
      },
      deepseek: {
        type: 'openai-compatible',
        label: 'DeepSeek',
        apiKey: 'ds-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      },
    },
  };
}

/**
 * 按 main.ts loadSettings 的顺序重放 providers 流水线：
 *   Object.assign(DEFAULT_SETTINGS, raw) → deletedProviderIds 归一
 *   → mergeProviderDefaults → pruneUnsupportedProviders → 修 activeProvider
 * 步骤顺序本身就是被测行为的一部分（prune 必须在修复之前）。
 */
function loadSettingsLikePlugin(raw: Record<string, any>) {
  const settings: any = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(JSON.stringify(raw)));

  settings.deletedProviderIds = Array.isArray(settings.deletedProviderIds)
    ? settings.deletedProviderIds
    : [];

  settings.providers = mergeProviderDefaults(
    settings.providers,
    settings.deletedProviderIds,
  );

  settings.providers = pruneUnsupportedProviders(settings.providers);

  if (!settings.providers[settings.activeProvider]) {
    settings.activeProvider = Object.keys(settings.providers)[0] || DEFAULT_SETTINGS.activeProvider;
  }

  return settings;
}

async function runTests() {
  console.log('=== Settings Provider Migration Tests ===');

  // ── 1. 纯函数判据 ──

  await test('ProviderType 只承认 openai-compatible 与 anthropic', () => {
    expect(isSupportedProviderType('openai-compatible')).toBeTruthy();
    expect(isSupportedProviderType('anthropic')).toBeTruthy();
    // 已移除的协议与各种脏值都必须是 false（判据直接面对 data.json）。
    expect(isSupportedProviderType('gemini')).toBeFalsy();
    expect(isSupportedProviderType('google')).toBeFalsy();
    expect(isSupportedProviderType(undefined)).toBeFalsy();
    expect(isSupportedProviderType(null)).toBeFalsy();
    expect(isSupportedProviderType(42)).toBeFalsy();
  });

  await test('DEFAULT_PROVIDERS 里没有 gemini，出厂 activeProvider 指向存在的条目', () => {
    expect(Object.keys(DEFAULT_PROVIDERS)).toEqual(['openai', 'deepseek', 'qwen', 'anthropic']);
    expect(DEFAULT_SETTINGS.activeProvider).toBe('openai');
    expect(Boolean(DEFAULT_PROVIDERS[DEFAULT_SETTINGS.activeProvider])).toBeTruthy();
  });

  // ── 2. 持久化数据里的 type:'gemini' 条目 ──

  await test('a persisted gemini provider is dropped and activeProvider is repaired', () => {
    const settings = loadSettingsLikePlugin(persistedWithLegacyGemini());

    // 死条目消失，且不再以任何形式留在 providers 里。
    expect(settings.providers.gemini).toBe(undefined);
    expect(Object.keys(settings.providers).includes('gemini')).toBeFalsy();
    // 其它条目与补齐的默认项都还在。
    expect(Object.keys(settings.providers)).toEqual(['deepseek', 'openai', 'qwen', 'anthropic']);
    expect(settings.providers.deepseek.apiKey).toBe('ds-key');
    // activeProvider 必须指向真实存在的 provider（修复前它指向被丢弃的 'gemini'）。
    expect(settings.activeProvider).toBe('deepseek');
    expect(Boolean(settings.providers[settings.activeProvider])).toBeTruthy();
  });

  await test('every surviving provider entry has a supported type after loading', () => {
    const settings = loadSettingsLikePlugin(persistedWithLegacyGemini());

    for (const [id, config] of Object.entries(settings.providers as Record<string, ProviderConfig>)) {
      expect({
        id,
        supported: isSupportedProviderType(config.type),
      }).toEqual({ id, supported: true });
    }
  });

  await test('a null / type-less provider entry is dropped rather than crashing the load', () => {
    const settings = loadSettingsLikePlugin({
      activeProvider: 'broken',
      providers: {
        broken: null,
        typeless: { label: 'No type', apiKey: 'k', baseUrl: '', model: 'm' },
        ok: {
          type: 'anthropic',
          label: 'Anthropic',
          apiKey: 'k',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
        },
      },
    });

    expect(Object.keys(settings.providers).includes('broken')).toBeFalsy();
    expect(Object.keys(settings.providers).includes('typeless')).toBeFalsy();
    expect(settings.activeProvider).toBe('ok');
  });

  // ── 3. 判据是条目自己的 type，不是 map key ──

  await test('a provider merely NAMED like gemini survives when its type is supported', () => {
    const settings = loadSettingsLikePlugin({
      activeProvider: 'my-gemini',
      providers: {
        'my-gemini': {
          // 名字里带 gemini，但它说的是 OpenAI 兼容协议 —— 用户自己的网关。
          type: 'openai-compatible',
          label: 'My Gemini-compatible gateway',
          apiKey: 'sk-gw',
          baseUrl: 'https://gw.example.com/v1',
          model: 'gemini-2.5-flash',
        },
      },
    });

    expect(settings.providers['my-gemini'].apiKey).toBe('sk-gw');
    expect(settings.providers['my-gemini'].baseUrl).toBe('https://gw.example.com/v1');
    expect(settings.activeProvider).toBe('my-gemini');
  });

  // ── 4. 空 providers 的兜底 ──

  await test('an empty provider map falls back to the factory default instead of an undefined active provider', () => {
    const settings = loadSettingsLikePlugin({
      activeProvider: 'gemini',
      providers: {
        gemini: { type: 'gemini', label: 'Gemini', apiKey: 'k', baseUrl: '', model: 'gemini-2.5-flash' },
      },
      // 四个内置 provider 全被用户删过 → mergeProviderDefaults 不会把它们补回来，
      // 于是 prune 之后 providers 为空，只剩 DEFAULT_SETTINGS 那条兜底。
      deletedProviderIds: ['openai', 'deepseek', 'qwen', 'anthropic'],
    });

    expect(settings.providers).toEqual({});
    expect(settings.activeProvider).toBe(DEFAULT_SETTINGS.activeProvider);
  });

  // ── 5. main.ts 的结构性契约（顺序 + 不落盘 + 不迁移 Google 凭证）──
  // 这几条是「loadSettings 无法直接跑」的补偿：它们锁住上面重放的那条流水线
  // 与真实实现仍然同序同形。

  const mainSource = readFileSync('main.ts', 'utf8');

  await test('loadSettings prunes unsupported providers BEFORE repairing activeProvider', () => {
    const pruneAt = mainSource.indexOf('pruneUnsupportedProviders(this.settings.providers)');
    const repairAt = mainSource.indexOf(
      'this.settings.activeProvider = Object.keys(this.settings.providers)[0]',
    );

    expect(pruneAt >= 0).toBeTruthy();
    expect(repairAt >= 0).toBeTruthy();
    expect(pruneAt < repairAt).toBeTruthy();
  });

  await test('pruning stays in memory: nothing is persisted between prune and the activeProvider repair', () => {
    const pruneAt = mainSource.indexOf('pruneUnsupportedProviders(this.settings.providers)');
    const repairAt = mainSource.indexOf(
      'this.settings.activeProvider = Object.keys(this.settings.providers)[0]',
    );
    const between = mainSource.slice(pruneAt, repairAt);

    // 落盘会让降级回旧版本的用户永久丢掉被丢弃的配置；也意味着一次静默的数据迁移。
    expect(between.includes('saveData')).toBeFalsy();
    expect(between.includes('saveSettings')).toBeFalsy();
    // 不该有弹窗告知（用户没做错任何事，只是升级了）。
    expect(between.includes('Notice')).toBeFalsy();
  });

  await test('the legacy flat-format branch no longer synthesises a gemini entry nor migrates Google credentials', () => {
    const branchStart = mainSource.indexOf('if (!raw.providers');
    const branchEnd = mainSource.indexOf('// 确保 providers 中包含所有默认 provider', branchStart);

    expect(branchStart >= 0).toBeTruthy();
    expect(branchEnd > branchStart).toBeTruthy();

    const branch = mainSource.slice(branchStart, branchEnd);
    // 只看代码：这段分支的注释里仍会解释「旧格式的 provider 可能是已移除的 gemini」，
    // 那是说明为什么可以原样记下 activeProvider，不是迁移行为本身。
    const branchCode = branch
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');

    // 旧格式仍然迁移 OpenAI 兼容那几家的凭证……
    expect(branchCode.includes('old.openaiApiKey')).toBeTruthy();
    // ……但不再有 gemini 条目，也不再把 Google 的 key/model 塞进别的协议。
    expect(branchCode.toLowerCase().includes('gemini')).toBeFalsy();
    expect(branchCode.includes('old.apiKey')).toBeFalsy();
    expect(branchCode.includes('old.primaryModel')).toBeFalsy();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
