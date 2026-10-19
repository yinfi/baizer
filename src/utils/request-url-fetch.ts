/**
 * request-url-fetch.ts
 *
 * 为什么需要它
 * ----------
 * Obsidian 桌面端运行在 Electron renderer 进程（origin: app://obsidian.md），
 * window.fetch 遵循浏览器 CORS 策略。部分 OpenAI-compatible 端点
 * （如 opencode.ai 的 /v1/chat/completions）不返回 Access-Control-Allow-Origin，
 * 导致 LLM 调用直接 net::ERR_FAILED。而 Obsidian 的 requestUrl（v1.8.9 实测）
 * 是**整体缓冲**的——返回 { status, headers, arrayBuffer, text }，不支持流式，
 * `stream: true` 会被运行时静默忽略。
 *
 * 方案（三级传输链）
 * -----------------
 * 在全局安装 fetch 垫片（main.ts onload 最早处调用），按序尝试：
 *   1. 原生 fetch —— CORS 友好的端点（DeepSeek 官方、Gemini 等）保持浏览器
 *      原生语义与流式，行为完全不变；
 *   2. Node http/https 传输 —— 原生 fetch 抛 TypeError（CORS 拦截 / mixed
 *      content / 网络失败）时启用。Obsidian 桌面 renderer 的 CJS require 可
 *      解析 Node 内建模块（Claudian 等插件同款做法），Node 请求**完全不受
 *      CORS 约束**，且响应 body 走 res.on('data') 事件流，**逐块流式**；
 *   3. requestUrl 兜底 —— Node 传输不可用（移动端）/失败时，用 Obsidian
 *      requestUrl 重放（绕过 CORS 但整体缓冲，功能完整、无流式）。
 *
 * 为什么能兜住 pi-ai / @google/generative-ai：
 *   - openai SDK 每次 new OpenAI(...) 时通过 `options.fetch ?? getDefaultFetch()`
 *     捕获全局 fetch（pi-ai 的 createClient 每次调用都新建 client），垫片在
 *     模块加载后安装即可被后续所有请求拾取；
 *   - generative-ai 在请求时刻动态引用全局 fetch。
 */

import { requestUrl as obsidianRequestUrl } from 'obsidian';
import { logger } from './logger';

export interface RequestUrlFetchDeps {
  requestUrl: typeof obsidianRequestUrl;
}

const DEFAULT_DEPS: RequestUrlFetchDeps = { requestUrl: obsidianRequestUrl };

let installed = false;

/**
 * 安装全局 fetch 垫片（幂等）。必须在任何 LLM / HTTP 请求发起前调用——
 * main.ts onload 的最早处。
 *
 * @param deps - 测试注入点；缺省使用 obsidian 的真实 requestUrl。
 */
