function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}"`);
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
  console.log('=== web-search Tests ===');
  const { createWebSearchTool } = await import('../src/skills/builtin/web-search/executor');

  await test('retries 202 responses before parsing results', async () => {
    let attempts = 0;
    const tool = createWebSearchTool({
      requestUrl: async (_options: any) => {
        attempts++;
        if (attempts < 3) {
          return { status: 202, text: '<html>please wait</html>' };
        }
        return {
          status: 200,
          text: `
            <a class="result__a" href="https://obsidian.md">Obsidian</a>
            <a class="result__snippet" href="https://obsidian.md">Knowledge base app</a>
          `,
        };
      },
      wait: async () => undefined,
    });

    const result = await tool.execute({ query: 'obsidian' }, {} as any);
    expect(attempts).toBe(3);
    expect(result.results[0].title).toContain('Obsidian');
  });

  await test('returns an error for thrown request failures', async () => {
    const tool = createWebSearchTool({
      requestUrl: async (_options: any) => {
        throw new Error('network down');
      },
      wait: async () => undefined,
    });

    const result = await tool.execute({ query: 'obsidian' }, {} as any);
    expect(result.error).toContain('network down');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
