function expect(actual: any) {
  return {
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
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
  console.log('=== Knowledge Guardian Context Tests ===');
  const { KnowledgeRuntime } = await import('../../src/knowledge/runtime');

  await test('formats guardian knowledge context with article titles and claims', async () => {
    const runtime: any = Object.create(KnowledgeRuntime.prototype);
    runtime.metadataIndex = {
      search: () => [
        {
          title: 'Roadmap Decisions',
          keyClaims: ['Prefer progressive disclosure', 'Keep defaults lightweight'],
          concepts: ['onboarding', 'activation'],
        },
      ],
    };

    const context = await runtime.getGuardianKnowledgeContext('roadmap activation');

    expect(context).toContain('[知识库参考]');
    expect(context).toContain('Roadmap Decisions');
    expect(context).toContain('Prefer progressive disclosure');
    expect(context).toContain('onboarding');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