export function installRequestUrlFetchFallback(deps?: RequestUrlFetchDeps): void {
  if (installed) return;
  const g = globalThis as unknown as { fetch?: typeof fetch };
  const nativeFetch = g.fetch;
  if (typeof nativeFetch !== 'function') return;
  installed = true;
  const fallback = deps ?? DEFAULT_DEPS;
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      // 1) 浏览器原生 fetch：CORS 友好的端点保持原生流式与中断语义
      return await nativeFetch(input, init);
    } catch (err) {
      // CORS 拦截 / mixed content / 网络层失败都表现为 TypeError；其它错误
      // （编程错误、主动 abort 的 AbortError 等）保持原样上抛。
      if (!(err instanceof TypeError)) throw err;
      logger.warn(
        'Native fetch failed (CORS/network); retrying via node http(s) / requestUrl',
        'fetch-fallback',
        {
          url: resolveUrl(input),
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // 2) Node http/https：桌面端可用，无 CORS 且真流式
      const transport = getNodeTransport();
      if (transport) {
        try {
          return await nodeHttpFetch(transport, input, init);
        } catch (nodeErr) {
          logger.warn('Node http(s) fetch failed; falling back to requestUrl', 'fetch-fallback', {
            url: resolveUrl(input),
            error: nodeErr instanceof Error ? nodeErr.message : String(nodeErr),
          });
        }
      }
      // 3) requestUrl 兜底：绕过 CORS，但整体缓冲（无流式）
      return requestUrlFetch(input, init, fallback);
    }
  };
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/* ------------------------------------------------------------------ */
/* Node http/https 传输层（Obsidian 桌面 renderer，绕过 CORS、支持流式） */
/* ------------------------------------------------------------------ */

interface NodeTransport {
  https: any;
  http: any;
}

let cachedNodeTransport: NodeTransport | null | undefined;

/**
 * 惰性探测 Node 传输能力。Obsidian 桌面 renderer 的 CJS require 可解析
 * node 内建模块；移动端 / 无 require 环境返回 null（走浏览器链路）。
 */
function getNodeTransport(): NodeTransport | null {
  if (cachedNodeTransport !== undefined) return cachedNodeTransport;
  cachedNodeTransport = null;
  try {
    const g = globalThis as any;
    const requireFn =
      typeof g.require === 'function'
        ? g.require
        : typeof require === 'function'
          ? require
          : null;
    if (!requireFn) return null;
    const https = requireFn('https');
    const http = requireFn('http');
    if (!https || !http || typeof https.request !== 'function' || typeof http.request !== 'function') {
      return null;
    }
    cachedNodeTransport = { https, http };
  } catch {
    cachedNodeTransport = null;
  }
  return cachedNodeTransport;
}

/**
 * 用 Node http/https 执行请求，包装成 WHATWG Response（body 为增量 ReadableStream）。
 * 请求体统一缓冲（LLM 请求体是小型 JSON），响应体逐块流式。
 */
export async function nodeHttpFetch(
  transport: NodeTransport,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (input instanceof Request && input.bodyUsed) {
    throw new TypeError(
      'node http(s) fallback: request body was already consumed by the native fetch attempt',
    );
  }

  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`node http(s) fallback: unsupported protocol ${url.protocol}`);
  }
  const method = request.method;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // 请求 Node 不压缩响应，避免 gzip 时 SSE 解析错乱
  if (!('accept-encoding' in headers)) {
    headers['accept-encoding'] = 'identity';
  }

  let body: Uint8Array | null = null;
  const rawBody: BodyInit | null | undefined =
    init?.body ?? (input instanceof Request ? input.body : undefined);
  if (rawBody != null) {
    body = new Uint8Array(await request.arrayBuffer());
  }

  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return nodeRequest(transport, url, method, headers, body, signal, MAX_REDIRECTS);
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function nodeRequest(
  transport: NodeTransport,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
  signal: AbortSignal | undefined,
  redirectsLeft: number,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? transport.https : transport.http;
    let settled = false;
    let req: any = null;

    const cleanupSignal = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      req?.destroy();
      fail(toAbortError(signal));
    };

    req = mod.request(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body ? { 'content-length': String(body.byteLength) } : {}),
        },
      },
      (res: any) => {
        if (settled) return;
        const status = res.statusCode ?? 0;
        const location = res.headers?.location;
        if (REDIRECT_STATUSES.has(status) && location && redirectsLeft > 0) {
          settled = true;
          cleanupSignal();
          res.resume(); // 丢弃重定向响应体，释放连接
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch (e) {
            fail(e);
            return;
          }
          // 303 一律转 GET；其余保持方法/请求体
          const nextMethod = status === 303 ? 'GET' : method;
          const nextBody = status === 303 ? null : body;
          const nextHeaders = nextBody ? headers : stripBodyHeaders(headers);
          resolve(nodeRequest(transport, nextUrl, nextMethod, nextHeaders, nextBody, signal, redirectsLeft - 1));
          return;
        }
        settled = true;
        cleanupSignal();
        resolve(buildNodeResponse(res, signal));
      },
    );

    req.on('error', (error: any) => fail(error));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (body) req.end(body);
    else req.end();
  });
}

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  delete next['content-length'];
  delete next['content-type'];
  return next;
}

function buildNodeResponse(res: any, signal?: AbortSignal): Response {
  const status = res.statusCode ?? 200;
  const statusText = res.statusMessage ?? '';

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) headers[key] = item;
      }
    } else {
      headers[key] = String(value);
    }
  }

  const noBody = status === 204 || status === 205 || status === 304;
  if (noBody) {
    res.resume();
    return new Response(null, { status, statusText, headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const onData = (chunk: any) => {
        if (closed) return;
        try {
          // chunk 是 Node Buffer（Uint8Array 子类）→ 拷贝成独立 Uint8Array
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          /* 流已关闭 */
        }
      };
      const onEnd = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      };
      const onError = (error: any) => {
        if (closed) return;
        closed = true;
        controller.error(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => {
        if (closed) return;
        closed = true;
        try {
          res.destroy();
        } catch {
          /* 已断开 */
        }
        controller.error(toAbortError(signal));
      };

      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', onError);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    cancel() {
      try {
        res.destroy();
      } catch {
        /* 已断开 */
      }
    },
  });

  return new Response(stream, { status, statusText, headers });
}

/* ------------------------------------------------------------------ */
/* requestUrl 兜底（整体缓冲）                                          */
/* ------------------------------------------------------------------ */

/** Obsidian 运行时的流式请求参数（d.ts 未声明 stream 字段；1.8.9 实测忽略）。 */
type StreamingRequestUrlParam = Parameters<typeof obsidianRequestUrl>[0] & { stream?: boolean };

/** Obsidian 流式响应体：Node 风格事件流（'data' / 'end' / 'error'）。 */
interface StreamableBody {
  on(event: 'data' | 'end' | 'error', listener: (...args: any[]) => void): unknown;
}

