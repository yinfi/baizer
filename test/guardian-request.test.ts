function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
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
  console.log('=== Guardian Request Tests ===');
  const { requestGuardianResponse } = await import('../src/ui/guardian-request');

  await test('uses generate instead of chat and forwards the override system prompt', async () => {
    const calls: any[] = [];
    const modelService = {
      generate: async (prompt: string, systemPrompt?: string) => {
        calls.push({ prompt, systemPrompt });
        return '{"type":"none"}';
      },
      chat: async () => {
        throw new Error('guardian should not call chat');
      },
    } as any;

    const result = await requestGuardianResponse(
      modelService,
      'guardian prompt',
      'Return ONLY JSON.',
    );

    expect(result).toBe('{"type":"none"}');
    expect(calls).toEqual([{
      prompt: 'guardian prompt',
      systemPrompt: 'Return ONLY JSON.',
    }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
