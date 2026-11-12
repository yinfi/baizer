/**
 * test/pi-native-model.test.ts
 *
 * 纯构造断言，零网络依赖。验证 buildOpenAICompatModel / buildAnthropicModel /
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

function makeAnthropicConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'anthropic',
    label: 'Anthropic',
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

// ---- 测试套件 ----

async function runTests() {
  console.log('=== Pi Native Model Tests ===');

  const {
    buildOpenAICompatModel,
    buildAnthropicModel,
    supportsAdaptiveThinking,
    isOpenCodeGoBaseUrl,
    buildOpenCodeGoHeaders,
  } = await import('../src/runtime/pi/pi-native-model');

  // (a) OpenAI-compatible Model 字段正确性
  await test('buildOpenAICompatModel: id / name 取自 config.model', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig({ model: 'gpt-4o-mini' }), undefined, undefined);
    expect(model.id).toBe('gpt-4o-mini');
    expect(model.name).toBe('gpt-4o-mini');
  });

  await test('buildOpenAICompatModel: input 包含 text 和 image', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.input).toEqual(['text', 'image']);
  });

  await test('buildOpenAICompatModel: cost 全为 0', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  // (b) OpenAI-compatible Model 字段正确性
  await test('buildOpenAICompatModel: api / provider 字段正确', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.api).toBe('openai-completions');
    expect(model.provider).toBe('openai');
  });

  await test('buildOpenAICompatModel: apiFlavor 缺省 → api=openai-completions', () => {
    // 不设 apiFlavor（现有 4 个内置 provider 的形态）应保持 completions，确保零回归
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
    expect(model.api).toBe('openai-completions');
  });

  await test("buildOpenAICompatModel: apiFlavor='completions' → api=openai-completions", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig({ apiFlavor: 'completions' }), 100000, 'medium');
    expect(model.api).toBe('openai-completions');
  });

  await test("buildOpenAICompatModel: apiFlavor='responses' → api=openai-responses", () => {
    // cch 这类只认 /responses 的后端：apiFlavor='responses' 时必须路由到 pi 的 responses provider
    const model = buildOpenAICompatModel(makeOpenAIConfig({ apiFlavor: 'responses' }), 100000, 'medium');
    expect(model.api).toBe('openai-responses');
    expect(model.provider).toBe('openai');
  });

  await test("buildOpenAICompatModel: apiFlavor='responses' 保留 baseUrl 与 thinking 映射", () => {
    const model = buildOpenAICompatModel(
      makeOpenAIConfig({ apiFlavor: 'responses', baseUrl: 'https://cch.example.com/v1' }),
      100000,
      'high',
    );
    expect(model.baseUrl).toBe('https://cch.example.com/v1');
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap!.high).toBe('high');
  });

  await test('buildOpenAICompatModel: 自定义 baseUrl 生效', () => {
    const model = buildOpenAICompatModel(
      makeOpenAIConfig({ baseUrl: 'https://api.deepseek.com' }),
      100000,
      'medium',
    );
    expect(model.baseUrl).toBe('https://api.deepseek.com');
  });

  await test('OpenCode Go endpoint gets a trimmed session header only', () => {
    expect(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(isOpenCodeGoBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(buildOpenCodeGoHeaders('https://opencode.ai/zen/go/v1', '  session-1  ')).toEqual({
      'x-opencode-session': 'session-1',
    });
    expect(buildOpenCodeGoHeaders('https://api.openai.com/v1', 'session-1')).toBeUndefined();
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
  // 两种存活协议共用同一条判据（thinkingLevel !== 'off'），故每个档位在
  // OpenAI-compatible 上验一遍；Anthropic 侧由 (f) 的 off/medium/undefined 覆盖。
  await test("thinkingLevel='off' → reasoning=false（OpenAI-compat）", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'off');
    expect(model.reasoning).toBe(false);
  });

  await test("thinkingLevel='minimal' → reasoning=true（OpenAI-compat）", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'minimal');
    expect(model.reasoning).toBe(true);
  });

  await test("thinkingLevel='low' → reasoning=true（OpenAI-compat）", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'low');
    expect(model.reasoning).toBe(true);
  });

  await test("thinkingLevel='medium' → reasoning=true（OpenAI-compat）", () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), 100000, 'medium');
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
    const openai = buildOpenAICompatModel(makeOpenAIConfig(), 100000, undefined);
    const anthropic = buildAnthropicModel(makeAnthropicConfig(), 100000, undefined);
    expect(openai.reasoning).toBe(true);
    expect(anthropic.reasoning).toBe(true);
  });

  // (d) contextWindow 缺省回落
  await test('contextWindow=undefined → 回落到 100000（OpenAI-compat）', () => {
    const model = buildOpenAICompatModel(makeOpenAIConfig(), undefined, 'medium');
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

  // (e) resolveCustomHeaders：opencode.ai Go 网关等要求自定义 header 的端点
  const { resolveCustomHeaders } = await import('../src/runtime/pi/pi-native-model');

  await test('resolveCustomHeaders: customHeaders=undefined → 返回 undefined', () => {
    expect(resolveCustomHeaders(undefined, 'conv-1')).toBeUndefined();
  });

  await test('resolveCustomHeaders: 无占位符的固定 header 原样透传', () => {
    const result = resolveCustomHeaders({ 'x-api-version': '2024-01' }, 'conv-1');
    expect(result).toEqual({ 'x-api-version': '2024-01' });
  });

  await test('resolveCustomHeaders: {{conversationId}} 替换为当前会话 ID（opencode.ai Go 场景）', () => {
    const result = resolveCustomHeaders({ 'x-opencode-session': '{{conversationId}}' }, 'conv-abc-123');
    expect(result).toEqual({ 'x-opencode-session': 'conv-abc-123' });
  });

  await test('resolveCustomHeaders: 占位符嵌在固定前缀中也能替换', () => {
    const result = resolveCustomHeaders({ 'x-session': 'ses_{{conversationId}}' }, 'abc');
    expect(result).toEqual({ 'x-session': 'ses_abc' });
  });

  await test('resolveCustomHeaders: 无 conversationId 时跳过含占位符的 header', () => {
    const result = resolveCustomHeaders({ 'x-opencode-session': '{{conversationId}}' }, undefined);
    expect(result).toBeUndefined();
  });

  await test('resolveCustomHeaders: 无 conversationId 时固定 header 仍保留，仅跳过占位符 header', () => {
    const result = resolveCustomHeaders(
      { 'x-opencode-session': '{{conversationId}}', 'x-api-version': '2024-01' },
      undefined,
    );
    expect(result).toEqual({ 'x-api-version': '2024-01' });
  });

  // (f) Anthropic Messages：buildAnthropicModel
  // （构造器与 makeAnthropicConfig 已在文件上方取好，供 (c) 的 undefined 档共用。）

  await test('buildAnthropicModel: api / provider / baseUrl 字段正确', () => {
    const model = buildAnthropicModel(makeAnthropicConfig(), 100000, 'medium');
    expect(model.api).toBe('anthropic-messages');
    expect(model.provider).toBe('anthropic');
    expect(model.baseUrl).toBe('https://api.anthropic.com');
  });

  await test('buildAnthropicModel: baseUrl 缺省/纯空白回落到官方端点，且不带 /v1', () => {
    // pi 的 SDK 自己拼 /v1/messages；baseUrl 若已含 /v1 会变成 /v1/v1/messages
    expect(buildAnthropicModel(makeAnthropicConfig({ baseUrl: '' }), 100000, 'medium').baseUrl)
      .toBe('https://api.anthropic.com');
    expect(buildAnthropicModel(makeAnthropicConfig({ baseUrl: '   ' }), 100000, 'medium').baseUrl)
      .toBe('https://api.anthropic.com');
  });

  await test('buildAnthropicModel: 自定义 baseUrl 去掉首尾空白后保留', () => {
    const model = buildAnthropicModel(makeAnthropicConfig({ baseUrl: ' https://gw.example.com ' }), 100000, 'medium');
    expect(model.baseUrl).toBe('https://gw.example.com');
  });

  await test('buildAnthropicModel: id / name 取自 config.model', () => {
    const model = buildAnthropicModel(makeAnthropicConfig({ model: 'claude-opus-4-5' }), 100000, 'medium');
    expect(model.id).toBe('claude-opus-4-5');
    expect(model.name).toBe('claude-opus-4-5');
  });

  await test('buildAnthropicModel: input 支持 text + image，成本字段全 0', () => {
    const model = buildAnthropicModel(makeAnthropicConfig(), 100000, 'medium');
    expect(model.input).toEqual(['text', 'image']);
    expect(model.cost.input).toBe(0);
    expect(model.cost.output).toBe(0);
    expect(model.cost.cacheRead).toBe(0);
    expect(model.cost.cacheWrite).toBe(0);
  });

  await test('buildAnthropicModel: thinkingLevelMap 的值是 Anthropic effort 档位', () => {
    const m = buildAnthropicModel(makeAnthropicConfig(), 100000, 'medium').thinkingLevelMap!;
    expect(m.off).toBe(null);
    expect(m.minimal).toBe('low');
    expect(m.low).toBe('low');
    expect(m.medium).toBe('medium');
    expect(m.high).toBe('high');
    expect(m.xhigh).toBe('xhigh');
  });

  await test('buildAnthropicModel: maxTokens 固定 8192（跨任意兼容网关的安全值）', () => {
    expect(buildAnthropicModel(makeAnthropicConfig(), 100000, 'medium').maxTokens).toBe(8192);
  });

  await test('buildAnthropicModel: contextWindow 缺省回落 100000，传入值优先', () => {
    expect(buildAnthropicModel(makeAnthropicConfig(), undefined, 'medium').contextWindow).toBe(100000);
    expect(buildAnthropicModel(makeAnthropicConfig(), 0, 'medium').contextWindow).toBe(100000);
    expect(buildAnthropicModel(makeAnthropicConfig(), 200000, 'medium').contextWindow).toBe(200000);
  });

  await test("buildAnthropicModel: thinkingLevel='off' → reasoning=false，其余为 true", () => {
    expect(buildAnthropicModel(makeAnthropicConfig(), 100000, 'off').reasoning).toBe(false);
    expect(buildAnthropicModel(makeAnthropicConfig(), 100000, 'medium').reasoning).toBe(true);
    expect(buildAnthropicModel(makeAnthropicConfig(), 100000, undefined).reasoning).toBe(true);
  });

  await test('buildAnthropicModel: 仅 adaptive 家族带 compat.forceAdaptiveThinking', () => {
    // budget_tokens 家族不加 compat：pi 走 thinking:{type:'enabled', budget_tokens}
    const budget = buildAnthropicModel(makeAnthropicConfig({ model: 'claude-sonnet-4-5' }), 100000, 'medium');
    expect(budget.compat).toBeUndefined();
    // adaptive 家族：pi 走 thinking:{type:'adaptive'} + output_config.effort
    const adaptive = buildAnthropicModel(makeAnthropicConfig({ model: 'claude-sonnet-5' }), 100000, 'medium');
    expect((adaptive.compat as any)?.forceAdaptiveThinking).toBe(true);
  });

  await test('supportsAdaptiveThinking: 命中 adaptive 家族', () => {
    expect(supportsAdaptiveThinking('claude-fable-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-haiku-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
  });

  await test('supportsAdaptiveThinking: 网关前缀 / 大小写 / 空白都能识别', () => {
    expect(supportsAdaptiveThinking('anthropic/claude-sonnet-5')).toBe(true);
    expect(supportsAdaptiveThinking('CLAUDE-SONNET-5')).toBe(true);
    expect(supportsAdaptiveThinking('openrouter:claude-opus-5')).toBe(true);
    expect(supportsAdaptiveThinking('  claude-sonnet-5  ')).toBe(true);
  });

  await test('supportsAdaptiveThinking: 不误伤 budget_tokens 家族与空值', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
    expect(supportsAdaptiveThinking('claude-opus-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('gpt-4o')).toBe(false);
    expect(supportsAdaptiveThinking('deepseek-chat')).toBe(false);
    expect(supportsAdaptiveThinking(undefined)).toBe(false);
    expect(supportsAdaptiveThinking('')).toBe(false);
  });

}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
