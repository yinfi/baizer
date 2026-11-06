import type { ProviderConfig } from '../src/mcp/types';
import type { ModelCatalogDeps } from '../src/services/model-catalog-service';

/**
 * 模型列表请求的超时 / 取消 / 并发合并（issue #81）。
 *
 * 背景：Obsidian 的 requestUrl 没有原生取消能力，移动端慢网络下 /models 可能长时间
 * 挂起，设置页重渲染还每次都重发一遍 —— 页面既等不到结果，又叠出一堆重复请求。
 * 这里锁住三件事：
 *  1) 请求有明确超时，且超时错误可辨识（含 timed out + URL）；
 *  2) 调用方可用 AbortSignal 取消，预取消与等待中取消都按 AbortError 处理，晚到结果被忽略；
 *  3) 并发的非 forceRefresh 调用共享同一个请求，不会叠出重复 /models。
 */

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

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
    toMatch: (pattern: RegExp) => {
      if (typeof actual !== 'string' || !pattern.test(actual)) {
        throw new Error(`Expected ${String(actual)} to match ${pattern}`);
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

/** 永不落定的请求：模拟移动端上被挂住的 /models。 */
function neverSettles(): Promise<any> {
  return new Promise(() => { /* 故意不 resolve */ });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function anthropicConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'anthropic',
    label: 'Anthropic',
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

function openaiConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'openai-compatible',
    label: 'OpenAI',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  };
}

async function runTests() {
  console.log('=== Model catalog timeout / in-flight dedupe Tests ===');
  const catalog = await import('../src/services/model-catalog-service');
  const { ModelService } = await import('../src/services/model-service');

  /**
   * 用原型对象造一个只带模型列表相关字段的 ModelService：与 test/model-service.test.ts 的
   * 既有风格一致（跳过构造函数），但必须手动补上 modelListInFlight —— 构造函数不跑。
   */
  function createModelService(): any {
    const service: any = Object.create(ModelService.prototype);
    service.settings = {
      activeProvider: 'anthropic',
      providers: { anthropic: anthropicConfig() },
    };
    service.modelListCache = new Map();
    service.modelListCacheTtlMs = 10 * 60 * 1000;
    service.modelListInFlight = new Map();
    service.getActiveProviderConfig = () => service.settings.providers.anthropic;
    return service;
  }

  await test('(a) a hung request rejects with a "timed out" error naming the URL, in bounded time', async () => {
    // 默认超时必须是一个明确的有限值（沿用 main 上 #87 的 10s），而不是「永远等」。
    expect(catalog.DEFAULT_MODELS_REQUEST_TIMEOUT_MS).toBe(10000);

    const startedAt = Date.now();
    let caught: any;
    try {
      await catalog.listModels(anthropicConfig(), {
        requestUrl: () => neverSettles(),
        timeoutMs: 40,
      });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - startedAt;

    expect(caught instanceof Error).toBe(true);
    expect(caught.message).toMatch(/timed out/);
    expect(caught.message).toMatch(/https:\/\/api\.anthropic\.com\/v1\/models/);
    // 有界：绝不能等到默认的 15s；40ms 的超时应当很快返回。
    expect(elapsed < 1000).toBe(true);

    // openai-compatible 分支同样遵守超时（deps 必须真的透传到该分支）。
    let openaiCaught: any;
    try {
      await catalog.listModels(openaiConfig(), {
        requestUrl: () => neverSettles(),
        timeoutMs: 20,
      });
    } catch (e) {
      openaiCaught = e;
    }
    expect(openaiCaught instanceof Error).toBe(true);
    expect(openaiCaught.message).toMatch(/timed out/);
    expect(openaiCaught.message).toMatch(/https:\/\/api\.openai\.com\/v1\/models/);
  });

  await test('(b) a pre-aborted signal rejects AbortError before any request is sent', async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;

    const deps: ModelCatalogDeps = {
      requestUrl: async () => {
        requests += 1;
        return { status: 200, text: '{"data":[]}' } as any;
      },
      signal: controller.signal,
      timeoutMs: 1000,
    };

    let caught: any;
    try {
      await catalog.listModels(anthropicConfig(), deps);
    } catch (e) {
      caught = e;
    }

    expect(caught instanceof Error).toBe(true);
    expect(caught.name).toBe('AbortError');
    expect(requests).toBe(0);
  });

  await test('(c) aborting while pending rejects AbortError and a late response is ignored', async () => {
    const controller = new AbortController();
    const pending = deferred<any>();
    let requests = 0;

    const deps: ModelCatalogDeps = {
      requestUrl: () => {
        requests += 1;
        return pending.promise;
      },
      signal: controller.signal,
      timeoutMs: 5000,
    };

    const request = catalog.listModels(anthropicConfig(), deps);
    // 让请求先真正发出去，再 abort。
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    let caught: any;
    try {
      await request;
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof Error).toBe(true);
    expect(caught.name).toBe('AbortError');
    expect(requests).toBe(1);

    // 晚到的响应不得再改变任何结果（也不得产生未处理的 rejection）。
    let lateThenRan = false;
    request.then(() => { lateThenRan = true; }, () => undefined);
    pending.resolve({ status: 200, text: JSON.stringify({ data: [{ id: 'late-model' }] }) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lateThenRan).toBe(false);
    expect(caught.name).toBe('AbortError');
  });

  await test('(d) a fast success still resolves normally (both protocol branches)', async () => {
    const anthropicModels = await catalog.listModels(anthropicConfig(), {
      requestUrl: async () => ({
        status: 200,
        text: JSON.stringify({ data: [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' }] }),
      } as any),
      timeoutMs: 1000,
    });
    expect(anthropicModels).toEqual([{ value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (claude-opus-4-5)' }]);

    // openai-compatible 的注入缝同样可用（此前该分支完全不透传 deps）。
    const openaiModels = await catalog.listModels(openaiConfig(), {
      requestUrl: async () => ({
        status: 200,
        text: JSON.stringify({ data: [{ id: 'gpt-4o' }] }),
      } as any),
      timeoutMs: 1000,
    });
    expect(openaiModels).toEqual([{ value: 'gpt-4o', label: 'gpt-4o' }]);
  });

  await test('(e) concurrent non-forced calls share one request and hit the endpoint exactly once', async () => {
    let requests = 0;
    const gate = deferred<any>();
    const deps: ModelCatalogDeps = {
      requestUrl: () => {
        requests += 1;
        return gate.promise;
      },
    };

    const service = createModelService();
    const first = service.getAvailableModelsWithStatus(false, deps);
    const second = service.getAvailableModelsWithStatus(false, deps);

    // 第二次调用已挂到同一个在途请求上，而不是再发一条 /models。
    expect(service.modelListInFlight.size).toBe(1);
    expect(requests).toBe(1);

    gate.resolve({ status: 200, text: JSON.stringify({ data: [{ id: 'claude-opus-4-5' }] }) });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(requests).toBe(1);
    expect(firstResult.listed).toBe(true);
    expect(secondResult.listed).toBe(true);
    expect(firstResult.models.some((model: any) => model.value === 'claude-opus-4-5')).toBe(true);
    expect(secondResult.models.some((model: any) => model.value === 'claude-opus-4-5')).toBe(true);
    // 落定后必须清掉在途登记，不能把一次请求永久留在表里。
    expect(service.modelListInFlight.size).toBe(0);

    // 结果进了 10 分钟缓存：再问一次也不该发请求。
    await service.getAvailableModelsWithStatus(false, deps);
    expect(requests).toBe(1);
  });

  await test('(f) a failed concurrent request is also removed from the in-flight map', async () => {
    let requests = 0;
    const deps: ModelCatalogDeps = {
      requestUrl: async () => {
        requests += 1;
        return { status: 500, text: '' } as any;
      },
    };

    const service = createModelService();
    const [firstResult, secondResult] = await Promise.all([
      service.getAvailableModelsWithStatus(false, deps),
      service.getAvailableModelsWithStatus(false, deps),
    ]);

    expect(requests).toBe(1);
    expect(firstResult.error instanceof Error).toBe(true);
    expect(firstResult.error.message).toMatch(/500/);
    expect(secondResult.error instanceof Error).toBe(true);
    expect(service.modelListInFlight.size).toBe(0);

    // 失败也必须从在途表里删掉：清掉缓存后再次调用应重新打端点，
    // 而不是共享那次早已落定的失败。
    service.modelListCache.clear();
    const retried = await service.getAvailableModelsWithStatus(false, deps);
    expect(requests).toBe(2);
    expect(retried.error instanceof Error).toBe(true);
    expect(service.modelListInFlight.size).toBe(0);
  });

  await test('(z) model list parsing ignores malformed rows and bodies', async () => {
    const ok = (text: string) => async () => ({ status: 200, text }) as any;

    const openai = await catalog.listModels(openaiConfig(), {
      requestUrl: ok(JSON.stringify({ data: [null, 'x', 5, {}, { id: 7 }, { id: '  ' }, { id: 'gpt-4o ' }, { id: 'text-embedding-3' }, { id: 'b-model' }, { id: 'gpt-4o' }] })),
    });
    expect(openai.map((m: any) => m.value)).toEqual(['b-model', 'gpt-4o']);

    for (const body of ['{}', 'null', '[]', '{"data":"x"}', '{"data":{}}']) {
      expect(await catalog.listModels(openaiConfig(), { requestUrl: ok(body) })).toEqual([]);
      expect(await catalog.listModels(anthropicConfig(), { requestUrl: ok(body) })).toEqual([]);
    }

    const anthropic = await catalog.listModels(anthropicConfig(), {
      requestUrl: ok(JSON.stringify({ data: [null, { id: 3 }, { id: 'claude-a', display_name: 7 }, { id: 'claude-b', display_name: ' Claude B ' }, { id: 'claude-c', display_name: '   ' }] })),
    });
    expect(anthropic).toEqual([
      { value: 'claude-a', label: 'claude-a' },
      { value: 'claude-b', label: 'Claude B (claude-b)' },
      { value: 'claude-c', label: 'claude-c' },
    ]);
  });

  await test('(g) malformed model rows are dropped instead of failing the whole list', async () => {
    const openaiModels = await catalog.listModels(openaiConfig(), {
      requestUrl: async () => ({
        status: 200,
        text: JSON.stringify({
          data: [
            { id: 'gpt-4o' },
            null,
            'gpt-4o-mini',
            { id: 42 },
            { id: '  gpt-4o  ' },
            { id: 'text-embedding-3-small' },
          ],
        }),
      } as any),
    });
    // 非对象 / 非字符串 id 丢弃；id 去空白后按值去重；embedding 仍被关键词排除。
    expect(openaiModels).toEqual([{ value: 'gpt-4o', label: 'gpt-4o' }]);

    const anthropicModels = await catalog.listModels(anthropicConfig(), {
      requestUrl: async () => ({
        status: 200,
        text: JSON.stringify({
          data: [
            { id: 'claude-x', display_name: '' },
            { id: 'claude-y', display_name: 'Claude Y' },
            { id: null },
            'junk',
          ],
        }),
      } as any),
    });
    expect(anthropicModels).toEqual([
      { value: 'claude-x', label: 'claude-x' },
      { value: 'claude-y', label: 'Claude Y (claude-y)' },
    ]);
  });

  await test('(h) recognizes the listing-unsupported marker on plain objects', () => {
    // 跨模块副本（或重建的异常）没有原型链，只能靠稳定 code 识别。
    expect(catalog.isModelListingUnsupported({ code: 'model-listing-unsupported' })).toBe(true);
    expect(catalog.isModelListingUnsupported({ code: 'something-else' })).toBe(false);
    expect(catalog.isModelListingUnsupported('model-listing-unsupported')).toBe(false);
    expect(catalog.isModelListingUnsupported(null)).toBe(false);
  });

  await test('(i) rejection reasons are always Errors (non-Error throws keep readable text)', async () => {
    // 注入实现同步抛出字符串：rejection reason 必须仍是 Error（prefer-promise-reject-errors），
    // 这样 ModelService → 设置页状态行拿到的始终是可展示的错误。
    let syncCaught: any;
    try {
      await catalog.listModels(openaiConfig(), {
        requestUrl: (() => { throw 'socket hang up'; }) as any,
        timeoutMs: 1000,
      });
    } catch (e) {
      syncCaught = e;
    }
    expect(syncCaught instanceof Error).toBe(true);
    expect(syncCaught.message).toBe('socket hang up');

    // Promise.reject(带 message 的对象)：reason 变成 Error，但保留可读文本。
    let objectCaught: any;
    try {
      await catalog.listModels(openaiConfig(), {
        requestUrl: () => Promise.reject({ message: 'gateway down' }),
        timeoutMs: 1000,
      });
    } catch (e) {
      objectCaught = e;
    }
    expect(objectCaught instanceof Error).toBe(true);
    expect(objectCaught.message).toBe('gateway down');

    // 真 Error 原样透传：不额外包一层，name / code 等可辨识属性不丢。
    const original = new Error('network down');
    original.name = 'NetworkError';
    let errorCaught: any;
    try {
      await catalog.listModels(openaiConfig(), {
        requestUrl: () => Promise.reject(original),
        timeoutMs: 1000,
      });
    } catch (e) {
      errorCaught = e;
    }
    expect(errorCaught).toBe(original);
    expect(errorCaught.name).toBe('NetworkError');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
