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

  await test('gemini config declares image and thinking support', async () => {
    expect(getProviderCapabilities({ type: 'gemini' } as any)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    });
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

  await test('missing config falls back to gemini capabilities', async () => {
    expect(getProviderCapabilities(undefined)).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
