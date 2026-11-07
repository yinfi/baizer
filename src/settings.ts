import {
    App,
    PluginSettingTab,
    Setting,
    SettingPage,
    Notice,
    Modal,
    debounce,
    Debouncer,
    setIcon,
} from 'obsidian';
import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import { BUILTIN_PROVIDER_KEYS, DEFAULT_ASR_MODEL, DEFAULT_PROVIDERS, DEFAULT_SETTINGS, IPlugin, MEMORY_DIR, OpenAIApiFlavor, PluginSettings, ProviderConfig, ProviderType } from './mcp/types';
import { ModelOption } from './models/interfaces';
import type { AvailableModelsResult } from './services/model-service';
import { checkAvailabilityWithStatus, isModelListingUnsupported, listModels } from './services/model-catalog-service';
import type { MemoryRecord } from './memory/hindsight-types';
import type { MemoryView } from './memory/types';
import type {
    DerivedSkillRegenerateBlocker,
    DerivedSkillStatus,
} from './skills/builtin/plugin-ctrl/plugin-watcher';
import { t, Locale } from './i18n/zh';
import { thrownMessage } from './utils/thrown-message';
import { logger } from './utils/logger';
import { detach } from './utils/promise-guard';

export type SettingsSectionId =
    | 'overview'
    | 'connection'
    | 'behavior'
    | 'memory'
    | 'permissions'
    | 'skills'
    | 'capture'
    | 'knowledge'
    | 'guardian'
    | 'appearance'
    | 'plugin-skills';

export type SettingsBadgeTone = 'warning' | 'danger' | 'muted' | 'accent' | 'success';

export interface SettingsSectionStatus {
    label: string;
    tone: SettingsBadgeTone;
}

export type ConnectionTestState = 'idle' | 'testing' | 'success' | 'warning' | 'error';

export interface ConnectionTestStatus {
    state: ConnectionTestState;
    message: string;
}

export interface SettingsOverviewAction {
    label: string;
    sectionId: SettingsSectionId;
    tone: SettingsBadgeTone;
}

interface SettingsSectionMeta {
    id: SettingsSectionId;
    title: string;
    description: string;
    keywords: string[];
}

export function getSettingsFallbackCss(): string {
    return `
.baizer-settings-search {
    width: 100%;
    height: 34px;
    padding: 0 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-secondary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
}
.baizer-settings-action {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-secondary);
    color: var(--text-normal);
    cursor: pointer;
}
.baizer-settings-action.is-primary { border-color: color-mix(in srgb, var(--interactive-accent) 38%, var(--background-modifier-border)); color: var(--text-accent); }
.baizer-settings-action.is-accent { border-style: dashed; }
.baizer-settings-action.is-danger { border-color: color-mix(in srgb, var(--text-error) 30%, var(--background-modifier-border)); color: var(--text-error); }
.baizer-settings-action:disabled { cursor: default; opacity: .45; }
.baizer-settings-detail-input {
    display: block;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-primary);
    color: var(--text-normal);
}
/* 长地址/长模型名：输入框本身可编辑全文，悬停另有 title 给完整值。 */
.baizer-settings-detail-input[type="text"] {
    text-overflow: ellipsis;
}
.baizer-settings-field-hint {
    color: var(--text-muted);
    font-size: var(--font-smallest);
    line-height: 1.5;
    /* 帮助文字占满整行并连续换行，不再被窄列折成碎句。 */
    white-space: normal;
    overflow-wrap: anywhere;
}
.baizer-settings-field-hint.is-warning { color: var(--text-warning); }
/* 真故障（401/网络/解析）用 error 色；能力缺口仍走 is-warning，两者必须一眼可分。 */
.baizer-settings-field-hint.is-error { color: var(--text-error); }
.baizer-settings-field-feedback:empty { display: none; }
.baizer-settings-field-feedback {
    font-size: var(--font-smallest);
    line-height: 1.5;
    overflow-wrap: anywhere;
}
.baizer-settings-field-feedback.is-error { color: var(--text-error); }
.baizer-settings-field-feedback.is-warning { color: var(--text-warning); }
.baizer-settings-model-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.baizer-settings-model-select { flex: 1 1 220px; min-width: 0; }
/* 兜底列表不是该端点的结论：降调 + 虚线边，别让用户以为这些模型一定被支持。 */
.baizer-settings-model-select.is-untrusted {
    border-style: dashed;
    color: var(--text-muted);
}
.baizer-settings-model-picker .baizer-settings-action { flex: 0 0 auto; }
.baizer-settings-header-example {
    margin: 0;
    padding: 6px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--background-modifier-border) 32%, transparent);
    color: var(--text-muted);
    font-family: var(--font-monospace);
    font-size: var(--font-smallest);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
/* 声明式行里的全宽控件（render 回调）：name/desc 在上、控件独占一行，
   长 Base URL / 多行 header / 模型选择器不再被原生右侧窄列压扁。 */
.setting-item.baizer-setting-stacked { flex-direction: column; align-items: stretch; gap: 8px; }
.setting-item.baizer-setting-stacked .setting-item-info { width: 100%; margin-right: 0; }
.setting-item.baizer-setting-stacked .setting-item-control { width: 100%; justify-content: flex-start; flex-wrap: wrap; text-align: start; }
.setting-item.baizer-setting-stacked .setting-item-control input[type="text"],
.setting-item.baizer-setting-stacked .setting-item-control input[type="password"],
.setting-item.baizer-setting-stacked .setting-item-control textarea,
.setting-item.baizer-setting-stacked .setting-item-control select { width: 100%; min-width: 0; }
.setting-item.baizer-setting-stacked .baizer-settings-model-field { width: 100%; display: flex; flex-direction: column; gap: 6px; }
.setting-item.baizer-setting-stacked .baizer-settings-header-example { width: 100%; }
.setting-item.baizer-setting-stacked .baizer-settings-summary-list { width: 100%; }
.baizer-settings-summary-list,
.baizer-settings-skill-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
}
.baizer-settings-summary-list li,
.baizer-settings-skill-list li,
.baizer-settings-sample-line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 88%, transparent);
    border-radius: 8px;
    color: var(--text-muted);
}
.baizer-settings-summary-list strong,
.baizer-settings-skill-list strong,
.baizer-settings-sample-line strong { color: var(--text-normal); }
.baizer-settings-inline-note { padding: 10px 12px; border-radius: 8px; font-size: var(--font-ui-small); }
.baizer-settings-inline-note.is-warning { color: var(--text-warning); background: color-mix(in srgb, var(--color-yellow) 16%, transparent); }
.baizer-settings-inline-note.is-success { color: var(--color-green); background: color-mix(in srgb, var(--color-green) 10%, transparent); }
.baizer-settings-inline-note.is-danger { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 12%, transparent); }
.baizer-settings-inline-note.is-accent { color: var(--text-accent); background: color-mix(in srgb, var(--interactive-accent) 10%, transparent); }

/* ===== 记忆(Hindsight)面板 ===== */
.baizer-memory-toolbar { display: flex; flex-direction: column; gap: 8px; }
.baizer-memory-path {
    padding: 3px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--background-modifier-border) 45%, transparent);
    color: var(--text-muted);
    font-size: var(--font-smallest);
    font-family: var(--font-monospace);
}
.baizer-memory-toolbar-actions { display: flex; gap: 8px; align-items: center; }
.baizer-memory-search { display: flex; gap: 8px; align-items: center; }
.baizer-memory-search .baizer-settings-search { flex: 1 1 auto; }
.baizer-memory-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.baizer-memory-tab {
    min-height: 28px;
    padding: 0 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 999px;
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}
.baizer-memory-tab:hover { color: var(--text-normal); border-color: color-mix(in srgb, var(--interactive-accent) 40%, var(--background-modifier-border)); }
.baizer-memory-tab.is-active {
    color: var(--text-on-accent);
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
}
.baizer-memory-list { display: flex; flex-direction: column; gap: 8px; }
.baizer-memory-row {
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 88%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--background-primary-alt) 96%, var(--background-secondary));
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 120ms ease;
}
.baizer-memory-row:hover { border-color: color-mix(in srgb, var(--background-modifier-border) 100%, transparent); }
.baizer-memory-row-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
}
.baizer-memory-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.baizer-memory-type {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: var(--font-smallest);
    font-weight: var(--font-medium);
    text-transform: capitalize;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
}
.baizer-memory-type.is-world { color: var(--text-accent); background: color-mix(in srgb, var(--interactive-accent) 15%, transparent); }
.baizer-memory-type.is-experience { color: var(--color-green); background: color-mix(in srgb, var(--color-green) 14%, transparent); }
.baizer-memory-type.is-observation { color: var(--text-warning); background: color-mix(in srgb, var(--color-yellow) 16%, transparent); }
.baizer-memory-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: var(--font-smallest);
    color: var(--text-muted);
    background: color-mix(in srgb, var(--background-modifier-border) 40%, transparent);
}
.baizer-memory-confidence { color: var(--text-faint); font-size: var(--font-smallest); }
.baizer-memory-row-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.baizer-memory-time { color: var(--text-faint); font-size: var(--font-smallest); white-space: nowrap; }
.baizer-memory-delete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    opacity: .55;
    transition: color 120ms ease, background-color 120ms ease, opacity 120ms ease;
}
.baizer-memory-delete:hover { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 12%, transparent); opacity: 1; }
.baizer-memory-delete .svg-icon { width: 15px; height: 15px; }
.baizer-memory-row-text {
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
}
`;
}
let settingsFallbackSheet: CSSStyleSheet | null = null;

/**
 * 兜底样式以 constructable stylesheet 挂到 document.adoptedStyleSheets(排在 styles.css 之后,
 * 优先级与原先末尾注入的 <style> 相同),不再创建 <style> 元素。重复调用只刷新内容(t() 随 locale 变化)。
 */
function ensureSettingsFallbackStyles(): void {
    const doc = typeof document === 'undefined' ? null : document;
    if (!doc || typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in doc)) return;

    if (!settingsFallbackSheet) settingsFallbackSheet = new CSSStyleSheet();
    settingsFallbackSheet.replaceSync(getSettingsFallbackCss());
    if (!doc.adoptedStyleSheets.includes(settingsFallbackSheet)) {
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, settingsFallbackSheet];
    }
}

// 惰性求值：t() 依赖当前 locale，必须在调用时（而非模块加载时）求值，
// 否则切换语言后分区标题/描述不会更新（模块级常量会冻结初次 t() 结果）。
function getSettingsSections(): SettingsSectionMeta[] {
    return [
    { id: 'overview', title: t('Overview'), description: t('Configuration health and actions that need attention.'), keywords: ['overview', 'health', 'risk', 'status', '概览'] },
    { id: 'connection', title: t('Connection'), description: t('Provider, API key, endpoint, model, and connection tests.'), keywords: ['provider', 'api key', 'base url', 'model', 'connection', 'openai', 'anthropic', 'deepseek', 'qwen', '连接', '服务商'] },
    { id: 'behavior', title: t('Behavior'), description: t('Context budget, system prompt, and runtime behavior.'), keywords: ['behavior', 'runtime', 'context window', 'token', 'system prompt', 'persona', 'prompt', 'thinking', 'reasoning', '行为'] },
    { id: 'memory', title: t('Memory'), description: t('Memory retention, recall, search, and deletion.'), keywords: ['memory', 'hindsight', 'recall', 'forget', 'profile', 'privacy', 'observation', '记忆'] },
    { id: 'permissions', title: t('Permissions'), description: t('Vault write scope, file operations, plugin control, and confirmations.'), keywords: ['permissions', 'file creation', 'file modification', 'plugin control', 'confirm', '权限'] },
    { id: 'skills', title: t('Skills'), description: t('Enable or disable individual skills (availability, separate from permissions).'), keywords: ['skills', 'skill', 'enable', 'disable', 'workflow', 'available', '技能'] },
    { id: 'capture', title: t('Capture'), description: t('Inbox, clipping storage, WeChat import, URL capture, and video transcription.'), keywords: ['wechat', 'capture', 'inbox', 'storage', 'clippings', 'web clipper', 'transcription', 'transcribe', 'asr', 'whisper', 'audio', 'video', '字幕', '转写', '语音', '采集', '微信'] },
    { id: 'knowledge', title: t('Knowledge'), description: t('Source folders, output folder, compile state, and ontology.'), keywords: ['knowledge', 'wiki', 'compile', 'source folders', 'batch', 'ontology', 'schema', '知识'] },
    { id: 'guardian', title: t('Guardian'), description: t('Inline writing assistance, trigger mode, and ignored folders.'), keywords: ['guardian', 'auto mode', 'manual mode', 'ignored folders', 'sensitivity', 'selection', 'toolbar', 'selection toolbar', '守护', '行内补全', '幽灵文本', '灵敏度', '补全', '选中', '工具条', '选中工具条'] },
    { id: 'appearance', title: t('Appearance'), description: t('Workbench theme, font size, and opacity.'), keywords: ['appearance', 'theme', 'font', 'opacity', 'terminal', 'workbench', 'language', 'locale', '外观', '语言'] },
    { id: 'plugin-skills', title: t('Plugin Skills'), description: t('Skill generation, excluded plugins, and startup scanning.'), keywords: ['plugin', 'skills', 'generator', 'exclude', 'startup', '插件'] },
    ];
}

/** 把 ProviderConfig.customHeaders 渲染成每行一条 "Header-Name: value" 的可编辑文本。 */
function serializeCustomHeaders(headers: Record<string, string> | undefined): string {
    if (!headers) return '';
    return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n');
}

export interface RequestPathSummary {
    /** 实际请求路径模板；{baseUrl} / {model} 为占位符 */
    pathTemplate: string;
    /** 该协议的服务地址是否通常包含 /v1 */
    baseUrlIncludesV1: boolean;
    /** 说明「地址该不该带 /v1」的一句话 */
    note: string;
}

/**
 * 各协议实际请求到哪个路径。
 *
 * 这是「API 类型」与「服务地址」不再混淆的关键：地址由 SDK 追加端点路径，
 * 用户必须知道地址里要不要写 /v1，以及最终打到哪里。
 */
export function getRequestPathSummary(type: ProviderType, apiFlavor?: OpenAIApiFlavor): RequestPathSummary {
    if (type === 'anthropic') {
        return {
            pathTemplate: '{baseUrl}/v1/messages',
            baseUrlIncludesV1: false,
            note: t('The service address must NOT include /v1 — the Anthropic SDK appends /v1/messages itself. The official endpoint is https://api.anthropic.com.'),
        };
    }
    // 非 Anthropic 一律按 OpenAI 兼容描述（含磁盘上残留的未知 type）：
    // 与 ModelService.buildModelForConfig 的降级方向保持一致，不凭空多出第三种说法。
    const isResponses = apiFlavor === 'responses';
    return {
        pathTemplate: isResponses ? '{baseUrl}/responses' : '{baseUrl}/chat/completions',
        baseUrlIncludesV1: true,
        note: isResponses
            ? t('The service address usually ends with /v1 — the OpenAI SDK appends /responses itself, so do not paste the full request path.')
            : t('The service address usually ends with /v1 — the OpenAI SDK appends /chat/completions itself, so do not paste the full request path.'),
    };
}

/** 把协议说明与实际请求路径拼成一行可连续阅读的帮助文字。 */
export function describeRequestPath(type: ProviderType, apiFlavor: OpenAIApiFlavor | undefined, baseUrl: string): string {
    const summary = getRequestPathSummary(type, apiFlavor);
    const base = (baseUrl || '').trim().replace(/\/+$/, '');
    const actual = summary.pathTemplate.replace('{baseUrl}', base || '{baseUrl}');
    return `${summary.note} ${fillPlaceholders(t('Actual request path: {path}'), { path: actual })}`;
}

