import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { ModelOption } from '../models/interfaces';
import { ProviderConfig } from '../mcp/types';
import { ProviderCapabilities } from '../runtime/provider-capabilities';
import { logger } from '../utils/logger';

/**
 * model-catalog-service —— provider 元数据服务（非 runtime）。
 *
 * pi-agent runtime 只覆盖「LLM 推理」；provider 的元能力（列模型 / 探活 / 能力声明）
 * pi 不提供动态版本（pi-ai 只有编译期静态 getModels()，无运行时 REST 探测）。
 * 为保留「用户自定义 baseUrl 下动态列模型」的能力，这些元能力从旧的 per-provider
 * 包装层（已被 pi runtime 取代）剥离到此处，作为独立的 HTTP 元数据查询层。
 *
 * 关键区别：这里的调用都是纯 REST 元数据请求，**不触发任何 LLM 推理**，
 * 因此不属于 runtime 迁移范畴。checkAvailability 也改为轻量的端点 200 探测，
 * 不再像旧 provider 那样发一次 generateContent('Hello') 烧 token。
 */

/** Anthropic 要求的 API 版本头（SDK 0.129.0 与官方 REST 文档一致）。 */
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic 官方端点。注意官方 baseUrl **不带** /v1（见 src/mcp/types.ts 的说明）。 */
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * 列模型请求的应用层超时。
 *
 * 背景（#81）：Obsidian `requestUrl` 没有 `AbortSignal`/超时参数，弱网或 Captive Portal
 * 下请求可以挂起到系统级 TCP 超时（经验上可达数十秒到数分钟）。设置页每次整页/分区重绘都会
 * 无条件重新拉一次模型清单（见 renderModelField 的 `void load(false)`），移动端弱网下
 * 请求挂起期间主线程被反复唤醒、下拉长期停在 Loading，这是 issue 列的嫌疑点之二。
 * 这里不改调用时机（那属于「清空缓存」那一层的职责），只保证单次请求不会无限挂起。
 */
const MODEL_LISTING_TIMEOUT_MS = 10_000;

/** requestUrl 没有取消能力；超时只能让等待方提前放弃，底层请求可能仍在飞，但不再占用调用方。 */
function withRequestTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * 「这个端点没有列模型能力」——与「这个端点不能推理」是两件事，必须可区分。
 *
 * 理由：Anthropic 兼容网关里只实现 POST /v1/messages 的很多，GET /v1/models 常常没做。
 * 若把它和 401/网络错误一视同仁当成「provider 不可用」，UI 就会既不给模型下拉、
 * 又不让用户手输模型 —— 用户明明能聊天却被挡住。
 * 故单独成类 + 提供 isModelListingUnsupported 谓词，让 UI（WP-B 的 settings.ts）能区分：
 * 列表不可用 → 允许手输 model id；其余错误 → 照常报错。
 */
export class ModelListingUnsupportedError extends Error {
  /** 稳定标识，便于 UI 不依赖 message 文案做判断。 */
  readonly code = 'model-listing-unsupported';
  readonly status: number;
  readonly url: string;

  constructor(providerLabel: string, status: number, url: string) {
    super(`${providerLabel} does not expose a model listing endpoint (HTTP ${status}): ${url}`);
    this.name = 'ModelListingUnsupportedError';
    this.status = status;
    this.url = url;
  }
}

/** 判断错误是否为「端点不支持列模型」（而非 key / 网络 / 限流问题）。 */
export function isModelListingUnsupported(error: unknown): error is ModelListingUnsupportedError {
  return error instanceof ModelListingUnsupportedError
    || (typeof error === 'object' && error !== null && (error as any).code === 'model-listing-unsupported');
}

/**
 * 哪些 HTTP 状态码意味着「端点根本没实现列模型」。
 * 404/405/501 是网关缺路由时的典型回法；400/401/403/429/5xx 仍按真实错误上报，
 * 因为那些更可能是 key、配额或服务端故障，误判成「不支持列表」会掩盖真问题。
 */
function isListingUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** 可注入的 REST 依赖（沿用 request-url-fetch.ts / web-search 的 deps 模式，便于测试）。 */
export interface ModelCatalogDeps {
  /** 与 Obsidian `requestUrl` 同签名：返回结构化的 HTTP 响应（外部数据仍在调用侧解析）。 */
  requestUrl: (options: RequestUrlParam) => Promise<RequestUrlResponse>;
}

/** provider 类型 → 静态能力声明。旧 provider 层的 getCapabilities 是硬编码常量，此处按 type 直接返回。 */
export function getProviderCapabilities(config: ProviderConfig | undefined): ProviderCapabilities {
  if (config?.type === 'openai-compatible') {
    return {
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: false,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    };
  }
  if (config?.type === 'anthropic') {
    // Anthropic Messages 原生支持 extended thinking、图像 content block 与 tool_use；
    // 用户会指向官方端点或各类兼容网关，故自定义 baseUrl 同样支持。
    return {
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: true,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    };
  }
  // 未配置 / 未知 type 的安全兜底。取值沿用移除 'gemini' 之前的兜底分支，
  // 以免为「配置读不出来」这种情况顺手改掉既有 UI 行为；loadSettings 已经用
  // pruneUnsupportedProviders 丢掉不受支持的 type，所以正常路径不会落到这里。
  return {
    supportsThinking: true,
    supportsModelListing: true,
    supportsImageInput: true,
    supportsToolCalling: true,
    supportsCustomBaseUrl: false,
  };
}

/**
 * 拉取 provider 当前可用的模型列表（纯 REST，无 LLM）。
 * openai-compatible 用 /models；anthropic 用 Anthropic Messages 的 /v1/models。
 * 失败抛错，由调用方回落到 fallback 列表。
 */
export async function listModels(config: ProviderConfig, deps?: ModelCatalogDeps): Promise<ModelOption[]> {
  if (!config?.apiKey?.trim()) {
    throw new Error(`${config?.label || 'Provider'} API Key not configured`);
  }
  if (config.type === 'anthropic') return listAnthropicModels(config, deps);
  return listOpenAICompatModels(config);
}

/**
 * 探活结果的三态。存在的理由：`checkAvailability()` 把「端点活着但不会列模型」
 * 和「端点真的能列模型」都压成 `true`，于是连接测试会对一个刚回 404 的 URL 报
 * 「model list reachable at <url>」—— 而同一屏的模型输入框却说列不了模型。
 * 这里把「活着」与「列模型可用」拆开，UI 才能说人话。
 */
export interface AvailabilityStatus {
    /** 端点应答了（哪怕答的是 404/405/501）。网络层失败才是 false。 */
    reachable: boolean;
    /** 端点明确表示没有列模型能力（404 / 405 / 501）。此时 reachable 仍为 true。 */
    listingUnsupported: boolean;
    /** reachable === false 时的原因。 */
    error?: Error;
}

/**
 * 轻量探活：验证 key/端点是否可用。
 * 不发 LLM 推理，改用列模型端点的 200 判定（更快、不烧 token）。
 *
 * 映射规则：
 *  - 列模型成功（无论清单是否为空）→ `{reachable:true, listingUnsupported:false}`；
 *  - 404 / 405 / 501 → `{reachable:true, listingUnsupported:true}` —— 端点应答了，
 *    只是不提供模型清单；生成能力**未被验证**（真发一次推理会烧 token，故不在这里证伪）；
 *  - 其他任何失败（401、网络、解析）→ `{reachable:false, error}`。
 * openai-compatible 永远抛不出 ModelListingUnsupportedError，故它恒为前两种之一，
 * 行为与改动前完全一致。
 */
