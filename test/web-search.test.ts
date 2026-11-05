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

  // 工具 args 是模型给的 JSON（外部输入）：非字符串字段按缺省处理，不能把工具体打崩。
  await test('ignores non-string query fields instead of crashing', async () => {
    let requestedUrl = '';
    const tool = createWebSearchTool({
      requestUrl: async (options: any) => {
        requestedUrl = options.url;
        return { status: 200, text: `<html>${'x'.repeat(60)}</html>` };
      },
      wait: async () => undefined,
    });

    const result = await tool.execute({ query: 42, time_range: 7 }, {} as any);
    // 非字符串 query 视为空查询；非字符串 time_range 不拼进 URL。
    expect(requestedUrl).toBe('https://html.duckduckgo.com/html/?q=');
    expect(Array.isArray(result.results)).toBe(true);
  });

  await test('treats null tool args as an empty query', async () => {
    const tool = createWebSearchTool({
      requestUrl: async (_options: any) => ({ status: 200, text: 'too short' }),
      wait: async () => undefined,
    });

    const result = await tool.execute(null, {} as any);
    expect(result.message).toContain('No results');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