export type FieldValidationState = 'ok' | 'warning' | 'error';

export interface FieldValidation {
    state: FieldValidationState;
    /** state 为 'ok' 时为空串 */
    message: string;
}

const VALIDATION_OK: FieldValidation = { state: 'ok', message: '' };

function invalidField(message: string): FieldValidation {
    return { state: 'error', message };
}

/** 服务商名称必填。此前空值静默回退旧名，用户以为改名成功、实际没改。 */
export function validateProviderName(value: string): FieldValidation {
    if (!(value || '').trim()) return invalidField(t('Provider name is required.'));
    return VALIDATION_OK;
}

/**
 * 服务地址校验。
 *
 * 核心是「地址里不能再带端点路径」：各协议 SDK 自己追加端点，粘了完整路径就会请求
 * {baseUrl}/chat/completions/chat/completions 这类不存在的地址，而报错信息只会说
 * 「连接失败」，用户根本猜不到原因。
 */
export function validateBaseUrl(type: ProviderType, value: string): FieldValidation {
    const trimmed = (value || '').trim();
    if (!trimmed) return invalidField(t('Base URL is required.'));
    if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
        return invalidField(t('Base URL must start with http:// or https:// and must not contain spaces.'));
    }

    // 先剥掉查询串/锚点，避免把 ?key=... 当成路径的一部分误判。
    const withoutQuery = trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '');

    if (type === 'anthropic') {
        if (/\/v1\/messages$/i.test(withoutQuery)) {
            return invalidField(t('Base URL must not include the request path — remove /v1/messages.'));
        }
        if (/\/v1$/i.test(withoutQuery)) {
            return invalidField(t('For Anthropic the base URL must not include /v1 — the SDK appends /v1/messages. Use https://api.anthropic.com.'));
        }
        return VALIDATION_OK;
    }

    if (/\/(chat\/completions|responses|completions)$/i.test(withoutQuery)) {
        return invalidField(t('Base URL must not include the request path — remove /chat/completions or /responses.'));
    }
    return VALIDATION_OK;
}

export interface CustomHeaderIssue {
    /** 1 起算的行号，与 textarea 里数到的行号一致 */
    line: number;
    text: string;
    reason: 'missing-colon' | 'empty-name' | 'duplicate-name';
}

export interface CustomHeadersValidation {
    state: FieldValidationState;
    message: string;
    issues: CustomHeaderIssue[];
    /** 可用的 header；非法行被跳过，但其余行照常保留 */
    headers: Record<string, string> | undefined;
}

/** 非法行的成因文案。写成短句，多条时用「;」串起来仍可读。 */
const CUSTOM_HEADER_ISSUE_REASONS: Record<CustomHeaderIssue['reason'], string> = {
    'missing-colon': 'missing ":" — write "Header-Name: value"',
    'empty-name': 'missing header name',
    'duplicate-name': 'duplicate header name, the last one wins',
};

/**
 * 校验并解析多行 header（取代此前静默忽略非法行的 parseCustomHeaders）。
 *
 * 有意保持宽松解析：非法行跳过而不是整段丢弃——用户逐行编辑时，正在敲的那一行不该把
 * 已经配好的其它 header 一起清空。但「跳过」必须出声，故逐行给出行号与成因，由 UI 就地显示
 * （此前是静默忽略，用户以为保存成功了）。
 *
 * 只有「名字重复」算 warning——它不会让请求发不出去，只是后一行会覆盖前一行。
 */
export function validateCustomHeaders(text: string): CustomHeadersValidation {
    const issues: CustomHeaderIssue[] = [];
    const headers: Record<string, string> = {};
    const seen = new Set<string>();

    (text || '').split('\n').forEach((raw, index) => {
        const trimmed = raw.trim();
        if (!trimmed) return;

        const separator = trimmed.indexOf(':');
        if (separator === -1) {
            issues.push({ line: index + 1, text: trimmed, reason: 'missing-colon' });
            return;
        }

        const name = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        if (!name) {
            issues.push({ line: index + 1, text: trimmed, reason: 'empty-name' });
            return;
        }

        // header 名大小写不敏感，重复判定也要按小写比。
        const normalized = name.toLowerCase();
        if (seen.has(normalized)) {
            issues.push({ line: index + 1, text: trimmed, reason: 'duplicate-name' });
        }
        seen.add(normalized);
        headers[name] = value;
    });

    const resolvedHeaders = Object.keys(headers).length > 0 ? headers : undefined;
    if (!issues.length) {
        return { state: 'ok', message: '', issues, headers: resolvedHeaders };
    }

    const details = issues
        .map(issue => `L${issue.line} ${t(CUSTOM_HEADER_ISSUE_REASONS[issue.reason])}`)
        .join('; ');
    const hasHardError = issues.some(issue => issue.reason !== 'duplicate-name');

    return {
        state: hasHardError ? 'error' : 'warning',
        message: fillPlaceholders(
            t('Custom headers: {issues}. Those lines are ignored; the rest are kept.'),
            { issues: details },
        ),
        issues,
        headers: resolvedHeaders,
    };
}

/**
 * 模型列表的来源状态。此前只有一个 `listUnavailable` 布尔量，把
 * 「端点不具备列模型能力」和「未配 key / 401 / 网络故障」塌成同一件事，
 * 于是真正的故障被说成「手动输入即可」，能力缺口又被当成配置错误。
 */
export type ModelListStatus =
    /** 端点真的返回了非空模型清单 */
    | 'listed'
    /** 端点不具备列模型能力（/models 返回 404/405/501）—— 能力缺口，不是故障 */
    | 'listing-unsupported'
    /** 端点 200 但清单为空（或响应体不是 {data:[...]}）—— 答了，但没宣称任何模型 */
    | 'empty-listing'
    /** 还没配 API Key，请求根本没发出去 */
    | 'missing-key'
    /** 其他失败：401、网络、JSON 解析……这是真错误，必须原样说出来 */
    | 'error';

export interface ModelFieldState {
    /** 下拉里的候选模型（可能为空） */
    options: ModelOption[];
    status: ModelListStatus;
    note: string;
    noteTone: 'muted' | 'warning' | 'error';
    /**
     * 手填模型 ID 是否可用。恒为 true：兼容网关常常没实现 /models，
     * 手填是唯一能配置模型的途径，下拉拉不到绝不代表字段不可用。
     */
    manualEntry: true;
    /**
     * 列表能不能当成「端点的真实结论」。**只由 `listed` 决定**。
     *
     * 不能用「listingUnsupported 与 error 都没设」来反推：`models` 永远非空
     * （抓不到就回落到内置列表），端点回 200 `{"data":[]}` 时两个标志都不设、
     * 列表里却是硬编码的兜底模型。此时若当可信，就会把 `claude-sonnet-4-5`
     * 这类内置值写进一个从未宣称过它的端点配置里。
     */
    trustList: boolean;
}

/**
 * 错误原因可能是一整页 HTML 或超长 JSON。截断后再展示，
 * 避免一条帮助文字把整行撑成好几屏（窄面板下尤其明显）。
 */