export async function checkAvailabilityWithStatus(
  config: ProviderConfig,
  deps?: ModelCatalogDeps,
): Promise<AvailabilityStatus> {
  try {
    await listModels(config, deps);
    return { reachable: true, listingUnsupported: false };
  } catch (e) {
    if (isModelListingUnsupported(e)) {
      logger.warn(
        `Model listing unavailable for ${config?.label || config?.type}; assuming the endpoint can still generate`,
        'ModelCatalogService',
      );
      return { reachable: true, listingUnsupported: true };
    }
    logger.error('Availability check failed', e, 'ModelCatalogService');
    return {
      reachable: false,
      listingUnsupported: false,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

/**
 * 薄包装：只要「端点是否活着」这一个布尔量的既有调用方无需改动。
 * 需要区分「活着但不列模型」请用 checkAvailabilityWithStatus。
 */
export async function checkAvailability(config: ProviderConfig, deps?: ModelCatalogDeps): Promise<boolean> {
  return (await checkAvailabilityWithStatus(config, deps)).reachable;
}

async function listOpenAICompatModels(config: ProviderConfig): Promise<ModelOption[]> {
  const url = `${config.baseUrl || 'https://api.openai.com/v1'}/models`;
  const response = await withRequestTimeout(
    requestUrl({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    }),
    MODEL_LISTING_TIMEOUT_MS,
    'OpenAI models API',
  );
  if (response.status !== 200) {
    throw new Error(`OpenAI models API error: ${response.status}`);
  }

  const data = JSON.parse(response.text || '{}');
  const rows = Array.isArray(data?.data) ? data.data : [];

  const excludedKeywords = [
    'embedding', 'whisper', 'tts', 'transcribe', 'moderation',
    'dall-e', 'image', 'audio-preview', 'omni-moderation',
  ];

  const options = rows
    .map((row: any) => (typeof row?.id === 'string' ? row.id.trim() : ''))
    .filter((id: string) => {
      if (!id) return false;
      const lower = id.toLowerCase();
      return !excludedKeywords.some(keyword => lower.includes(keyword));
    })
    .map((id: string) => ({ value: id, label: id }))
    .sort((a: ModelOption, b: ModelOption) => a.value.localeCompare(b.value));

  return dedupeByValue(options);
}

/**
 * Anthropic Messages 的模型清单：`GET {baseUrl}/v1/models`，用 `x-api-key` 认证
 * （不是 Bearer），并必须带 `anthropic-version`。
 *
 * baseUrl 语义与 runtime 侧一致：官方端点不含 /v1，由这里拼 `/v1/models`
 * （runtime 侧由 SDK 拼 `/v1/messages`）。故这里只去掉尾部斜杠，不做 /v1 猜测 ——
 * 用户若把 baseUrl 填成 `https://api.anthropic.com/v1`，会得到 /v1/v1/models 而 404，
 * 这正是 src/mcp/types.ts 里把默认值定成不带 /v1 的原因。
 *
 * 响应形状：`{ data: [{ id, display_name?, ... }], has_more, ... }`。
 * display_name 可选，缺失时 label 退回 id。
 */
async function listAnthropicModels(config: ProviderConfig, deps?: ModelCatalogDeps): Promise<ModelOption[]> {
  const doRequest = deps?.requestUrl ?? requestUrl;
  const baseUrl = (config.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/v1/models`;

  const response = await withRequestTimeout(
    doRequest({
      url,
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    }),
    MODEL_LISTING_TIMEOUT_MS,
    'Anthropic models API',
  );

  if (response.status !== 200) {
    // 端点没有列模型能力 → 单独的错误类，让 UI 能区分「列不了模型」与「用不了」。
    if (isListingUnsupportedStatus(response.status)) {
      throw new ModelListingUnsupportedError(config.label || 'Anthropic', response.status, url);
    }
    throw new Error(`Anthropic models API error: ${response.status}`);
  }

  const data = JSON.parse(response.text || '{}');
  const rows = Array.isArray(data?.data) ? data.data : [];

  const options: ModelOption[] = rows
    .map((row: any): ModelOption | null => {
      const value = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!value) return null;
      const displayName = typeof row?.display_name === 'string' && row.display_name.trim().length > 0
        ? row.display_name.trim()
        : value;
      const label = displayName === value ? value : `${displayName} (${value})`;
      return { value, label };
    })
    .filter((option: ModelOption | null): option is ModelOption => option !== null)
    .sort((a: ModelOption, b: ModelOption) => a.value.localeCompare(b.value));

  return dedupeByValue(options);
}

function dedupeByValue(options: ModelOption[]): ModelOption[] {
  const deduped = new Map<string, ModelOption>();
  options.forEach((option: ModelOption) => {
    if (!deduped.has(option.value)) {
      deduped.set(option.value, option);
    }
  });
  return Array.from(deduped.values());
}
