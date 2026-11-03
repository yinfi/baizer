/**
 * test/anthropic-protocol.test.ts
 *
 * Anthropic 原生 Messages 协议的端到端接线测试（issue #58 part 2 / WP-A）。
 *
 * 覆盖策略（两层，缺一不可）：
 *
 *  1. **真实 pi-ai api**：全部用例都走 pi-ai 自带的 `api/anthropic-messages.js`
 *     （经 `anthropicMessagesApi()` 取到），不另建平行推理栈 —— 这正是 issue 要求的
 *     「复用 pi-ai 的 Anthropic 适配」。
 *  2. **真实 SDK 与 shim 各跑一遍**：
 *     - `streamSimple` + mock fetch：由**真实 @anthropic-ai/sdk** 发请求，
 *       证明「我们的接线」（buildAnthropicModel 的 baseUrl、注入的 apiKey、
 *       customHeaders）端到端正确；
 *     - `stream` + `options.client = shim`：由**打包时真正进 bundle 的**
 *       anthropic-sdk-shim 发请求，证明 shim 与真实 SDK 线协议等价。
 *     两者对同一输入必须发出等价请求（URL / 关键 header / JSON body 深等）。
 *
 * 运行：npx tsx --tsconfig tsconfig.test.json test/anthropic-protocol.test.ts
 */

import type { ProviderConfig } from '../src/mcp/types';