function summarizeModelListError(error: Error): string {
    const raw = (error?.message || '').replace(/\s+/g, ' ').trim();
    if (!raw) return t('unknown error');
    return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

/**
 * 模型字段的状态。
 *
 * 三态直接取自 ModelService.getAvailableModelsWithStatus 的语义化信号
 * （`listingUnsupported` / `error`），不再靠数组形状去猜「是不是列不出来」。
 * 旧启发式（「除当前模型外空无一物」= 列不出）会误伤「端点确实只暴露一个模型」
 * 的合法情况，也会把兜底列表误报成端点的真实清单。
 */
export function getModelFieldState(input: {
    result: Pick<AvailableModelsResult, 'models' | 'listed' | 'listingUnsupported' | 'error'>;
    currentModel: string;
    hasApiKey: boolean;
}): ModelFieldState {
    const options = (input.result.models || [])
        .filter(option => option && typeof option.value === 'string' && option.value.trim().length > 0);

    // 未配 key 时 ModelService 压根不发请求，它会把「没配 key」当 error 报回来。
    // 这属于「还没配好」而非故障，说清该做什么比抛一个错误串有用。
    if (!input.hasApiKey) {
        return {
            options,
            status: 'missing-key',
            note: t('No API key yet — you can type the model ID by hand; the list loads once a key is set.'),
            noteTone: 'warning',
            manualEntry: true,
            trustList: false,
        };
    }

    // 能力缺口优先于故障：端点不实现列模型，不代表它不能生成。
    if (input.result.listingUnsupported) {
        return {
            options,
            status: 'listing-unsupported',
            // 「列不出模型」≠「模型不能生成」：网关没实现 /models 很常见，/chat/completions 照样能用。
            // 不把这句话说清，用户会把可用的网关当成配错了。
            note: t('This endpoint does not support listing models. Type the model ID by hand — this does not mean the model cannot generate.'),
            noteTone: 'warning',
            manualEntry: true,
            trustList: false,
        };
    }

    if (input.result.error) {
        return {
            options,
            status: 'error',
            // 真错误就照实说，不再笼统化成「列表不可用」——原因决定了下一步该改什么。
            note: fillPlaceholders(
                t('Could not load the model list: {reason}. Type the model ID by hand.'),
                { reason: summarizeModelListError(input.result.error) },
            ),
            noteTone: 'error',
            manualEntry: true,
            trustList: false,
        };
    }

    // 端点答了 200，但没宣称任何模型（空清单，或响应体不是 {data:[...]}）。
    // 此时 models 是内置兜底列表：既不是故障，也绝不是这个端点的清单。
    if (!input.result.listed) {
        return {
            options,
            status: 'empty-listing',
            note: t('This endpoint returned no models. Type the model ID by hand — the listed suggestions are built in, not from this endpoint.'),
            noteTone: 'warning',
            manualEntry: true,
            trustList: false,
        };
    }

    return {
        options,
        status: 'listed',
        note: fillPlaceholders(
            t('{count} models listed. Pick one or type an ID.'),
            { count: String(options.length) },
        ),
        noteTone: 'muted',
        manualEntry: true,
        trustList: true,
    };
}

/** 连接测试探测的模型列表端点，用于把「测了什么」明确写进结果里。 */
export function getModelListEndpoint(type: ProviderType, baseUrl: string): string {
    const base = (baseUrl || '').trim().replace(/\/+$/, '');
    if (type === 'anthropic') {
        return `${base || DEFAULT_PROVIDERS.anthropic.baseUrl}/v1/models`;
    }
    return `${base || DEFAULT_PROVIDERS.openai.baseUrl}/models`;
}

/**
 * 连接测试的阶段。测试只探模型列表端点（不烧 token），故它只能证明「列得出/列不出模型」，
 * 证明不了「能不能生成」——这两个结论必须分开说。
 *
 * `model-list-unavailable` 与 `unreachable` 必须分开：前者端点活着、只是没有列模型能力
 * （404/405/501），后者才是真的连不上。此前两者共用一句「列表不可达」，于是 404 的端点
 * 会拿到一句绿色的「模型列表可达」，而同一屏的模型输入框却说列不了模型。
 */
export type ConnectionTestStage =
    | 'missing-key'
    /** 端点应答了，但不提供模型清单（404/405/501）——不是成功，也不是配置错误 */
    | 'model-list-unavailable'
    /** 真的连不上 / 401 / 网络 / 解析失败 */
    | 'unreachable'
    /** 正常列出了模型 */
    | 'endpoint-reachable';

/**
 * 把探活结果映射成测试阶段（纯函数，便于覆盖「真实探活结果 → 文案」这条端到端链路）。
 * 优先级：连不上 > 活着但不列模型 > 正常。
 */
export function getConnectionTestStage(status: {
    reachable: boolean;
    listingUnsupported: boolean;
}): ConnectionTestStage {
    if (!status.reachable) return 'unreachable';
    if (status.listingUnsupported) return 'model-list-unavailable';
    return 'endpoint-reachable';
}

export interface ConnectionTestReport {
    state: ConnectionTestState;
    message: string;
}

export function getConnectionTestReport(input: {
    label: string;
    stage: ConnectionTestStage;
    endpoint: string;
    /** 仅当「连不上」时给出的具体原因，原样附在结论后面。 */
    reason?: string;
}): ConnectionTestReport {
    const label = input.label || 'AI provider';

    if (input.stage === 'missing-key') {
        return { state: 'error', message: `${label}${t(': no API key configured.')}` };
    }

    // 端点活着但不提供模型清单：这不是成功，也不是配置错误。
    // 必须明说「生成能力未被验证」，否则用户会把 404 当成「连接正常」。
    if (input.stage === 'model-list-unavailable') {
        return {
            state: 'warning',
            message: fillPlaceholders(
                t('{label}: the endpoint at {url} answers, but it does not offer a model list. Generation was NOT verified — type the model ID by hand and try a real request.'),
                { label, url: input.endpoint },
            ),
        };
    }

    if (input.stage === 'endpoint-reachable') {
        return {
            state: 'success',
            message: fillPlaceholders(
                t('{label}: model list reachable at {url}. Only the endpoint was verified, not generation.'),
                { label, url: input.endpoint },
            ),
        };
    }

    // 真的连不上：把具体原因附上，否则「连接失败」四个字对排查毫无帮助。
    return {
        state: 'error',
        message: fillPlaceholders(
            t('{label}: could not reach the model list at {url}. Models cannot be listed — this does not prove the model cannot generate. Check the API key and service address, or type the model ID by hand.'),
            { label, url: input.endpoint },
        ) + (input.reason ? ` (${input.reason})` : ''),
    };
}

export interface ProtocolOption {
    value: ProviderType;
    label: string;
}

/**
 * 协议在 UI 上的展示名。
 * 单独抽出来是因为服务商卡片此前把所有非 OpenAI 兼容的协议都写成「OpenAI 兼容」——
 * 新增 anthropic 后卡片会直接把 Anthropic 说成 OpenAI 兼容。
 */
export function getProtocolLabel(type: ProviderType): string {
    if (type === 'anthropic') return t('Anthropic Messages API');
    return t('OpenAI-compatible');
}

/** 服务商卡片上的协议标记（纯装饰，但两种协议各有各的记号）。 */
/** 协议下拉的唯一来源：详情页与新增模态框共用，避免两处选项各自漂移。 */
export function getProtocolOptions(): ProtocolOption[] {
    return (['openai-compatible', 'anthropic'] as ProviderType[])
        .map(value => ({ value, label: getProtocolLabel(value) }));
}

/** 各协议的官方服务地址。直接读 DEFAULT_PROVIDERS，避免与冻结接口里的默认值各写一份。 */
export function getDefaultBaseUrlForType(type: ProviderType): string {
    if (type === 'anthropic') return DEFAULT_PROVIDERS.anthropic.baseUrl;
    return DEFAULT_PROVIDERS.openai.baseUrl;
}

/**
 * 新增自定义 provider 的初始配置。
 * 此前硬编码 openai-compatible —— 想加 Anthropic 网关只能先建好再改协议。
 */
export function buildNewProviderConfig(type: ProviderType, label: string, baseUrl: string): ProviderConfig {
    const trimmedUrl = (baseUrl || '').trim();
    return {
        type,
        label: (label || '').trim(),
        apiKey: '',
        baseUrl: trimmedUrl || getDefaultBaseUrlForType(type),
        model: '',
    };
}

/**
 * 协议切换时服务地址怎么迁移。
 * 地址为空（用户没填过）时填新协议的官方端点；其余情况保留用户填的值
 * —— 不清空、不猜测，交给就地校验去提示地址是否适用于新协议。
 */
export function resolveBaseUrlOnProtocolChange(nextType: ProviderType, previousBaseUrl: string): string {
    const trimmed = (previousBaseUrl || '').trim();
    if (!trimmed) return getDefaultBaseUrlForType(nextType);
    return trimmed;
}

/**
 * 模型字段的渲染依赖。以参数传入而非闭包 this，这样它能脱离 SettingTab 单测。
 */
export interface ModelFieldDeps {
    currentModel: string;
    hasApiKey: boolean;
    /**
     * 拉取可用模型**及其来源状态**。
     * 必须用 `getAvailableModelsWithStatus`：它把「端点不支持列模型」与
     * 「401/网络/未配 key」分开报，UI 才不必靠数组形状猜。
     */
    loadModels: (forceRefresh: boolean) => Promise<AvailableModelsResult>;
    /** 用户改定模型后落盘 */
    onModelChange: (modelId: string) => Promise<void> | void;
    /** 局部重绘后旧 DOM 已作废，异步回调据此放弃写入 */
    isStale: () => boolean;
    /**
     * 上一次已加载的结果。命中时直接渲染，不再重发 /models 请求 —— 设置页每次
     * 局部重绘都会重建模型字段，若每次都重新拉列表，移动端弱网下会堆起一串挂起请求
     * （issue #81）。只有用户点「Refresh list」才强制重取。
     */
    loadedResult?: AvailableModelsResult;
    /** 加载完成后把结果交给上层缓存（失败兜底结果也缓存，避免重绘后重复请求）。 */
    onLoaded?: (result: AvailableModelsResult) => void;
}

/**
 * 渲染模型字段：一个**始终可编辑**的文本输入（真源）+ 一个来自服务端的候选下拉 + 刷新按钮。
 *
 * 关键取舍：输入框是唯一真源。此前列表拉不到就把 select 置灰、只显示「模型列表不可用」，
 * 用户既看不到当前模型也改不了它 —— 没实现 /models 的兼容网关就此无法配置。
 * 下拉只是省打字的便利，拉不到时仍然照常显示（只是没有候选），绝不置灰。
 */
export function renderModelField(container: HTMLElement, deps: ModelFieldDeps): void {
    const input = container.createEl('input', {
        cls: 'baizer-settings-detail-input baizer-settings-model-input',
        attr: {
            type: 'text',
            spellcheck: 'false',
            autocomplete: 'off',
            'aria-label': t('Model ID'),
        },
    });
    input.value = deps.currentModel;
    // 长模型名不该只能靠截断看：悬停给完整值，输入框本身可编辑全文。
    input.title = deps.currentModel;

    const picker = container.createDiv({ cls: 'baizer-settings-model-picker' });
    const select = picker.createEl('select', {
        cls: 'baizer-settings-detail-input baizer-settings-model-select',
        attr: { 'aria-label': t('Model list') },
    });
    const refresh = picker.createEl('button', {
        cls: 'baizer-settings-action',
        text: t('Refresh list'),
        attr: { type: 'button' },
    });

    const note = container.createDiv({ cls: 'baizer-settings-field-hint' });

    let committed = deps.currentModel;

    const commitModel = async (): Promise<void> => {
        const value = input.value.trim();
        input.title = input.value;
        if (value === committed) return;
        committed = value;
        await deps.onModelChange(value);
    };

    input.addEventListener('input', () => {
        // 只同步 title，不落盘：模型 ID 半途的中间态没有保存价值，落盘还会重建 LLM 客户端。
        input.title = input.value;
    });
    input.addEventListener('change', () => { void commitModel(); });
    input.addEventListener('blur', () => { void commitModel(); });

    const applyState = (result: AvailableModelsResult): void => {
        const state = getModelFieldState({
            result,
            currentModel: input.value.trim(),
            hasApiKey: deps.hasApiKey,
        });

        select.empty();
        if (state.options.length === 0) {
            select.createEl('option', { value: '', text: t('No models listed') });
            select.value = '';
        } else {
            state.options.forEach(option => select.createEl('option', { value: option.value, text: option.label }));
            const current = input.value.trim();
            select.value = state.options.some(option => option.value === current)
                ? current
                : state.options[0].value;
        }
        // 有意不置灰：置灰的下拉既读不出候选也点不动，用户会以为整个模型字段坏了。
        select.disabled = false;
        // 兜底列表不是这个端点的结论，不能冒充「模型列表」；改称「候选建议」并降调，
        // 否则用户会以为下拉里那些模型一定被当前端点支持。
        select.toggleClass('is-untrusted', !state.trustList);
        select.setAttribute(
            'aria-label',
            state.trustList ? t('Model list') : t('Suggested models (not listed by this endpoint)'),
        );

        note.setText(state.note);
        note.toggleClass('is-warning', state.noteTone === 'warning');
        note.toggleClass('is-error', state.noteTone === 'error');

        // P0-2 保留，但只在列表可信时回填：新增/自定义 provider 的 model 为空时把真实列到的
        // 第一个模型写回 config，避免「下拉看着选了模型、config.model 仍是空」。
        // 列表不可信时绝不回填——兜底值未必被该端点支持，写进去等于替用户编了个模型。
        if (state.trustList && !input.value.trim() && state.options.length > 0) {
            input.value = state.options[0].value;
            input.title = input.value;
            committed = input.value;
            void deps.onModelChange(input.value);
        }
    };

    const load = async (forceRefresh: boolean): Promise<void> => {
        select.disabled = true;
        select.empty();
        select.createEl('option', { value: '__loading__', text: t('Loading models...') });
        select.value = '__loading__';
        try {
            const result = await deps.loadModels(forceRefresh);
            // 即使旧 DOM 已作废也把结果交给上层缓存：下一次重绘不必再打一次 /models。
            deps.onLoaded?.(result);
            if (deps.isStale()) return;
            applyState(result);
        } catch (caught: unknown) {
            // getAvailableModelsWithStatus 自己吞异常并回落，这里只兜底意外抛出：
            // 仍然保持可手填，但如实报成 error，不假装「列表可用」。
            if (deps.isStale()) return;
            applyState({
                models: [],
                listed: false,
                listingUnsupported: false,
                error: caught instanceof Error ? caught : new Error(String(caught)),
            });
        }
    };

    refresh.addEventListener('click', () => { void load(true); });
    select.addEventListener('change', () => {
        const value = select.value;
        if (!value || value === '__loading__') return;
        if (value === input.value.trim()) return;
        input.value = value;
        void commitModel();
    });

    if (deps.loadedResult) {
        // 命中缓存：直接渲染上次结果。重绘、搜索、展开分区都不再触发新的 /models 请求。
        applyState(deps.loadedResult);
    } else {
        void load(false);
    }
}

/** 就地校验反馈节点：只改文案与色调，不重建 DOM —— 重建会打断正在输入的焦点。 */
function createFieldFeedback(parent: HTMLElement): (validation: FieldValidation) => void {
    const element = parent.createDiv({ cls: 'baizer-settings-field-feedback' });
    return (validation: FieldValidation) => {
        element.toggleClass('is-error', validation.state === 'error');
        element.toggleClass('is-warning', validation.state === 'warning');
        element.setText(validation.state === 'ok' ? '' : validation.message);
    };
}

/**
 * 模型字段结果缓存键：端点的身份（provider / 协议 / 地址 / key 前缀）。
 * 只改模型名或其它无关设置时键不变，重绘可以复用上次列表；
 * 地址、协议或 key 变了才需要重新列模型。
 */
export function getModelFieldCacheKey(
    providerId: string,
    config: ProviderConfig | undefined,
): string {
    if (!config) return providerId;
    return `${providerId}:${config.type}:${(config.baseUrl || '').trim()}:${(config.apiKey || '').slice(0, 8)}`;
}

/** 模型字段结果缓存有效期：与 ModelService 的 modelListCache TTL 保持一致。 */
export const MODEL_FIELD_CACHE_TTL_MS = 10 * 60 * 1000;

export function getSettingsOverviewActions(settings: PluginSettings): SettingsOverviewAction[] {
    const actions: SettingsOverviewAction[] = [];

    // P1-4: \u6982\u89C8\u884C\u52A8\u9879\u6B64\u524D\u786C\u7F16\u7801\u4E2D\u6587,\u82F1\u6587\u73AF\u5883\u65E0\u6CD5\u56DE\u9000\u3002\u6539\u8D70 t()\u3002
    if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
        actions.push({ label: t('Permissions too broad'), sectionId: 'permissions', tone: 'danger' });
    }

    for (const provider of Object.values(settings.providers || {})) {
        if (!provider.apiKey?.trim()) {
            actions.push({ label: `${provider.label} ${t('missing API key')}`, sectionId: 'connection', tone: 'warning' });
        }
    }

    return actions;
}

/** 派生技能在设置页的一行展示。判定归 PluginWatcher，这里只决定「显示什么」。 */
export interface DerivedSkillRow {
    pluginId: string;
    skillName: string;
    /** 生成时的插件版本；漂移时附上当前版本 */
    versionLabel: string;
    /** 陈旧 / 被手工编辑 / 未提供，按此固定顺序 */
    badges: string[];
    /** 最近一次生成失败的原因；没有则 null */
    failureReason: string | null;
    offered: boolean;
}

/**
 * 把对账状态 + 生成失败原因映射成展示行。
 * 抽成纯函数是为了可测：DOM 那层只负责把这些字段放进元素里。
 */
export function getDerivedSkillRows(
    statuses: DerivedSkillStatus[],
    failures: ReadonlyMap<string, string>,
): DerivedSkillRow[] {
    return statuses.map((status) => ({
        pluginId: status.pluginId,
        skillName: status.skillName,
        versionLabel: buildDerivedVersionLabel(status),
        badges: buildDerivedBadges(status),
        failureReason: failures.get(status.pluginId) ?? null,
        offered: status.offered,
    }));
}

/** 无溯源时明说「版本未知」,不要编一个出来——用户据此判断要不要信这份技能。 */
function buildDerivedVersionLabel(status: DerivedSkillStatus): string {
    if (!status.recordedVersion) {
        return t('Generated from an unknown version');
    }
    const base = t('Generated from v{version}').replace('{version}', status.recordedVersion);
    if (!status.stale || !status.installedVersion) return base;
    return `${base} · ${t('plugin now v{version}').replace('{version}', status.installedVersion)}`;
}

/** 被拒成因 → 该去改哪一项。笼统列举全部前置条件会指向与本次无关的事。 */
const REGENERATE_BLOCKER_MESSAGES: Record<DerivedSkillRegenerateBlocker, string> = {
    'auto-generate-off': 'Cannot regenerate: turn on automatic plugin skill generation first.',
    'plugin-control-off': 'Cannot regenerate: grant plugin control first.',
    'model-not-ready': 'Cannot regenerate: configure a usable model first.',
    'source-missing': 'Cannot regenerate: the source plugin is no longer installed or enabled.',
    'source-excluded': 'Cannot regenerate: the source plugin is on the exclude list.',
};

/**
 * 显式重新生成的三种结局,各说各的:
 * - 带 blocker:条件不满足,什么都没做——并点明是哪一项
 * - regenerated=false:真的试了但没写成，带上原因
 * - regenerated=true:写成了
 * 把中间那种说成成功就是把失败报成成功——ticket 05 要消灭的正是这类提示。
 */
export function getRegenerateOutcomeMessage(
    pluginId: string,
    outcome:
        | Pick<DerivedSkillStatus, 'regenerated' | 'failureReason'>
        | { blocker: DerivedSkillRegenerateBlocker },
): string {
    if ('blocker' in outcome) {
        return t(REGENERATE_BLOCKER_MESSAGES[outcome.blocker]);
    }
    if (!outcome.regenerated) {
        const reason = outcome.failureReason ?? t('unknown reason');
        return fillPlaceholders(
            t('Could not regenerate the skill for {plugin}: {reason}'),
            { plugin: pluginId, reason },
        );
    }
    return fillPlaceholders(t('Regenerated the skill for {plugin}.'), { plugin: pluginId });
}

/**
 * 占位符替换。用回调式 replace 而非替换串:失败原因来自 provider 的异常消息,
 * 是任意外部文本,其中的 $& / $' / $1 在替换串位置有特殊语义,会把文案吃掉。
 */
function fillPlaceholders(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match);
}

function buildDerivedBadges(status: DerivedSkillStatus): string[] {
    const badges: string[] = [];
    if (status.stale) badges.push(t('Stale'));
    // handEdited 为 null 表示无溯源、无从判断,不能报成「你改过」。
    if (status.handEdited === true) badges.push(t('Edited by you'));
    if (!status.offered) badges.push(t('Not offered'));
    return badges;
}

export function getConnectionTestStatusPresentation(
    status: ConnectionTestStatus
): SettingsSectionStatus | undefined {
    if (!status.message.trim() || status.state === 'idle') {
        return undefined;
    }

    if (status.state === 'testing') {
        return { tone: 'accent', label: status.message };
    }

    if (status.state === 'success') {
        return { tone: 'success', label: status.message };
    }

    // 「端点活着但没有模型清单」既不是成功也不是失败：绿色会让用户以为一切正常，
    // 红色又会让人以为配错了。用 warning 如实表达「这条结论没验证生成能力」。
    if (status.state === 'warning') {
        return { tone: 'warning', label: status.message };
    }

    return { tone: 'danger', label: status.message };
}

function getSectionMeta(id: SettingsSectionId): SettingsSectionMeta {
    const section = getSettingsSections().find(candidate => candidate.id === id);
    if (!section) {
        throw new Error(`Unknown settings section: ${id}`);
    }
    return section;
}

function renderSettingHeading(
    containerEl: HTMLElement,
    name: string,
    options: { settingClass?: string; nameClass?: string } = {},
): Setting {
    const heading = new Setting(containerEl).setName(name).setHeading();
    if (options.settingClass) heading.settingEl.addClass(options.settingClass);
    if (options.nameClass) heading.nameEl.addClass(options.nameClass);
    return heading;
}

/**
 * 声明式设置页（Obsidian >= 1.13 的 getSettingDefinitions()）。
 *
 * 设计取舍：
 * - 每个原「分区」变成一个可导航的子页；标量设置用 control 定义，Obsidian 负责渲染、
 *   保存与全局设置搜索索引。
 * - 动态/异步内容（模型列表、连接测试、记忆浏览、派生技能、知识库状态）用 render 回调
 *   或 SettingPage 子类，因为它们依赖运行时状态、没有对应的声明式控件。
 * - 读取/写入仍走插件自己的 saveSettings()/saveSettingsLight()：getControlValue/
 *   setControlValue 被覆写，保留既有的「重建 provider/guardian/knowledge」副作用。
 */

const API_KEY_PLACEHOLDER = 'sk-...';

/** 这些键的落盘走 400ms debounce：逐击键/逐格拖动时重建服务代价高。 */
const DEBOUNCED_SETTING_KEYS = new Set<string>([
    'systemPrompt',
    'ignoredFolders',
    'contextWindow',
    'guardianSensitivity',
    'knowledgeSourceFolders',
    'knowledgeMaxCompileBatch',
    'asrBaseUrl',
    'asrApiKey',
    'asrModel',
    'asrLanguage',
    'wechatInboxPath',
    'wechatStoragePath',
    'pluginSkillExcludeList',
]);

