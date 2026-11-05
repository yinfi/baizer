/**
 * test/main-lint-cleanup.test.ts
 *
 * issue #67「清理 main.ts 的 lint 警告」的行为回归测试。
 *
 * main.ts 顶层 import 了 7 个走 esbuild text loader 的 SKILL.md，tsx 在测试
 * 环境里无法解析（见 settings-provider-migration.test.ts 的说明），所以这里沿用
 * 仓库既有做法：
 *   - 能抽成纯函数的逻辑（旧扁平设置迁移、错误信息提取、收件箱链接匹配）直接
 *     测纯函数；
 *   - 只存在于 main.ts 的接线（事件签名、catch 写法、正则字面量）用源码结构断言
 *     锁定，防止清掉告警后又从别处长回来。
 *
 * 覆盖的行为：
 *   1. 剪贴板 catch：Error / 非 Error 抛出值 / 空 message 的展示文案。
 *   2. 旧扁平设置（providers map 之前）迁移：字段映射、默认值、不再迁移 Google
 *      凭证、以及迁移后 activeProvider 修复。
 *   3. wikilink / Markdown link / 裸 URL 的识别，以及 URL 尾随右括号不再被吞。
 *   4. 10 条告警对应的 any / 未使用变量 / 无必要转义写法已从 main.ts 消失。
 *
 * 运行：npx tsx --tsconfig tsconfig.test.json test/main-lint-cleanup.test.ts
 */

import { readFileSync } from 'fs';
import { getErrorMessage } from '../src/utils/error-message';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  LegacyFlatSettings,
  buildProvidersFromLegacySettings,
  mergeProviderDefaults,
  pruneUnsupportedProviders,
} from '../src/mcp/types';
import { extractRawUrlMatches } from '../src/services/inbox-autosave';

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

/**
 * 按 main.ts loadSettings 的顺序重放迁移 + providers 流水线。
 * 迁移字段映射本身来自 src/mcp/types（与 main.ts 共用同一份纯函数）；
 * 这里的顺序必须与 main.ts 一致：迁移 → deletedProviderIds 归一 →
 * mergeProviderDefaults → prune → 修 activeProvider。
 */
function loadSettingsLikePlugin(raw: Record<string, unknown>) {
  const settings: any = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(JSON.stringify(raw)));

  const legacy = raw as LegacyFlatSettings;
  if (!raw.providers && legacy.provider) {
    const migrated = buildProvidersFromLegacySettings(legacy);
    settings.activeProvider = migrated.activeProvider;
    settings.providers = migrated.providers;
  }

  settings.deletedProviderIds = Array.isArray(settings.deletedProviderIds)
    ? settings.deletedProviderIds
    : [];

  settings.providers = mergeProviderDefaults(settings.providers, settings.deletedProviderIds);
  settings.providers = pruneUnsupportedProviders(settings.providers);

  if (!settings.providers[settings.activeProvider]) {
    settings.activeProvider = Object.keys(settings.providers)[0] || DEFAULT_SETTINGS.activeProvider;
  }

  return settings;
}

