// test/knowledge/executor.test.ts
// 回归：simple mode 的 knowledge executor 直接收模型生成的工具入参（外部数据），
// 必须显式窄化，不能被 null/数字/字符串混入的 args 带崩或透传错类型。

import { createExecutor } from '../../src/skills/builtin/knowledge/executor';
import { ToolContext } from '../../src/skills/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${JSON.stringify(actual)}"`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

function createRegistry() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const registry = {
    execute: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { executed: name, args };
    },
  };
  return { registry: registry as any, calls };
}

const ctx = {} as ToolContext;

console.log('=== Knowledge Executor Tests ===');

async function runTests() {
  await test('missing or non-string query returns the legacy error without executing', async () => {
    const { registry, calls } = createRegistry();
    const executor = createExecutor(registry);

    expect(await executor.execute(undefined, ctx)).toEqual({ error: 'Missing query parameter' });
    expect(await executor.execute(null, ctx)).toEqual({ error: 'Missing query parameter' });
    expect(await executor.execute(42, ctx)).toEqual({ error: 'Missing query parameter' });
    expect(await executor.execute([], ctx)).toEqual({ error: 'Missing query parameter' });
    expect(await executor.execute({ query: 42 }, ctx)).toEqual({ error: 'Missing query parameter' });
    expect(await executor.execute({ name: '' }, ctx)).toEqual({ error: 'Missing query parameter' });
    expect(calls.length).toBe(0);
  });

  await test('accepts query/name and defaults max_results to 3', async () => {
    const { registry, calls } = createRegistry();
    const executor = createExecutor(registry);

    await executor.execute({ query: '知识编译' }, ctx);
    expect(calls[0]).toEqual({ name: 'query_knowledge', args: { query: '知识编译', max_results: 3 } });

    // simple mode 兼容旧入参 name。
    await executor.execute({ name: 'legacy query' }, ctx);
    expect(calls[1]).toEqual({ name: 'query_knowledge', args: { query: 'legacy query', max_results: 3 } });
  });

  await test('max_results narrowing preserves the old falsy/non-number fallback', async () => {
    const { registry, calls } = createRegistry();
    const executor = createExecutor(registry);

    await executor.execute({ query: 'q', max_results: 5 }, ctx);
    await executor.execute({ query: 'q', max_results: 0 }, ctx);
    await executor.execute({ query: 'q', max_results: '7' }, ctx);
    await executor.execute({ query: 'q', max_results: null }, ctx);

    expect(calls[0].args).toEqual({ query: 'q', max_results: 5 });
    expect(calls[1].args).toEqual({ query: 'q', max_results: 3 });
    expect(calls[2].args).toEqual({ query: 'q', max_results: 3 });
    expect(calls[3].args).toEqual({ query: 'q', max_results: 3 });
  });

  console.log('All knowledge executor tests passed!');
}

void runTests();