/** 纯 UI 字段：只写 data.json，不重建 provider/guardian/knowledge。 */
const LIGHT_SETTING_KEYS = new Set<string>([
    'terminalTheme',
    'terminalFontSize',
    'terminalOpacity',
]);

/** 这些键变化后需要重建定义结构（可选项/说明文字随值变化），而不是只刷新谓词。 */
const STRUCTURAL_SETTING_KEYS = new Set<string>([
    'language',
]);

function providerKey(providerId: string, field: 'label' | 'type' | 'apiFlavor' | 'baseUrl'): string {
    return `provider.${providerId}.${field}`;
}

function skillKey(skillName: string): string {
    return `skill.${skillName}`;
}

/** FieldValidation → control.validate 的返回值（ok 时返回 undefined）。 */
function validationMessage(validation: FieldValidation): string | undefined {
    return validation.state === 'ok' ? undefined : validation.message;
}

export class SettingTab extends PluginSettingTab {
    plugin: IPlugin;

    // 文本/滑块逐次落盘代价高：debounce 到一次保存。
    // debounce 回调返回的 Promise 会被 debounce 丢弃，落盘失败必须在这里接住：
    // 记日志 + Notice，让用户知道刚才的修改没有保存。
    private debouncedPersist: Debouncer<[], Promise<void>> = debounce(
        () => this.persistSettings().catch(this.reportAsyncFailure),
        400,
        false,
    );
    // 纯 UI 字段（外观主题/字号/不透明度）走轻量保存 + debounce，避免拖动滑块时重建 LLM 客户端。
    private debouncedPersistLight: Debouncer<[], Promise<void>> = debounce(
        () => this.persistSettingsLight().catch(this.reportAsyncFailure),
        400,
        false,
    );
    // 设置页里所有「不能 await 的异步入口」（事件监听、Modal 回调、debounce）的统一失败出口。
    // notifyFailure 只负责让用户看到；日志由 detach/voidHandler 记。
    private readonly notifyFailure = (error: unknown): void => {
        new Notice(`${t('Settings action failed')}: ${thrownMessage(error) || t('unknown reason')}`);
    };
    // debounce 回调里没有 detach 可用，自己记日志再提示。
    private readonly reportAsyncFailure = (error: unknown): void => {
        logger.error('Settings persist failed', error, 'SettingsTab');
        this.notifyFailure(error);
    };
    private revealedApiKeys = new Set<string>();
    private connectionTestStatus = new Map<string, ConnectionTestStatus>();
    // 模型字段结果缓存：重绘/翻页都复用上次列表，只有用户点 Refresh list 才强制重取。
    private modelFieldCache = new Map<string, { result: AvailableModelsResult; timestamp: number }>();
    // 知识库状态行 5s 内复用上次文案，避免每次打开子页都遍历全库。
    private ontologyStatusCache: { text: string; title: string; timestamp: number } | null = null;
    private static readonly ONTOLOGY_STATUS_CACHE_TTL_MS = 5000;
    // 面板打开期间监听「页面被隐藏」：移动端切后台/被回收前尽量把 debounce 里的最后编辑落盘。
    private visibilityFlushInstalled = false;

