/**
 * pi-native-model.ts
 *
 * 把项目的 ProviderConfig 映射成 pi-ai 原生 Model 对象，并提供注入 apiKey 的
 * StreamFn 工厂。这是 Phase 1 的纯构造层——不改任何现有文件，只新增。
 *
 * 使用场景（Phase 2 接入时调用）：
 *   const model = buildGeminiModel(config, settings.contextWindow, settings.thinkingLevel);
 *   const streamFn = createNativeStreamFn(config.apiKey);
 *   // 然后把 model 和 streamFn 传给 pi agentLoop。
 */

import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
// streamSimple 只在运行期动态 import（与 harness-chat-runtime.ts 的 AgentHarness 同模式），
// 避免 ESM-only pi-ai 在 CJS 测试环境（tsconfig.test.json module=commonjs）下
// 因 "No exports main defined" 错误而无法加载。
import type { ProviderConfig } from '../../mcp/types';

// 与 settings.contextWindow 默认值对齐（src/mcp/types.ts DEFAULT_SETTINGS），
// 也与 pi-provider-bridge.ts 的同名常量保持一致。
const DEFAULT_CONTEXT_WINDOW = 100000;

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
 * 把 Gemini provider 配置映射成 pi-ai Model。
 *
 * @param config        - 项目 ProviderConfig（type 必须为 'gemini'）
 * @param contextWindow - 模型上下文窗口 token 数；缺省回落到 DEFAULT_CONTEXT_WINDOW
 * @param thinkingLevel - 推理深度档位；'off' 关闭 reasoning，其余（含 undefined）开启
 */
export function buildGeminiModel(
  config: ProviderConfig,
  contextWindow?: number,
  thinkingLevel?: string,
): Model<'google-generative-ai'> {
  return {
    id: config.model,
    name: config.model,
    // google-generative-ai：pi 使用此 api 值路由到 Google Generative AI provider
    api: 'google-generative-ai',
    provider: 'google',
    // Gemini 官方端点，pi 会在此基础上拼接模型路径
    baseUrl: 'https://generativelanguage.googleapis.com',
    // thinkingLevel !== 'off' 时开启 reasoning（undefined 也视为开启）。
    // 与 pi-provider-bridge.ts 的逻辑完全一致。
    reasoning: thinkingLevel !== 'off',
    // Gemini 支持文本和图像输入
    input: ['text', 'image'],
    // 成本字段全置 0：项目内部不做费用核算，pi 用于显示用途
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    // 取真实配置的上下文窗口；缺省回落到默认值，避免 pi 内部预算判断出错
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    // Gemini 输出 token 上限（Phase 0 验证值）
    maxTokens: 8192,
    // Gemini 的 thinkingLevelMap 不显式设置，让 pi google provider 使用内置的
    // thinking budget 默认值。reasoning flag（上方）控制是否开启思考。
  };
}

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
): Model<'openai-completions'> {
  // 用户没有配置 baseUrl 时回落到 OpenAI 官方端点
  const baseUrl = config.baseUrl?.trim() || 'https://api.openai.com';

  return {
    id: config.model,
    name: config.model,
    // openai-completions：pi 用此值路由到 OpenAI-compatible completions provider
    api: 'openai-completions',
    provider: 'openai',
    baseUrl,
    // 同 Gemini：thinkingLevel !== 'off' 时开启 reasoning
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
 * @param model  - 由 buildGeminiModel / buildOpenAICompatModel 构造的 pi-ai Model
 * @param apiKey - 用户配置的 API 密钥（不存入 Model，每次调用经 options 透传）
 */
export function createNativeCompleteFn(model: Model<any>, apiKey: string): NativeCompleteFn {
  return async (prompt, systemPrompt, options) => {
    const { completeSimple } = await import('@earendil-works/pi-ai');
    const context = {
      systemPrompt: systemPrompt ?? '',
      messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
    };
    const result: AssistantMessage = await completeSimple(model, context, {
      apiKey,
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
      ...(typeof options?.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return extractAssistantText(result);
  };
}

/** 从 AssistantMessage 抽出所有 text 块并拼接（忽略 thinking / tool_call 块）。 */
function extractAssistantText(message: AssistantMessage): string {
  if (!message?.content?.length) return '';
  return message.content
    .filter((block): block is { type: 'text'; text: string } => (block as any)?.type === 'text')
    .map(block => block.text)
    .join('');
}
