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
      generate: async (...args: any[]) => {
        calls.push(args);
        return '{"type":"none"}';
      },
      chat: async () => {
        throw new Error('guardian should not call chat');
      },
    } as any;

    const result = await requestGuardianResponse(
      modelService,
      {
        prompt: 'guardian prompt',
        systemPromptOverride: 'Return ONLY JSON.',
        obsidianContext: {
          activeNote: { path: 'Daily/2026-05-13.md', title: '2026-05-13' },
        },
        userProfile: {
          preferences: {
            responseStyle: 'balanced',
          },
        },
      } as any,
    );

    expect(result).toBe('{"type":"none"}');
    expect(calls).toEqual([[
      'guardian prompt',
      'Return ONLY JSON.',
      'guardian',
      {
        activeNote: { path: 'Daily/2026-05-13.md', title: '2026-05-13' },
      },
      {
        preferences: {
          responseStyle: 'balanced',
        },
      },
    ]]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
