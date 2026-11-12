// src/feedback/issue-template.ts — 仓库模板 ↔ 插件字段的同源映射与正文渲染
//
// GitHub 的 ISSUE_TEMPLATE 只作用于 Web 表单，REST 写入不会自动套用模板，
// 所以正文必须由插件本地渲染成等价 Markdown。本模块是插件侧的**唯一**字段事实源，
// 由 test/feedback-contract.test.ts 与 .github/ISSUE_TEMPLATE/*.yml 逐项对齐
// （字段 id + dropdown 选项取值 + label 取值），模板漂移时测试失败。

import type { DiagnosticsSnapshot, DiagnosticsProvider, FeedbackIssueType } from './types';
import type { ProviderType } from '../mcp/types';

/** 模板里一个可填字段（textarea / input / dropdown）。markdown 引导块不算。 */
export interface TemplateField {
  id: string;
  label: string;
  /** 与模板 yml 的 validations.required 同源，由同源测试锁定。 */
  required: boolean;
  /** 仅 dropdown 有：合法取值集合。 */
  options?: string[];
  /**
   * 缺失时的固定填充（决策表 3 的右列）。**有它即「允许缺失」**——
   * `surface` 在模板里标着 required，但设计明确给了兜底值；可选字段同理。
   * 没有 fallback 的字段缺失即渲染失败，不静默填「无」——否则 issue 会变成一句
   * 「XX 不好使」，而那正是本功能要消灭的东西。
   */
  fallback?: string;
}

/** 模板字段缺失时的固定填充。 */
const MISSING = '无';
const BUG_SURFACE_FALLBACK = 'Somewhere else / not sure';
const FEATURE_SURFACE_FALLBACK = 'Something new';

const PLATFORM_OPTIONS = ['Windows', 'macOS', 'Linux', 'iOS', 'Android'];

const BUG_SURFACE_OPTIONS = [
  'Workbench (chat)',
  'Guardian (inline completions)',
  'Selection menu',
  'Knowledge Wiki',
  'Memory',
  'Settings',
  BUG_SURFACE_FALLBACK,
];

const FEATURE_SURFACE_OPTIONS = [
  'Workbench (chat)',
  'Guardian (inline completions)',
  'Skills / tools',
  'Knowledge Wiki',
  'Memory',
  'Settings',
  FEATURE_SURFACE_FALLBACK,
];

/** bug_report.yml 的 provider 下拉选项（顺序即模板顺序，由同源测试锁定）。 */
export const PROVIDER_OPTIONS: DiagnosticsProvider[] = [
  'Google Gemini',
  'OpenAI',
  'DeepSeek',
  'Qwen / DashScope',
  'Other OpenAI-compatible endpoint',
  'Anthropic',
  'Not relevant to this bug',
];

/**
 * 映射表会产出、但模板 dropdown 未覆盖的取值。
 *
 * 此前 `Anthropic` 在这里（模板侧缺口），已在本次给 bug_report.yml 补上该选项后清空。
 * 机制保留：将来映射新增取值而模板未跟上时，同源测试会要求把它显式登记在这里，
 * 而不是让它悄悄通过。
 */
export const PROVIDER_TEMPLATE_EXCEPTIONS: DiagnosticsProvider[] = [];

/** 缺陷类模板的可填字段（顺序 = 正文小节顺序）。 */
export const BUG_TEMPLATE_FIELDS: TemplateField[] = [
  { id: 'what-happened', label: 'What happened', required: true },
  { id: 'repro', label: 'Steps to reproduce', required: true },
  { id: 'plugin-version', label: 'Baizer version', required: true },
  { id: 'obsidian-version', label: 'Obsidian version', required: true },
  { id: 'platform', label: 'Platform', required: true, options: PLATFORM_OPTIONS },
  { id: 'provider', label: 'Provider', required: true, options: PROVIDER_OPTIONS },
  { id: 'surface', label: 'Where it happened', required: true, options: BUG_SURFACE_OPTIONS, fallback: BUG_SURFACE_FALLBACK },
  { id: 'console', label: 'Console output', required: false, fallback: MISSING },
];

/** 需求类模板的可填字段（顺序 = 正文小节顺序）。 */
export const FEATURE_TEMPLATE_FIELDS: TemplateField[] = [
  { id: 'problem', label: 'The problem', required: true },
  { id: 'proposal', label: 'What you have in mind', required: false, fallback: MISSING },
  { id: 'workaround', label: 'How you handle it today', required: false, fallback: MISSING },
  { id: 'surface', label: 'Which part of Baizer', required: true, options: FEATURE_SURFACE_OPTIONS, fallback: FEATURE_SURFACE_FALLBACK },
];