    constructor(app: App, plugin: IPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        // 设置侧栏里的插件图标（声明式设置页不再自己画标题栏/图标）。
        this.icon = 'bot';
        ensureSettingsFallbackStyles();
        this.installVisibilityFlush();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 存储适配：声明式控件按 key 读写插件自己的设置对象。
    // 不走 PluginSettingTab 默认实现，是为了保留 saveSettings() 的重建副作用。
    // ────────────────────────────────────────────────────────────────────────

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            ...this.buildAttentionItems(),
            this.buildProvidersPage(),
            this.buildBehaviorPage(),
            this.buildMemoryPage(),
            this.buildPermissionsPage(),
            this.buildSkillsPage(),
            this.buildCapturePage(),
            this.buildKnowledgePage(),
            this.buildGuardianPage(),
            this.buildAppearancePage(),
            this.buildPluginSkillsPage(),
        ];
    }

    getControlValue(key: string): unknown {
        if (key.startsWith('provider.')) return this.getProviderControlValue(key);
        if (key.startsWith('skill.')) {
            const skillName = key.slice('skill.'.length);
            return !(this.plugin.settings.disabledSkills ?? []).includes(skillName);
        }

        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        switch (key) {
            case 'knowledgeSourceFolders':
                return (this.plugin.settings.knowledgeSourceFolders ?? []).join('\n');
            case 'vaultWriteAllowedFolders':
                return (this.plugin.settings.vaultWriteAllowedFolders ?? []).join('\n');
            case 'pluginSkillExcludeList':
                return (this.plugin.settings.pluginSkillExcludeList ?? []).join(', ');
            case 'knowledgeOntologyEnabled':
                return this.plugin.settings.knowledgeOntologyEnabled !== false;
            default:
                return settings[key];
        }
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (key.startsWith('provider.')) {
            await this.setProviderControlValue(key, value);
            return;
        }
        if (key.startsWith('skill.')) {
            await this.setSkillControlValue(key, value);
            return;
        }

        const settings = this.plugin.settings;
        switch (key) {
            case 'knowledgeSourceFolders':
                settings.knowledgeSourceFolders = String(value ?? '')
                    .split('\n')
                    .map(entry => entry.trim())
                    .filter(entry => entry.length > 0);
                break;
            case 'vaultWriteAllowedFolders':
                settings.vaultWriteAllowedFolders = String(value ?? '')
                    .split(/\r?\n/)
                    .map(entry => entry.trim())
                    .filter(entry => entry.length > 0);
                break;
            case 'pluginSkillExcludeList':
                settings.pluginSkillExcludeList = String(value ?? '')
                    .split(',')
                    .map(entry => entry.trim())
                    .filter(entry => entry.length > 0);
                break;
            case 'knowledgeWikiFolder':
                settings.knowledgeWikiFolder = String(value ?? '').trim() || 'Knowledge Wiki';
                break;
            case 'asrBaseUrl':
            case 'asrApiKey':
            case 'asrModel':
            case 'asrLanguage':
                settings[key] = String(value ?? '').trim();
                break;
            case 'language': {
                const locale = value as Locale;
                if (typeof this.plugin.applyLanguageChange === 'function') {
                    await this.plugin.applyLanguageChange(locale);
                } else {
                    settings.language = locale;
                    await this.persistSettingsLight();
                }
                this.update();
                return;
            }
            default:
                (settings as unknown as Record<string, unknown>)[key] = value;
                break;
        }

        if (LIGHT_SETTING_KEYS.has(key)) {
            this.debouncedPersistLight();
        } else if (DEBOUNCED_SETTING_KEYS.has(key)) {
            this.debouncedPersist();
        } else {
            await this.persistSettings();
        }
        if (STRUCTURAL_SETTING_KEYS.has(key)) this.update();
        else this.refreshDomState();
    }

    private getProviderControlValue(key: string): unknown {
        const parsed = this.parseProviderKey(key);
        if (!parsed) return undefined;
        const config = this.plugin.settings.providers[parsed.providerId];
        if (!config) return undefined;
        switch (parsed.field) {
            case 'label': return config.label;
            case 'type': return config.type;
            case 'apiFlavor': return config.apiFlavor ?? 'completions';
            case 'baseUrl': return config.baseUrl;
        }
    }

    private async setProviderControlValue(key: string, value: unknown): Promise<void> {
        const parsed = this.parseProviderKey(key);
        if (!parsed) return;
        const settings = this.plugin.settings;
        const config = settings.providers[parsed.providerId];
        if (!config) return;

        switch (parsed.field) {
            case 'label':
                config.label = String(value ?? '').trim();
                this.debouncedPersist();
                return;
            case 'baseUrl':
                config.baseUrl = String(value ?? '').trim();
                this.connectionTestStatus.delete(parsed.providerId);
                this.debouncedPersist();
                return;
            case 'type': {
                const nextType = value as ProviderType;
                if (nextType === config.type) return;
                config.type = nextType;
                // 地址语义随协议变，按新协议迁移而不是把上个协议的地址原样留着冒充可用。
                config.baseUrl = resolveBaseUrlOnProtocolChange(nextType, config.baseUrl);
                // apiFlavor 只对 openai-compatible 有意义，切走时清掉避免残留值日后被误读。
                if (nextType !== 'openai-compatible') delete config.apiFlavor;
                this.connectionTestStatus.delete(parsed.providerId);
                await this.persistSettings();
                this.update();
                return;
            }
            case 'apiFlavor':
                config.apiFlavor = value as OpenAIApiFlavor;
                this.connectionTestStatus.delete(parsed.providerId);
                await this.persistSettings();
                this.update();
                return;
        }
    }

    private parseProviderKey(key: string): { providerId: string; field: 'label' | 'type' | 'apiFlavor' | 'baseUrl' } | null {
        const rest = key.slice('provider.'.length);
        const dot = rest.lastIndexOf('.');
        if (dot <= 0) return null;
        const field = rest.slice(dot + 1);
        if (field !== 'label' && field !== 'type' && field !== 'apiFlavor' && field !== 'baseUrl') return null;
        return { providerId: rest.slice(0, dot), field };
    }

    private async setSkillControlValue(key: string, value: unknown): Promise<void> {
        const skillName = key.slice('skill.'.length);
        const next = new Set(this.plugin.settings.disabledSkills ?? []);
        if (value) next.delete(skillName);
        else next.add(skillName);
        this.plugin.settings.disabledSkills = [...next];
        await this.persistSettings();
    }

    private async persistSettings(): Promise<void> {
        await this.plugin.saveSettings();
    }

    private async persistSettingsLight(): Promise<void> {
        if (typeof this.plugin.saveSettingsLight === 'function') {
            await this.plugin.saveSettingsLight();
        } else {
            await this.plugin.saveSettings();
        }
    }

    /** debouncedPersist 的回调已自带 catch（日志 + Notice）；detach 保证 run() 本身也不留悬空 Promise。 */
    private flushPersistedEdits(): void {
        detach(this.debouncedPersist.run(), 'SettingsTab');
    }

    hide(): void {
        // 面板关闭时立即落盘 debounce 里未触发的最后一次编辑，避免丢改。
        this.flushPersistedEdits();
        detach(this.debouncedPersistLight.run(), 'SettingsTab');
        super.hide();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 顶部：需要关注的配置项。声明式页面无法在 1.13.0 上给导航项加状态角标
    // （displayValue/status 是 1.13.1 的 API），因此把「概览」折叠成页首的静态行。
    // ────────────────────────────────────────────────────────────────────────

    private buildAttentionItems(): SettingDefinitionItem[] {
        const actions = getSettingsOverviewActions(this.plugin.settings);
        if (!actions.length) return [];
        return [{
            type: 'group',
            heading: t('Needs attention'),
            items: actions.map(action => ({
                name: action.label,
                desc: fillPlaceholders(
                    t('Review this on the {section} page.'),
                    { section: getSectionMeta(action.sectionId).title },
                ),
            })),
        }];
    }

    // ────────────────────────────────────────────────────────────────────────
    // 连接：服务商列表 → 每个服务商一个声明式子页。
    // ────────────────────────────────────────────────────────────────────────

    private buildProvidersPage(): SettingDefinitionPage {
        const meta = getSectionMeta('connection');
        const providerIds = Object.keys(this.plugin.settings.providers);
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [{
                type: 'list',
                emptyState: t('No providers configured. Add one to get started.'),
                addItem: {
                    name: t('Add provider'),
                    action: () => this.openAddProviderModal(),
                },
                onDelete: (index: number) => {
                    const id = Object.keys(this.plugin.settings.providers)[index];
                    if (id) this.requestDeleteProvider(id);
                },
                items: providerIds.map(id => this.buildProviderPage(id)),
            }],
        };
    }

    private buildProviderPage(providerId: string): SettingDefinitionPage {
        const settings = this.plugin.settings;
        const config = settings.providers[providerId];
        const isActive = settings.activeProvider === providerId;
        const statusBits = [
            isActive ? t('Active provider') : t('Inactive provider'),
            getProtocolLabel(config.type),
            config.model?.trim() ? config.model.trim() : t('No model selected'),
        ];
        if (!config.apiKey?.trim()) statusBits.push(t('Needs key'));

        return {
            type: 'page',
            name: this.uniqueProviderPageName(providerId),
            desc: statusBits.join(' · '),
            items: [
                {
                    name: isActive ? t('Active provider') : t('Use this provider'),
                    desc: isActive
                        ? t('AI requests use this provider.')
                        : t('Make this the provider that AI requests use.'),
                    action: () => { void this.activateProvider(providerId); },
                    disabled: isActive,
                },
                {
                    name: t('Provider name'),
                    desc: t('Shown in the provider list. An empty name is rejected instead of silently keeping the old one.'),
                    control: {
                        type: 'text',
                        key: providerKey(providerId, 'label'),
                        placeholder: t('My Provider'),
                        validate: (value: string) => validationMessage(validateProviderName(value)),
                    },
                },
                {
                    name: t('Protocol'),
                    desc: t('The wire protocol this provider speaks. Switching it only shows the fields that apply.'),
                    control: {
                        type: 'dropdown',
                        key: providerKey(providerId, 'type'),
                        options: Object.fromEntries(getProtocolOptions().map(option => [option.value, option.label])),
                    },
                },
                {
                    name: t('API type (Chat Completions / Responses)'),
                    desc: getRequestPathSummary('openai-compatible', config.apiFlavor).note,
                    visible: () => config.type === 'openai-compatible',
                    control: {
                        type: 'dropdown',
                        key: providerKey(providerId, 'apiFlavor'),
                        defaultValue: 'completions',
                        options: {
                            completions: t('Chat Completions (/chat/completions)'),
                            responses: t('Responses (/responses)'),
                        },
                    },
                },
                {
                    name: t('Service address (Base URL)'),
                    render: (setting: Setting) => this.renderProviderBaseUrlRow(setting, providerId),
                },
                {
                    name: t('API key'),
                    desc: t('Stored locally and hidden by default. Use Reveal to check it; Clear asks for confirmation.'),
                    render: (setting: Setting) => this.renderProviderApiKeyRow(setting, providerId),
                },
                {
                    name: t('Model'),
                    desc: t('Pick a model from the list once the endpoint returns it, or type the model ID directly.'),
                    render: (setting: Setting) => this.renderProviderModelRow(setting, providerId),
                },
                {
                    name: t('Custom headers (advanced)'),
                    desc: t('One "Header-Name: value" per line. Use {{conversationId}} to send the current conversation ID; it is skipped for one-off calls that have no conversation.'),
                    render: (setting: Setting) => this.renderProviderHeadersRow(setting, providerId),
                },
                {
                    name: t('Connection test'),
                    desc: fillPlaceholders(
                        t('Checks whether the model list is reachable at {url}. It does not run a generation, so a pass means "the endpoint answers", not "the model can generate".'),
                        { url: getModelListEndpoint(config.type, config.baseUrl) },
                    ),
                    render: (setting: Setting) => this.renderProviderTestRow(setting, providerId),
                },
            ],
        };
    }

    private uniqueProviderPageName(providerId: string): string {
        const settings = this.plugin.settings;
        const label = settings.providers[providerId]?.label?.trim() || providerId;
        const siblings = Object.keys(settings.providers)
            .filter(otherId => otherId !== providerId)
            .map(otherId => settings.providers[otherId]?.label?.trim() || otherId);
        return siblings.includes(label) ? `${label} (${providerId})` : label;
    }

    private openAddProviderModal(): void {
        const settings = this.plugin.settings;
        new AddProviderModal(this.app, (draft) => {
            const key = `custom-${Date.now()}`;
            settings.providers[key] = buildNewProviderConfig(draft.type, draft.label, draft.baseUrl);
            settings.activeProvider = key;
            detach(this.persistSettings().then(() => this.update()), 'SettingsTab', this.notifyFailure);
        }).open();
    }

    private requestDeleteProvider(providerId: string): void {
        const settings = this.plugin.settings;
        const config = settings.providers[providerId];
        if (!config) return;
        if (Object.keys(settings.providers).length <= 1) {
            new Notice(t('At least one provider must remain configured.'));
            this.update();
            return;
        }
        new MemoryConfirmModal(
            this.app,
            t('Delete Provider'),
            `${t('Delete provider')} "${config.label || providerId}"? ${t('This removes its configuration from this workspace.')}`,
            async () => {
                delete settings.providers[providerId];
                if (BUILTIN_PROVIDER_KEYS.includes(providerId)) {
                    settings.deletedProviderIds = Array.from(new Set([...(settings.deletedProviderIds || []), providerId]));
                }
                // 仅当删的是当前激活项时才需要改选激活；删其它项保持当前激活不变。
                if (providerId === settings.activeProvider) {
                    settings.activeProvider = Object.keys(settings.providers)[0] || DEFAULT_SETTINGS.activeProvider;
                }
                this.connectionTestStatus.delete(providerId);
                this.revealedApiKeys.delete(providerId);
                await this.persistSettings();
                new Notice(t('Provider deleted'));
                this.update();
            },
            // 列表的删除按钮会先删掉 DOM 行；取消时把界面重新同步回真实数据。
            () => this.update(),
        ).open();
    }

    private async activateProvider(providerId: string): Promise<void> {
        if (typeof this.plugin.modelService.switchProvider === 'function') {
            await this.plugin.modelService.switchProvider(providerId, () => this.persistSettings());
        } else {
            this.plugin.settings.activeProvider = providerId;
            await this.persistSettings();
        }
        this.update();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 连接子页里的动态行（API Key / 模型 / 请求头 / 连接测试）。
    // ────────────────────────────────────────────────────────────────────────

    /**
     * 声明式控件的右侧列很窄：多行文本会被压成一条细缝。需要整行宽度的 textarea
     * 统一走这个 render 行（name/desc 在上、textarea 占满整行），与 Base URL 同一布局。
     */
    private renderStackedTextarea(
        setting: Setting,
        options: { value: string; rows?: number; placeholder?: string; onChange: (value: string) => void },
    ): void {
        setting.settingEl.addClass('baizer-setting-stacked');
        setting.addTextArea(area => {
            area.setPlaceholder(options.placeholder ?? '');
            area.inputEl.rows = options.rows ?? 4;
            area.inputEl.setAttribute('spellcheck', 'false');
            area.setValue(options.value);
            area.onChange(options.onChange);
        });
    }

    /** Base URL 需要整行宽度 + 就地校验 + 动态请求路径说明，故用 render 而非原生 text 控件。 */
    private renderProviderBaseUrlRow(setting: Setting, providerId: string): void {
        const config = this.plugin.settings.providers[providerId];
        if (!config) return;
        setting.settingEl.addClass('baizer-setting-stacked');
        const input = setting.controlEl.createEl('input', {
            cls: 'baizer-settings-detail-input',
            attr: {
                type: 'text',
                placeholder: getDefaultBaseUrlForType(config.type),
                spellcheck: 'false',
                autocomplete: 'off',
                'aria-label': t('Service address (Base URL)'),
            },
        });
        input.value = config.baseUrl;
        // 完整值可悬停查看，输入框本身可编辑全文——不靠截断当唯一手段。
        input.title = config.baseUrl;
        const feedback = createFieldFeedback(setting.controlEl);
        const pathHint = setting.controlEl.createDiv({ cls: 'baizer-settings-field-hint' });
        const sync = (): void => {
            feedback(validateBaseUrl(config.type, input.value));
            pathHint.setText(describeRequestPath(config.type, config.apiFlavor, input.value));
        };
        input.addEventListener('input', () => {
            input.title = input.value;
            config.baseUrl = input.value;
            sync();
            this.debouncedPersist();
        });
        input.addEventListener('change', () => {
            config.baseUrl = input.value;
            this.connectionTestStatus.delete(providerId);
            this.debouncedPersist();
        });
        sync();
    }

    private renderProviderApiKeyRow(setting: Setting, providerId: string): void {
        const config = this.plugin.settings.providers[providerId];
        if (!config) return;
        setting.settingEl.addClass('baizer-setting-stacked');
        const hasKey = () => !!config.apiKey?.trim();
        let inputEl: HTMLInputElement | null = null;
        let revealButton: { setButtonText(text: string): unknown } | null = null;

        setting.addText(text => {
            inputEl = text.inputEl;
            text.inputEl.type = this.revealedApiKeys.has(providerId) ? 'text' : 'password';
            text.inputEl.autocomplete = 'off';
            text.inputEl.spellcheck = false;
            text.setPlaceholder(API_KEY_PLACEHOLDER);
            text.setValue(config.apiKey);
            text.onChange((value: string) => {
                config.apiKey = value;
                this.debouncedPersist();
            });
            text.inputEl.addEventListener('change', () => {
                this.connectionTestStatus.delete(providerId);
                this.debouncedPersist();
            });
        });
        setting.addButton(button => {
            revealButton = button;
            button.setButtonText(this.revealedApiKeys.has(providerId) ? t('Hide') : t('Reveal'));
            button.onClick(() => {
                const reveal = !this.revealedApiKeys.has(providerId);
                if (reveal) this.revealedApiKeys.add(providerId);
                else this.revealedApiKeys.delete(providerId);
                if (inputEl) inputEl.type = reveal ? 'text' : 'password';
                revealButton?.setButtonText(reveal ? t('Hide') : t('Reveal'));
            });
        });
        setting.addButton(button => {
            button.setButtonText(t('Clear')).setDestructive();
            button.onClick(() => {
                if (!hasKey()) return;
                // 清空 API Key 不可逆（需重去服务商后台复制），与其它破坏性操作一致做二次确认。
                new MemoryConfirmModal(
                    this.app,
                    t('Clear API Key'),
                    t('Clear the API key for this provider? You will need to paste it again to reconnect.'),
                    async () => {
                        config.apiKey = '';
                        this.revealedApiKeys.delete(providerId);
                        this.connectionTestStatus.delete(providerId);
                        await this.persistSettings();
                        this.update();
                    },
                ).open();
            });
        });
    }

    private renderProviderModelRow(setting: Setting, providerId: string): (() => void) | void {
        const config = this.plugin.settings.providers[providerId];
        if (!config) return;
        setting.settingEl.addClass('baizer-setting-stacked');
        const isActive = this.plugin.settings.activeProvider === providerId;
        const container = setting.controlEl.createDiv({ cls: 'baizer-settings-model-field' });
        const cacheKey = getModelFieldCacheKey(providerId, config);
        const cached = this.modelFieldCache.get(cacheKey);
        const loadedResult = cached && Date.now() - cached.timestamp < MODEL_FIELD_CACHE_TTL_MS
            ? cached.result
            : undefined;
        let alive = true;

        renderModelField(container, {
            currentModel: config.model || '',
            hasApiKey: !!config.apiKey?.trim(),
            loadModels: (forceRefresh: boolean) => isActive
                ? this.plugin.modelService.getAvailableModelsWithStatus(forceRefresh)
                : this.loadModelsForConfig(config),
            onModelChange: async (modelId: string) => {
                this.connectionTestStatus.delete(providerId);
                if (isActive && typeof this.plugin.modelService.switchModel === 'function') {
                    await this.plugin.modelService.switchModel(modelId, () => this.persistSettings());
                } else {
                    config.model = modelId;
                    await this.persistSettings();
                }
                this.update();
            },
            // 行已被重绘/翻页销毁时，异步回来的结果不再写旧 DOM。
            isStale: () => !alive,
            loadedResult,
            onLoaded: (result) => {
                if (this.modelFieldCache.size >= 8 && !this.modelFieldCache.has(cacheKey)) {
                    const oldestKey = this.modelFieldCache.keys().next().value;
                    if (oldestKey !== undefined) this.modelFieldCache.delete(oldestKey);
                }
                this.modelFieldCache.set(cacheKey, { result, timestamp: Date.now() });
            },
        });
        return () => { alive = false; };
    }

    /** 非激活 provider 也能列模型：直接打该 provider 自己的 /models，而不是问激活的那个。 */
    private async loadModelsForConfig(config: ProviderConfig): Promise<AvailableModelsResult> {
        // 没配 key 时不发请求：结果只用于显示「先填 key」的提示，打一次必然失败的请求没有意义。
        if (!config.apiKey?.trim()) {
            return { models: [], listed: false, listingUnsupported: false };
        }
        try {
            const models = await listModels(config);
            return { models, listed: models.length > 0, listingUnsupported: false };
        } catch (error: unknown) {
            if (isModelListingUnsupported(error)) {
                return { models: [], listed: false, listingUnsupported: true };
            }
            return {
                models: [],
                listed: false,
                listingUnsupported: false,
                error: error instanceof Error ? error : new Error(String(error)),
            };
        }
    }

    private renderProviderHeadersRow(setting: Setting, providerId: string): void {
        const config = this.plugin.settings.providers[providerId];
        if (!config) return;
        setting.settingEl.addClass('baizer-setting-stacked');
        const feedback = createFieldFeedback(setting.controlEl);
        setting.addTextArea(text => {
            text.setPlaceholder('x-header-name: value');
            text.inputEl.setAttribute('spellcheck', 'false');
            text.inputEl.rows = 4;
            text.setValue(serializeCustomHeaders(config.customHeaders));
            const sync = (value: string): void => {
                const validation = validateCustomHeaders(value);
                feedback(validation);
                // 非法行跳过、其余行照常保存：不能因为正在敲的那一行把已配好的 header 全清掉。
                config.customHeaders = validation.headers;
            };
            text.onChange((value: string) => {
                sync(value);
                this.debouncedPersist();
            });
            sync(text.getValue());
        });
        setting.controlEl.createEl('pre', {
            cls: 'baizer-settings-header-example',
            text: 'x-opencode-session: {{conversationId}}',
        });
    }

    private renderProviderTestRow(setting: Setting, providerId: string): void {
        const config = this.plugin.settings.providers[providerId];
        if (!config) return;
        const endpoint = getModelListEndpoint(config.type, config.baseUrl);
        const statusEl = setting.controlEl.createDiv({
            cls: 'baizer-settings-inline-note',
            attr: { role: 'status', 'aria-live': 'polite' },
        });
        const paint = (): void => {
            const status = this.connectionTestStatus.get(providerId);
            const presentation = status ? getConnectionTestStatusPresentation(status) : undefined;
            statusEl.className = 'baizer-settings-inline-note';
            statusEl.dataset.tone = presentation ? presentation.tone : 'muted';
            if (presentation) statusEl.addClass(`is-${presentation.tone}`);
            statusEl.textContent = presentation?.label ?? '';
            statusEl.toggleClass('is-hidden', !presentation);
        };
        paint();

        setting.addButton(button => {
            button.setButtonText(
                this.connectionTestStatus.get(providerId)?.state === 'testing' ? t('Testing...') : t('Run test'),
            );
            button.setCta();
            button.onClick(async () => {
                const label = config.label || 'AI provider';
                if (!config.apiKey.trim()) {
                    this.connectionTestStatus.set(providerId, getConnectionTestReport({ label, stage: 'missing-key', endpoint }));
                    paint();
                    return;
                }
                button.setDisabled(true);
                button.setButtonText(t('Testing...'));
                this.connectionTestStatus.set(providerId, {
                    state: 'testing',
                    message: `${t('Testing connection to')} ${label}...`,
                });
                paint();
                try {
                    await this.plugin.modelService.updateSettings(this.plugin.settings);
                    const availability = await checkAvailabilityWithStatus(config);
                    this.connectionTestStatus.set(providerId, getConnectionTestReport({
                        label,
                        stage: getConnectionTestStage(availability),
                        endpoint,
                        reason: availability.error?.message,
                    }));
                } catch (error: unknown) {
                    this.connectionTestStatus.set(providerId, getConnectionTestReport({
                        label,
                        stage: 'unreachable',
                        endpoint,
                        reason: thrownMessage(error) || t('unknown reason'),
                    }));
                } finally {
                    button.setDisabled(false);
                    button.setButtonText(t('Run test'));
                    paint();
                }
            });
        });
    }

    // ────────────────────────────────────────────────────────────────────────
    // 行为：上下文预算、thinking、系统提示词。
    // ────────────────────────────────────────────────────────────────────────

    private buildBehaviorPage(): SettingDefinitionPage {
        const meta = getSectionMeta('behavior');
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    type: 'group',
                    heading: t('Runtime'),
                    items: [
                        {
                            name: t('Context Window Limit'),
                            desc: t('Limit token usage. Higher values allow reading larger files but cost more.'),
                            control: {
                                type: 'slider',
                                key: 'contextWindow',
                                min: 10000,
                                max: 1000000,
                                step: 10000,
                                defaultValue: DEFAULT_SETTINGS.contextWindow,
                            },
                        },
                        {
                            name: t('Thinking Level'),
                            desc: t('Controls how much reasoning the model uses. Lower = fewer tokens; higher = better results on complex tasks.'),
                            control: {
                                type: 'dropdown',
                                key: 'thinkingLevel',
                                defaultValue: 'medium',
                                options: {
                                    off: t('Off (no thinking)'),
                                    minimal: t('Minimal'),
                                    low: t('Low'),
                                    medium: t('Medium (default)'),
                                    high: t('High'),
                                    xhigh: t('X-High (select models only)'),
                                },
                            },
                        },
                    ],
                },
                {
                    type: 'group',
                    heading: t('System prompt'),
                    items: [
                        {
                            name: t('Customize System Prompt'),
                            desc: t('Override the default AI personality.'),
                            control: { type: 'toggle', key: 'customizePrompt' },
                        },
                        {
                            name: t('System prompt'),
                            desc: t('Sent to the model at the start of every conversation.'),
                            visible: () => this.plugin.settings.customizePrompt,
                            render: (setting: Setting) => this.renderStackedTextarea(setting, {
                                value: this.plugin.settings.systemPrompt,
                                rows: 8,
                                placeholder: t('You are a helpful assistant...'),
                                onChange: (value: string) => {
                                    this.plugin.settings.systemPrompt = value;
                                    this.debouncedPersist();
                                },
                            }),
                        },
                        {
                            name: t('Restore Default Prompt'),
                            desc: t('Replace your custom system prompt with the default.'),
                            visible: () => this.plugin.settings.customizePrompt,
                            action: () => {
                                new MemoryConfirmModal(
                                    this.app,
                                    t('Restore Default Prompt'),
                                    t('Replace your custom system prompt with the default? Your current prompt will be lost.'),
                                    async () => {
                                        this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                                        await this.persistSettings();
                                        this.update();
                                    },
                                ).open();
                            },
                        },
                    ],
                },
            ],
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 记忆：开关留在主页面，「浏览/删除记忆」是独立子页（异步列表不适合声明式控件）。
    // ────────────────────────────────────────────────────────────────────────

    private buildMemoryPage(): SettingDefinitionPage {
        const meta = getSectionMeta('memory');
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    name: t('Privacy Mode'),
                    desc: t('When enabled, new conversation turns are not retained as Hindsight memory.'),
                    control: { type: 'toggle', key: 'privacyMode' },
                },
                {
                    type: 'group',
                    heading: t('Recall'),
                    items: [
                        {
                            name: t('Semantic query expansion'),
                            desc: t('When enabled, memory recall first uses the AI to expand your query with synonyms and cross-language terms, improving recall for reworded or cross-language queries. Adds one cached AI call per conversation turn; does not affect Guardian completions.'),
                            control: { type: 'toggle', key: 'memoryQueryExpansion' },
                        },
                        {
                            name: t('Entity graph recall'),
                            desc: t('When enabled, memory recall also surfaces memories that share entities (people, projects, technologies) with the best matches, providing related context even without keyword overlap. Runs locally with no extra AI calls.'),
                            control: { type: 'toggle', key: 'memoryGraphRecall' },
                        },
                        {
                            name: t('Conflict-aware updates'),
                            desc: t('When enabled, a new fact on the same topic (e.g. you change a stated preference) retires the outdated one so recall no longer mixes old and new. Retired memories are kept and can be restored.'),
                            control: { type: 'toggle', key: 'memoryConflictUpdate' },
                        },
                    ],
                },
                {
                    type: 'page',
                    name: t('Browse memory'),
                    desc: t('Search, review, and delete remembered memories.'),
                    page: () => new MemoryBrowserPage(this),
                },
                {
                    name: t('Data folder'),
                    desc: MEMORY_DIR,
                },
            ],
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 权限：预设 → 生效权限摘要 → 高级开关。
    // ────────────────────────────────────────────────────────────────────────

    private buildPermissionsPage(): SettingDefinitionPage {
        const meta = getSectionMeta('permissions');
        const settings = this.plugin.settings;
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    type: 'group',
                    heading: t('Permission presets'),
                    items: [
                        {
                            name: t('Read only'),
                            desc: t('Read and analyze notes without writing to the vault.'),
                            action: () => this.applyPresetWithConfirm('read-only'),
                        },
                        {
                            name: t('Scoped write'),
                            desc: t('Write only inside explicitly configured folders.'),
                            action: () => this.applyPresetWithConfirm('configured-folders'),
                        },
                        {
                            name: t('Automation'),
                            desc: t('Allow scoped writes with fewer repeated confirmations.'),
                            action: () => this.applyPresetWithConfirm('automation'),
                        },
                        {
                            name: t('Open access'),
                            desc: t('Allow full-vault writes and plugin control.'),
                            action: () => this.applyPresetWithConfirm('open'),
                        },
                    ],
                },
                {
                    name: t('Effective permissions'),
                    desc: t('What the current switches allow.'),
                    render: (setting: Setting) => this.renderEffectivePermissions(setting),
                },
                {
                    type: 'group',
                    heading: t('Advanced permission switches'),
                    items: [
                        {
                            name: t('Vault Write Scope'),
                            desc: t('Choose how broadly AI can write inside your vault.'),
                            control: {
                                type: 'dropdown',
                                key: 'vaultWriteScope',
                                defaultValue: 'all-vault',
                                options: {
                                    'read-only': t('Read Only'),
                                    'current-note': t('Current Note'),
                                    'configured-folders': t('Configured Folders'),
                                    'all-vault': t('All Vault'),
                                },
                            },
                        },
                        {
                            name: t('Writable Folders'),
                            desc: t('One vault folder per line. AI can create or modify files only inside these folders.'),
                            visible: () => settings.vaultWriteScope === 'configured-folders',
                            render: (setting: Setting) => this.renderStackedTextarea(setting, {
                                value: settings.vaultWriteAllowedFolders.join('\n'),
                                rows: 4,
                                placeholder: 'Projects/\nInbox/',
                                onChange: (value: string) => {
                                    settings.vaultWriteAllowedFolders = value
                                        .split(/\r?\n/)
                                        .map(entry => entry.trim())
                                        .filter(entry => entry.length > 0);
                                    this.debouncedPersist();
                                },
                            }),
                        },
                        {
                            name: t('Allow File Creation'),
                            desc: t('Allow note and file creation after the selected write scope is satisfied.'),
                            control: { type: 'toggle', key: 'allowFileCreation' },
                        },
                        {
                            name: t('Allow File Modification'),
                            desc: t('Allow note and file modification after the selected write scope is satisfied.'),
                            control: { type: 'toggle', key: 'allowFileModification' },
                        },
                        {
                            name: t('Allow Plugin Control'),
                            desc: t('Let AI execute commands from other plugins.'),
                            render: (setting: Setting) => this.renderDangerToggle(setting, {
                                key: 'allowPluginControl',
                                dangerWhen: true,
                                title: t('Allow Plugin Control'),
                                message: t('Grant AI permission to execute commands from other plugins? This can trigger destructive plugin actions on your behalf.'),
                                grantedNotice: t('Permission granted: AI can now control your plugins.'),
                            }),
                        },
                        {
                            name: t('Allow Reading Plugin Config Values'),
                            desc: t('Let AI read third-party plugin configuration values. When off, only key names and types are returned. API keys, tokens, and secrets are always redacted regardless of this setting.'),
                            control: { type: 'toggle', key: 'allowPluginConfigValues' },
                        },
                        {
                            name: t('Confirm Executions'),
                            desc: t('Always ask for confirmation before writing files or running commands.'),
                            render: (setting: Setting) => this.renderDangerToggle(setting, {
                                key: 'confirmExecutions',
                                dangerWhen: false,
                                title: t('Disable Execution Confirmation'),
                                message: t('Turn off confirmation? AI will write files and run commands without asking each time.'),
                            }),
                        },
                    ],
                },
            ],
        };
    }

    /**
     * 提权/降档开关需要二次确认，且取消后 UI 必须回退到原值 —— 声明式 toggle 无法拦截
     * 「先写入再确认」，故这两项用 render 自行接管。
     */
    private renderDangerToggle(
        setting: Setting,
        options: {
            key: 'allowPluginControl' | 'confirmExecutions';
            dangerWhen: boolean;
            title: string;
            message: string;
            grantedNotice?: string;
        },
    ): void {
        const settings = this.plugin.settings;
        const read = (): boolean => settings[options.key];
        setting.addToggle(toggle => {
            toggle.setValue(read());
            toggle.onChange(async (value: boolean) => {
                if (value === options.dangerWhen) {
                    new MemoryConfirmModal(this.app, options.title, options.message, async () => {
                        settings[options.key] = value;
                        if (options.grantedNotice) new Notice(options.grantedNotice);
                        await this.persistSettings();
                        this.update();
                    }, () => { toggle.setValue(read()); }).open();
                    // 取消或未确认前，UI 回退到原值。
                    toggle.setValue(!options.dangerWhen);
                    return;
                }
                settings[options.key] = value;
                await this.persistSettings();
                this.update();
            });
        });
    }

    private applyPresetWithConfirm(preset: 'read-only' | 'configured-folders' | 'automation' | 'open'): void {
        // 提权预设（open=开插件控制+全库写；automation=关执行确认）与单独开关保持一致的二次确认。
        const escalates = preset === 'open' || preset === 'automation';
        if (!escalates) {
            detach(this.applyPermissionPreset(preset).then(() => this.update()), 'SettingsTab', this.notifyFailure);
            return;
        }
        const title = preset === 'open' ? t('Open access') : t('Automation');
        const message = preset === 'open'
            ? t('Open access grants full-vault writes and plugin control. AI can trigger destructive plugin actions on your behalf. Continue?')
            : t('Automation turns off per-action confirmation. AI will write files without asking each time. Continue?');
        new MemoryConfirmModal(this.app, title, message, async () => {
            await this.applyPermissionPreset(preset);
            this.update();
        }).open();
    }

    private async applyPermissionPreset(preset: 'read-only' | 'configured-folders' | 'automation' | 'open'): Promise<void> {
        const settings = this.plugin.settings;
        if (preset === 'read-only') {
            settings.vaultWriteScope = 'read-only';
            settings.allowFileCreation = false;
            settings.allowFileModification = false;
            settings.allowPluginControl = false;
            settings.confirmExecutions = true;
        } else if (preset === 'configured-folders') {
            settings.vaultWriteScope = 'configured-folders';
            settings.allowFileCreation = true;
            settings.allowFileModification = true;
            settings.allowPluginControl = false;
            settings.confirmExecutions = true;
        } else if (preset === 'automation') {
            settings.vaultWriteScope = 'configured-folders';
            settings.allowFileCreation = true;
            settings.allowFileModification = true;
            settings.allowPluginControl = false;
            settings.confirmExecutions = false;
        } else {
            settings.vaultWriteScope = 'all-vault';
            settings.allowFileCreation = true;
            settings.allowFileModification = true;
            settings.allowPluginControl = true;
            settings.confirmExecutions = true;
        }
        await this.persistSettings();
    }

    private renderEffectivePermissions(setting: Setting): void {
        const settings = this.plugin.settings;
        setting.settingEl.addClass('baizer-setting-stacked');
        const list = setting.controlEl.createEl('ul', { cls: 'baizer-settings-summary-list' });
        const rows: Array<[string, string]> = [
            [t('Write scope'), settings.vaultWriteScope],
            [t('Writable folders'), settings.vaultWriteScope === 'configured-folders'
                ? (settings.vaultWriteAllowedFolders.join(', ') || t('Not configured'))
                : t('Not applicable')],
            [t('File creation'), settings.allowFileCreation ? t('Allowed') : t('Blocked')],
            [t('File modification'), settings.allowFileModification ? t('Allowed') : t('Blocked')],
            [t('Plugin control'), settings.allowPluginControl ? t('Allowed') : t('Blocked')],
            [t('Execution confirmation'), settings.confirmExecutions ? t('Required') : t('Automatic')],
        ];
        for (const [label, value] of rows) {
            const item = list.createEl('li');
            item.createEl('strong', { text: label });
            item.createSpan({ text: value });
        }
        if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
            setting.controlEl.createDiv({
                cls: 'baizer-settings-inline-note is-danger',
                text: t('Current permissions are broad. Keep this enabled only when automation requires it.'),
            });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 技能：每个 skill 一个声明式开关（可被全局设置搜索命中）。
    // ────────────────────────────────────────────────────────────────────────

    private buildSkillsPage(): SettingDefinitionPage {
        const meta = getSectionMeta('skills');
        const skills = typeof this.plugin.modelService?.getSkillList === 'function'
            ? this.plugin.modelService.getSkillList()
            : [];
        const items: SettingDefinitionItem[] = skills.length
            ? skills.map(skill => ({
                name: skill.name,
                desc: `${skill.description}${skill.commands?.length ? ` (${skill.commands.join(', ')})` : ''}`,
                control: { type: 'toggle', key: skillKey(skill.name) },
            }))
            : [{ name: t('No skills registered.') }];
        return {
            type: 'page',
            name: meta.title,
            desc: t('Enable or disable individual skills. This controls availability only — a skill being on does not bypass the read/write permissions above.'),
            items,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 采集：视频转写与微信入库路径。
    // ────────────────────────────────────────────────────────────────────────

    private buildCapturePage(): SettingDefinitionPage {
        const meta = getSectionMeta('capture');
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    type: 'group',
                    heading: t('Video transcription'),
                    items: [
                        {
                            name: t('Transcription endpoint (Base URL)'),
                            desc: t('Base URL of an OpenAI-compatible /audio/transcriptions service. Leave empty to reuse the active OpenAI-compatible provider. The endpoint path is appended by the plugin, so include /v1 if your service needs it.'),
                            control: { type: 'text', key: 'asrBaseUrl', placeholder: 'https://api.openai.com/v1' },
                        },
                        {
                            name: t('Transcription API key'),
                            desc: t('Leave empty to reuse the API key of the active provider when it is OpenAI-compatible. Services on localhost usually need no key.'),
                            render: (setting: Setting) => {
                                setting.settingEl.addClass('baizer-setting-stacked');
                                setting.addText(text => {
                                    text.inputEl.type = 'password';
                                    text.inputEl.autocomplete = 'off';
                                    text.inputEl.spellcheck = false;
                                    text.setPlaceholder(t('(reuse provider key)'));
                                    text.setValue(this.plugin.settings.asrApiKey);
                                    text.onChange((value: string) => {
                                        this.plugin.settings.asrApiKey = value.trim();
                                        this.debouncedPersist();
                                    });
                                });
                            },
                        },
                        {
                            name: t('Transcription model'),
                            desc: t('Model name sent to the endpoint. Defaults to whisper-1, which is what earlier versions hardcoded.'),
                            control: { type: 'text', key: 'asrModel', placeholder: DEFAULT_ASR_MODEL },
                        },
                        {
                            name: t('Transcription language'),
                            desc: t('ISO-639-1 code such as zh or en. Leave empty to let the endpoint detect the language.'),
                            control: { type: 'text', key: 'asrLanguage', placeholder: 'auto' },
                        },
                    ],
                },
                {
                    type: 'group',
                    heading: t('WeChat capture'),
                    items: [
                        {
                            name: t('WeChat Inbox Path'),
                            desc: t('The file to monitor for new WeChat links.'),
                            control: { type: 'text', key: 'wechatInboxPath', placeholder: 'Inbox.md' },
                        },
                        {
                            name: t('WeChat Storage Path'),
                            desc: t('The folder to store saved articles.'),
                            control: { type: 'text', key: 'wechatStoragePath', placeholder: 'Clippings' },
                        },
                        {
                            name: t('Mobile WeChat Capture'),
                            desc: t('Use this URL scheme from iOS Shortcuts or Android automation. Fallback command: Save URL from clipboard.'),
                            action: () => { void this.copyMobileScheme(); },
                        },
                    ],
                },
            ],
        };
    }

    private async copyMobileScheme(): Promise<void> {
        const scheme = 'obsidian://baizer-clip?text=<encoded-share-text>';
        await navigator.clipboard?.writeText?.(scheme);
        new Notice(t('Baizer mobile capture URL scheme copied.'));
    }

    // ────────────────────────────────────────────────────────────────────────
    // 知识库：编译设置 → ontology 状态与操作 → ontology 高级设置。
    // ────────────────────────────────────────────────────────────────────────

    private buildKnowledgePage(): SettingDefinitionPage {
        const meta = getSectionMeta('knowledge');
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    type: 'group',
                    heading: t('Knowledge Compile'),
                    items: [
                        {
                            name: t('Source Folders'),
                            desc: t('Folders to watch, one per line.'),
                            render: (setting: Setting) => this.renderStackedTextarea(setting, {
                                value: (this.plugin.settings.knowledgeSourceFolders ?? []).join('\n'),
                                rows: 4,
                                placeholder: 'Clippings\nReading Notes',
                                onChange: (value: string) => {
                                    this.plugin.settings.knowledgeSourceFolders = value
                                        .split('\n')
                                        .map(entry => entry.trim())
                                        .filter(entry => entry.length > 0);
                                    this.debouncedPersist();
                                },
                            }),
                        },
                        {
                            name: t('Wiki Output Folder'),
                            desc: t('The folder where compiled wiki pages are stored.'),
                            control: { type: 'text', key: 'knowledgeWikiFolder', placeholder: 'Knowledge Wiki' },
                        },
                        {
                            name: t('Auto Compile'),
                            desc: t('Compile notes automatically when watched folders change.'),
                            control: { type: 'toggle', key: 'knowledgeAutoCompile' },
                        },
                        {
                            name: t('Max Compile Batch'),
                            desc: t('Maximum number of notes to compile in a single batch.'),
                            control: {
                                type: 'slider',
                                key: 'knowledgeMaxCompileBatch',
                                min: 1,
                                max: 200,
                                step: 1,
                                defaultValue: DEFAULT_SETTINGS.knowledgeMaxCompileBatch,
                            },
                        },
                    ],
                },
                {
                    type: 'group',
                    heading: t('Ontology'),
                    items: [
                        {
                            name: t('Ontology status'),
                            desc: t('Current ontology schema and stale-article counts.'),
                            render: (setting: Setting) => this.renderOntologyStatusRow(setting),
                        },
                        {
                            name: t('Open ontology'),
                            desc: t('Open the ontology schema file to review or edit it.'),
                            action: () => { void this.runOntologyAction('open'); },
                        },
                        {
                            name: t('Discover'),
                            desc: t('Create the ontology schema from the compiled wiki when there is enough content.'),
                            action: () => { void this.runOntologyAction('discover'); },
                        },
                        {
                            name: t('Preview'),
                            desc: t('Show what discovery would produce without writing the schema.'),
                            action: () => { void this.runOntologyAction('preview'); },
                        },
                        {
                            name: t('Mark stale pending'),
                            desc: t('Queue stale notes for recompilation.'),
                            action: () => { void this.runOntologyAction('mark-stale'); },
                        },
                    ],
                },
                {
                    type: 'group',
                    heading: t('Ontology advanced settings'),
                    items: [
                        {
                            name: t('Enable Ontology Schema'),
                            desc: t('Use Knowledge Wiki/_ontology.md to add stable categories and entity extraction to future compiles.'),
                            control: { type: 'toggle', key: 'knowledgeOntologyEnabled' },
                        },
                        {
                            name: t('Ontology Update Mode'),
                            desc: t('Manual never discovers automatically. Suggest reports readiness without writing. Auto creates a missing schema when thresholds are met.'),
                            control: {
                                type: 'dropdown',
                                key: 'knowledgeOntologyUpdateMode',
                                defaultValue: 'suggest',
                                options: {
                                    manual: t('Manual'),
                                    suggest: t('Suggest (recommended)'),
                                    auto: t('Auto create when missing'),
                                },
                            },
                        },
                        {
                            name: t('Minimum Articles'),
                            desc: t('Minimum compiled wiki articles required before ontology discovery can run.'),
                            control: {
                                type: 'number',
                                key: 'knowledgeOntologyMinArticles',
                                min: 1,
                                max: 500,
                                step: 1,
                                defaultValue: 10,
                            },
                        },
                        {
                            name: t('Minimum Topic Frequency'),
                            desc: t('A topic must appear this many times before it can influence ontology discovery.'),
                            control: {
                                type: 'number',
                                key: 'knowledgeOntologyMinTopicFrequency',
                                min: 1,
                                max: 100,
                                step: 1,
                                defaultValue: 3,
                            },
                        },
                        {
                            name: t('Minimum Concept Frequency'),
                            desc: t('A concept must appear this many times before it can influence ontology discovery.'),
                            control: {
                                type: 'number',
                                key: 'knowledgeOntologyMinConceptFrequency',
                                min: 1,
                                max: 100,
                                step: 1,
                                defaultValue: 2,
                            },
                        },
                        {
                            name: t('Auto Recompile Stale Articles'),
                            desc: t('Automatically recompile affected notes after ontology changes. Keep off if you want to review stale notes first.'),
                            control: { type: 'toggle', key: 'knowledgeOntologyAutoRecompileStale' },
                        },
                    ],
                },
            ],
        };
    }

    private renderOntologyStatusRow(setting: Setting): void {
        setting.settingEl.addClass('baizer-setting-stacked');
        const statusEl = setting.controlEl.createDiv({ cls: 'baizer-settings-inline-note' });
        const cached = this.ontologyStatusCache;
        if (cached && Date.now() - cached.timestamp < SettingTab.ONTOLOGY_STATUS_CACHE_TTL_MS) {
            statusEl.textContent = cached.text;
            statusEl.title = cached.title;
            return;
        }
        statusEl.textContent = t('Ontology status: loading...');
        void this.refreshOntologyStatus(statusEl);
    }

    private async runOntologyAction(action: 'open' | 'discover' | 'preview' | 'mark-stale'): Promise<void> {
        const runtime = this.plugin.knowledgeRuntime;
        if (action === 'open') {
            if (!runtime?.openOntologyFile) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            await runtime.openOntologyFile();
            this.ontologyStatusCache = null;
            this.update();
            return;
        }
        if (action === 'discover') {
            if (!runtime?.discoverOntology) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            const path = await runtime.discoverOntology();
            new Notice(path ? t('Ontology schema created') + ': ' + path : t('Ontology schema was not created.'));
            this.ontologyStatusCache = null;
            this.update();
            return;
        }
        if (action === 'preview') {
            if (!runtime?.discoverOntologyPreview) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            const preview = await runtime.discoverOntologyPreview();
            if (preview.content) console.debug('[Baizer] Ontology preview:\n', preview.content);
            new Notice(preview.message);
            return;
        }
        if (!runtime?.markOntologyStaleFilesPending) {
            new Notice(t('Knowledge runtime is not available.'));
            return;
        }
        const count = await runtime.markOntologyStaleFilesPending();
        new Notice(`${t('Marked stale notes pending')}: ${count}`);
        this.ontologyStatusCache = null;
        this.update();
    }

    /**
     * 刷新知识库状态行。计数默认走 KnowledgeStatusService 的缓存（30s TTL），
     * 避免每次打开子页都串行遍历全库。
     */
    private async refreshOntologyStatus(statusEl: HTMLElement): Promise<void> {
        const runtime = this.plugin.knowledgeRuntime;
        if (!runtime?.getOntologyStatus) {
            statusEl.textContent = t('Ontology status: Knowledge runtime is not available.');
            return;
        }
        try {
            const status = await runtime.getOntologyStatus();
            const readiness = runtime.getOntologyDiscoveryReadiness
                ? await runtime.getOntologyDiscoveryReadiness()
                : null;
            const counts = runtime.getStatusService
                ? await runtime.getStatusService().getGlobalCounts()
                : null;
            const parts = [`${t('Ontology')}: ${status.kind}`];
            if (readiness) parts.push(`${t('discovery')}: ${readiness.kind}`);
            if (counts) parts.push(`${t('stale notes')}: ${counts.stale}`);
            const text = parts.join('  ·  ');
            const title = `${t('path')}: ${status.path}`;
            this.ontologyStatusCache = { text, title, timestamp: Date.now() };
            if (!statusEl.isConnected) return;
            statusEl.textContent = text;
            statusEl.title = title;
        } catch (error: unknown) {
            if (!statusEl.isConnected) return;
            statusEl.textContent = `${t('Ontology status unavailable')}: ${thrownMessage(error)}`;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Guardian：选中工具条与补全开关。
    // ────────────────────────────────────────────────────────────────────────

    private buildGuardianPage(): SettingDefinitionPage {
        const meta = getSectionMeta('guardian');
        const settings = this.plugin.settings;
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    name: t('Selection Toolbar'),
                    desc: t('Show a floating AI toolbar (rewrite, explain, etc.) when you select text in the editor.'),
                    control: { type: 'toggle', key: 'enableSelectionMenu' },
                },
                {
                    type: 'group',
                    heading: t('Guardian'),
                    items: [
                        {
                            name: t('Enable Guardian'),
                            desc: t('Allow AI to passively analyze text and offer suggestions.'),
                            control: { type: 'toggle', key: 'enableGuardian' },
                        },
                        {
                            name: t('Auto Mode'),
                            desc: t('Automatically analyze text after 5 seconds of inactivity.'),
                            visible: () => settings.enableGuardian,
                            control: { type: 'toggle', key: 'guardianAutoMode' },
                        },
                        {
                            name: t('Guardian Sensitivity'),
                            desc: t('Low (manual) to high (copilot style).'),
                            visible: () => settings.enableGuardian,
                            control: {
                                type: 'slider',
                                key: 'guardianSensitivity',
                                min: 0,
                                max: 100,
                                step: 25,
                                defaultValue: DEFAULT_SETTINGS.guardianSensitivity,
                            },
                        },
                        {
                            name: t('UI Style'),
                            desc: t('Choose how suggestions appear in the editor.'),
                            visible: () => settings.enableGuardian,
                            control: {
                                type: 'dropdown',
                                key: 'guardianUIStyle',
                                defaultValue: 'hybrid',
                                options: {
                                    ghost: t('Ghost Text (Inline)'),
                                    gutter: t('Gutter Dot (Subtle)'),
                                    hybrid: t('Hybrid (Both)'),
                                },
                            },
                        },
                        {
                            name: t('Auto deep-dive when fast completion is empty or weak'),
                            desc: t('When AI has no immediate suggestion or only a mediocre one while you stay put, it reads related notes and personal memory to attempt a deeper completion. Slower, uses more tokens, on by default.'),
                            visible: () => settings.enableGuardian,
                            control: { type: 'toggle', key: 'guardianAutoDeepEscalation' },
                        },
                        {
                            name: t('Ignored Folders'),
                            desc: t('Path patterns to ignore, one per line.'),
                            visible: () => settings.enableGuardian,
                            render: (setting: Setting) => this.renderStackedTextarea(setting, {
                                value: settings.ignoredFolders,
                                rows: 4,
                                placeholder: 'Private/\nSecrets/\nTemplates/',
                                onChange: (value: string) => {
                                    settings.ignoredFolders = value;
                                    this.debouncedPersist();
                                },
                            }),
                        },
                        {
                            name: t('Manual Mode Hotkey'),
                            desc: t('Open the Obsidian hotkey settings for Guardian.'),
                            visible: () => settings.enableGuardian,
                            action: () => {
                                this.app.setting.openTabById('hotkeys');
                                this.app.setting.activeTab.setQuery('Guardian: Manual Trigger');
                            },
                        },
                    ],
                },
            ],
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 外观：语言与 Workbench 主题。(语言影响所有页面文案，切换后整页重渲染。)
    // ────────────────────────────────────────────────────────────────────────

    private buildAppearancePage(): SettingDefinitionPage {
        const meta = getSectionMeta('appearance');
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    name: t('Language'),
                    desc: t('Interface language. Follow system uses your device language.'),
                    control: {
                        type: 'dropdown',
                        key: 'language',
                        defaultValue: 'auto',
                        options: {
                            auto: t('Follow system'),
                            en: 'English',
                            zh: '中文',
                        },
                    },
                },
                {
                    type: 'group',
                    heading: t('Workbench'),
                    items: [
                        {
                            name: t('Theme Style'),
                            desc: t('Adjust the terminal look and feel.'),
                            control: {
                                type: 'dropdown',
                                key: 'terminalTheme',
                                defaultValue: 'hacker-green',
                                options: {
                                    'hacker-green': t('Hacker Green'),
                                    cyberpunk: t('Cyberpunk Neon'),
                                    'obsidian-native': t('Obsidian Native'),
                                },
                            },
                        },
                        {
                            name: t('Font Size'),
                            desc: t('Workbench text size.'),
                            control: {
                                type: 'slider',
                                key: 'terminalFontSize',
                                min: 12,
                                max: 24,
                                step: 1,
                                defaultValue: DEFAULT_SETTINGS.terminalFontSize,
                            },
                        },
                        {
                            name: t('Background Opacity'),
                            desc: t('Workbench panel opacity, from 50% to 100%.'),
                            control: {
                                type: 'slider',
                                key: 'terminalOpacity',
                                min: 0.5,
                                max: 1,
                                step: 0.05,
                                defaultValue: DEFAULT_SETTINGS.terminalOpacity,
                            },
                        },
                    ],
                },
            ],
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 插件技能：自动生成开关 + 派生技能管理（文件在隐藏目录，这里是唯一入口）。
    // ────────────────────────────────────────────────────────────────────────

    private buildPluginSkillsPage(): SettingDefinitionPage {
        const meta = getSectionMeta('plugin-skills');
        const watcher = this.plugin.pluginWatcher;
        const rows = watcher
            ? getDerivedSkillRows(
                watcher.getDerivedSkillStatuses(),
                watcher.getGenerationFailures(),
            )
            : [];
        const derivedItems: SettingGroupItem[] = rows.length
            ? rows.map(row => ({
                name: row.pluginId,
                desc: this.buildDerivedSkillDescription(row),
                render: (setting: Setting) => this.renderDerivedSkillRow(setting, row),
            }))
            : [{ name: t('No plugin skills have been generated yet.') }];
        return {
            type: 'page',
            name: meta.title,
            desc: meta.description,
            items: [
                {
                    name: t('Auto-generate plugin skills'),
                    desc: t('Generate AI skills for installed plugins on startup.'),
                    control: { type: 'toggle', key: 'autoGeneratePluginSkills' },
                },
                {
                    name: t('Excluded plugins'),
                    desc: t('Plugin IDs to exclude from skill generation, comma-separated.'),
                    control: { type: 'text', key: 'pluginSkillExcludeList', placeholder: 'plugin-id-1, plugin-id-2' },
                },
                {
                    type: 'group',
                    heading: t('Generated plugin skills'),
                    items: derivedItems,
                },
            ],
        };
    }

    private buildDerivedSkillDescription(row: DerivedSkillRow): string {
        const parts = [row.versionLabel, ...row.badges];
        if (row.failureReason) parts.push(`${t('Last generation failed')}: ${row.failureReason}`);
        return parts.join(' · ');
    }

    private renderDerivedSkillRow(setting: Setting, row: DerivedSkillRow): void {
        setting.addButton(button => button
            .setButtonText(t('Regenerate'))
            .onClick(() => { void this.regenerateDerivedSkill(row.pluginId); }));
        setting.addButton(button => {
            button.setButtonText(t('Delete')).setDestructive();
            button.onClick(() => {
                new MemoryConfirmModal(
                    this.app,
                    t('Delete plugin skill'),
                    t('Delete the generated skill for {plugin}? This cannot be undone.')
                        .replace('{plugin}', row.pluginId),
                    async () => { await this.deleteDerivedSkill(row.pluginId); },
                ).open();
            });
        });
    }

    /**
     * 显式重新生成:覆盖写,即使用户手改过——这是用户亲自要求的,优先于对账给手工编辑的保护。
     * 三种结局都要说清楚(见 getRegenerateOutcomeMessage),不能把没写成的报成已重新生成。
     */
    private async regenerateDerivedSkill(pluginId: string): Promise<void> {
        const watcher = this.plugin.pluginWatcher;
        if (!watcher) return;
        const status = await watcher.regenerateDerivedSkill(pluginId);
        new Notice(getRegenerateOutcomeMessage(pluginId, status));
        this.update();
    }

    private async deleteDerivedSkill(pluginId: string): Promise<void> {
        const watcher = this.plugin.pluginWatcher;
        if (!watcher) return;
        const deleted = await watcher.deleteDerivedSkill(pluginId);
        new Notice(deleted
            ? t('Deleted the skill for {plugin}.').replace('{plugin}', pluginId)
            : t('Failed to delete the skill for {plugin}.').replace('{plugin}', pluginId));
        this.update();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 移动端：面板打开期间监听「页面被隐藏」，尽量把 debounce 里的最后编辑落盘。
    // ────────────────────────────────────────────────────────────────────────

    private readonly handleVisibilityChange = (): void => {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'visible') return;
        this.flushPersistedEdits();
        detach(this.debouncedPersistLight.run(), 'SettingsTab');
    };

    private installVisibilityFlush(): void {
        if (this.visibilityFlushInstalled || typeof document === 'undefined') return;
        if (typeof document.addEventListener !== 'function') return;
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        this.visibilityFlushInstalled = true;
    }
}

