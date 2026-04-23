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
  const { GeminiProvider } = await import('../src/models/gemini');
  const { OpenAIProvider } = await import('../src/models/openai');

  await test('Gemini provider declares image and thinking support', async () => {
    const provider = new GeminiProvider();

    expect(provider.getCapabilities()).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    });
  });

  await test('OpenAI-compatible provider declares custom base url support', async () => {
    const provider = new OpenAIProvider();

    expect(provider.getCapabilities()).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: false,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