/** 类型 → 模板 label。取值必须与模板文件的 `labels:` 同源，由测试锁定。 */
export const TEMPLATE_LABELS: Record<FeedbackIssueType, string[]> = {
  bug: ['bug'],
  enhancement: ['enhancement'],
};

export function templateFields(type: FeedbackIssueType): TemplateField[] {
  return type === 'bug' ? BUG_TEMPLATE_FIELDS : FEATURE_TEMPLATE_FIELDS;
}

/** 正文渲染前对缺失字段的固定填充（决策表 3 的右列）。 */
function fallbackFor(field: TemplateField): string {
  return field.fallback ?? MISSING;
}

/** 标题单行化：换行折叠为空格（BR3.3）。正文不做任何内容层改写。 */
export function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export interface IssueRenderInput {
  type: FeedbackIssueType;
  /** 澄清得到的字段值，键为模板字段 id。诊断类字段由调用方先行填入。 */
  fields: Record<string, string | undefined>;
  diagnostics: DiagnosticsSnapshot;
}

export type IssueRenderResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * 按模板字段清单确定性渲染正文：同一组字段 + 同一份诊断信息 ⇒ 逐字节相同的正文。
 *
 * 必填字段缺失即失败——不静默填「无」，否则 issue 会变成一句「XX 不好使」。
 */
export function renderIssueBody(input: IssueRenderInput): IssueRenderResult {
  const fields = templateFields(input.type);
  const sections: string[] = [];

  for (const field of fields) {
    const raw = input.fields[field.id];
    const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
    if (!value) {
      if (field.fallback === undefined) {
        return { ok: false, error: `Missing required field: ${field.label} (${field.id})` };
      }
      sections.push(`### ${field.label}\n\n${fallbackFor(field)}`);
      continue;
    }
    sections.push(`### ${field.label}\n\n${value}`);
  }

  return { ok: true, body: sections.join('\n\n') };
}

// ==================== provider 映射（决策表 3b） ====================

export interface ProviderMappingRule {
  /** 配置侧 providerType；'unconfigured' 表示没有可用 provider。 */
  providerType: ProviderType | 'unconfigured';
  /** provider label 的大小写不敏感子串命中集；缺省 = 该 providerType 的兜底规则。 */
  labelMatches?: string[];
  value: DiagnosticsProvider;
}

/**
 * 穷尽且确定的映射。映射在 get_plugin_diagnostics 内部完成——快照携带的是
 * **已落到模板域的取值**，不携带原始 provider label（label 可能是用户自建的
 * 端点名，写进公开 issue 属于超范围暴露）。
 */
export const PROVIDER_MAPPING: ProviderMappingRule[] = [
  { providerType: 'openai-compatible', labelMatches: ['gemini', 'google'], value: 'Google Gemini' },
  { providerType: 'openai-compatible', labelMatches: ['openai', 'gpt'], value: 'OpenAI' },
  { providerType: 'openai-compatible', labelMatches: ['deepseek'], value: 'DeepSeek' },
  { providerType: 'openai-compatible', labelMatches: ['qwen', 'dashscope'], value: 'Qwen / DashScope' },
  { providerType: 'openai-compatible', value: 'Other OpenAI-compatible endpoint' },
  { providerType: 'anthropic', value: 'Anthropic' },
  { providerType: 'unconfigured', value: 'Not relevant to this bug' },
];

/**
 * 把配置侧的 provider 落到模板下拉域。
 *
 * 无 provider（未配置 / 未知类型）时返回 `Not relevant to this bug`，
 * 而不是把它塞进 `Other OpenAI-compatible endpoint`——那会让 triage 误判方言。
 */
export function resolveProvider(
  providerType: ProviderType | undefined,
  label: string | undefined,
): DiagnosticsProvider {
  const type: ProviderType | 'unconfigured' =
    providerType === 'anthropic' || providerType === 'openai-compatible'
      ? providerType
      : 'unconfigured';
  const normalized = (label ?? '').toLowerCase();
  const candidates = PROVIDER_MAPPING.filter(rule => rule.providerType === type);
  for (const rule of candidates) {
    if (!rule.labelMatches) continue;
    if (rule.labelMatches.some(needle => normalized.includes(needle))) return rule.value;
  }
  // 兜底规则（无 labelMatches 的那条）——每个 providerType 有且仅有一条，保证穷尽。
  const fallback = candidates.find(rule => !rule.labelMatches);
  return fallback?.value ?? 'Not relevant to this bug';
}