/**
 * getMemoryView() 的超时上限。记忆读取要扫 memories.json，慢是正常的，但"永不 settle"
 * 不该让页面永远停在 Loading：超时就当这次加载失败，落到可重试的错误态。
 */
const MEMORY_VIEW_TIMEOUT_MS = 15_000;

/**
 * 记忆浏览子页。
 *
 * 记忆条目的读取/搜索/删除是异步数据 + 自由列表，没有对应的声明式控件，
 * 因此这一页是 imperative 的 SettingPage；父页面上的开关仍是声明式定义。
 */
class MemoryBrowserPage extends SettingPage {
    private memoryView: MemoryView | null = null;
    private memorySearchQuery = '';
    private memoryActiveTab: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = 'overview';
    private memoryLoading = false;
    private memoryError = '';
    // getMemoryView() resolving null (no memoryManager: active provider has no API key) or
    // rejecting every time used to make display() <-> refresh() recurse without bound (no
    // scheduler/reentrancy guard survived the #106 declarative-settings rewrite - see the
    // startup/memory perf diagnosis). memoryUnavailable makes "no memoryManager" terminal
    // instead of retriable; refreshInFlight is the reentrancy guard for both paths.
    private memoryUnavailable = false;
    private refreshInFlight = false;
    // 在途期间用户又点了 Refresh/Tab/搜索：记下最后一次意图，等在途结束后补跑一次，
    // 而不是静默丢弃这次点击。
    private pendingRefreshMode: 'overview' | 'observations' | 'facts' | 'recent' | 'search' | null = null;
    // 测试可调小；生产用 MEMORY_VIEW_TIMEOUT_MS。
    private memoryRequestTimeoutMs = MEMORY_VIEW_TIMEOUT_MS;

