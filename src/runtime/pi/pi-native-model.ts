/**
 * pi-native-model.ts
 *
 * 把项目的 ProviderConfig 映射成 pi-ai 原生 Model 对象，并提供注入 apiKey 的
 * StreamFn 工厂。这是 Phase 1 的纯构造层——不改任何现有文件，只新增。
 *
 * 使用场景（Phase 2 接入时调用）：
 *   const model = buildOpenAICompatModel(config, settings.contextWindow, settings.thinkingLevel);
 *   const streamFn = createNativeStreamFn(config.apiKey);
 *   // 然后把 model 和 streamFn 传给 pi agentLoop。
 */

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
// streamSimple 只在运行期动态 import（与 harness-chat-runtime.ts 的 AgentHarness 同模式），
// 避免 ESM-only pi-ai 在 CJS 测试环境（tsconfig.test.json module=commonjs）下
// 因 "No exports main defined" 错误而无法加载。
import type { ProviderConfig } from '../../mcp/types';

// 与 settings.contextWindow 默认值对齐（src/mcp/types.ts DEFAULT_SETTINGS），
// 也与 pi-provider-bridge.ts 的同名常量保持一致。
const DEFAULT_CONTEXT_WINDOW = 100000;
const OPENCODE_GO_HOST = 'opencode.ai';
const OPENCODE_GO_PATH = /^\/zen\/go(?:\/|$)/i;

/** 判断 provider endpoint 是否为 OpenCode Go。 */
export function isOpenCodeGoBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname.toLowerCase() === OPENCODE_GO_HOST && OPENCODE_GO_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/** 构造 OpenCode Go 要求的会话路由头，其他 endpoint 返回 undefined。 */
export function buildOpenCodeGoHeaders(
  baseUrl: string | undefined,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId || !isOpenCodeGoBaseUrl(baseUrl)) return undefined;
  return { 'x-opencode-session': normalizedSessionId };
}


/**
 * thinking 档对应 OpenAI reasoning_effort 的映射表。
 * - null  : 该档不支持 / 关闭推理（provider 用默认行为）
 * - string: 传给 provider 的具体值（OpenAI 用 reasoning_effort）
 *
 * 项目自定义的 thinkingLevel 与 pi 的 ModelThinkingLevel 同名，
 * 因此 key 直接对应，无需转换。
 */
const OPENAI_COMPAT_THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
} as const;

/**
 * Anthropic 的 thinking 档位映射表。
 *
 * 值的语义是 **Anthropic effort**（`output_config.effort`），由 pi 的
 * mapThinkingLevelToEffort 在 adaptive 模型上读取；budget 模型不看这张表。
 * 因此绝不能复用上面的 OpenAI reasoning_effort 表 —— 两者只是名字像，
 * 一旦把 reasoning_effort 发给 Anthropic，请求会因未知字段被拒。
 *
 * - off → null：关闭思考。pi 的 thinkingDisabled 判据是 `thinkingLevelMap.off !== null`，
 *   给 null 表示「off 这一档由调用方彻底不发 thinking 字段」，而不是发 disabled。
 * - minimal → 'low'：Anthropic effort 没有 minimal 这一档，pi 的默认 switch 也把
 *   minimal/low 都落到 'low'，这里显式写出来是为了让映射可读、可测。
 * - xhigh → 'xhigh'：pi 的注释说明 xhigh 只在 Opus 4.7/4.8、Sonnet 5、Fable 5 上原生可用；
 *   非 adaptive 模型走 budget 路径，pi 的 clampReasoning 会把 xhigh 收敛成 high。
 */
const ANTHROPIC_THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
} as const;

/**
 * Anthropic 的 max_tokens 上限。Anthropic Messages 协议要求该字段必填；
 * 取 8192 是「所有 Claude 模型都接受」的安全值（见 buildAnthropicModel 注释）。
 */
const ANTHROPIC_MAX_TOKENS = 8192;

/**
 * 把 OpenAI-compatible provider 配置映射成 pi-ai Model。
 * 覆盖 OpenAI 官方及所有兼容接口（DeepSeek、Qwen、自建 OpenAI-compat 服务等）。
 *
 * @param config        - 项目 ProviderConfig（type 为 'openai-compatible'）
 * @param contextWindow - 模型上下文窗口 token 数；缺省回落到 DEFAULT_CONTEXT_WINDOW
 * @param thinkingLevel - 推理深度档位；'off' 关闭 reasoning，其余（含 undefined）开启
 */
