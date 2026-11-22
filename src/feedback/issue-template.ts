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

/**
 * 四项环境诊断字段合并进一张表格渲染，而不是各占一个小节——原来 8 个小节平铺，
 * 环境信息被拆得比正文本身还碎，不像一份正常的 GitHub issue。
 *
 * 表格固定插在 surface 之前，是因为**两个模板都声明了 surface 字段**，这个锚点在
 * bug / feature 两条路径上位置一致（bug：surface 之后还有 console；feature：surface
 * 是最后一个）。
 *
 * 这四个 id 只由 bug 模板声明（均为 required、无 fallback），feature 模板从不声明；
 * feature 侧的取值全部来自 input.fields——payload.ts 会把 diagnosticFields(snapshot)
 * 合并进去。所以表格读的是 input.fields，而不是 templateFields 的字段清单。
 *
 * 行标签 ≠ 字段 label：'Baizer'/'Obsidian' 比 'Baizer version'/'Obsidian version'
 * 在表格里更紧凑，不影响同源测试（它只比对 templateFields 的 label，不比对这里）。
 * 缺失一律按「无」填充。
 */
const ENVIRONMENT_FIELD_ROWS: Array<{ id: string; label: string }> = [
  { id: 'plugin-version', label: 'Baizer' },
  { id: 'obsidian-version', label: 'Obsidian' },
  { id: 'platform', label: 'Platform' },
  { id: 'provider', label: 'Provider' },
];

function buildEnvironmentSection(fields: Record<string, string | undefined>): string {
  const rows = ENVIRONMENT_FIELD_ROWS.map(row => {
    const raw = fields[row.id];
    const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : MISSING;
    return `| ${row.label} | ${value} |`;
  });
  return ['## Environment', '', '| | |', '|---|---|', ...rows].join('\n');
}

/**
 * console 字段对应模板的 `render: shell`——GitHub 的 Web 表单会把这个 textarea
 * 的值自动包进 shell 代码块；REST 写入没有这个自动行为，这里手动补上，只在有
 * 真实内容时才围栏，「无」保持纯文本，不伪装成一段 shell 输出。
 */
function renderConsoleValue(value: string): string {
  return value === MISSING ? value : `\`\`\`shell\n${value}\n\`\`\``;
}

type ResolvedField = { ok: true; value: string } | { ok: false; error: string };

function resolveField(field: TemplateField, raw: string | undefined): ResolvedField {
  const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  if (value) return { ok: true, value };
  if (field.fallback === undefined) {
    return { ok: false, error: `Missing required field: ${field.label} (${field.id})` };
  }
  return { ok: true, value: fallbackFor(field) };
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
 *
 * 四项环境字段不再各占一个小节，合并进 surface 字段前的一张 `## Environment`
 * 表格；两个模板都声明了 surface 字段，这个锚点在 bug / feature 两条路径上位置一致
 * （bug 的 surface 之后还有 console，feature 的 surface 收尾）。这四个 id 只由 bug
 * 模板声明并校验；feature 模板不含它们，表格完全来自 input.fields 里诊断快照塞的值，
 * 与模板字段无关——这正是「功能请求也要带环境信息」的落地方式。
 */
export function renderIssueBody(input: IssueRenderInput): IssueRenderResult {
  const fields = templateFields(input.type);
  const sections: string[] = [];
  const environmentIds = new Set(ENVIRONMENT_FIELD_ROWS.map(row => row.id));

  for (const field of fields) {
    if (environmentIds.has(field.id)) {
      // 不渲染独立小节，但仍走必填校验——bug 模板里这四项是 required 且无 fallback；
      // feature 模板从不声明它们，这个分支对 feature 永远不会触发。
      const resolved = resolveField(field, input.fields[field.id]);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      continue;
    }

    if (field.id === 'surface') {
      // 环境表格固定插在 surface 前：两个模板都声明了 surface 字段，锚点位置一致
      // （bug 的 surface 之后还有 console，feature 的 surface 收尾），且表格直接读
      // input.fields（诊断快照），与 field.id 是否在模板里声明无关——这正是 feature
      // 报告也带环境信息的落地方式。
      sections.push(buildEnvironmentSection(input.fields));
    }

    const resolved = resolveField(field, input.fields[field.id]);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const value = field.id === 'console' ? renderConsoleValue(resolved.value) : resolved.value;
    sections.push(`## ${field.label}\n\n${value}`);
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
