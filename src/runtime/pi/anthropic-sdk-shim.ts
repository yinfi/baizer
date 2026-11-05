/**
 * anthropic-sdk-shim.ts
 *
 * `@anthropic-ai/sdk` 的最小替身：只实现 pi-ai 的 `anthropic-messages` api 真正用到的那一面。
 *
 * ## 为什么需要它
 *
 * issue #58 要求「优先复用当前 pi-ai 的 Anthropic 适配能力，避免另建平行推理栈」，
 * 所以协议层（消息转换、content block、tool_use/tool_result、SSE 解析、thinking 映射）
 * 全部留在 pi-ai 的 `dist/api/anthropic-messages.js` 里，本模块一行都不碰。
 * 但那个文件顶层 `import Anthropic from "@anthropic-ai/sdk"`，把整个 SDK 打进单文件
 * bundle 要多约 650KB（SDK 自身 716.7KB input，还拖来 fast-sha256 / @stablelib/base64 /
 * standardwebhooks），实测会让 dist/main.js 从 5,006,087 B 涨到 5,658,476 B —— 越过
 * 5,242,880 B（5MB）的 Obsidian Sync 硬限。详见 esbuild.config.mjs 里 KEPT_PI_APIS
 * 与 aliasAnthropicSdkToShim 的注释与实测数字。
 *
 * ## pi 到底用了 SDK 的什么（逐条对照 dist/api/anthropic-messages.js 核实）
 *
 *  1. `class PiAnthropic extends Anthropic { ... }` —— 需要一个可 `new`、可被继承的类。
 *  2. `new PiAnthropic({ apiKey, authToken, baseURL, dangerouslyAllowBrowser, fetch, defaultHeaders })`
 *  3. `client.beta.messages.create(params, requestOptions).asResponse()` —— 只要**原始 Response**；
 *     pi 自己用 `iterateAnthropicEvents` 解析 SSE，所以本模块**不解析任何响应体**。
 *  4. `Anthropic.APIError` —— 用于 `instanceof` 判断与读 `.status` / `.type` / `.message`。
 *  5. `client.withOptions({ defaultHeaders })` —— 只出现在 workload identity federation 分支
 *     （需要 ANTHROPIC_FEDERATION_RULE_ID 等环境变量），Baizer 走不到，但为保真仍实现。
 *
 * 也就是说，本模块只负责「拼 URL + 拼 header + 发 fetch + 非 2xx 抛 APIError」。
 *
 * ## 与真实 SDK 的行为对齐点（都是照 node_modules/@anthropic-ai/sdk 的源码抄的）
 *
 *  - 非 2xx 时抛 `APIError`，message 形如 `${status} ${error.message}`，`.type` 取
 *    `body.error.type`。pi 的 catch 分支靠它把 401/429 变成可读的错误事件
 *    （见 anthropic-messages.js 的 `!(error instanceof Anthropic.APIError)` 判断）。
 *  - `betas` / `user_profile_id` / `workspace_id` 从请求体里摘掉，`betas` 转成
 *    `anthropic-beta` header（SDK 的 beta/messages.create 就是这么做的）。
 *  - `anthropic-version: 2023-06-01` 是默认值，可被 `defaultHeaders` 覆盖。
 *  - header 合并顺序与 SDK 的 buildHeaders 一致：内置默认 → 认证 → defaultHeaders →
 *    body 派生（anthropic-beta）→ 单次请求 header，后者覆盖前者；同名 header 大小写
 *    不敏感地去重，避免 `x-api-key` 发两遍。
 *  - 超时与 SDK 的 fetchWithTimeout 同语义：只覆盖「拿到响应头之前」，拿到 Response 后
 *    即清除定时器，长流式响应不会被超时打断。
 *
 * ## 有意与真实 SDK 不同的两点（都是为了让「漂移」出声，而不是静默出错）
 *
 *  - 请求 URL 不追加 `?beta=true`。SDK 的 `client.beta.messages.create` 会打
 *    `/v1/messages?beta=true`，那个 query 只是 SDK 内部的 beta 路由标记，线协议完全相同；
 *    去掉它可以让 URL 就是干净的 `/v1/messages`，对严格校验 query 的兼容网关更安全。
 *  - `asResponse()` 之外的 Promise 用法（`await create(...)`、`.then()`）会**抛错**而不是
 *    返回 Response。SDK 的 APIPromise 在 `.then()` 时会解析响应体成消息对象，本模块没有
 *    解析能力；与其静默给出形状不对的值，不如让 pi-ai 的用法漂移立刻炸出来。
 *    （esbuild.config.mjs 的 aliasAnthropicSdkToShim 在构建期也做同样的核对。）
 */

import { asString, prop } from '../../utils/narrow';