async function runTests() {
  console.log('=== main.ts lint cleanup regression tests ===');

  // ── 1. 剪贴板异常信息（对应 main.ts:203-204）──

  await test('getErrorMessage shows Error.message', () => {
    expect(getErrorMessage(new Error('clipboard unavailable'))).toBe('clipboard unavailable');
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  await test('getErrorMessage keeps non-Error values that carry a message', () => {
    // 旧代码是 e?.message：字符串/普通对象抛出值只要带 truthy message 就显示。
    expect(getErrorMessage({ message: 'plain object error' })).toBe('plain object error');
    expect(getErrorMessage({ message: 42 })).toBe('42');
    expect(getErrorMessage(new Error(''))).toBe('unknown error');
  });

  await test('getErrorMessage falls back to "unknown error" like e?.message did', () => {
    expect(getErrorMessage('thrown string')).toBe('unknown error');
    expect(getErrorMessage(42)).toBe('unknown error');
    expect(getErrorMessage(null)).toBe('unknown error');
    expect(getErrorMessage(undefined)).toBe('unknown error');
    expect(getErrorMessage({ message: '' })).toBe('unknown error');
    expect(getErrorMessage({ message: 0 })).toBe('unknown error');
    expect(getErrorMessage('x', 'fallback text')).toBe('fallback text');
  });

  // ── 2. 旧扁平设置迁移（对应 main.ts:328-329）──

  await test('legacy flat settings map every old provider field with the old defaults', () => {
    const legacy: LegacyFlatSettings = {
      provider: 'deepseek',
      openaiApiKey: 'sk-openai',
      openaiBaseUrl: 'https://proxy.example.com/v1',
      openaiModel: 'gpt-4.1',
      deepseekApiKey: 'sk-deepseek',
      // baseUrl / model 缺失 → 沿用旧默认值
      qwenApiKey: 'sk-qwen',
    };

    const migrated = buildProvidersFromLegacySettings(legacy);

    expect(migrated.activeProvider).toBe('deepseek');
    expect(Object.keys(migrated.providers)).toEqual(['openai', 'deepseek', 'qwen']);
    expect(migrated.providers.openai).toEqual({
      type: 'openai-compatible',
      label: 'OpenAI',
      apiKey: 'sk-openai',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'gpt-4.1',
    });
    expect(migrated.providers.deepseek).toEqual({
      type: 'openai-compatible',
      label: 'DeepSeek',
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    expect(migrated.providers.qwen).toEqual({
      type: 'openai-compatible',
      label: 'Qwen',
      apiKey: 'sk-qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-turbo',
    });
  });

  await test('missing legacy keys become empty apiKeys, and a missing provider falls back to openai', () => {
    const migrated = buildProvidersFromLegacySettings({});

    expect(migrated.activeProvider).toBe('openai');
    expect(migrated.providers.openai.apiKey).toBe('');
    expect(migrated.providers.deepseek.apiKey).toBe('');
    expect(migrated.providers.qwen.apiKey).toBe('');
  });

  await test('the removed Google credentials are never migrated into an openai-compatible entry', () => {
    // 历史 data.json 里可能同时存在旧 Google 的 apiKey / primaryModel，迁移分支
    // 不再读取它们：否则会造出「看着配好了、实际必然失败」的 provider。
    const legacy = {
      provider: 'gemini',
      apiKey: 'google-key',
      primaryModel: 'gemini-2.5-flash',
      openaiApiKey: 'sk-openai',
    } as LegacyFlatSettings & Record<string, unknown>;

    const migrated = buildProvidersFromLegacySettings(legacy);
    const serialized = JSON.stringify(migrated.providers);

    expect(migrated.activeProvider).toBe('gemini');
    expect(serialized.includes('google-key')).toBeFalsy();
    expect(serialized.includes('gemini-2.5-flash')).toBeFalsy();
    expect(migrated.providers.openai.apiKey).toBe('sk-openai');
  });

  await test('after migration the activeProvider repair moves a removed gemini selection to a live provider', () => {
    const settings = loadSettingsLikePlugin({
      provider: 'gemini',
      openaiApiKey: 'sk-old',
    });

    // 迁移结果覆盖为三家 openai-compatible；merge 补上 anthropic 默认项；
    // 被移除的 'gemini' 不在 map 里，于是修复到第一个存在的 provider。
    expect(Object.keys(settings.providers)).toEqual(['openai', 'deepseek', 'qwen', 'anthropic']);
    expect(settings.providers.gemini).toBe(undefined);
    expect(settings.activeProvider).toBe('openai');
    expect(settings.providers.openai.apiKey).toBe('sk-old');
  });

  await test('a persisted providers map is not treated as legacy flat settings', () => {
    const settings = loadSettingsLikePlugin({
      activeProvider: 'anthropic',
      provider: 'gemini',
      providers: {
        anthropic: {
          type: 'anthropic',
          label: 'Anthropic',
          apiKey: 'k',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
        },
      },
    });

    // 有 providers 时迁移分支不触发：旧扁平字段 provider / openaiApiKey 被忽略，
    // anthropic 条目原样保留，不会被覆盖成迁移出来的三家。
    expect(settings.providers.anthropic.apiKey).toBe('k');
    expect(settings.providers.openai).toEqual(DEFAULT_PROVIDERS.openai);
    expect(settings.activeProvider).toBe('anthropic');
  });

  // ── 3. 收件箱链接正则（对应 main.ts:453）──

  await test('wikilinks and Markdown links are not treated as raw URLs', () => {
    const matches = extractRawUrlMatches('[[Saved note]] [Read later](https://b.com/path)');
    expect(matches).toEqual([]);
  });

  await test('a raw URL stops before its trailing close paren', () => {
    const content = 'see (https://a.com/x) and https://b.com/plain';
    const matches = extractRawUrlMatches(content);

    expect(matches.map((m: any) => m.url)).toEqual(['https://a.com/x', 'https://b.com/plain']);
    // 索引与长度仍指向原始文本里被替换的 [start, start+length) 区间。
    expect(matches[0]).toEqual({ url: 'https://a.com/x', index: content.indexOf('https://a.com/x'), length: 'https://a.com/x'.length });
    expect(matches[0].index + matches[0].length).toBe(content.indexOf(')'));
  });

  await test('raw URL recognition keeps the pre-fix behaviour inside the char class', () => {
    // 仅去掉字符类里多余的转义：除空白与右括号外，其它字符（逗号、左括号、
    // 查询串）仍属于 URL —— 与改动前的匹配结果一致（改动前 `\)` 与 `)` 等价）。
    expect(extractRawUrlMatches('https://a.com/x_(y').map((m: any) => m.url)).toEqual([
      'https://a.com/x_(y',
    ]);
    expect(extractRawUrlMatches('https://a.com/x,tail').map((m: any) => m.url)).toEqual([
      'https://a.com/x,tail',
    ]);
  });

  // ── 4. main.ts 源码结构：10 条告警对应的写法不再出现 ──

  const mainSource = readFileSync('main.ts', 'utf8');

  await test('the editor-change plumbing uses Obsidian types instead of any', () => {
    expect(mainSource.includes('private onEditorChange = (editor: any, info: any)')).toBeFalsy();
    expect(mainSource.includes('private queueGuardianCheck(editor: any, info: any)')).toBeFalsy();
    expect(
      mainSource.includes('private onEditorChange = (editor: Editor, info: EditorChangeInfo)'),
    ).toBeTruthy();
    expect(
      mainSource.includes('private queueGuardianCheck(editor: Editor, info: EditorChangeInfo)'),
    ).toBeTruthy();
  });

  await test('unused catch binding and ribbon event parameter are gone', () => {
    // 注册 view 的 catch 不再绑定异常；ribbon 回调不再声明未使用的 evt。
    expect(mainSource.includes('} catch (e) {\n            // hot reload')).toBeFalsy();
    expect(mainSource.includes('} catch {\n            // hot reload')).toBeTruthy();
    expect(mainSource.includes('(evt: MouseEvent)')).toBeFalsy();
  });

  await test('the clipboard catch narrows unknown instead of asserting any', () => {
    expect(mainSource.includes('catch (e: any)')).toBeFalsy();
    expect(mainSource.includes('getErrorMessage(e)')).toBeTruthy();
  });

  await test('legacy settings migration reads unknown JSON through LegacyFlatSettings', () => {
    expect(mainSource.includes('const raw: Record<string, unknown> = await this.loadData()')).toBeTruthy();
    expect(mainSource.includes('const legacy = raw as LegacyFlatSettings')).toBeTruthy();
    expect(mainSource.includes('buildProvidersFromLegacySettings(legacy)')).toBeTruthy();
    expect(mainSource.includes('(raw as any)')).toBeFalsy();
    expect(mainSource.includes('const old = raw as any')).toBeFalsy();
  });

  await test('the inbox URL regex has no needless escape in its char class', () => {
    expect(mainSource.includes('(https?:\\/\\/[^\\s)]+)')).toBeTruthy();
    expect(mainSource.includes('[^\\s\\)]')).toBeFalsy();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