/**
 * 用 Obsidian requestUrl 执行一次请求，并包装成 WHATWG Response。
 * 原生 fetch / Node 传输都失败时的最后兜底；整体缓冲（无流式）。
 */
export async function requestUrlFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  deps: RequestUrlFetchDeps = DEFAULT_DEPS,
): Promise<Response> {
  // 原生 fetch 已消费过 body 的 Request 无法重放，直接报错更诚实。
  if (input instanceof Request && input.bodyUsed) {
    throw new TypeError(
      'requestUrl fallback: request body was already consumed by the native fetch attempt',
    );
  }

  const request = new Request(input, init);
  const url = request.url;
  const method = request.method;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: string | ArrayBuffer | undefined;
  const rawBody: BodyInit | null | undefined =
    init?.body ?? (input instanceof Request ? input.body : undefined);
  if (rawBody != null) {
    if (typeof rawBody === 'string' || rawBody instanceof URLSearchParams) {
      // 字符串保持原样，避免 ArrayBuffer 转换引入编码差异
      body = rawBody.toString();
    } else if (rawBody instanceof ArrayBuffer) {
      body = rawBody;
    } else if (ArrayBuffer.isView(rawBody)) {
      const view = rawBody as ArrayBufferView;
      body = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    } else {
      // Blob / FormData / ReadableStream：统一缓冲成 ArrayBuffer
      body = await request.arrayBuffer();
    }
  }

  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) {
    throw toAbortError(signal);
  }

  const res = await deps.requestUrl({
    url,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    throw: false,
    // 请求流式响应：仅部分 Obsidian 版本运行时支持，d.ts 未声明。
    stream: true,
  } as StreamingRequestUrlParam as any);

  // 下载期间被 abort：不再交付数据
  if (signal?.aborted) {
    throw toAbortError(signal);
  }

  const status = res.status ?? 200;
  const noBody = status === 204 || status === 205 || status === 304;
  if (noBody) {
    return new Response(null, { status, statusText: '', headers: { ...res.headers } });
  }

  // 若运行时真的提供了事件流 body（部分版本），逐块交付
  const streamBody = (res as any)?.body as StreamableBody | undefined;
  if (streamBody && typeof streamBody.on === 'function') {
    return buildStreamingResponse(status, res.headers, streamBody, signal);
  }

  // 常规 requestUrl：整体缓冲
  return buildBufferedResponse(res, signal);
}

/** 把 Obsidian 的事件流 body 包装成 WHATWG ReadableStream，逐块交付。 */
function buildStreamingResponse(
  status: number,
  headers: Record<string, string>,
  body: StreamableBody,
  signal?: AbortSignal,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const onData = (chunk: any) => {
        if (closed) return;
        let bytes: Uint8Array;
        if (typeof chunk === 'string') {
          bytes = new TextEncoder().encode(chunk);
        } else if (chunk instanceof Uint8Array) {
          bytes = chunk;
        } else if (chunk instanceof ArrayBuffer) {
          bytes = new Uint8Array(chunk);
        } else {
          bytes = new Uint8Array(chunk); // Buffer / 其它 TypedArray
        }
        try {
          controller.enqueue(bytes);
        } catch {
          // 流已被 close/error，忽略迟到的块
        }
      };
      const onEnd = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      };
      const onError = (err: any) => {
        if (closed) return;
        closed = true;
        controller.error(err instanceof Error ? err : new Error(String(err)));
      };
      const onAbort = () => {
        if (closed) return;
        closed = true;
        controller.error(toAbortError(signal));
      };

      body.on('data', onData);
      body.on('end', onEnd);
      body.on('error', onError);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
  });
  return new Response(stream, { status, statusText: '', headers: { ...headers } });
}

/** 把 requestUrl 的整体缓冲响应包装成 WHATWG Response（单块 ReadableStream）。 */
function buildBufferedResponse(
  res: {
    status: number;
    headers: Record<string, string>;
    arrayBuffer?: ArrayBuffer;
    text?: string;
  },
  signal?: AbortSignal,
): Response {
  const status = res.status ?? 200;
  const noBody = status === 204 || status === 205 || status === 304;
  const bodyBytes = noBody
    ? null
    : (res.arrayBuffer ?? new TextEncoder().encode(res.text ?? '').buffer);

  let body: ReadableStream<Uint8Array> | null = null;
  if (bodyBytes) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal) {
          if (signal.aborted) {
            controller.error(toAbortError(signal));
            return;
          }
          // requestUrl 无法真正取消底层连接；abort 后停止本地交付，
          // 让调用方（OpenAI SDK 的 SSE 迭代器）立即收到中止错误。
          signal.addEventListener('abort', () => controller.error(toAbortError(signal)), {
            once: true,
          });
        }
        controller.enqueue(new Uint8Array(bodyBytes));
        controller.close();
      },
    });
  }

  return new Response(body, { status, statusText: '', headers: { ...res.headers } });
}

function toAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError');
}