/** Anthropic 官方端点（与 src/mcp/types.ts 的 DEFAULT_PROVIDERS.anthropic.baseUrl 一致）。 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Anthropic 要求的 API 版本头，SDK 0.129.0 的默认值。 */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * SDK 的默认请求超时（client.js: `BaseAnthropic.DEFAULT_TIMEOUT = 600000`，10 分钟）。
 *
 * 必须照抄：真 SDK 即使调用方一个 timeout 都没给，也会在请求上装这个上限
 * （`this.timeout = options.timeout ?? DEFAULT_TIMEOUT` → `options.timeout = options.timeout ?? this.timeout`
 * → fetchWithTimeout 里 setTimeout(abort, ms)）。shim 若在「没人给 timeout」时干脆不装信号，
 * 连接半死不活时这个回合会永远挂着 —— 真 SDK 会自己中断，两边行为必须一致。
 * 注意 pi 的调用方（model-service 的 generate）刻意不转发 timeoutMs，改用 AbortSignal 表达超时，
 * 所以「没人给 timeout」是常态路径而不是边缘情况。
 */
const DEFAULT_TIMEOUT_MS = 600000;

/** 判定「请求已经带了认证」时要看的 header（与 pi 的 hasRequestAuth 同一套）。 */
const AUTH_HEADERS = ['x-api-key', 'authorization', 'cf-aig-authorization'];

/** 单次请求可覆盖项，对齐 SDK RequestOptions 里 pi 会传的那几个。 */
export interface AnthropicShimRequestOptions {
  signal?: AbortSignal;
  /** 毫秒；只覆盖拿到响应头之前，与 SDK 的 fetchWithTimeout 同语义。 */
  timeout?: number;
  headers?: Record<string, string | null | undefined>;
  /** pi 传 0 并自己用 retryProviderRequest 重试，本模块不实现重试。 */
  maxRetries?: number;
}

/** 构造函数入参，字段名逐字对齐 pi 的 createClient。 */
export interface AnthropicShimClientOptions {
  apiKey?: string | null;
  authToken?: string | null;
  baseURL?: string;
  defaultHeaders?: Record<string, string | null | undefined>;
  dangerouslyAllowBrowser?: boolean;
  fetch?: typeof fetch;
  /**
   * 客户端级超时（毫秒），对应 SDK ClientOptions.timeout。
   * 真 SDK 是 `this.timeout = options.timeout ?? DEFAULT_TIMEOUT`，单次请求可覆盖；
   * shim 同样支持，未提供时退到 DEFAULT_TIMEOUT_MS。pi 不传这个字段。
   */
  timeout?: number;
  /** federation 配置，真实 SDK 用它换 token；本模块不实现，仅接受该字段。 */
  config?: unknown;
}

/**
 * 非 2xx 响应错误。字段与 message 生成规则照抄 SDK 的 `core/error.js`，
 * 这样用户看到的报错文本与用官方 SDK 时一致（例如 "401 invalid x-api-key"）。
 */
export class APIError extends Error {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  readonly error: unknown;
  readonly type: string | null;

  constructor(
    status: number | undefined,
    error: unknown,
    message: string | undefined,
    headers: Headers | undefined,
    type?: string | null,
  ) {
    super(APIError.makeMessage(status, error, message));
    this.name = 'APIError';
    this.status = status;
    this.headers = headers;
    this.error = error;
    this.type = type ?? null;
  }

  /** 与 SDK 的 APIError.makeMessage 逐字一致。error 是解析后的响应体,当外部输入处理。 */
  static makeMessage(status: number | undefined, error: unknown, message: string | undefined): string {
    const errorMessage = prop(error, 'message');
    const msg = errorMessage
      ? typeof errorMessage === 'string'
        ? errorMessage
        : JSON.stringify(errorMessage)
      : error
        ? JSON.stringify(error)
        : message;
    if (status && msg) return `${status} ${msg}`;
    if (status) return `${status} status code (no body)`;
    if (msg) return msg;
    return '(no status code or body)';
  }

  /**
   * 与 SDK 的 APIError.generate 等价（SDK 会按 status 返回 AuthenticationError /
   * RateLimitError 等子类；pi 只做 `instanceof APIError` 与读 status/type，
   * 故这里统一返回 APIError，避免为一个没人检查的类名多写 8 个空子类）。
   * errorResponse 是解析后的响应体,当外部输入处理。
   */
  static generate(
    status: number | undefined,
    errorResponse: unknown,
    message: string | undefined,
    headers: Headers | undefined,
  ): APIError {
    const type = asString(prop(prop(errorResponse, 'error'), 'type'));
    return new APIError(status, errorResponse, message, headers, type);
  }
}