// ---- 最小 expect / test 工具（与项目其他测试文件风格一致） ----

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy but got ${JSON.stringify(actual)}`);
    },
    toBeFalsy: () => {
      if (actual) throw new Error(`Expected falsy but got ${JSON.stringify(actual)}`);
    },
    toBeUndefined: () => {
      if (actual !== undefined) throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
    },
    toContain: (needle: string) => {
      if (typeof actual !== 'string' || !actual.includes(needle)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`);
      }
    },
    toBeGreaterThan: (n: number) => {
      if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`);
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

// ---- fixtures ----

const BASE_URL = 'https://gateway.example.com';
const API_KEY = 'sk-ant-api03-test-key';

function anthropicConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'anthropic',
    label: 'Anthropic',
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

/** 记录每次请求（url + init），供断言「实际发出去的线协议」。 */
function recordingFetch(handler: (call: { url: string; init: any }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl: any = async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  impl.calls = calls;
  return impl;
}

/** 构造 Anthropic SSE 响应体（`event:` + `data:` 双行 + 空行分隔）。 */
function sseResponse(events: Array<[string, any]>): Response {
  const text = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 一段正常的「文本回复」SSE：message_start → text 分片 → message_delta → message_stop。 */
function textStreamEvents(chunks: string[], opts: { inputTokens?: number; outputTokens?: number } = {}) {
  return [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test_1',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: opts.inputTokens ?? 12, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...chunks.map((chunk) => ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    }] as [string, any]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: opts.outputTokens ?? 7 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ] as Array<[string, any]>;
}

/** 一段「调用工具」SSE：tool_use 起始 + input_json_delta 拼参数。 */
function toolStreamEvents(): Array<[string, any]> {
  return [
    ['message_start', {
      type: 'message_start',
      message: { id: 'msg_test_tool', model: 'claude-sonnet-4-5', usage: { input_tokens: 20, output_tokens: 1 } },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_note', input: {} },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"Notes/a.md"}' },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 9 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

/** 取出实际发出去的请求体（JSON 解析后的对象）。 */
function requestBody(call: { init: any }): any {
  return JSON.parse(call.init.body);
}

/** 归一化 fetch init 里的 headers：真实 SDK 传 Headers 实例，shim 传普通对象。 */
function rawHeaders(init: any): Array<[string, string]> {
  const headers = init?.headers;
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([k, v]: any) => [String(k), String(v)]);
  return Object.entries(headers).map(([k, v]) => [k, String(v)]);
}

/** 取 header（大小写不敏感）。 */
function header(call: { init: any }, name: string): string | undefined {
  const found = rawHeaders(call.init).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

/**
 * 只比较「协议语义」header。
 * 真实 SDK 还会发 X-Stainless-* / user-agent 等实现细节，shim 有意不发（见 shim 文件头），
 * 故等价性只在这几个决定请求能否被 Anthropic 端点正确受理的 header 上比较。
 */
function protocolHeaders(call: { init: any }): Record<string, string> {
  const keep = ['content-type', 'anthropic-version', 'anthropic-beta', 'x-api-key', 'authorization'];
  const out: Record<string, string> = {};
  for (const [key, value] of rawHeaders(call.init)) {
    const lower = key.toLowerCase();
    if (keep.includes(lower)) out[lower] = value;
  }
  // 排序键：header 顺序是无关紧要的实现细节，而本文件的 toEqual 走 JSON.stringify
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---- 测试套件 ----

async function runTests() {
  console.log('=== Anthropic Messages Protocol Tests ===');

  const { buildAnthropicModel, supportsAdaptiveThinking } = await import('../src/runtime/pi/pi-native-model');
  const shimModule = await import('../src/runtime/pi/anthropic-sdk-shim');
  const ShimAnthropic: any = shimModule.default;
  const ShimAPIError: any = shimModule.APIError;

  // 真实 SDK：只用于「与 shim 对比」和「验证我们的接线」，不是运行时依赖
  const RealAnthropic: any = (await import('@anthropic-ai/sdk')).default;

  // 真实 pi-ai 的 anthropic-messages api（不是我们的实现）
  const compat: any = await import('@earendil-works/pi-ai/compat');
  const anthropicApi = compat.anthropicMessagesApi();

  const model = buildAnthropicModel(anthropicConfig(), 100000, 'medium');
  const basicContext = {
    systemPrompt: 'You are Baizer.',
    messages: [{ role: 'user' as const, content: 'hi', timestamp: 1 }],
  };

  /* ------------------------------------------------------------------ */
  /* (a) 走真实 SDK：证明「我们的接线」端到端正确                          */
  /* ------------------------------------------------------------------ */

  await test('real SDK: POST {baseUrl}/v1/messages with x-api-key + anthropic-version', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['Hello', ' world'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    expect(fetchImpl.calls.length).toBe(1);
    const call = fetchImpl.calls[0];
    // 真实 SDK 打的是 /v1/messages?beta=true（?beta 只是 SDK 内部的路由标记）。
    // 协议路径是 pathname；shim 有意不带该 query（见 anthropic-sdk-shim.ts 的文件头说明）。
    const url = new URL(call.url);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe('/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(header(call, 'x-api-key')).toBe(API_KEY);
    expect(header(call, 'anthropic-version')).toBe('2023-06-01');
    expect(header(call, 'content-type')).toBe('application/json');
    // 绝不能把 OpenAI 的认证方式发给 Anthropic 端点
    expect(header(call, 'authorization')).toBeUndefined();
  });

  await test('real SDK: system is a top-level param, not a system-role message', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    // Anthropic Messages 用顶层 system 字段（数组 content block），messages 里不允许 system 角色
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].text).toBe('You are Baizer.');
    expect(body.messages.some((m: any) => m.role === 'system')).toBeFalsy();
  });

  await test('real SDK: max_tokens is present and numeric (required by the protocol)', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5');
  });

  await test('real SDK: user content is sent as content blocks, not a bare string', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    const first = body.messages[0];
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content[0].type).toBe('text');
    expect(first.content[0].text).toBe('hi');
  });

  await test('real SDK: tool_use / tool_result round trip keeps ids and block types', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['done'])));
    // 一条「上一轮调了工具 + 工具返回结果」的历史，必须被转成 tool_use / tool_result content block
    const context = {
      systemPrompt: '',
      messages: [
        { role: 'user' as const, content: 'read the note', timestamp: 1 },
        {
          role: 'assistant' as const,
          content: [{ type: 'toolCall', id: 'toolu_abc', name: 'read_note', arguments: { path: 'Notes/a.md' } }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult' as const,
          toolCallId: 'toolu_abc',
          toolName: 'read_note',
          content: [{ type: 'text', text: '# a.md body' }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    await compat.completeSimple(model, context as any, { apiKey: API_KEY, fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    const toolUse = assistant.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.id).toBe('toolu_abc');
    expect(toolUse.name).toBe('read_note');
    expect(toolUse.input).toEqual({ path: 'Notes/a.md' });

    const toolResultMsg = body.messages.find(
      (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
    );
    const toolResult = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(toolResult.tool_use_id).toBe('toolu_abc');
  });

  await test('real SDK: custom headers from ProviderConfig reach the wire', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, {
      apiKey: API_KEY,
      headers: { 'x-opencode-session': 'conv-42' },
      fetch: fetchImpl,
    });
    expect(header(fetchImpl.calls[0], 'x-opencode-session')).toBe('conv-42');
  });

  /* ------------------------------------------------------------------ */
  /* (b) thinking 能力门控：不支持的档位不发出非法字段                     */
  /* ------------------------------------------------------------------ */

  await test('thinking off: neither thinking nor reasoning_effort is sent', async () => {
    const offModel = buildAnthropicModel(anthropicConfig(), 100000, 'off');
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    // reasoning 未传 == off：pi 的 agent 在 thinkingLevel='off' 时正是这样调用
    await compat.completeSimple(offModel, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  await test('thinking on + budget model (claude-sonnet-4-5): budget_tokens, never reasoning_effort', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, reasoning: 'medium', fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    expect(body.thinking.type).toBe('enabled');
    expect(typeof body.thinking.budget_tokens).toBe('number');
    // budget 必须给答案留出空间，不能等于整个 max_tokens
    expect(body.thinking.budget_tokens).toBeGreaterThan(0);
    expect(body.thinking.budget_tokens <= body.max_tokens).toBeTruthy();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  await test('thinking on + adaptive model (claude-sonnet-5): adaptive + output_config.effort', async () => {
    const adaptive = buildAnthropicModel(anthropicConfig({ model: 'claude-sonnet-5' }), 100000, 'medium');
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(adaptive, basicContext, { apiKey: API_KEY, reasoning: 'medium', fetch: fetchImpl });

    const body = requestBody(fetchImpl.calls[0]);
    expect(body.thinking.type).toBe('adaptive');
    // 档位映射成 Anthropic effort（medium → 'medium'），不是 OpenAI 的 reasoning_effort
    expect(body.output_config.effort).toBe('medium');
    expect(body.reasoning_effort).toBeUndefined();
  });

  await test('adaptive model detection is prefix/family based and does not over-match', () => {
    // 来自 pi-ai dist/providers/data/anthropic.json 的 forceAdaptiveThinking 家族
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true);
    expect(supportsAdaptiveThinking('anthropic/claude-fable-5')).toBe(true);
    // 非 adaptive：budget_tokens 家族
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
    expect(supportsAdaptiveThinking('claude-opus-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAdaptiveThinking(undefined)).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /* (c) SSE：文本增量 / 工具参数增量 / usage / 正常停止                    */
  /* ------------------------------------------------------------------ */

  await test('SSE text deltas accumulate into one assistant text block', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['Hel', 'lo, ', 'Baizer'])));
    const result = await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    expect(result.stopReason).toBe('stop');
    expect(result.rawStopReason).toBe('end_turn');
    const text = result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    expect(text).toBe('Hello, Baizer');
  });

  await test('SSE usage from message_start + message_delta is reported', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['hi'], { inputTokens: 31, outputTokens: 9 })));
    const result = await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    expect(result.usage.input).toBe(31);
    expect(result.usage.output).toBe(9);
    // Anthropic 不返回 total，pi 用分量求和
    expect(result.usage.totalTokens).toBe(40);
  });

  await test('SSE tool-argument deltas assemble a toolCall with parsed arguments', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(toolStreamEvents()));
    const result = await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });

    expect(result.rawStopReason).toBe('tool_use');
    expect(result.stopReason).toBe('toolUse');
    const call = result.content.find((b: any) => b.type === 'toolCall');
    expect(call.id).toBe('toolu_1');
    expect(call.name).toBe('read_note');
    expect(call.arguments).toEqual({ path: 'Notes/a.md' });
  });

  await test('SSE deltas surface as streaming events (text_delta / toolcall_delta)', async () => {
    const textFetch = recordingFetch(() => sseResponse(textStreamEvents(['ab', 'cd'])));
    const seen: string[] = [];
    for await (const event of anthropicApi.stream(model, basicContext, { apiKey: API_KEY, fetch: textFetch })) {
      seen.push((event as any).type);
    }
    expect(seen.includes('text_delta')).toBe(true);
    expect(seen.includes('text_end')).toBe(true);
    expect(seen.includes('done')).toBe(true);

    const toolFetch = recordingFetch(() => sseResponse(toolStreamEvents()));
    let toolDelta = '';
    for await (const event of anthropicApi.stream(model, basicContext, { apiKey: API_KEY, fetch: toolFetch })) {
      if ((event as any).type === 'toolcall_delta') toolDelta += (event as any).delta;
    }
    expect(toolDelta).toBe('{"path":"Notes/a.md"}');
  });

  /* ------------------------------------------------------------------ */
  /* (d) 错误：401 / 429 必须浮成可读的 provider 错误                      */
  /* ------------------------------------------------------------------ */

  await test('401 from the endpoint becomes an APIError-driven error result (real SDK)', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    }));
    const result = await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('401');
    expect(result.errorMessage).toContain('invalid x-api-key');
  });

  await test('429 from the endpoint becomes an error result mentioning 429', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'rate limited' },
    }));
    const result = await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: fetchImpl });
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('429');
    expect(result.errorMessage).toContain('rate limited');
  });

  /* ------------------------------------------------------------------ */
  /* (e) 取消                                                            */
  /* ------------------------------------------------------------------ */

  await test('pre-aborted signal: no request is issued and stopReason is aborted', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['never'])));
    const controller = new AbortController();
    controller.abort();
    const result = await compat.completeSimple(model, basicContext, {
      apiKey: API_KEY,
      signal: controller.signal,
      fetch: fetchImpl,
    });
    expect(result.stopReason).toBe('aborted');
    expect(fetchImpl.calls.length).toBe(0);
  });

  await test('abort mid-stream ends with stopReason aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['partial'])));
    const stream = anthropicApi.stream(model, basicContext, {
      apiKey: API_KEY,
      signal: controller.signal,
      fetch: fetchImpl,
    });

    let sawDelta = false;
    for await (const event of stream) {
      if ((event as any).type === 'text_delta' && !sawDelta) {
        sawDelta = true;
        controller.abort();
      }
    }
    const result = await stream.result();
    expect(sawDelta).toBe(true);
    expect(result.stopReason).toBe('aborted');
  });

  /* ------------------------------------------------------------------ */
  /* (f) shim ⇄ 真实 SDK 的线协议等价性（shim 才是进 bundle 的那份）        */
  /* ------------------------------------------------------------------ */

  /**
   * shim 是「打包时真正进 bundle 的那份 @anthropic-ai/sdk」。它不走 pi 的 streamSimple
   * （production 里 shim 就是被 pi 直接 `new` 出来的，等价于真实 SDK 的位置），
   * 所以这里在 client 层做两件事：
   *   1. shim 自己的请求形状（URL / 认证 / 版本 header / beta 提升 / APIError / 取消）；
   *   2. **把 pi 用真实 SDK 生成的那个 body 原样喂给 shim**，逐字比对两者的线协议。
   */
  function shimClient(fetchImpl: any, defaultHeaders: Record<string, string> = {}) {
    return new ShimAnthropic({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch: fetchImpl,
      defaultHeaders,
    });
  }

  await test('shim: POST /v1/messages with x-api-key + anthropic-version', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['shimmed'])));
    const client = shimClient(fetchImpl);
    await client.beta.messages.create(
      { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      {},
    ).asResponse();

    const call = fetchImpl.calls[0];
    // 有意不带真实 SDK 的 ?beta=true 标记，路径严格是 /v1/messages
    expect(call.url).toBe(`${BASE_URL}/v1/messages`);
    expect(call.init.method).toBe('POST');
    expect(header(call, 'x-api-key')).toBe(API_KEY);
    expect(header(call, 'anthropic-version')).toBe('2023-06-01');
    expect(header(call, 'content-type')).toBe('application/json');
    expect(header(call, 'authorization')).toBeUndefined();
  });

  await test('shim reproduces the real SDK request for the exact body pi generated', async () => {
    // 1) 让 pi 用真实 SDK 发一次，抓下它实际写出的请求
    const sdkFetch = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    await compat.completeSimple(model, basicContext, { apiKey: API_KEY, fetch: sdkFetch, maxTokens: 4096 });
    const sdkCall = sdkFetch.calls[0];
    const sdkBody = requestBody(sdkCall);

    // 2) 把这个 body 原样交给 shim（production 里 shim 就是 pi 用的那个 client）
    const shimFetch = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    await shimClient(shimFetch).beta.messages.create(sdkBody, {}).asResponse();
    const shimCall = shimFetch.calls[0];

    // 3) 线协议等价：同一 pathname、同一组协议 header、逐字相同的 JSON body
    const sdkUrl = new URL(sdkCall.url);
    const shimUrl = new URL(shimCall.url);
    expect(`${shimUrl.origin}${shimUrl.pathname}`).toBe(`${sdkUrl.origin}${sdkUrl.pathname}`);
    expect(shimUrl.search).toBe('');
    expect(sdkUrl.search).toBe('?beta=true');
    expect(shimCall.init.method).toBe(sdkCall.init.method);
    expect(protocolHeaders(shimCall)).toEqual(protocolHeaders(sdkCall));
    expect(requestBody(shimCall)).toEqual(sdkBody);
    // 且 body 确实是 pi 生成的「原生 Messages」形状，而不是我们手写的假货
    expect(Array.isArray(sdkBody.system)).toBe(true);
    expect(typeof sdkBody.max_tokens).toBe('number');
  });

  await test('capability gating: cacheRetention=none drops cache_control, thinking still absent', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['ok'])));
    await compat.completeSimple(model, basicContext, {
      apiKey: API_KEY,
      fetch: fetchImpl,
      cacheRetention: 'none',
    });

    const body = requestBody(fetchImpl.calls[0]);
    // 端点不支持 prompt caching 时，不能发出 cache_control 这种无效字段
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  await test('shim: betas are lifted out of the body into the anthropic-beta header', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      fetch: fetchImpl,
      defaultHeaders: {},
    });
    await client.beta.messages.create(
      { model: 'claude-sonnet-4-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }], betas: ['a-2026-01-01', 'b-2026-02-02'] },
      {},
    ).asResponse();

    expect(header(fetchImpl.calls[0], 'anthropic-beta')).toBe('a-2026-01-01,b-2026-02-02');
    expect(requestBody(fetchImpl.calls[0]).betas).toBeUndefined();
  });

  await test('shim: non-2xx error matches the real SDK byte for byte (status/type/message)', async () => {
    // Anthropic 的标准错误体是嵌套的 error.error.message；SDK 的 makeMessage 只看顶层
    // error.message，因此两边都会退化成 JSON 串。这里直接与真实 SDK 对比，避免我手写
    // 期望值把「我们以为的」当成「SDK 的」。
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };

    let sdkError: any;
    try {
      const client = new RealAnthropic({
        apiKey: API_KEY,
        baseURL: BASE_URL,
        maxRetries: 0,
        fetch: recordingFetch(() => jsonResponse(429, body)),
      });
      await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    } catch (error: any) {
      sdkError = error;
    }

    let shimError: any;
    try {
      await shimClient(recordingFetch(() => jsonResponse(429, body)))
        .beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    } catch (error: any) {
      shimError = error;
    }

    expect(sdkError instanceof RealAnthropic.APIError).toBe(true);
    expect(shimError instanceof ShimAPIError).toBe(true);
    expect(shimError instanceof ShimAnthropic.APIError).toBe(true);
    expect(shimError.status).toBe(sdkError.status);
    expect(shimError.status).toBe(429);
    expect(shimError.type).toBe(sdkError.type);
    expect(shimError.type).toBe('rate_limit_error');
    expect(shimError.message).toBe(sdkError.message);
    expect(shimError.message).toContain('429');
    expect(shimError.headers instanceof Headers).toBe(true);
  });

  await test('shim: non-JSON error bodies still produce a readable message', async () => {
    const fetchImpl = recordingFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    let caught: any;
    try {
      await shimClient(fetchImpl).beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    } catch (error: any) {
      caught = error;
    }
    expect(caught.status).toBe(502);
    expect(caught.message).toContain('502');
    expect(caught.message).toContain('bad gateway');
  });

  await test('shim: header-owned auth (no apiKey) is accepted and normalized to one x-api-key', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({
      baseURL: BASE_URL,
      fetch: fetchImpl,
      defaultHeaders: { 'X-Api-Key': 'from-custom-header' },
    });
    await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();

    // 同名 header 大小写不敏感去重：不能出现两个 x-api-key
    const keys = Object.keys(fetchImpl.calls[0].init.headers).filter((k) => k.toLowerCase() === 'x-api-key');
    expect(keys.length).toBe(1);
    expect(header(fetchImpl.calls[0], 'x-api-key')).toBe('from-custom-header');
  });

  await test('shim: no auth at all fails loudly before any network call', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({ baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {} });
    let caught: any;
    try {
      await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    } catch (error: any) {
      caught = error;
    }
    expect(caught.message).toContain('authentication');
    expect(fetchImpl.calls.length).toBe(0);
  });

  await test('shim: withOptions merges defaultHeaders (federation path shape)', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const base = new ShimAnthropic({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      fetch: fetchImpl,
      defaultHeaders: { 'x-keep': 'kept' },
    });
    const cloned = base.withOptions({ defaultHeaders: { 'x-added': 'added' } });
    await cloned.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();

    expect(header(fetchImpl.calls[0], 'x-keep')).toBe('kept');
    expect(header(fetchImpl.calls[0], 'x-added')).toBe('added');
  });

  await test('shim: the caller signal reaches fetch (cancellation is wired through)', async () => {
    const controller = new AbortController();
    const fetchImpl = recordingFetch(({ init }) => {
      expect(init.signal instanceof AbortSignal).toBe(true);
      return sseResponse(textStreamEvents(['x']));
    });
    const client = new ShimAnthropic({ apiKey: API_KEY, baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {} });
    await client.beta.messages.create(
      { model: 'm', max_tokens: 1, messages: [] },
      { signal: controller.signal },
    ).asResponse();
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ---- F3：没人给 timeout 时必须装 SDK 的 600000ms 默认值 ----
  // 旧行为：options.timeout 为空就直接返回 signal: undefined，连接半死不活时这个回合永远挂着，
  // 而真 SDK 是 `BaseAnthropic.DEFAULT_TIMEOUT = 600000`，会自己中断。
  // 10 分钟的定时器没法等，所以这里截获 setTimeout 看它实际排了多少毫秒（原函数照常调用）。

  /** 截获 setTimeout 的延时参数，跑完 fn 后恢复。 */
  async function captureTimeouts(fn: () => Promise<void>): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (handler: any, ms?: number, ...rest: any[]) => {
      delays.push(Number(ms));
      return (realSetTimeout as any)(handler, ms, ...rest);
    };
    try {
      await fn();
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }
    return delays;
  }

  await test('shim: applies the SDK default timeout (600000ms) when none is supplied', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({ apiKey: API_KEY, baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {} });

    const delays = await captureTimeouts(async () => {
      await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    });

    // 与 SDK 的 DEFAULT_TIMEOUT 一致
    expect(delays.includes(600000)).toBe(true);
  });

  await test('shim: an explicit per-request timeout wins over the default', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({ apiKey: API_KEY, baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {} });

    const delays = await captureTimeouts(async () => {
      await client.beta.messages.create(
        { model: 'm', max_tokens: 1, messages: [] },
        { timeout: 1234 },
      ).asResponse();
    });

    expect(delays.includes(1234)).toBe(true);
    expect(delays.includes(600000)).toBe(false);
  });

  await test('shim: the client-level timeout is honoured when the request omits one', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({
      apiKey: API_KEY, baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {}, timeout: 4321,
    });

    const delays = await captureTimeouts(async () => {
      await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    });

    expect(delays.includes(4321)).toBe(true);
    expect(delays.includes(600000)).toBe(false);
  });

  await test('shim: awaiting create() directly fails loudly instead of returning a Response', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({ apiKey: API_KEY, baseURL: BASE_URL, fetch: fetchImpl, defaultHeaders: {} });
    let caught: any;
    try {
      await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {});
    } catch (error: any) {
      caught = error;
    }
    expect(caught.message).toContain('asResponse');
  });

  await test('shim: trailing slashes in baseURL do not produce //v1/messages', async () => {
    const fetchImpl = recordingFetch(() => sseResponse(textStreamEvents(['x'])));
    const client = new ShimAnthropic({
      apiKey: API_KEY,
      baseURL: `${BASE_URL}/`,
      fetch: fetchImpl,
      defaultHeaders: {},
    });
    await client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [] }, {}).asResponse();
    expect(fetchImpl.calls[0].url).toBe(`${BASE_URL}/v1/messages`);
  });

  /* ------------------------------------------------------------------ */
  /* (g) 模型清单：GET /v1/models（x-api-key 认证，不是 Bearer）            */
  /* ------------------------------------------------------------------ */

  const { listModels, checkAvailability, checkAvailabilityWithStatus, isModelListingUnsupported } =
    await import('../src/services/model-catalog-service');

  /** 记录 requestUrl 调用并按脚本返回 {status, text}。 */
  function listingDeps(handler: (opts: any) => { status: number; text: string }) {
    const calls: any[] = [];
    return {
      calls,
      deps: {
        requestUrl: async (opts: any) => {
          calls.push(opts);
          return handler(opts);
        },
      } as any,
    };
  }

  await test('listModels(anthropic): GET {baseUrl}/v1/models with x-api-key + anthropic-version', async () => {
    const { calls, deps } = listingDeps(() => ({
      status: 200,
      text: JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-5' },
          { id: 'claude-sonnet-4-5', display_name: 'duplicate must be dropped' },
          { id: '   ' },
          { id: '' },
        ],
      }),
    }));

    const models = await listModels(anthropicConfig(), deps);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${BASE_URL}/v1/models`);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers['x-api-key']).toBe(API_KEY);
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    // 不是 Bearer
    expect(calls[0].headers.authorization).toBeUndefined();
    // 按 value 排序、去重、丢掉空 id；有 display_name 时 label 带上 id
    expect(models).toEqual([
      { value: 'claude-opus-4-5', label: 'claude-opus-4-5' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (claude-sonnet-4-5)' },
    ]);
  });

  await test('listModels(anthropic): baseUrl 尾部斜杠被去掉，缺省用官方端点（不带 /v1）', async () => {
    const trailing = listingDeps(() => ({ status: 200, text: '{"data":[]}' }));
    await listModels(anthropicConfig({ baseUrl: `${BASE_URL}/` }), trailing.deps);
    expect(trailing.calls[0].url).toBe(`${BASE_URL}/v1/models`);

    const fallback = listingDeps(() => ({ status: 200, text: '{"data":[]}' }));
    await listModels(anthropicConfig({ baseUrl: '' }), fallback.deps);
    expect(fallback.calls[0].url).toBe('https://api.anthropic.com/v1/models');
  });

  await test('listModels(anthropic): 404 becomes ModelListingUnsupportedError, availability stays true', async () => {
    const { deps } = listingDeps(() => ({ status: 404, text: 'not found' }));

    let caught: any;
    try {
      await listModels(anthropicConfig(), deps);
    } catch (error: any) {
      caught = error;
    }
    expect(isModelListingUnsupported(caught)).toBe(true);
    expect(caught.status).toBe(404);
    expect(caught.code).toBe('model-listing-unsupported');
    // 端点列不了模型 ≠ 端点不能生成：乐观返回 true，由 UI 的手输/兜底列表兜住
    expect(await checkAvailability(anthropicConfig(), deps)).toBe(true);
  });

  await test('listModels(anthropic): 405 / 501 同样算「列表不可用」', async () => {
    for (const status of [405, 501]) {
      const { deps } = listingDeps(() => ({ status, text: '' }));
      let caught: any;
      try {
        await listModels(anthropicConfig(), deps);
      } catch (error: any) {
        caught = error;
      }
      expect(isModelListingUnsupported(caught)).toBe(true);
      expect(await checkAvailability(anthropicConfig(), deps)).toBe(true);
    }
  });

  await test('listModels(anthropic): 401 is a real failure, not a listing-capability gap', async () => {
    const { deps } = listingDeps(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' }));

    let caught: any;
    try {
      await listModels(anthropicConfig(), deps);
    } catch (error: any) {
      caught = error;
    }
    expect(isModelListingUnsupported(caught)).toBe(false);
    expect(caught.message).toContain('401');
    expect(await checkAvailability(anthropicConfig(), deps)).toBe(false);
  });

  await test('listModels(anthropic): missing api key fails before any network call', async () => {
    const { calls, deps } = listingDeps(() => ({ status: 200, text: '{"data":[]}' }));
    let caught: any;
    try {
      await listModels(anthropicConfig({ apiKey: '' }), deps);
    } catch (error: any) {
      caught = error;
    }
    expect(caught.message).toContain('API Key');
    expect(calls.length).toBe(0);
  });

  // ---- F2：探活三态。404 必须报「活着但不会列模型」，不能报成绿色的「可达」 ----
  // 旧行为：checkAvailability 把 404 压成 true，连接测试于是对刚回 404 的 URL 报
  // 「model list reachable at <url>」，而同一屏的模型输入框同时说列不了模型。

  await test('checkAvailabilityWithStatus: 404 on /v1/models → reachable but NOT listing-capable', async () => {
    const { calls, deps } = listingDeps(() => ({ status: 404, text: 'not found' }));

    const status = await checkAvailabilityWithStatus(anthropicConfig(), deps);

    // 关键：走的是真实 404 响应路径（不是断言纯格式化函数）
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${BASE_URL}/v1/models`);
    expect(status.reachable).toBe(true);
    expect(status.listingUnsupported).toBe(true);
    expect(status.error).toBe(undefined);
    // 薄包装语义不变：仍然乐观返回 true（生成能力未被证伪）
    expect(await checkAvailability(anthropicConfig(), deps)).toBe(true);
  });

  await test('checkAvailabilityWithStatus: 405 / 501 同样报 listingUnsupported', async () => {
    for (const code of [405, 501]) {
      const { deps } = listingDeps(() => ({ status: code, text: '' }));
      const status = await checkAvailabilityWithStatus(anthropicConfig(), deps);
      expect(status.reachable).toBe(true);
      expect(status.listingUnsupported).toBe(true);
    }
  });

  await test('checkAvailabilityWithStatus: 401 → unreachable with an error', async () => {
    const { deps } = listingDeps(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' }));

    const status = await checkAvailabilityWithStatus(anthropicConfig(), deps);

    expect(status.reachable).toBe(false);
    expect(status.listingUnsupported).toBe(false);
    expect(status.error instanceof Error).toBe(true);
    expect(await checkAvailability(anthropicConfig(), deps)).toBe(false);
  });

  await test('checkAvailabilityWithStatus: 200 with a real list → reachable and listing-capable', async () => {
    const { deps } = listingDeps(() => ({
      status: 200,
      text: JSON.stringify({ data: [{ id: 'claude-opus-4-5' }] }),
    }));

    const status = await checkAvailabilityWithStatus(anthropicConfig(), deps);

    expect(status.reachable).toBe(true);
    expect(status.listingUnsupported).toBe(false);
    expect(status.error).toBe(undefined);
  });

  /* ------------------------------------------------------------------ */
  /* (h) 打包策略自证：SDK 没进 bundle、shim 进了                          */
  /* ------------------------------------------------------------------ */

  const { existsSync, readFileSync, statSync } = await import('fs');
  if (!existsSync('dist/main.js')) {
    console.log('  SKIP bundle strategy checks (dist/main.js not built — run `npm run build` first)');
  } else {
    await test('bundle: uses the shim and does NOT inline @anthropic-ai/sdk', () => {
      const source = readFileSync('dist/main.js', 'utf8');
      expect(source.includes('anthropic-sdk-shim')).toBe(true);
      expect(source.includes('// node_modules/@anthropic-ai/sdk/')).toBe(false);
    });

    await test('bundle: keeps the openai catalog and drops the unused provider catalogs', () => {
      const source = readFileSync('dist/main.js', 'utf8');
      // 保留的那家 provider 真的读自己的目录，掏空会让 openai 退化成「没有模型」
      expect(source.includes('providers/data/openai.json')).toBe(true);
      // 'gemini' 协议移除后 pi 的 google provider 不再保留（见 esbuild.config.mjs 的
      // KEPT_PI_PROVIDERS），于是 google.json 与其余用不到的目录一样离开包。
      expect(source.includes('providers/data/google.json')).toBe(false);
      // 用不到的 provider 目录（近 1MB）必须不在包里
      expect(source.includes('providers/data/openrouter.json')).toBe(false);
      expect(source.includes('providers/data/amazon-bedrock.json')).toBe(false);
    });

    await test('bundle: stays under the 4.8 MiB budget', () => {
      const bytes = statSync('dist/main.js').size;
      expect(bytes < 4.8 * 1024 * 1024).toBe(true);
      expect(bytes < 5 * 1024 * 1024).toBe(true);
    });
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