export function buildOpenAICompatModel(
  config: ProviderConfig,
  contextWindow?: number,
  thinkingLevel?: string,
): Model<'openai-completions' | 'openai-responses'> {
  // 用户没有配置 baseUrl 时回落到 OpenAI 官方端点
  const baseUrl = config.baseUrl?.trim() || 'https://api.openai.com';

  // 依 apiFlavor 选择 pi provider：
  // - 'responses'          → 'openai-responses'   → OpenAI SDK client.responses.create（/responses）
  // - 'completions'/缺省   → 'openai-completions'  → client.chat.completions.create（/chat/completions）
  // 两个 provider 都以 model.baseUrl 作为 OpenAI SDK 的 baseURL，端点路径由 SDK 自动追加，
  // 故 baseUrl 语义一致，无需为 responses 单独处理拼接。
  const api = config.apiFlavor === 'responses' ? 'openai-responses' : 'openai-completions';

  return {
    id: config.model,
    name: config.model,
    // 依 apiFlavor 路由到 pi 的 completions / responses provider
    api,
    provider: 'openai',
    baseUrl,
    // thinkingLevel !== 'off' 时开启 reasoning（undefined 也视为开启）
    reasoning: thinkingLevel !== 'off',
    // OpenAI-compat 同样支持文本和图像输入
    input: ['text', 'image'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    // OpenAI 系列输出 token 上限（Phase 0 验证值）
    maxTokens: 16384,
    // 显式提供 thinkingLevelMap，把项目的 6 档映射到 OpenAI reasoning_effort。
    // off → null（关闭，pi 不发送 reasoning_effort）
    // minimal/low → 'low'，medium → 'medium'，high/xhigh → 'high'
    thinkingLevelMap: { ...OPENAI_COMPAT_THINKING_LEVEL_MAP },
  };
}

/**
 * 把 Anthropic 原生 Messages provider 配置映射成 pi-ai Model。
 *
 * 与 OpenAI-compatible 构造器的关键差异：baseUrl 语义是「SDK 会在其上追加 /v1/messages」，
 * 故官方端点**不带 /v1**（见 src/mcp/types.ts DEFAULT_PROVIDERS.anthropic 的注释）。
 * 用户填 https://api.anthropic.com 或任何兼容网关的根地址即可。
 *
 * @param config        - 项目 ProviderConfig（type 必须为 'anthropic'）
 * @param contextWindow - 模型上下文窗口 token 数；缺省回落到 DEFAULT_CONTEXT_WINDOW
 * @param thinkingLevel - 推理深度档位；'off' 关闭 reasoning，其余（含 undefined）开启
 */
export function buildAnthropicModel(
  config: ProviderConfig,
  contextWindow?: number,
  thinkingLevel?: string,
): Model<'anthropic-messages'> {
  // 用户没有配置 baseUrl 时回落到 Anthropic 官方端点（不含 /v1，pi 会追加 /v1/messages）
  const baseUrl = config.baseUrl?.trim() || 'https://api.anthropic.com';

  // 自适应思考（type:'adaptive' + output_config.effort）只有新一批 Claude 支持；
  // 其余模型走 budget_tokens。判据来自 pi-ai 自带的模型目录，见函数注释。
  const adaptiveThinking = supportsAdaptiveThinking(config.model);

  return {
    id: config.model,
    name: config.model,
    // anthropic-messages：pi 路由到 api/anthropic-messages.js（原生 Messages 协议）
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl,
    // 同 OpenAI-compatible：thinkingLevel !== 'off' 时开启 reasoning
    reasoning: thinkingLevel !== 'off',
    // Anthropic Messages 支持文本与图像 content block
    input: ['text', 'image'],
    // 成本字段全置 0：项目内部不做费用核算，pi 用于显示用途
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    // Anthropic 的 max_tokens 是**必填**（pi 的 buildParams 会带上去）。
    // 取 8192 而不是按模型目录取 64000/128000：Baizer 允许用户指向任意兼容网关，
    // 而 8192 是所有 Claude 模型都接受的最小安全值；thinking budget 由 pi 的
    // adjustMaxTokensForThinking 在这个上限内自动收敛，不会出现 budget ≥ max_tokens。
    maxTokens: ANTHROPIC_MAX_TOKENS,
    // thinkingLevelMap 的值是 **Anthropic effort**（low/medium/high/xhigh/max），
    // 不是 OpenAI 的 reasoning_effort —— pi 的 mapThinkingLevelToEffort 只在
    // adaptive 模型上读它，budget 模型直接按档位算 budget_tokens。
    // off: null 让 pi 在关闭思考时不发 `thinking: { type: "disabled" }`（本构造器在
    // thinkingLevel==='off' 时已把 reasoning 置 false，请求里根本不会有 thinking 字段）。
    thinkingLevelMap: { ...ANTHROPIC_THINKING_LEVEL_MAP },
    ...(adaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
}

/**
 * 判断某个模型 id 是否属于「自适应思考」家族。
 *
 * 依据：pi-ai 1.3.0 的 dist/providers/data/anthropic.json —— 该目录里
 * `compat.forceAdaptiveThinking === true` 的模型恰好是这些家族（括号内为实测 maxTokens/ctx）：
 *   fable-5, haiku-5-5, opus-4-6, opus-4-7, opus-4-8, opus-5, sonnet-4-6, sonnet-5
 * 而 claude-sonnet-4-5 / claude-opus-4-5 / claude-haiku-4-5 走 budget_tokens。
 *
 * 为什么按家族前缀而不是精确 id：网关常带前缀（`anthropic/claude-sonnet-5`）或日期后缀
 * （`claude-sonnet-4-5-20250929`）。前缀匹配同时覆盖两者，且上面这些前缀不会误伤
 * 非 adaptive 的 sonnet-4-5 / opus-4-5 / haiku-4-5。
 *
 * 为什么默认走 budget_tokens：`thinking: { type: "enabled", budget_tokens }` 是
 * Anthropic 与各类兼容网关都实现的老形式（新模型上仅被标记 deprecated，仍被接受），
 * 而 `type: "adaptive"` 是较新的线格式。把 adaptive 限定在「确认支持的家族」上，
 * 可以让指向老网关/第三方模型的用户不至于因为一个不被识别的字段直接 400。
 */
export function supportsAdaptiveThinking(modelId: string | undefined): boolean {
  const id = (modelId ?? '').trim().toLowerCase();
  if (!id) return false;
  // 去掉网关前缀（openrouter 风格 `anthropic/`、bedrock 风格 `.../`），再要求出现 claude- 家族名
  return /(?:^|[/:])claude-(?:fable-5|haiku-5-5|opus-4-[678]|opus-5|sonnet-4-6|sonnet-5)/.test(id);
}

/**
 * 把 ProviderConfig.customHeaders 解析成实际发送的 header。
 *
 * 值里的 {{conversationId}} 占位符替换为当前会话 ID；无 conversationId 时，
 * 含该占位符的 header 整体跳过（而非发送字面量 "{{conversationId}}"），
 * 避免一次性调用（/edit、file-back 等无会话概念的场景）发出错误的 header 值。
 *
 * @param customHeaders - 来自 ProviderConfig.customHeaders 的原始配置
 * @param conversationId - 当前对话的稳定会话 ID；无会话上下文时传 undefined
 */
export function resolveCustomHeaders(
  customHeaders: Record<string, string> | undefined,
  conversationId: string | undefined,
): Record<string, string> | undefined {
  if (!customHeaders) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(customHeaders)) {
    if (value.includes('{{conversationId}}')) {
      if (!conversationId) continue;
      resolved[key] = value.split('{{conversationId}}').join(conversationId);
    } else {
      resolved[key] = value;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * 创建一个把 apiKey 注入 streamSimple options 的 StreamFn 工厂。
 *
 * apiKey 不存入 Model 对象（Model 是纯配置描述，不含凭证），
 * 而是在每次调用 streamSimple 时通过 options.apiKey 透传给 pi provider。
 * 这样同一个 Model 实例可以在运行期安全共享，凭证切换只需重建 StreamFn。
 *
 * @param apiKey - 用户配置的 API 密钥（来自 ProviderConfig.apiKey）
 */
/**
 * 无状态单次生成的可调参数。对齐 pi-ai SimpleStreamOptions 的子集：
 * temperature/maxTokens 直接透传；signal 用 pi 原生硬中断（取代旧的 raceWithAbort 软取消）。
 * reasoning 由 model.reasoning 决定，不在此处覆盖。
 */
export interface NativeCompleteOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 无状态单次生成句柄：给定 prompt + 可选 systemPrompt，返回一段纯文本。
 * 与会话型 StreamFn 并列，是无状态生成的 pi 原生出口（底层 completeSimple）。
 */
export type NativeCompleteFn = (
  prompt: string,
  systemPrompt?: string,
  options?: NativeCompleteOptions,
) => Promise<string>;

/**
 * 创建注入 apiKey 的无状态生成函数（对应 createNativeStreamFn 的一次性版本）。
 *
 * 底层用 pi-ai 的 completeSimple（Promise<AssistantMessage>），把 prompt 包成
 * 单条 user 消息、systemPrompt 放进 Context.systemPrompt，最后抽出 AssistantMessage
 * 里的 text 块拼接返回。无工具、无历史——纯「输入 prompt → 输出文本」。
 *
 * completeSimple 经动态 import 加载（与 createNativeStreamFn 同模式，规避 ESM-only 包
 * 在 CJS 测试环境的加载问题）。
 *
 * @param model  - 由 buildOpenAICompatModel / buildAnthropicModel 构造的 pi-ai Model
 * @param apiKey - 用户配置的 API 密钥（不存入 Model，每次调用经 options 透传）
 */
export function createNativeCompleteFn(model: Model<Api>, apiKey: string): NativeCompleteFn {
  return async (prompt, systemPrompt, options) => {
    // pi-ai 1.3.0 的主入口不再导出 completeSimple/streamSimple（改为 createModels() 返回的实例方法）；
    // `/compat` 子路径保留旧全局 API（含 api-registry），故无状态路径经它继续可用。
    const { completeSimple } = await import('@earendil-works/pi-ai/compat');
    const context = {
      systemPrompt: systemPrompt ?? '',
      messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
    };
    const requestSessionId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `baizer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const headers = buildOpenCodeGoHeaders(model.baseUrl, requestSessionId);
    const result: AssistantMessage = await completeSimple(model, context, {
      apiKey,
      ...(headers ? { headers } : {}),
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
      ...(typeof options?.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return extractAssistantText(result);
  };
}

/**
 * 会话型 StreamFn 的取值依赖：apiKey 与自定义 header 都在**每次调用时**取最新值，
 * 使运行期切换凭证/header 配置下一轮即生效（对齐旧的 getApiKeyAndHeaders 回调语义）。
 */
export interface NativeStreamDeps {
  getApiKey: () => string | Promise<string>;
  /** 取当前 provider 配置的自定义 header（已按 conversationId 解析占位符）。 */
  getHeaders?: () => Record<string, string> | undefined;
}

/**
 * 创建会话型 StreamFn（注入 apiKey 与自定义 header）。
 *
 * pi 1.3.0 的 `AgentOptions.streamFn` 是**必填**字段——`Agent` 不再自己按 model.api
 * 路由到 api-registry，而是把「如何发起一次流式请求」完全交给注入的 streamFn。
 * 这同时意味着凭证与自定义 header 的注入点从旧的 `getApiKeyAndHeaders` 回调
 * 整体搬到本函数（`getApiKeyAndHeaders` 在 1.3.0 已不存在）。
 *
 * 自定义 header 必须走 options.headers：opencode.ai Go 网关要求
 * `x-opencode-session`（值来自 ProviderConfig.customHeaders 的 {{conversationId}} 占位符），
 * 丢失它会让该网关以 "Request is missing x-opencode-session" 拒绝请求。
 * options 里已有的 header 优先保留，本函数的 header 覆盖同名键。
 *
 * 底层 streamSimple 经动态 import 从 `/compat` 加载（主入口已不导出，见 createNativeCompleteFn 注释）。
 */
export function createNativeStreamFn(deps: NativeStreamDeps): StreamFn {
  return async (model, context, options) => {
    const { streamSimple } = await import('@earendil-works/pi-ai/compat');
    const apiKey = await deps.getApiKey();
    const custom = deps.getHeaders?.();
    const headers = custom && Object.keys(custom).length > 0
      ? { ...(options?.headers ?? {}), ...custom }
      : options?.headers;
    return streamSimple(model, context, {
      ...options,
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    });
  };
}

/** 从 AssistantMessage 抽出所有 text 块并拼接（忽略 thinking / tool_call 块）。 */
function extractAssistantText(message: AssistantMessage): string {
  if (!message?.content?.length) return '';
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block?.type === 'text')
    .map(block => block.text)
    .join('');
}