/**
 * `client.beta.messages.create(...)` 的返回值。
 *
 * 真实 SDK 是 `APIPromise`：惰性发请求，`.asResponse()` 给原始 Response，`.then()` 给解析后的消息。
 * 本模块保持「惰性」与 `.asResponse()`，但把 `.then()` 系列做成抛错 —— 见文件头注释。
 */
class AnthropicAPIPromise {
  private responsePromise: Promise<Response> | undefined;

  constructor(private readonly start: () => Promise<Response>) {}

  asResponse(): Promise<Response> {
    // 惰性：与 SDK 一致，不在 create() 时就把请求发出去（避免无人消费时的 unhandled rejection）。
    this.responsePromise ??= this.start();
    return this.responsePromise;
  }

  then(): never {
    throw new Error(
      'anthropic-sdk-shim: 只支持 .asResponse()。pi-ai 的 anthropic-messages api 若改为 ' +
        'await client.beta.messages.create(...)，说明用法已漂移，请重新核对 shim 与 ' +
        'esbuild.config.mjs 的 aliasAnthropicSdkToShim。',
    );
  }

  catch(): never {
    return this.then();
  }

  finally(): never {
    return this.then();
  }
}

/**
 * 逐字对齐 SDK buildHeaders 的覆盖顺序，并做大小写不敏感去重。
 * 顺序（后者覆盖前者）：内置默认 → 认证 → defaultHeaders → anthropic-beta → 单次请求 header。
 */
function mergeHeaders(
  base: Array<[string, string | null | undefined]>,
  ...sources: Array<Record<string, string | null | undefined> | undefined>
): Record<string, string> {
  const merged = new Map<string, string>();
  const put = (name: string, value: string | null | undefined) => {
    // SDK 的 buildHeaders 会丢弃 null（"explicitly omitted" 语义）与 undefined。
    if (value === null || value === undefined) return;
    merged.set(name.toLowerCase(), String(value));
  };

  for (const [name, value] of base) put(name, value);
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) put(name, value);
  }
  return Object.fromEntries(merged);
}

/** `betas` → `anthropic-beta` 的值（SDK 用数组的 toString()，即逗号连接）。 */
function betaHeaderValue(betas: unknown): string | undefined {
  if (betas === null || betas === undefined) return undefined;
  if (Array.isArray(betas)) return betas.length > 0 ? betas.join(',') : undefined;
  return String(betas);
}

