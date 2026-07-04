/**
 * test/pi-native-model.test.ts
 *
 * 纯构造断言，零网络依赖。验证 buildGeminiModel / buildOpenAICompatModel /
 * createNativeStreamFn 的字段正确性。
 *
 * 运行：npx tsx --tsconfig tsconfig.test.json test/pi-native-model.test.ts
 */

import type { ProviderConfig } from '../src/mcp/types';

// ---- 最小 expect / test 工具（与项目其他测试文件风格一致） ----

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy but got ${JSON.stringify(actual)}`);
    },
    toBeFalsy: () => {
      if (actual) throw new Error(`Expected falsy but got ${JSON.stringify(actual)}`);
    },
    toBeUndefined: () => {
      if (actual !== undefined) throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
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

// ---- 公共 fixture ----

function makeGeminiConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'gemini',
    label: 'Google Gemini',
    apiKey: 'test-api-key',
    baseUrl: '',
    model: 'gemini-2.5-flash',
    ...overrides,
  };
}

function makeOpenAIConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'openai-compatible',
    label: 'OpenAI',
    apiKey: 'test-openai-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  };
}

// ---- 测试套件 ----

async function runTests() {
  console.log('=== Pi Native Model Tests ===');

  const { buildGeminiModel, buildOpenAICompatModel } =
    await import('../src/runtime/pi/pi-native-model');

  // (a) Gemini Model 字段正确性
  await test('buildGeminiModel: api / provider / baseUrl 字段正确', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'medium');
    expect(model.api).toBe('google-generative-ai');
    expect(model.provider).toBe('google');
    expect(model.baseUrl).toBe('https://generativelanguage.googleapis.com');
  });

  await test('buildGeminiModel: id / name 取自 config.model', () => {
    const model = buildGeminiModel(makeGeminiConfig({ model: 'gemini-2.5-pro' }), undefined, undefined);
    expect(model.id).toBe('gemini-2.5-pro');
    expect(model.name).toBe('gemini-2.5-pro');
  });

  await test('buildGeminiModel: contextWindow 使用传入值', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 200000, 'medium');
    expect(model.contextWindow).toBe(200000);
  });

  await test('buildGeminiModel: reasoning=true 当 thinkingLevel=medium', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'medium');
    expect(model.reasoning).toBe(true);
  });

  await test('buildGeminiModel: input 包含 text 和 image', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'medium');
    expect(model.input).toEqual(['text', 'image']);
  });

  await test('buildGeminiModel: cost 全为 0', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'medium');
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  await test('buildGeminiModel: thinkingLevelMap 未设置（undefined）', () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'medium');
    // Gemini 不显式设置 thinkingLevelMap，让 pi google provider 用内置默认值
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  // (b) OpenAI-compatible Model 字段正确性
  await test('buildOpenAICompatModel: api / provider 字段正确', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.api).toBe('openai-completions');
    expect(model.provider).toBe('openai');
  });

  await test('buildOpenAICompatModel: 自定义 baseUrl 生效', () => {
    const model = buildOpenAICompatModel(
      makeOpenAIConfig({ baseUrl: 'https://api.deepseek.com' }),
      100000,
      'medium',
    );
    expect(model.baseUrl).toBe('https://api.deepseek.com');
  });

  await test('buildOpenAICompatModel: baseUrl 缺省回落到 https://api.openai.com', () => {
    const model = buildOpenAICompatModel(
      makeOpenAIConfig({ baseUrl: '' }),
      100000,
      'medium',
    );
    expect(model.baseUrl).toBe('https://api.openai.com');
  });

  await test('buildOpenAICompatModel: thinkingLevelMap 包含所有 6 档', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    const m = model.thinkingLevelMap!;
    expect(m.off).toBe(null);
    expect(m.minimal).toBe('low');
    expect(m.low).toBe('low');
    expect(m.medium).toBe('medium');
    expect(m.high).toBe('high');
    expect(m.xhigh).toBe('high');
  });

  await test('buildOpenAICompatModel: maxTokens 为 16384', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.maxTokens).toBe(16384);
  });

  // (c) thinkingLevel → reasoning 映射
  await test("thinkingLevel='off' → reasoning=false（Gemini）", () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'off');
    expect(model.reasoning).toBe(false);
  });

  await test("thinkingLevel='off' → reasoning=false（OpenAI-compat）", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'off');
    expect(model.reasoning).toBe(false);
  });

  await test("thinkingLevel='minimal' → reasoning=true", () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'minimal');
    expect(model.reasoning).toBe(true);
  });

  await test("thinkingLevel='low' → reasoning=true", () => {
    const model = buildGeminiModel(makeGeminiConfig(), 100000, 'low');
    expect(model.reasoning).toBe(true);
  });

  await test("thinkingLevel='high' → reasoning=true", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'high');
    expect(model.reasoning).toBe(true);
  });

  await test("thinkingLevel='xhigh' → reasoning=true", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'xhigh');
    expect(model.reasoning).toBe(true);
  });

  await test('thinkingLevel=undefined → reasoning=true（与 pi-provider-bridge 对齐）', () => {
    const gemini = buildGeminiModel(makeGeminiConfig(), 100000, undefined);
    const openai = buildOpenAICompatModel(makeOpenAIConfig(), 100000, undefined);
    expect(gemini.reasoning).toBe(true);
    expect(openai.reasoning).toBe(true);
  });

  // (d) contextWindow 缺省回落
  await test('contextWindow=undefined → 回落到 100000（Gemini）', () => {
    const model = buildGeminiModel(makeGeminiConfig(), undefined, 'medium');
    expect(model.contextWindow).toBe(100000);
  });

  await test('contextWindow=0 → 回落到 100000（OpenAI-compat）', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 0, 'medium');
    expect(model.contextWindow).toBe(100000);
  });

  await test('contextWindow=50000 → 使用传入值（OpenAI-compat）', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 50000, 'medium');
    expect(model.contextWindow).toBe(50000);
  });

}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
