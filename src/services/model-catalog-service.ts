import { requestUrl } from 'obsidian';
import { ModelOption } from '../models/interfaces';
import { ProviderConfig } from '../mcp/types';
import { ProviderCapabilities } from '../runtime/provider-capabilities';
import { logger } from '../utils/logger';

/**
 * model-catalog-service —— provider 元数据服务（非 runtime）。
 *
 * pi-agent runtime 只覆盖「LLM 推理」；provider 的元能力（列模型 / 探活 / 能力声明）
 * pi 不提供动态版本（pi-ai 只有编译期静态 getModels()，无运行时 REST 探测）。
 * 为保留「用户自定义 baseUrl 下动态列模型」的能力，这些元能力从旧 GeminiProvider/
 * OpenAIProvider 剥离到此处，作为独立的 HTTP 元数据查询层。
 *
 * 关键区别：这里的调用都是纯 REST 元数据请求，**不触发任何 LLM 推理**，
 * 因此不属于 runtime 迁移范畴。checkAvailability 也改为轻量的端点 200 探测，
 * 不再像旧 provider 那样发一次 generateContent('Hello') 烧 token。
 */

/** provider 类型 → 静态能力声明。原 GeminiProvider/OpenAIProvider.getCapabilities 是硬编码常量，此处按 type 直接返回。 */
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
  // gemini（含未知类型的安全兜底）
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
 * gemini 用 Generative Language models 端点；openai-compatible 用 /models。
 * 失败抛错，由调用方回落到 fallback 列表。
 */
export async function listModels(config: ProviderConfig): Promise<ModelOption[]> {
  if (!config?.apiKey?.trim()) {
    throw new Error(`${config?.label || 'Provider'} API Key not configured`);
  }
  return config.type === 'gemini'
    ? listGeminiModels(config)
    : listOpenAICompatModels(config);
}

/**
 * 轻量探活：验证 key/端点是否可用。
 * 不发 LLM 推理，改用列模型端点的 200 判定（更快、不烧 token）。
 */
export async function checkAvailability(config: ProviderConfig): Promise<boolean> {
  try {
    await listModels(config);
    return true;
  } catch (e) {
    logger.error('Availability check failed', e, 'ModelCatalogService');
    return false;
  }
}

async function listGeminiModels(config: ProviderConfig): Promise<ModelOption[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.apiKey)}`;
  const response = await requestUrl({ url, method: 'GET' });
  if (response.status !== 200) {
    throw new Error(`Gemini models API error: ${response.status}`);
  }

  const data = JSON.parse(response.text || '{}');
  const models = Array.isArray(data?.models) ? data.models : [];

  const options: ModelOption[] = models
    .filter((model: any) => {
      const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
      const name = typeof model?.name === 'string' ? model.name : '';
      return name.startsWith('models/') && methods.includes('generateContent');
    })
    .map((model: any) => {
      const value = String(model.name).replace(/^models\//, '');
      const displayName = typeof model?.displayName === 'string' && model.displayName.trim().length > 0
        ? model.displayName.trim()
        : value;
      const label = displayName === value ? value : `${displayName} (${value})`;
      return { value, label };
    })
    .sort((a: ModelOption, b: ModelOption) => a.value.localeCompare(b.value));

  return dedupeByValue(options);
}

async function listOpenAICompatModels(config: ProviderConfig): Promise<ModelOption[]> {
  const url = `${config.baseUrl || 'https://api.openai.com/v1'}/models`;
  const response = await requestUrl({
    url,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });
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

function dedupeByValue(options: ModelOption[]): ModelOption[] {
  const deduped = new Map<string, ModelOption>();
  options.forEach((option: ModelOption) => {
    if (!deduped.has(option.value)) {
      deduped.set(option.value, option);
    }
  });
  return Array.from(deduped.values());
}
