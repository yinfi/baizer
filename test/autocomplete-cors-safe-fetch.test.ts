/**
 * Autocomplete (Guardian / stateless generation) must never depend on a bare native fetch.
 *
 * Bug: on `app://obsidian.md`, endpoints without CORS headers (opencode.ai /zen/go/v1/responses)
 * fail the preflight under native fetch. Stateless generation used to rely on whatever
 * `window.fetch` happened to be, and re-tried a doomed native request on every call.
 *
 * These tests do NOT install the global shim: the only way the request can succeed is if
 * autocomplete passes its own CORS-safe fetch to pi. They fail if it returns to native fetch.
 */
import http from 'http';

function expect(actual: any) {
  return {
    toBe(expected: any) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toContain(expected: string) {
      if (!String(actual).includes(expected)) throw new Error(`Expected "${actual}" to contain "${expected}"`);
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

/** Minimal OpenAI Responses SSE server. Records every request. */
async function startResponsesServer() {
  const hits: Array<{ method?: string; url?: string; stream: boolean; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, stream: /"stream":\s*true/.test(body), headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
      res.write(ev({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } }));
      res.write(ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [], status: 'in_progress' } }));
      res.write(ev({ type: 'response.content_part.added', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }));
      res.write(ev({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'suggestion' }));
      res.write(ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'suggestion' }] } }));
      res.write(ev({ type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  return { hits, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function runTests() {
  console.log('=== Autocomplete CORS-safe transport Tests ===');
  const cors = await import('../src/utils/request-url-fetch');
  const { buildOpenAICompatModel, createNativeCompleteFn } = await import('../src/runtime/pi/pi-native-model');
  const originalFetch = globalThis.fetch;

  // 模拟 CORS 预检失败：对 JS 而言就是 fetch 抛 TypeError。
  const nativeCalls: string[] = [];
  const installBlockedNativeFetch = () => {
    nativeCalls.length = 0;
    globalThis.fetch = (async (input: any) => {
      nativeCalls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
  };

  try {
    await test('shared fetch skips native for an origin already known to be CORS-blocked', async () => {
      cors.resetCorsSafeFetchStateForTesting();
      const calls: string[] = [];
      let nativeAttempts = 0;
      const safe = cors.createCorsSafeFetch({
        getNativeFetch: () => (async (input: any) => {
          nativeAttempts += 1;
          const url = typeof input === 'string' ? input : input.url;
          if (url.includes('blocked')) throw new TypeError('Failed to fetch');
          return new Response('native-ok', { status: 200 });
        }) as typeof fetch,
        deps: { requestUrl: (async (o: any) => { calls.push(o.url); return { status: 200, headers: {}, text: 'fallback-ok' }; }) as any },
        getNodeTransport: () => null, // 移动端：没有 Node 传输，直接 requestUrl
      });

      expect(await (await safe('https://blocked.example/v1/responses', { method: 'POST', body: '{}' })).text()).toBe('fallback-ok');
      expect(nativeAttempts).toBe(1);
      // 第二次：同一 origin 不再白白发一次必败的原生请求。
      expect(await (await safe('https://blocked.example/v1/responses', { method: 'POST', body: '{}' })).text()).toBe('fallback-ok');
      expect(nativeAttempts).toBe(1);
      expect(calls.length).toBe(2);
      // 其它 origin 仍走原生。
      expect(await (await safe('https://ok.example/')).text()).toBe('native-ok');
      expect(nativeAttempts).toBe(2);
    });

    await test('blocked-origin memory expires so a fixed endpoint recovers native fetch', async () => {
      cors.resetCorsSafeFetchStateForTesting();
      let clock = 1_000;
      let corsBlocked = true;
      let nativeAttempts = 0;
      const safe = cors.createCorsSafeFetch({
        getNativeFetch: () => (async () => {
          nativeAttempts += 1;
          if (corsBlocked) throw new TypeError('Failed to fetch');
          return new Response('native-ok', { status: 200 });
        }) as typeof fetch,
        deps: { requestUrl: (async () => ({ status: 200, headers: {}, text: 'fallback-ok' })) as any },
        getNodeTransport: () => null,
        now: () => clock,
      });
      expect(await (await safe('https://flaky.example/x')).text()).toBe('fallback-ok');
      clock += 60_000; // 仍在 TTL 内
      await safe('https://flaky.example/x');
      expect(nativeAttempts).toBe(1);
      clock += 11 * 60_000; // 过期；端点已补上 CORS 头
      corsBlocked = false;
      expect(await (await safe('https://flaky.example/x')).text()).toBe('native-ok');
      expect(nativeAttempts).toBe(2);
    });

    await test('a failed fallback does not mark the origin blocked (offline != CORS)', async () => {
      cors.resetCorsSafeFetchStateForTesting();
      let nativeAttempts = 0;
      const safe = cors.createCorsSafeFetch({
        getNativeFetch: () => (async () => { nativeAttempts += 1; throw new TypeError('Failed to fetch'); }) as typeof fetch,
        deps: { requestUrl: (async () => { throw new Error('offline'); }) as any },
        getNodeTransport: () => null,
      });
      let threw = false;
      try { await safe('https://offline.example/x'); } catch { threw = true; }
      expect(threw).toBe(true);
      try { await safe('https://offline.example/x'); } catch { /* expected */ }
      expect(nativeAttempts).toBe(2); // 没有被误记为 CORS 拦截
    });

    await test('createNativeCompleteFn (openai-responses) succeeds with native fetch blocked and no global shim', async () => {
      cors.resetCorsSafeFetchStateForTesting();
      installBlockedNativeFetch(); // 注意：故意不调用 installRequestUrlFetchFallback
      const srv = await startResponsesServer();
      try {
        const model = buildOpenAICompatModel({
          type: 'openai-compatible', label: 'opencode', apiKey: 'k',
          baseUrl: `http://127.0.0.1:${srv.port}/v1`, model: 'm', apiFlavor: 'responses',
        } as any);
        expect(model.api).toBe('openai-responses');
        const complete = createNativeCompleteFn(model as any, 'k');

        expect(await complete('hi', 'sys', { maxTokens: 16 })).toBe('suggestion');
        expect(srv.hits.length).toBe(1);
        expect(srv.hits[0].url).toBe('/v1/responses');
        expect(nativeCalls.length).toBe(1); // 首次探测一次原生

        // Guardian 每次停顿都会触发补全：之后不应再碰原生 fetch。
        expect(await complete('hi again', 'sys', { maxTokens: 16 })).toBe('suggestion');
        expect(srv.hits.length).toBe(2);
        expect(nativeCalls.length).toBe(1);
      } finally {
        await srv.close();
      }
    });

    await test('ModelService.generate (Guardian entry point) reaches the endpoint with native fetch blocked', async () => {
      cors.resetCorsSafeFetchStateForTesting();
      installBlockedNativeFetch();
      const srv = await startResponsesServer();
      try {
        const { ModelService } = await import('../src/services/model-service');
        const config = {
          type: 'openai-compatible', label: 'opencode', apiKey: 'k',
          baseUrl: `http://127.0.0.1:${srv.port}/v1`, model: 'm', apiFlavor: 'responses',
        };
        const service: any = Object.create(ModelService.prototype);
        service.settings = { activeProvider: 'p', providers: { p: config }, contextWindow: 32000, thinkingLevel: 'off' };
        service.getActiveProviderConfig = () => config;

        const text = await service.generate('complete this', 'sys', 'guardian', undefined, undefined, { temperature: 0.25, skipGenerationPlan: true });
        expect(text).toBe('suggestion');
        expect(srv.hits.length).toBe(1);
        expect(srv.hits[0].stream).toBe(true);
      } finally {
        await srv.close();
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    cors.resetCorsSafeFetchStateForTesting();
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});