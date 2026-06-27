// test/gemini-provider.test.ts
// GeminiProvider の startChat が thinkingConfig をモデル名でゲートしているかを検証する。
// SDK の HTTP 呼び出しはしない。getGenerativeModel に渡される引数だけを確認する。

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toBeUndefined: () => {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
      }
    },
    toBeDefined: () => {
      if (actual === undefined) {
        throw new Error('Expected value to be defined but got undefined');
      }
    },
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

/** startChat を呼び、getGenerativeModel に渡された config を捕捉して返す。 */
function captureGetGenerativeModel(provider: any, thinkingLevel?: string): any {
  let capturedConfig: any = 'NOT_CALLED';

  // genAI.getGenerativeModel をスパイに差し替える。
  // startChat が呼んだ引数を記録し、本物の代わりにフェイクモデルを返す。
  const fakeChat = {
    sendMessageStream: async function* () { yield { text: () => 'ok', functionCalls: () => undefined }; },
    getHistory: async () => [],
  };
  const fakeModel = {
    startChat: () => fakeChat,
  };

  const origGetGenerativeModel = provider['genAI'].getGenerativeModel.bind(provider['genAI']);
  provider['genAI'].getGenerativeModel = (config: any) => {
    capturedConfig = config;
    return fakeModel;
  };

  try {
    provider.startChat(undefined, undefined, thinkingLevel);
  } finally {
    provider['genAI'].getGenerativeModel = origGetGenerativeModel;
  }

  return capturedConfig;
}

async function runTests() {
  console.log('=== GeminiProvider thinkingConfig gate tests ===');

  const { GeminiProvider } = await import('../src/models/gemini');

  function makeProvider(modelName: string) {
    const provider = new GeminiProvider();
    // configure で genAI インスタンスが作られる。ダミーキーで十分。
    provider.configure({ apiKey: 'dummy-key', modelName } as any);
    return provider;
  }

  await test('gemini-2.5-flash + thinkingLevel medium → thinkingConfig present', () => {
    const provider = makeProvider('gemini-2.5-flash');
    const config = captureGetGenerativeModel(provider, 'medium');
    expect(config.generationConfig?.thinkingConfig?.thinkingBudget).toBe(4096);
    // includeThoughts が無いと thought part が一切返らず think タイムラインが空になる。
    expect(config.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
  });

  await test('gemini-2.0-flash + thinkingLevel off → thinkingBudget 0 (disable)', () => {
    const provider = makeProvider('gemini-2.0-flash');
    const config = captureGetGenerativeModel(provider, 'off');
    expect(config.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
    // off は思考自体を無効化するので thought サマリも要求しない。
    expect(config.generationConfig?.thinkingConfig?.includeThoughts).toBe(false);
  });

  await test('gemini-2.5-flash + thinkingLevel xhigh → thinkingBudget 16384', () => {
    const provider = makeProvider('gemini-2.5-flash');
    const config = captureGetGenerativeModel(provider, 'xhigh');
    expect(config.generationConfig?.thinkingConfig?.thinkingBudget).toBe(16384);
  });

  await test('gemini-1.5-pro + thinkingLevel medium → thinkingConfig NOT sent', () => {
    const provider = makeProvider('gemini-1.5-pro');
    const config = captureGetGenerativeModel(provider, 'medium');
    // 非 gemini-2 モデルには generationConfig ごと付与しない。
    expect(config.generationConfig).toBeUndefined();
  });

  await test('gemini-1.5-flash + thinkingLevel high → thinkingConfig NOT sent', () => {
    const provider = makeProvider('gemini-1.5-flash');
    const config = captureGetGenerativeModel(provider, 'high');
    expect(config.generationConfig).toBeUndefined();
  });

  await test('gemini-2.5-flash + thinkingLevel undefined → thinkingConfig NOT sent', () => {
    const provider = makeProvider('gemini-2.5-flash');
    const config = captureGetGenerativeModel(provider, undefined);
    // thinkingLevel が未指定のときは generationConfig を付与しない。
    expect(config.generationConfig).toBeUndefined();
  });

  await test('thinkingBudget map: minimal→512, low→1024, high→8192', () => {
    const cases: Array<[string, number]> = [
      ['minimal', 512],
      ['low', 1024],
      ['high', 8192],
    ];
    const provider = makeProvider('gemini-2.5-flash');
    for (const [level, expected] of cases) {
      const config = captureGetGenerativeModel(provider, level);
      const budget = config.generationConfig?.thinkingConfig?.thinkingBudget;
      if (budget !== expected) {
        throw new Error(`thinkingLevel '${level}': expected thinkingBudget ${expected} but got ${budget}`);
      }
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