    constructor(private tab: SettingTab) {
        super();
        this.title = t('Browse memory');
    }

    display(): void {
        this.containerEl.empty();
        this.renderToolbar();
        this.renderSearch();
        this.renderTabs();
        this.renderList();
        // 首次打开自动加载；本次渲染会先画出 Loading。
        // 终止态（memoryUnavailable / memoryError）和已有请求在途（refreshInFlight）都不再
        // 自动重试 —— 这正是 #106 去掉 render-scheduler 后缺失的重入保护；没有它，
        // getMemoryView() 持续返回 null 或持续 reject 会让 display()/refresh() 无限互相递归。
        if (!this.memoryView && !this.memoryLoading && !this.memoryUnavailable && !this.memoryError && !this.refreshInFlight) {
            void this.refresh(this.memoryActiveTab, { repaintOnStart: false });
        }
    }

    private get plugin(): IPlugin {
        return this.tab.plugin;
    }

    private renderToolbar(): void {
        const toolbar = this.containerEl.createDiv({ cls: 'baizer-memory-toolbar' });
        toolbar.createSpan({
            cls: 'baizer-memory-path',
            text: `${t('Data folder')}: ${MEMORY_DIR}`,
        });
        const toolbarActions = toolbar.createDiv({ cls: 'baizer-memory-toolbar-actions' });
        this.createButton(toolbarActions, this.memoryLoading ? t('Refreshing...') : t('Refresh'), async () => {
            await this.refresh(this.memoryActiveTab);
        }, this.memoryLoading);
        this.createButton(toolbarActions, t('Clear Memory'), async () => {
            this.confirmClearAll();
        }, false, 'danger');
    }