/** 拼接 baseURL 与 path；顺手去掉尾部斜杠，避免 `//v1/messages`。 */
function joinUrl(baseURL: string | undefined, path: string): string {
  const base = (baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}${path}`;
}

/** JSON.parse，失败返回 undefined（对齐 SDK 的 safeJSON）。 */
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Anthropic 客户端替身。导出为 default 是因为 pi 写的是
 * `import Anthropic, {} from "@anthropic-ai/sdk"`（默认导入）。
 */
export default class Anthropic {
  /** pi 用 `error instanceof Anthropic.APIError` 判断，故必须挂在类上。 */
  static APIError = APIError;

  readonly apiKey: string | null;
  readonly authToken: string | null;
  readonly baseURL: string;
  /** pi 不读它，但 SDK 有这个字段，暴露出来便于排查。 */
  readonly fetch: typeof fetch | undefined;

  private readonly defaultHeaders: Record<string, string | null | undefined>;
  private readonly dangerouslyAllowBrowser: boolean;
  private readonly options: AnthropicShimClientOptions;

  constructor(options: AnthropicShimClientOptions = {}) {
    this.options = options;
    this.apiKey = options.apiKey ?? null;
    this.authToken = options.authToken ?? null;
    this.baseURL = options.baseURL?.trim() || DEFAULT_BASE_URL;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.dangerouslyAllowBrowser = options.dangerouslyAllowBrowser === true;
    this.fetch = options.fetch;
  }

  /** 克隆一个只改 defaultHeaders 的客户端（SDK 用它共享 federation token 缓存）。 */
  withOptions(overrides: { defaultHeaders?: Record<string, string | null | undefined> } = {}): Anthropic {
    return new (this.constructor as typeof Anthropic)({
      ...this.options,
      ...overrides,
      defaultHeaders: { ...this.defaultHeaders, ...(overrides.defaultHeaders ?? {}) },
    });
  }

  get beta(): { messages: { create: (params: any, options?: AnthropicShimRequestOptions) => AnthropicAPIPromise } } {
    return { messages: { create: (params, options) => this.createMessage(params, options) } };
  }

  /** 非 beta 别名；pi 不用，但保留以免调用方切过去时缺方法。 */
  get messages(): { create: (params: any, options?: AnthropicShimRequestOptions) => AnthropicAPIPromise } {
    return this.beta.messages;
  }

  private createMessage(params: any, options?: AnthropicShimRequestOptions): AnthropicAPIPromise {
    return new AnthropicAPIPromise(() => this.performRequest(params, options));
  }

  private async performRequest(params: any, options?: AnthropicShimRequestOptions): Promise<Response> {
    // SDK 的 beta/messages.create 会把这三个字段从 body 里摘掉，betas 转成 header。
    const { betas, user_profile_id: _userProfileId, workspace_id: _workspaceId, ...body } = params ?? {};

    const headers = mergeHeaders(
      [
        ['accept', 'application/json'],
        ...(this.dangerouslyAllowBrowser
          ? ([['anthropic-dangerous-direct-browser-access', 'true']] as Array<[string, string]>)
          : []),
        ['anthropic-version', DEFAULT_ANTHROPIC_VERSION],
        ['x-api-key', this.apiKey],
        ['authorization', this.authToken ? `Bearer ${this.authToken}` : undefined],
      ],
      this.defaultHeaders,
      // body 派生 header 排在 defaultHeaders 之后（SDK 的 buildBody / betas 走 options.headers）。
      // anthropic-beta 来自 body 的 betas；pi 已把用户配置的 anthropic-beta 并进该数组，不会丢。
      { 'content-type': 'application/json', 'anthropic-beta': betaHeaderValue(betas) },
      options?.headers,
    );

    this.assertAuth(headers);

    const { signal, cleanup } = this.buildAbortSignal(options);
    try {
      const response = await this.resolveFetch()(joinUrl(this.baseURL, '/v1/messages'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await this.toApiError(response);
      return response;
    } finally {
      // 拿到响应头即清除超时定时器（SDK 的 fetchWithTimeout 用 .finally 做同样的事），
      // 这样长流式响应不会被整体超时打断。
      cleanup();
    }
  }

  /**
   * 认证兜底。判据刻意与 pi 的 hasRequestAuth 完全一致（apiKey / authToken /
   * x-api-key / authorization / cf-aig-authorization 任一存在即可），
   * 保证本模块不会比 pi 自身更严格，从而不会把自定义 header 认证的网关挡在门外。
   */
  private assertAuth(headers: Record<string, string>): void {
    if (this.apiKey || this.authToken) return;
    const hasHeaderAuth = AUTH_HEADERS.some((name) => {
      const value = headers[name];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (hasHeaderAuth) return;
    throw new Error(
      'Could not resolve authentication method. Expected either apiKey or authToken to be set, ' +
        'or one of the X-Api-Key / Authorization / cf-aig-authorization headers.',
    );
  }

  /**
   * 合并调用方 signal 与超时。注意 `globalThis.fetch` 必须**调用时**再取：
   * main.ts 的 installRequestUrlFetchFallback() 在 onload 里替换全局 fetch
   * （绕 CORS + 保留流式），模块加载期取到的会是替换前的原生 fetch。
   */
  private resolveFetch(): typeof fetch {
    // window.fetch 可能被 main.ts 的 installRequestUrlFetchFallback() 运行期替换;
    // 这里按声明类型读取(window 本身自带 fetch?: typeof fetch),不绕成 any。
    const impl: typeof fetch | undefined = this.fetch ?? window.fetch;
    if (typeof impl !== 'function') {
      throw new Error('anthropic-sdk-shim: no fetch implementation available in this environment.');
    }
    return impl.bind(window);
  }

  private buildAbortSignal(options?: AnthropicShimRequestOptions): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const caller = options?.signal;
    // 与 SDK 对齐：单次请求没给 timeout 就退到客户端级 timeout，再没有就用 600000ms 默认值。
    // 非正数（含显式 0）也走默认值 —— SDK 对显式 timeout 会 validatePositiveInteger 直接报错，
    // 我们这里选择「按默认值兜住」，不把一个 SDK 认为非法的输入变成永久挂起。
    const requested = options?.timeout ?? this.options.timeout;
    const timeoutMs = typeof requested === 'number' && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (caller) {
      if (caller.aborted) controller.abort();
      else caller.addEventListener('abort', abort, { once: true });
    }
    const timer = window.setTimeout(abort, timeoutMs);

    return {
      signal: controller.signal,
      cleanup: () => {
        window.clearTimeout(timer);
        caller?.removeEventListener('abort', abort);
      },
    };
  }

  /** 非 2xx → APIError，读取 body 的规则照抄 SDK 的 client.js（errText → safeJSON → generate）。 */
  private async toApiError(response: Response): Promise<APIError> {
    const errText = await response.text().catch((error: unknown) => {
      const message = asString(prop(error, 'message'));
      return message ?? String(error);
    });
    const errJson = safeJson(errText);
    const errMessage = errJson ? undefined : errText;
    return APIError.generate(response.status, errJson, errMessage, response.headers);
  }
}
