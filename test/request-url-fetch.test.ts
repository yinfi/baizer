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
  console.log('=== request-url-fetch Tests ===');
  const { requestUrlFetch, installRequestUrlFetchFallback } = await import(
    '../src/utils/request-url-fetch'
  );

  const okDeps = (calls: any[]) => ({
    requestUrl: async (options: any) => {
      calls.push(options);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        arrayBuffer: new TextEncoder().encode('{"ok":true}').buffer,
        text: '{"ok":true}',
      };
    },
  });

  await test('requestUrlFetch returns a WHATWG Response with status/headers/body', async () => {
    const calls: any[] = [];
    const res = await requestUrlFetch(
      'https://example.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: '{"q":1}',
      },
      okDeps(calls) as any,
    );

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://example.com/v1/chat/completions');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"q":1}');
    expect(calls[0].headers['authorization']).toBe('Bearer x');
    expect(calls[0].throw).toBe(false);

    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  await test('requestUrlFetch streams chunks incrementally when runtime body is event-stream', async () => {
    const listeners: Record<string, Function[]> = {};
    const body = {
      on: (ev: string, fn: Function) => {
        (listeners[ev] ??= []).push(fn);
        return body;
      },
      _emit: (ev: string, ...args: any[]) => {
        (listeners[ev] ?? []).forEach((f) => f(...args));
      },
    };
    const deps = { requestUrl: async () => ({ status: 200, headers: {}, body }) };
    const res = await requestUrlFetch('https://example.com/stream', {}, deps as any);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = reader.read().then(({ value }) => new TextDecoder().decode(value));
    body._emit('data', 'hello ');
    // 第一块数据必须在 end 之前就能被读到 → 真正的增量流式
    expect(await first).toBe('hello ');

    body._emit('data', 'world');
    body._emit('end');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('world');
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  await test('nodeHttpFetch streams SSE chunks incrementally through node http', async () => {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"delta":"a"}\n\n');
        setTimeout(() => {
          res.write('data: {"delta":"b"}\n\n');
          res.end();
        }, 60);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":1}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r as any));
    const port = (server.address() as any).port;

    const { nodeHttpFetch } = await import('../src/utils/request-url-fetch');
    const transport = { http, https: null };
    const res = await nodeHttpFetch(transport as any, `http://127.0.0.1:${port}/sse`, {} as any);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = reader.read().then(({ value }) => new TextDecoder().decode(value));
    // 第一块（delta a）必须在 end 前可读 → 真正的增量流式
    const firstText = await first;
    expect(firstText).toContain('"delta":"a"');

    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('"delta":"b"');
    const done = await reader.read();
    expect(done.done).toBe(true);

    // 普通 JSON 请求也正常
    const jsonRes = await nodeHttpFetch(transport as any, `http://127.0.0.1:${port}/json`, {} as any);
    const json = await jsonRes.json();
    expect(json.ok).toBe(1);

    server.closeAllConnections?.();
    await new Promise((r) => server.close(r as any));
  });

  await test('nodeHttpFetch honors abort signal and follows redirects', async () => {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/target' });
        res.end();
      } else if (req.url === '/target') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('redirected-ok');
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        // 不结束，等待 abort
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r as any));
    const port = (server.address() as any).port;

    const { nodeHttpFetch } = await import('../src/utils/request-url-fetch');
    const transport = { http, https: null };

    const redirectRes = await nodeHttpFetch(transport as any, `http://127.0.0.1:${port}/redirect`, {} as any);
    expect(redirectRes.status).toBe(200);
    expect(await redirectRes.text()).toBe('redirected-ok');

    const controller = new AbortController();
    // 响应头先到达 → promise resolve；body 阶段 abort 由 cancel/断开体现
    const slowRes = await nodeHttpFetch(transport as any, `http://127.0.0.1:${port}/slow`, { signal: controller.signal } as any);
    expect(slowRes.status).toBe(200);
    slowRes.body?.cancel(); // 关闭底层连接，避免挂起

    // abort 在请求阶段：预置已 abort 的信号
    const aborted = new AbortController();
    aborted.abort();
    let threw2 = false;
    try {
      await nodeHttpFetch(transport as any, `http://127.0.0.1:${port}/target`, { signal: aborted.signal } as any);
    } catch (e: any) {
      threw2 = true;
      expect(e.name ?? 'AbortError').toBe('AbortError');
    }
    expect(threw2).toBe(true);

    server.closeAllConnections?.();
    await new Promise((r) => server.close(r as any));
  });

  await test('requestUrlFetch handles 204 without body', async () => {
    const deps = { requestUrl: async () => ({ status: 204, headers: {} }) };
    const res = await requestUrlFetch('https://example.com/delete', { method: 'DELETE' }, deps as any);
    expect(res.status).toBe(204);
    expect(res.body).toBe(null);
  });

  await test('requestUrlFetch honors a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = { requestUrl: async () => ({ status: 200, headers: {}, text: 'x' }) };
    let threw = false;
    try {
      await requestUrlFetch('https://example.com/', { signal: controller.signal } as any, deps as any);
    } catch (e: any) {
      threw = true;
      expect(e.name ?? 'AbortError').toBe('AbortError');
    }
    expect(threw).toBe(true);
  });

  await test('install() falls back to requestUrl on CORS TypeError, keeps native on success', async () => {
    const originalFetch = globalThis.fetch;
    const fallbackCalls: any[] = [];
    const deps = {
      requestUrl: async (options: any) => {
        fallbackCalls.push(options);
        return { status: 200, headers: {}, text: 'fallback-ok' };
      },
    };

    // 模拟：blocked.example 走 CORS 失败，ok.example 正常
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('blocked')) throw new TypeError('Failed to fetch');
      return new Response('native-ok', { status: 200 });
    };

    try {
      installRequestUrlFetchFallback(deps as any);
      const patched = globalThis.fetch as typeof fetch;

      const blocked = await patched('https://blocked.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await blocked.text()).toBe('fallback-ok');
      expect(fallbackCalls.length).toBe(1);
      expect(fallbackCalls[0].url).toContain('blocked.example');

      const ok = await patched('https://ok.example/');
      expect(await ok.text()).toBe('native-ok');
      expect(fallbackCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
