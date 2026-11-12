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

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Provider Capability Tests ===');
  // 迁移后能力声明由 model-catalog-service 按 ProviderConfig.type 静态返回，
  // 不再来自已删除的 GeminiProvider/OpenAIProvider 实例。
  const { getProviderCapabilities } = await import('../src/services/model-catalog-service');

  await test('an unknown/removed provider type falls back to the documented defaults', async () => {
    // 兜底分支的取值刻意沿用移除 'gemini' 之前的形态（见 model-catalog-service.ts）：
    // 它服务的场景是「配置读不出来」，不是「还有第三种协议」。故这里连历史上
    // 的 'gemini' 字面量一起钉住 —— 磁盘上的旧 data.json 仍可能带着它。
    const fallback = {
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    };
    expect(getProviderCapabilities({ type: 'gemini' } as any)).toEqual(fallback);
    expect(getProviderCapabilities({ type: 'something-unknown' } as any)).toEqual(fallback);
  });

  await test('openai-compatible config declares custom base url support', async () => {
    expect(getProviderCapabilities({ type: 'openai-compatible' } as any)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: false,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    });
  });

  await test('missing config falls back to the documented defaults', async () => {
    expect(getProviderCapabilities(undefined)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    });
  });

  // Anthropic Messages：原生协议支持 thinking / 图像 content block / tool_use，
  // 且用户可指向任意兼容网关（故 supportsCustomBaseUrl 为 true）。
  await test('anthropic config declares full native Messages capabilities', async () => {
    expect(getProviderCapabilities({ type: 'anthropic' } as any)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    });
  });

  await test('anthropic capabilities do not depend on apiKey/baseUrl being filled in', async () => {
    expect(getProviderCapabilities({ type: 'anthropic', apiKey: '', baseUrl: '' } as any)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