    private renderSearch(): void {
        const row = this.containerEl.createDiv({ cls: 'baizer-memory-search' });
        const input = row.createEl('input', {
            cls: 'baizer-settings-search',
            attr: { type: 'search', placeholder: t('Search memories'), 'aria-label': t('Search memories') },
        });
        input.value = this.memorySearchQuery;
        const runSearch = (): void => {
            if (!this.memorySearchQuery.trim()) return;
            this.memoryActiveTab = 'search';
            void this.refresh('search');
        };
        input.addEventListener('input', () => {
            this.memorySearchQuery = input.value;
        });
        input.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                runSearch();
            }
        });
        this.createButton(row, t('Search'), async () => runSearch(), false, 'accent');
    }

    private renderTabs(): void {
        const tabs = this.containerEl.createDiv({ cls: 'baizer-memory-tabs', attr: { role: 'tablist' } });
        const entries: Array<[typeof this.memoryActiveTab, string]> = [
            ['overview', t('Overview')],
            ['observations', t('Observations')],
            ['facts', t('Facts')],
            ['recent', t('Experiences')],
            ['search', t('Search Results')],
        ];
        for (const [id, label] of entries) {
            const selected = this.memoryActiveTab === id;
            const button = tabs.createEl('button', {
                text: label,
                cls: `baizer-memory-tab${selected ? ' is-active' : ''}`,
                attr: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false' },
            });
            button.addEventListener('click', () => {
                this.memoryActiveTab = id;
                void this.refresh(id);
            });
        }
    }

    private renderList(): void {
        if (this.memoryUnavailable) {
            this.containerEl.createDiv({
                cls: 'baizer-settings-inline-note is-warning',
                text: t('Memory is unavailable until the active provider has an API key. Add one on the Connection page, then press Refresh.'),
                attr: { role: 'status', 'aria-live': 'polite' },
            });
            return;
        }
        if (this.memoryError) {
            this.containerEl.createDiv({
                // 失败用 is-danger、"未配置 Key"用 is-warning：让"去配置"和"失败了可重试"
                // 在视觉上分得开。
                cls: 'baizer-settings-inline-note is-danger',
                text: this.memoryError,
                attr: { role: 'alert', 'aria-live': 'assertive' },
            });
            return;
        }

        const list = this.containerEl.createDiv({
            cls: 'baizer-memory-list',
            attr: { role: 'status', 'aria-live': 'polite' },
        });
        const records = this.getVisibleRecords();
        if (records.length === 0) {
            list.createDiv({
                cls: 'baizer-settings-empty-state',
                text: this.memoryLoading ? t('Loading memory...') : t('No memories to show.'),
            });
            return;
        }

        for (const record of records) {
            const row = list.createDiv({ cls: 'baizer-memory-row' });

            const head = row.createDiv({ cls: 'baizer-memory-row-head' });
            const headMeta = head.createDiv({ cls: 'baizer-memory-row-meta' });
            headMeta.createSpan({ cls: `baizer-memory-type is-${record.type}`, text: record.type });
            for (const tag of record.tags || []) {
                headMeta.createSpan({ cls: 'baizer-memory-tag', text: tag });
            }
            headMeta.createSpan({
                cls: 'baizer-memory-confidence',
                text: `${t('confidence')} ${Number(record.confidence || 0).toFixed(2)}`,
            });

            const headActions = head.createDiv({ cls: 'baizer-memory-row-actions' });
            headActions.createSpan({
                cls: 'baizer-memory-time',
                text: new Date(record.updatedAt || record.mentionedAt).toLocaleString(),
            });
            const deleteButton = headActions.createEl('button', {
                cls: 'baizer-memory-delete',
                attr: { type: 'button', title: t('Delete'), 'aria-label': t('Delete') },
            });
            setIcon(deleteButton, 'trash-2');
            deleteButton.addEventListener('click', () => this.confirmDeleteRecord(record.id));

            row.createDiv({ cls: 'baizer-memory-row-text', text: this.truncateText(record.text || '', 260) });
        }
    }

    private getVisibleRecords(): MemoryRecord[] {
        const sections = this.memoryView?.sections;
        if (!sections) return [];
        if (this.memoryActiveTab === 'observations') return sections.observations || [];
        if (this.memoryActiveTab === 'facts') return sections.facts || [];
        if (this.memoryActiveTab === 'recent') return sections.recent || [];
        if (this.memoryActiveTab === 'search') return sections.searchResults || [];
        return [...(sections.observations || []), ...(sections.facts || [])].slice(0, 10);
    }

    private truncateText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }

    private async refresh(
        mode: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = this.memoryActiveTab,
        options: { repaintOnStart?: boolean } = {},
    ): Promise<void> {
        // 重入保护：display() 的自动加载和用户点击 Refresh/Tab/Search 都会调用这里。
        // 已有一次调用在途时不并发发起第二次（避免互相覆盖 memoryView），但也**不丢弃**
        // 这次点击——记下最后一次意图，等在途那次 settle 之后补跑一次。
        if (this.refreshInFlight) {
            this.pendingRefreshMode = mode;
            return;
        }

        if (typeof this.plugin.modelService?.getMemoryView !== 'function') {
            this.memoryError = t('Memory service is not available.');
            this.display();
            return;
        }

        this.refreshInFlight = true;
        this.memoryLoading = true;
        this.memoryError = '';
        this.memoryUnavailable = false;
        if (options.repaintOnStart !== false) this.display();
        try {
            // 超时兜底：getMemoryView() 永不 settle 时也必须落回可重试的错误态，
            // 否则 loading 永远转下去、Refresh 点击也永远被吞。
            const view = await this.withTimeout(this.plugin.modelService.getMemoryView({
                mode,
                query: mode === 'search' ? this.memorySearchQuery : undefined,
                limit: 25,
            }), this.memoryRequestTimeoutMs);
            this.memoryView = view;
            // getMemoryView() 返回 null 时 modelService 没有 memoryManager（当前服务商未配置
            // API Key，或正在切换服务商）。这不是"还没加载完"，是结构性的"当前不可用"——
            // 终止态，不再自动重试；用户换服务商/补 API Key 后点 Refresh 才会清掉。
            this.memoryUnavailable = !view;
        } catch (error: unknown) {
            this.memoryError = thrownMessage(error) || t('Failed to load memory.');
        } finally {
            this.memoryLoading = false;
            this.refreshInFlight = false;
            this.display();
            const pending = this.pendingRefreshMode;
            this.pendingRefreshMode = null;
            // 补跑用户最后一次意图（repaintOnStart 用默认值，让 Loading 立刻上屏）。
            if (pending !== null) void this.refresh(pending);
        }
    }

    /** 给一个 promise 加超时；超时按加载失败处理（走 memoryError，用户可重试）。 */
    private async withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                task,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(t('Memory request timed out. Please try again.'))),
                        ms,
                    );
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    private confirmDeleteRecord(id: string): void {
        new MemoryConfirmModal(
            this.tab.app,
            t('Delete Memory'),
            t('Delete this remembered Hindsight memory record?'),
            async () => {
                if (typeof this.plugin.modelService?.deleteMemoryById !== 'function') {
                    new Notice(t('Memory deletion is not available.'));
                    return;
                }
                const result = await this.plugin.modelService.deleteMemoryById(id);
                new Notice(result?.message || `${t('Deleted memory')}: ${id}`);
                await this.refresh();
            },
        ).open();
    }

    private confirmClearAll(): void {
        new MemoryConfirmModal(
            this.tab.app,
            t('Clear Memory'),
            t('Clear all remembered Hindsight memory and legacy profile fields?'),
            async () => {
                if (typeof this.plugin.modelService?.forgetMemory !== 'function') {
                    new Notice(t('Memory clearing is not available.'));
                    return;
                }
                const result = await this.plugin.modelService.forgetMemory('all');
                new Notice(result?.message || t('Cleared all remembered Hindsight memory.'));
                await this.refresh();
            },
        ).open();
    }

    private createButton(
        containerEl: HTMLElement,
        label: string,
        onClick: () => void | Promise<void>,
        disabled: boolean,
        variant: 'default' | 'danger' | 'accent' = 'default',
    ): HTMLButtonElement {
        const button = containerEl.createEl('button', {
            text: label,
            cls: `baizer-settings-action is-${variant}`,
            attr: { type: 'button' },
        });
        button.disabled = disabled;
        button.addEventListener('click', () => {
            if (button.disabled) return;
            // 记忆子页所有动作按钮的统一入口：onClick 失败时记日志并提示，而不是静默变成 unhandled rejection。
            detach(onClick(), 'SettingsTab', (error) => {
                new Notice(`${t('Settings action failed')}: ${thrownMessage(error) || t('unknown reason')}`);
            });
        });
        return button;
    }
}

class MemoryConfirmModal extends Modal {
    private confirmed = false;

    constructor(
        app: App,
        private titleText: string,
        private message: string,
        private onConfirm: () => Promise<void>,
        /** 未确认直接关闭时调用：声明式列表的删除按钮会先移除 DOM 行，取消后需要重新同步。 */
        private onCancel?: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        renderSettingHeading(contentEl, this.titleText);
        contentEl.createEl('p', { text: this.message });

        const actions = contentEl.createDiv({ cls: 'baizer-memory-confirm-actions' });
        const cancel = actions.createEl('button', {
            text: t('Cancel'),
            cls: 'baizer-settings-action is-default',
            attr: { type: 'button' },
        });
        cancel.addEventListener('click', () => this.close());

        const confirm = actions.createEl('button', {
            text: t('Confirm'),
            cls: 'baizer-settings-action is-danger',
            attr: { type: 'button' },
        });
        confirm.addEventListener('click', () => {
            this.confirmed = true;
            this.close();
            // 用户已确认的（常为破坏性）操作失败时必须告知，不能只留一个静默的 void。
            detach(this.onConfirm(), 'SettingsTab', (error) => {
                new Notice(`${t('Settings action failed')}: ${thrownMessage(error) || t('unknown reason')}`);
            });
        });
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.confirmed) this.onCancel?.();
    }
}

/** 新增服务商模态框收集到的草稿；type 由用户在框内选择。 */
export interface AddProviderDraft {
    type: ProviderType;
    label: string;
    baseUrl: string;
}

class AddProviderModal extends Modal {
    private onSubmit: (draft: AddProviderDraft) => void;

    constructor(app: App, onSubmit: (draft: AddProviderDraft) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        renderSettingHeading(contentEl, t('Add Provider'));

        let typeValue: ProviderType = 'openai-compatible';
        let labelValue = '';
        let baseUrlValue = '';

        new Setting(contentEl)
            .setName(t('Provider Name'))
            .setDesc(t('Display name (for example: SiliconFlow, Groq, Ollama)'))
            .addText(text => text
                .setPlaceholder(t('My Provider'))
                .onChange((value: string) => {
                    labelValue = value;
                }));

        // 协议可选（含 Anthropic）：此前新 provider 固定 openai-compatible。
        new Setting(contentEl)
            .setName(t('Protocol'))
            .setDesc(t('The wire protocol this provider speaks.'))
            .addDropdown(dropdown => {
                getProtocolOptions().forEach(option => { dropdown.addOption(option.value, option.label); });
                dropdown.setValue(typeValue);
                dropdown.onChange((value: string) => {
                    typeValue = value as ProviderType;
                });
            });

        new Setting(contentEl)
            .setName(t('Service address (Base URL)'))
            .setDesc(describeRequestPath('openai-compatible', 'completions', ''))
            .addText(text => text
                .setPlaceholder(getDefaultBaseUrlForType('openai-compatible'))
                .onChange((value: string) => {
                    baseUrlValue = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('Add'))
                .setCta()
                .onClick(() => {
                    if (validateProviderName(labelValue).state !== 'ok') {
                        new Notice(t('Provider name is required.'));
                        return;
                    }
                    // 服务地址留空时由 buildNewProviderConfig 用该协议的官方端点兜底；
                    // 填了就按该协议的规则就地校验。
                    const baseUrlValidation = validateBaseUrl(typeValue, baseUrlValue);
                    if (baseUrlValue.trim() && baseUrlValidation.state === 'error') {
                        new Notice(baseUrlValidation.message);
                        return;
                    }
                    this.onSubmit({
                        type: typeValue,
                        label: labelValue.trim(),
                        baseUrl: baseUrlValue.trim(),
                    });
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
