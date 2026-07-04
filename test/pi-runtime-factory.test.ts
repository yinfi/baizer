function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
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
  console.log('=== Pi Runtime Factory Tests ===');
  const {
    createChatRuntime,
  } = await import('../src/runtime/runtime-factory');

  const deps = {
    provider: {} as any,
    memoryManager: null,
    toolRegistry: {
      getAllDefinitions: () => [],
      execute: async () => ({}),
    } as any,
    skillRegistry: {
      resolveByIntent: () => null,
      getSkillSummaryText: () => '',
      activateSkill: () => null,
    } as any,
  };

  await test('createChatRuntime returns a HarnessChatRuntime', () => {
    const runtime = createChatRuntime(deps);
    expect(runtime.constructor.name).toBe('HarnessChatRuntime');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
