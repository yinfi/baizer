import { App, PluginSettingTab, Setting, Notice, Modal, debounce, Debouncer, setIcon } from 'obsidian';
import { BUILTIN_PROVIDER_KEYS, DEFAULT_SETTINGS, IPlugin, MEMORY_DIR, PLUGIN_NAME, PluginSettings, ProviderConfig, VaultWriteScope } from './mcp/types';
import { ModelOption } from './models/interfaces';
import { OntologyUpdateMode } from './knowledge/types';
import type {
    DerivedSkillRegenerateBlocker,
    DerivedSkillStatus,
} from './skills/builtin/plugin-ctrl/plugin-watcher';
import { t, getLocale, Locale } from './i18n/zh';

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

export type ConnectionTestState = 'idle' | 'testing' | 'success' | 'error';

export interface ConnectionTestStatus {
    state: ConnectionTestState;
    message: string;
}

export interface ProviderDeletionState {
    canDelete: boolean;
    helperText: string;
    label: string;
}

export interface ProviderListSummary {
    total: number;
    configured: number;
    missingKey: number;
    label: string;
}

export interface ProviderCardMeta {
    id: string;
    label: string;
    protocolLabel: string;
    endpointSummary: string;
    modelSummary: string;
    statusLabel: string;
    statusTone: SettingsBadgeTone;
    isActive: boolean;
    compactMeta: string;
    protocolGlyph: string;
    statusGlyph: string;
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

const SETTINGS_FALLBACK_STYLE_ID = 'baizer-settings-fallback-styles';

export function getSettingsFallbackCss(): string {
    return `
.baizer-settings-page {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 24px;
    container-type: inline-size;
}
.baizer-settings-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 360px);
    grid-template-areas: "title search" "subtitle search";
    column-gap: 12px;
    row-gap: 4px;
    align-items: center;
}
.baizer-settings-title {
    grid-area: title;
    margin: 0;
    font-size: var(--font-ui-large);
    font-weight: var(--font-semibold);
}
.baizer-settings-subtitle {
    grid-area: subtitle;
    min-width: 0;
    margin: 0;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.baizer-settings-search-row {
    grid-area: search;
    min-width: 0;
}
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
.baizer-settings-top-status,
.baizer-settings-actions,
.baizer-settings-segments,
.baizer-settings-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.baizer-settings-top-status {
    justify-content: flex-end;
}
.baizer-settings-accordion {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.baizer-settings-section-card {
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 90%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--background-primary) 96%, var(--background-secondary));
    overflow: hidden;
}
.baizer-settings-section-card[open] {
    border-color: color-mix(in srgb, var(--interactive-accent) 38%, var(--background-modifier-border));
}
.baizer-settings-section-summary {
    min-height: 42px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 18px;
    gap: 8px;
    align-items: center;
    padding: 7px 10px;
    cursor: pointer;
    list-style: none;
}
.baizer-settings-section-summary::-webkit-details-marker {
    display: none;
}
.baizer-settings-section-copy {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 10px;
}
.baizer-settings-section-title {
    margin: 0;
    font-size: var(--font-ui-small);
    font-weight: var(--font-semibold);
}
.baizer-settings-section-description {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-smallest);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.baizer-settings-section-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
}
.baizer-settings-section-chevron {
    color: var(--text-muted);
    transition: transform 120ms ease;
}
.baizer-settings-section-card[open] .baizer-settings-section-chevron {
    transform: rotate(90deg);
}
.baizer-settings-section-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
    background: color-mix(in srgb, var(--background-secondary) 35%, transparent);
}
.baizer-settings-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 20px;
    padding: 0 7px;
    border-radius: 999px;
    font-size: var(--font-smallest);
    font-weight: var(--font-medium);
    white-space: nowrap;
}
.baizer-settings-badge.is-warning { color: var(--text-warning); background: color-mix(in srgb, var(--color-yellow) 18%, transparent); }
.baizer-settings-badge.is-danger { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 12%, transparent); }
.baizer-settings-badge.is-muted { color: var(--text-muted); background: color-mix(in srgb, var(--background-modifier-border) 65%, transparent); }
.baizer-settings-badge.is-accent { color: var(--text-accent); background: color-mix(in srgb, var(--interactive-accent) 14%, transparent); }
.baizer-settings-badge.is-success { color: var(--color-green); background: color-mix(in srgb, var(--color-green) 12%, transparent); }
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
.baizer-settings-panel,
.baizer-settings-task,
.baizer-settings-advanced,
.baizer-settings-provider-shell,
.baizer-settings-provider-card,
.baizer-settings-connection-card {
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 88%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--background-primary-alt) 96%, var(--background-secondary));
    overflow: hidden;
}
.baizer-settings-panel-header,
.baizer-settings-provider-toolbar,
.baizer-settings-connection-card-header {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
    background: color-mix(in srgb, var(--background-secondary) 74%, transparent);
}
.baizer-settings-panel-title,
.baizer-settings-connection-card-title {
    margin: 0;
    font-size: var(--font-ui-small);
    font-weight: var(--font-semibold);
}
.baizer-settings-panel-body { padding: 8px 10px; }
.baizer-settings-task {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
}
.baizer-settings-task strong { color: var(--text-normal); }
.baizer-settings-provider-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
}
.baizer-settings-provider-card {
    width: 100%;
    padding: 0;
    color: var(--text-normal);
}
.baizer-settings-provider-card.is-active {
    border-color: color-mix(in srgb, var(--interactive-accent) 46%, var(--background-modifier-border));
    background: color-mix(in srgb, var(--interactive-accent) 9%, var(--background-primary));
}
.baizer-settings-provider-card-main {
    width: 100%;
    display: block;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}
.baizer-settings-provider-card-main-inner {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(120px, .8fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
}
.baizer-settings-provider-card-title { min-width: 0; font-weight: var(--font-semibold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.baizer-settings-provider-card-meta { min-width: 0; margin: 0; color: var(--text-muted); font-size: var(--font-smallest); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.baizer-settings-provider-detail-inline {
    border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
    background: color-mix(in srgb, var(--background-primary) 68%, transparent);
}
.baizer-settings-connection-detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
}
.baizer-settings-detail-row {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 8px 10px;
    border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 58%, transparent);
}
.baizer-settings-detail-row:first-child { border-top: 0; }
.baizer-settings-detail-label { padding-top: 6px; font-size: var(--font-ui-small); font-weight: var(--font-semibold); }
.baizer-settings-detail-value { min-width: 0; }
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
.baizer-settings-detail-secret,
.baizer-settings-detail-secret-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.baizer-settings-detail-secret .baizer-settings-detail-input { flex: 1 1 240px; }
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
.baizer-settings-preset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.baizer-settings-preset { padding: 8px 10px; border: 1px solid var(--background-modifier-border); border-radius: 8px; background: var(--background-secondary); color: var(--text-normal); text-align: left; }
.baizer-settings-preset.is-active { border-color: color-mix(in srgb, var(--interactive-accent) 46%, var(--background-modifier-border)); background: color-mix(in srgb, var(--interactive-accent) 9%, var(--background-primary)); }
.baizer-settings-advanced summary { padding: 8px 10px; cursor: pointer; color: var(--text-muted); font-size: var(--font-ui-small); font-weight: var(--font-semibold); }
.baizer-settings-advanced-body { padding: 0 10px 10px; }
.baizer-settings-inline-note { padding: 10px 12px; border-radius: 8px; font-size: var(--font-ui-small); }
.baizer-settings-inline-note.is-warning { color: var(--text-warning); background: color-mix(in srgb, var(--color-yellow) 16%, transparent); }
.baizer-settings-inline-note.is-success { color: var(--color-green); background: color-mix(in srgb, var(--color-green) 10%, transparent); }
.baizer-settings-inline-note.is-danger { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 12%, transparent); }
.baizer-settings-inline-note.is-accent { color: var(--text-accent); background: color-mix(in srgb, var(--interactive-accent) 10%, transparent); }
.baizer-settings-inline-hint { color: var(--text-muted); font-size: var(--font-smallest); }
.baizer-full-width-textarea textarea { width: 100%; min-height: 110px; resize: vertical; }
.gemini-danger-setting { border-left: 3px solid color-mix(in srgb, var(--text-error) 75%, transparent); padding-left: 10px; }

/* ===== 记忆(Hindsight)面板 ===== */
.baizer-memory-toolbar { display: flex; flex-direction: column; gap: 8px; }
.baizer-memory-toolbar-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}
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
@container (max-width: 560px) {
    .baizer-settings-hero {
        grid-template-columns: 1fr;
        grid-template-areas: "title" "subtitle" "search";
    }
    .baizer-settings-section-summary,
    .baizer-settings-provider-card-main-inner,
    .baizer-settings-connection-detail-grid,
    .baizer-settings-detail-row,
    .baizer-settings-preset-grid {
        grid-template-columns: 1fr;
    }
    .baizer-settings-section-copy { flex-direction: column; align-items: flex-start; gap: 2px; }
    .baizer-settings-top-status,
    .baizer-settings-section-meta { justify-content: flex-start; }
    .baizer-settings-section-description,
    .baizer-settings-subtitle { white-space: normal; }
}
@media (max-width: 560px) {
    .baizer-settings-hero {
        grid-template-columns: 1fr;
        grid-template-areas: "title" "subtitle" "search";
    }
    .baizer-settings-section-summary,
    .baizer-settings-provider-card-main-inner,
    .baizer-settings-connection-detail-grid,
    .baizer-settings-detail-row,
    .baizer-settings-preset-grid {
        grid-template-columns: 1fr;
    }
    .baizer-settings-section-copy { flex-direction: column; align-items: flex-start; gap: 2px; }
    .baizer-settings-top-status,
    .baizer-settings-section-meta { justify-content: flex-start; }
    .baizer-settings-section-description,
    .baizer-settings-subtitle { white-space: normal; }
}
`;
}
function ensureSettingsFallbackStyles(): void {
    const doc = typeof document === 'undefined' ? null : document;
    if (!doc) return;

    const existing = doc.getElementById(SETTINGS_FALLBACK_STYLE_ID);
    if (existing) {
        existing.textContent = getSettingsFallbackCss();
        return;
    }

    const styleEl = doc.createElement('style');
    styleEl.id = SETTINGS_FALLBACK_STYLE_ID;
    styleEl.textContent = getSettingsFallbackCss();
    doc.head?.appendChild(styleEl);
}

// 惰性求值：t() 依赖当前 locale，必须在调用时（而非模块加载时）求值，
// 否则切换语言后分区标题/描述不会更新（模块级常量会冻结初次 t() 结果）。
function getSettingsSections(): SettingsSectionMeta[] {
    return [
    { id: 'overview', title: t('Overview'), description: t('Configuration health and actions that need attention.'), keywords: ['overview', 'health', 'risk', 'status', '概览'] },
    { id: 'connection', title: t('Connection'), description: t('Provider, API key, endpoint, model, and connection tests.'), keywords: ['provider', 'api key', 'base url', 'model', 'connection', 'openai', 'gemini', 'deepseek', 'qwen', '连接', '服务商'] },
    { id: 'behavior', title: t('Behavior'), description: t('Context budget, system prompt, and runtime behavior.'), keywords: ['behavior', 'runtime', 'context window', 'token', 'system prompt', 'persona', 'prompt', 'thinking', 'reasoning', '行为'] },
    { id: 'memory', title: t('Memory'), description: t('Memory retention, recall, search, and deletion.'), keywords: ['memory', 'hindsight', 'recall', 'forget', 'profile', 'privacy', 'observation', '记忆'] },
    { id: 'permissions', title: t('Permissions'), description: t('Vault write scope, file operations, plugin control, and confirmations.'), keywords: ['permissions', 'file creation', 'file modification', 'plugin control', 'confirm', '权限'] },
    { id: 'skills', title: t('Skills'), description: t('Enable or disable individual skills (availability, separate from permissions).'), keywords: ['skills', 'skill', 'enable', 'disable', 'workflow', 'available', '技能'] },
    { id: 'capture', title: t('Capture'), description: t('Inbox, clipping storage, WeChat import, and URL capture.'), keywords: ['wechat', 'capture', 'inbox', 'storage', 'clippings', 'web clipper', '采集', '微信'] },
    { id: 'knowledge', title: t('Knowledge'), description: t('Source folders, output folder, compile state, and ontology.'), keywords: ['knowledge', 'wiki', 'compile', 'source folders', 'batch', 'ontology', 'schema', '知识'] },
    { id: 'guardian', title: t('Guardian'), description: t('Inline writing assistance, trigger mode, and ignored folders.'), keywords: ['guardian', 'auto mode', 'manual mode', 'ignored folders', 'sensitivity', 'selection', 'toolbar', 'selection toolbar', '守护', '行内补全', '幽灵文本', '灵敏度', '补全', '选中', '工具条', '选中工具条'] },
    { id: 'appearance', title: t('Appearance'), description: t('Workbench theme, font size, and opacity.'), keywords: ['appearance', 'theme', 'font', 'opacity', 'terminal', 'workbench', 'language', 'locale', '外观', '语言'] },
    { id: 'plugin-skills', title: t('Plugin Skills'), description: t('Skill generation, excluded plugins, and startup scanning.'), keywords: ['plugin', 'skills', 'generator', 'exclude', 'startup', '插件'] },
    ];
}

function normalizeSearchQuery(query: string): string {
    return query.trim().toLowerCase();
}

function clampInteger(value: string, min: number, max: number, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

export function getMatchingSettingsSections(query: string): SettingsSectionId[] {
    const normalized = normalizeSearchQuery(query);
    const sections = getSettingsSections();
    if (!normalized) return sections.map(section => section.id);

    return sections
        .filter(section => {
            const haystack = [section.title, section.description, ...section.keywords]
                .join(' ')
                .toLowerCase();
            return haystack.includes(normalized);
        })
        .map(section => section.id);
}

export function getRenderableSettingsSections(
    visibleSections: SettingsSectionId[],
    openSectionIds: ReadonlySet<SettingsSectionId>
): SettingsSectionId[] {
    return visibleSections.filter(sectionId => openSectionIds.has(sectionId));
}

export function getSettingsSectionStatuses(
    settings: PluginSettings
): Partial<Record<SettingsSectionId, SettingsSectionStatus>> {
    const statuses: Partial<Record<SettingsSectionId, SettingsSectionStatus>> = {};
    const activeConfig = settings.providers[settings.activeProvider];

    // P1-4: 分区状态徽章统一走 i18n(此前全为裸英文,中文环境与已译标题混排)。
    if (!activeConfig?.apiKey?.trim()) {
        statuses.connection = { label: t('Needs key'), tone: 'warning' };
    } else if (!BUILTIN_PROVIDER_KEYS.includes(settings.activeProvider)) {
        statuses.connection = { label: t('Custom provider'), tone: 'accent' };
    }

    if (!settings.enableGuardian) {
        statuses.guardian = { label: t('Off'), tone: 'muted' };
    }

    if (settings.privacyMode) {
        statuses.memory = { label: t('Private'), tone: 'accent' };
    }

    if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
        // 'Risk' 过泛,细化为「权限偏宽」更自解释。
        statuses.permissions = { label: t('Broad access'), tone: 'danger' };
    }

    if (!settings.autoGeneratePluginSkills) {
        statuses['plugin-skills'] = { label: t('Off'), tone: 'muted' };
    }

    const overviewActions = getSettingsOverviewActions(settings);
    if (overviewActions.length > 0) {
        statuses.overview = {
            // 用占位模板而非拼接英文单复数。
            label: t('{n} to review').replace('{n}', String(overviewActions.length)),
            tone: overviewActions.some(action => action.tone === 'danger') ? 'danger' : 'warning',
        };
    }

    return statuses;
}

export function getSettingsOverviewActions(settings: PluginSettings): SettingsOverviewAction[] {
    const actions: SettingsOverviewAction[] = [];

    // P1-4: \u6982\u89C8\u884C\u52A8\u9879\u6B64\u524D\u786C\u7F16\u7801\u4E2D\u6587,\u82F1\u6587\u73AF\u5883\u65E0\u6CD5\u56DE\u9000\u3002\u6539\u8D70 t()\u3002
    if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
        actions.push({ label: t('Permissions too broad'), sectionId: 'permissions', tone: 'danger' });
    }

    for (const [_providerId, provider] of Object.entries(settings.providers || {})) {
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

export function getProviderDeletionState(settings: PluginSettings): ProviderDeletionState {
    const activeConfig = settings.providers[settings.activeProvider];
    if (!activeConfig) {
        return {
            canDelete: false,
            helperText: 'No active provider selected.',
            label: 'Delete Provider',
        };
    }

    if (Object.keys(settings.providers || {}).length <= 1) {
        return {
            canDelete: false,
            helperText: 'At least one provider must remain configured.',
            label: 'Delete Provider',
        };
    }

    return {
        canDelete: true,
        helperText: 'Remove the selected provider from this workspace.',
        label: 'Delete Provider',
    };
}

export function getProviderListSummary(settings: PluginSettings): ProviderListSummary {
    const providers = Object.values(settings.providers || {});
    const total = providers.length;
    const configured = providers.filter(provider => !!provider.apiKey?.trim()).length;
    const missingKey = total - configured;

    return {
        total,
        configured,
        missingKey,
        label: `${total} providers / ${configured} configured / ${missingKey} missing key`,
    };
}

export function getProviderCardMeta(settings: PluginSettings, providerId: string): ProviderCardMeta {
    const config = settings.providers[providerId];
    if (!config) {
        throw new Error(`Unknown provider: ${providerId}`);
    }

    // P1-4: 服务商卡片文案走 i18n(连接卡片是配置主战场,此前成片英文与已译字段标签混排)。
    const protocolLabel = config.type === 'gemini' ? 'Gemini API' : 'OpenAI-compatible';
    const hasApiKey = !!config.apiKey?.trim();
    const rawEndpoint = config.baseUrl?.trim() || t('Default provider endpoint');
    const endpointSummary = rawEndpoint.replace(/^https?:\/\//, '');
    const modelSummary = config.model?.trim()
        ? `${t('Model')}: ${config.model.trim()}`
        : `${t('Model')}: ${t('Not selected')}`;

    return {
        id: providerId,
        label: config.label,
        protocolLabel,
        endpointSummary,
        modelSummary,
        statusLabel: hasApiKey ? t('Key configured') : t('No API key'),
        statusTone: hasApiKey ? 'success' : 'warning',
        isActive: settings.activeProvider === providerId,
        compactMeta: modelSummary,
        protocolGlyph: config.type === 'gemini' ? '◈' : '◎',
        statusGlyph: hasApiKey ? '●' : '!',
    };
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

export class SettingTab extends PluginSettingTab {
    plugin: IPlugin;
    private renderToken = 0;
    private openSectionIds = new Set<SettingsSectionId>();
    // 分区内「高级」details 的展开态：与 openSectionIds 同理，避免局部重绘后塌回折叠（P1-3）。
    private openAdvanced = new Set<string>();
    // 首次打开面板时默认展开哪些分区一次性种子，避免新用户看到一堆全折叠的标题（P1-2）。
    private didInitExpand = false;
    // P0-1 局部刷新：display() 只建一次骨架（hero+搜索），accordionHost 内容由 renderAccordion() 单独重绘。
    private accordionHost: HTMLElement | null = null;
    private searchQuery = '';
    private revealApiKey = false;
    // 激活 provider 卡片的详情是否折叠。默认展开(false)；再次点击当前激活卡即切换折叠态，
    // 切换到其它 provider 时重置为展开。此前「激活==展开」耦合导致再点无法折叠(用户反馈)。
    private activeProviderDetailCollapsed = false;
    private connectionTestStatus: ConnectionTestStatus = { state: 'idle', message: '' };
    private memoryView: any = null;
    private memorySearchQuery = '';
    private memoryActiveTab: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = 'overview';
    private memoryLoading = false;
    private memoryError = '';
    // textarea 逐击键写盘代价高：包一层 400ms debounce，末尾触发一次落盘。
    private debouncedPersist: Debouncer<[], Promise<void>> = debounce(
        () => this.persistSettings(),
        400,
        false,
    );
    // 纯 UI 字段（外观主题/字号/不透明度）落盘：无需重建 provider/guardian/knowledge，走轻量保存 + debounce，
    // 避免拖动滑块时每格都重建 LLM 客户端（P0-3）。
    private debouncedPersistLight: Debouncer<[], Promise<void>> = debounce(
        () => this.persistSettingsLight(),
        400,
        false,
    );

    constructor(app: App, plugin: IPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private getActiveConfig(): ProviderConfig | undefined {
        const settings = this.plugin.settings;
        return settings.providers[settings.activeProvider];
    }

    private getVisibleSections(): SettingsSectionId[] {
        return getMatchingSettingsSections(this.searchQuery);
    }

    private async persistSettings(): Promise<void> {
        await this.plugin.saveSettings();
    }

    // 仅落盘纯 UI 字段：不触发 provider/guardian/knowledge 重建（见 saveSettingsLight）。
    private async persistSettingsLight(): Promise<void> {
        if (typeof this.plugin.saveSettingsLight === 'function') {
            await this.plugin.saveSettingsLight();
        } else {
            await this.plugin.saveSettings();
        }
    }

    private resetConnectionTestStatus(): void {
        this.connectionTestStatus = { state: 'idle', message: '' };
    }

    hide(): void {
        // 面板关闭时立即落盘 debounce 里未触发的最后一次编辑，避免丢改。
        this.debouncedPersist.run();
        this.debouncedPersistLight.run();
        this.accordionHost = null;
        super.hide();
    }

    // display() 现在只负责构建「骨架」：hero（标题+搜索）+ 一个持久的 accordion 宿主容器。
    // 骨架只在面板首次打开时建一次；内容更新一律走 renderAccordion()，因此搜索框与 hero 永不被销毁，
    // 输入焦点与光标自然保留（P0-1，修复搜索框每敲一字失焦的核心缺陷）。
    display(): void {
        const { containerEl } = this;
        ensureSettingsFallbackStyles();
        containerEl.empty();

        // 首次打开：给新用户默认展开 overview + connection，避免面对一堆全折叠标题（P1-2）。
        if (!this.didInitExpand) {
            this.didInitExpand = true;
            this.openSectionIds.add('overview');
            this.openSectionIds.add('connection');
        }

        const root = containerEl.createDiv({ cls: 'baizer-settings-page' });
        this.renderHeader(root);
        this.accordionHost = root.createDiv({ cls: 'baizer-settings-accordion-host' });
        this.renderAccordion();
    }

    private renderHeader(containerEl: HTMLElement): void {
        const hero = containerEl.createDiv({ cls: 'baizer-settings-hero' });
        renderSettingHeading(hero, `${PLUGIN_NAME} ${t('Configuration')}`, { nameClass: 'baizer-settings-title' });
        hero.createEl('p', {
            text: t('A cleaner control center for provider setup, runtime behavior, and plugin capabilities.'),
            cls: 'baizer-settings-subtitle',
        });

        const searchRow = hero.createDiv({ cls: 'baizer-settings-search-row' });
        const searchInput = searchRow.createEl('input', {
            cls: 'baizer-settings-search',
            attr: {
                type: 'search',
                placeholder: t('Search settings'),
                'aria-label': t('Search settings'),
            },
        }) as HTMLInputElement;
        searchInput.value = this.searchQuery;
        // 只更新查询并局部重绘手风琴；搜索框本身不重建，焦点不丢。
        searchInput.addEventListener('input', () => {
            this.searchQuery = searchInput.value;
            this.renderAccordion();
        });
    }

    // 局部刷新入口：只重绘 accordion 宿主内的内容，不触碰 hero/搜索框。
    // 所有 section 内的 onChange/click 现在都调用它（而非整页 display()），从而保留焦点与其它分区的展开态。
    private renderAccordion(): void {
        const host = this.accordionHost;
        if (!host) {
            // 骨架尚未建立（理论上不会发生），退回整页构建。
            this.display();
            return;
        }
        const token = ++this.renderToken;
        host.empty();

        const visibleSections = this.getVisibleSections();
        if (!visibleSections.length) {
            const empty = host.createDiv({ cls: 'baizer-settings-empty-state' });
            renderSettingHeading(empty, t('No matching settings'));
            empty.createEl('p', { text: t('Try searching by provider, prompt, permissions, or knowledge.') });
            return;
        }

        // 搜索命中时自动展开命中的分区，让用户一步看到目标设置（P1-2）。
        // 仅在有查询时生效，避免污染用户手动折叠的偏好。
        if (normalizeSearchQuery(this.searchQuery)) {
            visibleSections.forEach(id => this.openSectionIds.add(id));
        }

        const accordion = host.createDiv({ cls: 'baizer-settings-accordion' });
        const statuses = getSettingsSectionStatuses(this.plugin.settings);
        const renderableSections = new Set(getRenderableSettingsSections(visibleSections, this.openSectionIds));

        visibleSections.forEach(sectionId => {
            const meta = getSectionMeta(sectionId);
            const status = statuses[sectionId];
            const card = accordion.createEl('details', { cls: 'baizer-settings-section-card' }) as HTMLDetailsElement;
            card.open = this.openSectionIds.has(sectionId);
            card.addEventListener('toggle', () => {
                if (card.open) {
                    this.openSectionIds.add(sectionId);
                    // 首次展开某未渲染分区时，局部重绘即可注入其内容（不再整页重建）。
                    if (!renderableSections.has(sectionId)) this.renderAccordion();
                    return;
                }
                this.openSectionIds.delete(sectionId);
            });

            const summary = card.createEl('summary', { cls: 'baizer-settings-section-summary' });
            const copy = summary.createDiv({ cls: 'baizer-settings-section-copy' });
            renderSettingHeading(copy, meta.title, { nameClass: 'baizer-settings-section-title' });
            copy.createEl('p', { text: meta.description, cls: 'baizer-settings-section-description' });
            const metaEl = summary.createSpan({ cls: 'baizer-settings-section-meta' });
            if (status) {
                metaEl.createSpan({ cls: 'baizer-settings-badge is-' + status.tone, text: status.label });
            }
            // chevron 纯装饰：改用图标并 aria-hidden，避免读屏朗读「大于号」（P2）。
            const chevron = summary.createSpan({ cls: 'baizer-settings-section-chevron', attr: { 'aria-hidden': 'true' } });
            setIcon(chevron, 'chevron-right');

            if (renderableSections.has(sectionId)) {
                const content = card.createDiv({ cls: 'baizer-settings-section-content' });
                this.renderSectionContent(sectionId, content, token);
            }
        });
    }

    private renderSectionContent(sectionId: SettingsSectionId, containerEl: HTMLElement, token: number): void {
        switch (sectionId) {
            case 'overview':
                this.renderOverviewSection(containerEl);
                return;
            case 'connection':
                this.renderConnectionSection(containerEl, token);
                return;
            case 'behavior':
                this.renderRuntimeSection(containerEl);
                return;
            case 'memory':
                this.renderMemorySection(containerEl);
                return;
            case 'guardian':
                this.renderGuardianSection(containerEl);
                return;
            case 'permissions':
                this.renderPermissionsSection(containerEl);
                return;
            case 'skills':
                this.renderSkillsSection(containerEl);
                return;
            case 'appearance':
                this.renderAppearanceSection(containerEl);
                return;
            case 'capture':
                this.renderCaptureSection(containerEl);
                return;
            case 'knowledge':
                this.renderKnowledgeSection(containerEl);
                return;
            case 'plugin-skills':
                this.renderPluginSkillsSection(containerEl);
                return;
        }
    }

    // P1-3: 让分区内嵌套的「高级」details 记住展开态。局部重绘(renderAccordion)会重建这些节点,
    // 若不持久化,任何 toggle 都会让高级块塌回折叠——最典型的是切换 Vault Write Scope 后,
    // 新出现的 Writable Folders 必填项反被折叠隐藏。用 openAdvanced 集合按 key 记忆。
    private trackAdvancedDetails(details: HTMLDetailsElement, key: string): void {
        details.open = this.openAdvanced.has(key);
        details.addEventListener('toggle', () => {
            if (details.open) this.openAdvanced.add(key);
            else this.openAdvanced.delete(key);
        });
    }

    private renderOverviewSection(containerEl: HTMLElement): void {
        const actions = getSettingsOverviewActions(this.plugin.settings);
        if (!actions.length) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-success', text: t('No immediate configuration actions.') });
            return;
        }

        for (const action of actions) {
            const row = containerEl.createDiv({ cls: 'baizer-settings-task' });
            const sectionTitle = getSectionMeta(action.sectionId).title;
            const copy = row.createSpan({ cls: 'baizer-settings-task-copy' });
            // 正文只说问题;分区标题交给右侧跳转按钮承载,不再重复渲染两遍(P1-2 引导语义清晰化)。
            copy.createEl('strong', { text: action.label });
            // 跳转按钮:用真正的 action 样式(而非静态徽章),带明确动作动词与 aria-label,可供性清晰(P2)。
            const button = row.createEl('button', {
                text: `${t('Go to')} ${sectionTitle}`,
                cls: 'baizer-settings-action is-' + (action.tone === 'danger' ? 'danger' : 'accent'),
                attr: { type: 'button', 'aria-label': `${t('Go to')} ${sectionTitle}` },
            });
            button.addEventListener('click', () => {
                this.openSectionIds.add(action.sectionId);
                this.renderAccordion();
            });
        }
    }

    private renderMemorySection(containerEl: HTMLElement): void {
        const toolbar = containerEl.createDiv({ cls: 'baizer-memory-toolbar' });
        new Setting(toolbar)
            .setName(t('Privacy Mode'))
            .setDesc(t('When enabled, new conversation turns are not retained as Hindsight memory.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.privacyMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.privacyMode = value;
                    await this.persistSettings();
                    if (typeof this.plugin.modelService?.updateSettings === 'function') {
                        await this.plugin.modelService.updateSettings(this.plugin.settings);
                    }
                    await this.refreshMemoryView();
                }));

        new Setting(toolbar)
            .setName(t('Semantic query expansion'))
            .setDesc(t('When enabled, memory recall first uses the AI to expand your query with synonyms and cross-language terms, improving recall for reworded or cross-language queries. Adds one cached AI call per conversation turn; does not affect Guardian completions.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.memoryQueryExpansion)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.memoryQueryExpansion = value;
                    await this.persistSettings();
                    if (typeof this.plugin.modelService?.updateSettings === 'function') {
                        await this.plugin.modelService.updateSettings(this.plugin.settings);
                    }
                }));

        new Setting(toolbar)
            .setName(t('Entity graph recall'))
            .setDesc(t('When enabled, memory recall also surfaces memories that share entities (people, projects, technologies) with the best matches, providing related context even without keyword overlap. Runs locally with no extra AI calls.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.memoryGraphRecall)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.memoryGraphRecall = value;
                    await this.persistSettings();
                    if (typeof this.plugin.modelService?.updateSettings === 'function') {
                        await this.plugin.modelService.updateSettings(this.plugin.settings);
                    }
                }));

        new Setting(toolbar)
            .setName(t('Conflict-aware updates'))
            .setDesc(t('When enabled, a new fact on the same topic (e.g. you change a stated preference) retires the outdated one so recall no longer mixes old and new. Retired memories are kept and can be restored.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.memoryConflictUpdate)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.memoryConflictUpdate = value;
                    await this.persistSettings();
                    if (typeof this.plugin.modelService?.updateSettings === 'function') {
                        await this.plugin.modelService.updateSettings(this.plugin.settings);
                    }
                }));

        // 工具栏底行:左侧数据目录芯片,右侧「刷新 + 清除全部」操作组。
        // 清除全部从原本列表最底部上移至此 —— 避免高危操作被埋在长列表里(用户反馈「藏在数据中」)。
        const toolbarFooter = toolbar.createDiv({ cls: 'baizer-memory-toolbar-footer' });
        toolbarFooter.createSpan({
            cls: 'baizer-memory-path',
            text: `${t('Data folder')}: ${MEMORY_DIR}`,
        });
        const toolbarActions = toolbarFooter.createDiv({ cls: 'baizer-memory-toolbar-actions' });
        this.createActionButton(toolbarActions, this.memoryLoading ? t('Refreshing...') : t('Refresh'), async () => {
            await this.refreshMemoryView();
        }, 'default', this.memoryLoading);
        this.createActionButton(toolbarActions, t('Clear Memory'), async () => {
            this.confirmClearAllMemory();
        }, 'danger');

        this.renderMemorySearch(containerEl);
        this.renderMemoryTabs(containerEl);
        this.renderMemoryList(containerEl);

        if (!this.memoryView && !this.memoryLoading) {
            void this.refreshMemoryView();
        }
    }

    private async refreshMemoryView(
        mode: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = this.memoryActiveTab
    ): Promise<void> {
        if (typeof this.plugin.modelService?.getMemoryView !== 'function') {
            this.memoryError = t('Memory service is not available.');
            this.renderAccordion();
            return;
        }

        this.memoryLoading = true;
        this.memoryError = '';
        this.renderAccordion();
        try {
            this.memoryView = await this.plugin.modelService.getMemoryView({
                mode,
                query: mode === 'search' ? this.memorySearchQuery : undefined,
                limit: 25,
            });
        } catch (error: any) {
            this.memoryError = error?.message || t('Failed to load memory.');
        } finally {
            this.memoryLoading = false;
            this.renderAccordion();
        }
    }

    private getVisibleMemoryRecords(): any[] {
        const sections = this.memoryView?.sections;
        if (!sections) return [];
        if (this.memoryActiveTab === 'observations') return sections.observations || [];
        if (this.memoryActiveTab === 'facts') return sections.facts || [];
        if (this.memoryActiveTab === 'recent') return sections.recent || [];
        if (this.memoryActiveTab === 'search') return sections.searchResults || [];
        return [
            ...(sections.observations || []),
            ...(sections.facts || []),
        ].slice(0, 10);
    }

    private renderMemorySearch(containerEl: HTMLElement): void {
        const row = containerEl.createDiv({ cls: 'baizer-memory-search' });
        const input = row.createEl('input', {
            cls: 'baizer-settings-search',
            // P1-6: 补 aria-label(此前只有 placeholder,与顶部主搜索不一致)。
            attr: { type: 'search', placeholder: t('Search memories'), 'aria-label': t('Search memories') },
        }) as HTMLInputElement;
        input.value = this.memorySearchQuery;
        const runSearch = () => {
            if (!this.memorySearchQuery.trim()) return;
            this.memoryActiveTab = 'search';
            void this.refreshMemoryView('search');
        };
        input.addEventListener('input', () => {
            this.memorySearchQuery = input.value;
        });
        // P1-6: 支持回车提交,不必把手从键盘移到鼠标去点按钮。
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                runSearch();
            }
        });
        // 按钮常开(空查询在 runSearch 内部拦截),避免输入后禁用态因不重渲染而无法更新。
        this.createActionButton(row, t('Search'), async () => runSearch(), 'accent');
    }

    private renderMemoryTabs(containerEl: HTMLElement): void {
        // P1-6: 语义化为 tablist / tab,选中态用 aria-selected 表达(不再只靠颜色)。
        const tabs = containerEl.createDiv({ cls: 'baizer-memory-tabs', attr: { role: 'tablist' } });
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
                attr: {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': selected ? 'true' : 'false',
                },
            });
            button.addEventListener('click', () => {
                this.memoryActiveTab = id;
                void this.refreshMemoryView(id);
            });
        }
    }

    private renderMemoryList(containerEl: HTMLElement): void {
        if (this.memoryError) {
            // P1-5: 错误也是异步结果,用 role=alert 让读屏立即播报。
            containerEl.createDiv({
                cls: 'baizer-settings-inline-note is-warning',
                text: this.memoryError,
                attr: { role: 'alert', 'aria-live': 'assertive' },
            });
            return;
        }

        // P1-5: 记忆加载/结果是异步变化,标记为 status 区,读屏可感知「加载中/无记忆」。
        const list = containerEl.createDiv({ cls: 'baizer-memory-list', attr: { role: 'status', 'aria-live': 'polite' } });
        const records = this.getVisibleMemoryRecords();
        if (records.length === 0) {
            list.createDiv({
                cls: 'baizer-settings-empty-state',
                text: this.memoryLoading ? t('Loading memory...') : t('No memories to show.'),
            });
            return;
        }

        for (const record of records) {
            const row = list.createDiv({ cls: 'baizer-memory-row' });

            // 头部:左侧「类型 badge + 标签 chips + 置信度」,右侧「时间 + 删除图标」。
            // 删除按钮收成右上角的图标按钮 —— 不再是每行一个刺眼的红色文字块,悬停时才凸显。
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
                text: new Date(record.updatedAt || record.mentionedAt).toLocaleString('zh-CN'),
            });
            const deleteBtn = headActions.createEl('button', {
                cls: 'baizer-memory-delete',
                attr: { type: 'button', title: t('Delete'), 'aria-label': t('Delete') },
            });
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.addEventListener('click', () => this.confirmDeleteMemoryRecord(record.id));

            row.createDiv({ cls: 'baizer-memory-row-text', text: this.truncateSettingMemoryText(record.text || '', 260) });
        }
    }

    private truncateSettingMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }

    private confirmDeleteMemoryRecord(id: string): void {
        new MemoryConfirmModal(
            this.app,
            t('Delete Memory'),
            t('Delete this remembered Hindsight memory record?'),
            async () => {
                await this.deleteMemoryRecord(id);
            },
        ).open();
    }

    private confirmClearAllMemory(): void {
        new MemoryConfirmModal(
            this.app,
            t('Clear Memory'),
            t('Clear all remembered Hindsight memory and legacy profile fields?'),
            async () => {
                await this.clearAllMemory();
            },
        ).open();
    }

    private async deleteMemoryRecord(id: string): Promise<void> {
        if (typeof this.plugin.modelService?.deleteMemoryById !== 'function') {
            new Notice(t('Memory deletion is not available.'));
            return;
        }

        const result = await this.plugin.modelService.deleteMemoryById(id);
        new Notice(result?.message || `${t('Deleted memory')}: ${id}`);
        await this.refreshMemoryView();
    }

    private async clearAllMemory(): Promise<void> {
        if (typeof this.plugin.modelService?.forgetMemory !== 'function') {
            new Notice(t('Memory clearing is not available.'));
            return;
        }

        const result = await this.plugin.modelService.forgetMemory('all');
        new Notice(result?.message || t('Cleared all remembered Hindsight memory.'));
        await this.refreshMemoryView();
    }

    private renderConnectionSection(containerEl: HTMLElement, token: number): void {
        const settings = this.plugin.settings;
        const activeConfig = this.getActiveConfig();

        if (!activeConfig) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-warning', text: t('No active provider found.') });
            return;
        }

        const shell = containerEl.createDiv({ cls: 'baizer-settings-provider-shell' });
        const toolbar = shell.createDiv({ cls: 'baizer-settings-provider-toolbar' });
        toolbar.createDiv({ cls: 'baizer-settings-panel-title', text: t('Providers') });
        this.createActionButton(toolbar, t('+ Add'), async () => {
            new AddProviderModal(this.app, async (label, baseUrl) => {
                const key = `custom-${Date.now()}`;
                settings.providers[key] = {
                    type: 'openai-compatible',
                    label,
                    apiKey: '',
                    baseUrl,
                    model: '',
                };
                settings.activeProvider = key;
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.persistSettings();
                this.revealApiKey = false;
                this.renderAccordion();
            }).open();
        }, 'accent');

        const providerList = shell.createDiv({ cls: 'baizer-settings-provider-list' });
        Object.keys(settings.providers).forEach(providerId => {
            const meta = getProviderCardMeta(settings, providerId);
            const provider = settings.providers[providerId];
            const hasApiKey = !!provider.apiKey?.trim();
            const badgeLabel = !hasApiKey ? 'Needs key' : meta.isActive ? 'Active' : 'Ready';
            const badgeTone: SettingsBadgeTone = !hasApiKey ? 'warning' : 'success';

            const card = providerList.createDiv({
                cls: `baizer-settings-provider-card${meta.isActive ? ' is-active' : ''}`,
            });
            card.setAttribute('data-provider-id', providerId);

            // 切换按钮不能内嵌 button（无效 HTML），故用 header 行把删除图标作为兄弟节点并排。
            const header = card.createDiv({ cls: 'baizer-settings-provider-card-header' });
            // 激活卡此时兼作详情展开/折叠开关，补 aria-expanded 让读屏知道点击会展开/收起详情。
            const detailExpanded = meta.isActive && !this.activeProviderDetailCollapsed;
            const button = header.createEl('button', {
                cls: 'baizer-settings-provider-card-main',
                attr: {
                    type: 'button',
                    'aria-pressed': meta.isActive ? 'true' : 'false',
                    'aria-expanded': detailExpanded ? 'true' : 'false',
                },
            }) as HTMLButtonElement;
            // 栅格下沉到内层 div：移动端 WebView 不允许 <button> 当 grid 容器，
            // 直接在 button 上 display:grid 会被忽略、子项重叠。
            const buttonInner = button.createDiv({ cls: 'baizer-settings-provider-card-main-inner' });
            buttonInner.createDiv({ cls: 'baizer-settings-provider-card-title', text: meta.label });
            buttonInner.createDiv({ cls: 'baizer-settings-provider-card-meta', text: meta.compactMeta });
            buttonInner.createSpan({ cls: `baizer-settings-badge is-${badgeTone}`, text: badgeLabel });

            button.addEventListener('click', async () => {
                // 点当前激活卡：切换详情折叠/展开(可折叠已展开的详情)。
                if (providerId === settings.activeProvider) {
                    this.activeProviderDetailCollapsed = !this.activeProviderDetailCollapsed;
                    this.openSectionIds.add('connection');
                    this.renderAccordion();
                    return;
                }
                // 点其它卡：切换为激活并展开其详情。
                this.resetConnectionTestStatus();
                this.activeProviderDetailCollapsed = false;
                await this.plugin.modelService.switchProvider(providerId, () => this.persistSettings());
                this.revealApiKey = false;
                this.openSectionIds.add('connection');
                this.renderAccordion();
            });

            // 删除移到卡片头部：图标按钮 + tooltip，低调可发现，不再是抢眼的实体红按钮。
            // 每张卡删自己（点哪张删哪张）；至少保留一个 provider 时禁用。
            const canDelete = Object.keys(settings.providers || {}).length > 1;
            const deleteBtn = header.createEl('button', {
                cls: 'baizer-settings-provider-card-delete',
                attr: {
                    type: 'button',
                    title: t('Delete provider'),
                    'aria-label': `${t('Delete provider')} ${meta.label}`,
                },
            }) as HTMLButtonElement;
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.disabled = !canDelete;
            deleteBtn.addEventListener('click', (evt) => {
                evt.stopPropagation();
                if (deleteBtn.disabled) return;
                // T12: 删除 Provider 前用 MemoryConfirmModal 二次确认，避免误触即毁配置。
                new MemoryConfirmModal(
                    this.app,
                    t('Delete Provider'),
                    `${t('Delete provider')} "${meta.label}"? ${t('This removes its configuration from this workspace.')}`,
                    async () => {
                        delete settings.providers[providerId];
                        if (BUILTIN_PROVIDER_KEYS.includes(providerId)) {
                            settings.deletedProviderIds = Array.from(new Set([...(settings.deletedProviderIds || []), providerId]));
                        }
                        // 仅当删的是当前激活项时才需要改选激活；删其它项保持当前激活不变。
                        if (providerId === settings.activeProvider) {
                            settings.activeProvider = settings.providers.gemini ? 'gemini' : Object.keys(settings.providers)[0];
                            this.revealApiKey = false;
                            this.resetConnectionTestStatus();
                        }
                        this.openSectionIds.add('connection');
                        await this.persistSettings();
                        new Notice(t('Provider deleted'));
                        this.renderAccordion();
                    },
                ).open();
            });

            if (meta.isActive && !this.activeProviderDetailCollapsed) {
                this.renderActiveProviderDetail(card, activeConfig, token);
            }
        });
    }

    private renderActiveProviderDetail(parent: HTMLElement, activeConfig: ProviderConfig, token: number): void {
        const detail = parent.createDiv({ cls: 'baizer-settings-provider-detail-inline' });
        const grid = detail.createDiv({ cls: 'baizer-settings-connection-detail-grid' });
        const basic = grid.createDiv({ cls: 'baizer-settings-connection-card' });
        renderSettingHeading(
            basic.createDiv({ cls: 'baizer-settings-connection-card-header' }),
            t('Basic'),
            { nameClass: 'baizer-settings-connection-card-title' },
        );

        this.renderConnectionField(basic, t('Provider Name'), (valueEl) => {
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: { type: 'text', value: activeConfig.label, 'aria-label': t('Provider name') },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.label = input.value.trim() || activeConfig.label;
                this.openSectionIds.add('connection');
                await this.persistSettings();
                this.renderAccordion();
            });
        });

        this.renderConnectionField(basic, t('Protocol'), (valueEl) => {
            const select = valueEl.createEl('select', {
                cls: 'baizer-settings-detail-input',
                attr: { 'aria-label': t('Provider protocol') },
            }) as HTMLSelectElement;
            select.createEl('option', { value: 'gemini', text: t('Gemini API') });
            select.createEl('option', { value: 'openai-compatible', text: t('OpenAI-compatible') });
            select.value = activeConfig.type;
            select.addEventListener('change', async () => {
                activeConfig.type = select.value as ProviderConfig['type'];
                if (activeConfig.type === 'gemini') activeConfig.baseUrl = '';
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.plugin.modelService.updateSettings(this.plugin.settings);
                await this.persistSettings();
                this.renderAccordion();
            });
        });

        // 仅 OpenAI 兼容协议下暴露 API 端点方言选择（Chat Completions / Responses）。
        // Gemini 无此概念，隐藏该字段。缺省视为 completions。
        if (activeConfig.type === 'openai-compatible') {
            this.renderConnectionField(basic, t('API endpoint'), (valueEl) => {
                const select = valueEl.createEl('select', {
                    cls: 'baizer-settings-detail-input',
                    attr: { 'aria-label': t('API endpoint') },
                }) as HTMLSelectElement;
                select.createEl('option', { value: 'completions', text: t('Chat Completions (/chat/completions)') });
                select.createEl('option', { value: 'responses', text: t('Responses (/responses)') });
                select.value = activeConfig.apiFlavor ?? 'completions';
                select.addEventListener('change', async () => {
                    activeConfig.apiFlavor = select.value as NonNullable<ProviderConfig['apiFlavor']>;
                    this.resetConnectionTestStatus();
                    this.openSectionIds.add('connection');
                    await this.plugin.modelService.updateSettings(this.plugin.settings);
                    await this.persistSettings();
                    this.renderAccordion();
                });
            });
        }

        this.renderConnectionField(basic, t('Model'), (valueEl) => {
            const select = valueEl.createEl('select', {
                cls: 'baizer-settings-detail-input',
                attr: { 'aria-label': t('Model') },
            }) as HTMLSelectElement;
            if (activeConfig.model) {
                select.createEl('option', { value: activeConfig.model, text: activeConfig.model });
            } else {
                select.createEl('option', { value: '__empty__', text: t('Select a model') });
            }
            this.loadDynamicModelSelect(select, token).catch(() => undefined);
            select.value = activeConfig.model || '__empty__';
            select.addEventListener('change', async () => {
                const value = select.value;
                if (value === '__loading__' || value === '__failed__' || value === '__empty__') return;
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.plugin.modelService.switchModel(value, () => this.persistSettings());
                this.renderAccordion();
            });
        });

        const credentials = grid.createDiv({ cls: 'baizer-settings-connection-card' });
        renderSettingHeading(
            credentials.createDiv({ cls: 'baizer-settings-connection-card-header' }),
            t('Credentials'),
            { nameClass: 'baizer-settings-connection-card-title' },
        );

        this.renderConnectionField(credentials, t('API Endpoint'), (valueEl) => {
            const supportsCustomBaseUrl = this.plugin.modelService.getProviderCapabilities().supportsCustomBaseUrl;
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: 'text',
                    placeholder: 'https://api.openai.com/v1',
                    value: supportsCustomBaseUrl ? activeConfig.baseUrl : (activeConfig.baseUrl || t('Default Gemini endpoint')),
                    'aria-label': t('API endpoint'),
                },
            }) as HTMLInputElement;
            // disabled 只在「不支持自定义 baseUrl」(如 gemini) 时才设。
            // 注意：不能走 attr.disabled=undefined —— Obsidian createEl 会把 undefined 当字符串
            // 写成 disabled="undefined"，HTML 里 disabled 属性只要存在即生效，导致 openai-compatible
            // 的端点也被锁死（用户反馈「api端点不允许修改」的根因）。
            input.disabled = !supportsCustomBaseUrl;
            input.addEventListener('change', async () => {
                activeConfig.baseUrl = input.value;
                this.resetConnectionTestStatus();
                await this.persistSettings();
            });
        });

        this.renderConnectionField(credentials, t('API Key'), (valueEl) => {
            const keyRow = valueEl.createDiv({ cls: 'baizer-settings-detail-secret' });
            const input = keyRow.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: this.revealApiKey ? 'text' : 'password',
                    placeholder: 'sk-...',
                    value: activeConfig.apiKey,
                    autocomplete: 'off',
                    spellcheck: 'false',
                    'aria-label': t('API key'),
                },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.apiKey = input.value;
                this.resetConnectionTestStatus();
                await this.persistSettings();
            });

            const secretActions = keyRow.createDiv({ cls: 'baizer-settings-detail-secret-actions' });
            this.createActionButton(secretActions, this.revealApiKey ? t('Hide') : t('Reveal'), async () => {
                this.revealApiKey = !this.revealApiKey;
                this.openSectionIds.add('connection');
                this.renderAccordion();
            });
            this.createActionButton(secretActions, t('Clear'), () => {
                if (!activeConfig.apiKey.trim()) return;
                // P1-1: 清空 API Key 不可逆（需重去服务商后台复制），与删除 Provider 等操作一致做二次确认。
                new MemoryConfirmModal(
                    this.app,
                    t('Clear API Key'),
                    t('Clear the API key for this provider? You will need to paste it again to reconnect.'),
                    async () => {
                        activeConfig.apiKey = '';
                        this.revealApiKey = false;
                        this.resetConnectionTestStatus();
                        this.openSectionIds.add('connection');
                        await this.persistSettings();
                        this.renderAccordion();
                    },
                ).open();
            }, 'danger');
        });

        this.renderConnectionField(credentials, t('Test'), (valueEl) => {
            const actions = valueEl.createDiv({ cls: 'baizer-settings-actions' });
            this.createActionButton(actions, this.connectionTestStatus.state === 'testing' ? t('Testing...') : t('Run test'), async () => {
                const label = activeConfig.label || 'AI provider';
                if (!activeConfig.apiKey.trim()) {
                    this.connectionTestStatus = { state: 'error', message: `${label}${t(': no API key configured.')}` };
                    this.openSectionIds.add('connection');
                    this.renderAccordion();
                    return;
                }

                try {
                    this.connectionTestStatus = { state: 'testing', message: `${t('Testing connection to')} ${label}...` };
                    this.openSectionIds.add('connection');
                    this.renderAccordion();
                    await this.plugin.modelService.updateSettings(this.plugin.settings);
                    const success = await this.plugin.modelService.checkAvailability();
                    this.connectionTestStatus = success
                        ? { state: 'success', message: `${label}${t(': connection successful.')}` }
                        : { state: 'error', message: t('Connection failed. Check API key, base URL, and model.') };
                } catch (error: any) {
                    this.connectionTestStatus = { state: 'error', message: `${t('Connection failed')}: ${error.message}` };
                }

                this.openSectionIds.add('connection');
                this.renderAccordion();
            }, 'primary', this.connectionTestStatus.state === 'testing');

            // 删除 Provider 已上移到卡片头部的图标按钮，此处只保留连接测试结果提示。
            const status = getConnectionTestStatusPresentation(this.connectionTestStatus);
            if (status) {
                // P1-5: 连接测试「测试中→成功/失败」是异步结果,加 aria-live 让读屏播报;失败用 assertive。
                valueEl.createDiv({
                    cls: `baizer-settings-inline-note is-${status.tone}`,
                    text: status.label,
                    attr: { role: 'status', 'aria-live': status.tone === 'danger' ? 'assertive' : 'polite' },
                });
            }
        });
    }

    private renderConnectionField(
        containerEl: HTMLElement,
        label: string,
        renderValue: (valueEl: HTMLElement) => void
    ): void {
        const row = containerEl.createDiv({ cls: 'baizer-settings-detail-row' });
        row.createDiv({ cls: 'baizer-settings-detail-label', text: label });
        const value = row.createDiv({ cls: 'baizer-settings-detail-value' });
        renderValue(value);
    }

    private async loadDynamicModelSelect(select: HTMLSelectElement, token: number, forceRefresh: boolean = false): Promise<void> {
        const config = this.getActiveConfig();
        const currentModel = config?.model || '';

        select.empty();
        select.createEl('option', { value: '__loading__', text: t('Loading models...') });
        select.value = '__loading__';
        select.disabled = true;

        try {
            const models = await this.plugin.modelService.getAvailableModels(forceRefresh);
            if (token !== this.renderToken) return;

            select.empty();
            const options: ModelOption[] = models.length > 0
                ? models
                : [{ value: currentModel, label: `${currentModel} (${t('Current')})` }];

            options.forEach(option => select.createEl('option', { value: option.value, text: option.label }));

            if (currentModel && !options.some(option => option.value === currentModel)) {
                select.createEl('option', { value: currentModel, text: `${currentModel} (${t('Current')})` });
            }

            const resolved = currentModel || options[0]?.value || '';
            select.value = resolved;
            select.disabled = false;

            // P0-2: 新增/自定义 provider 的 model 为空时，下拉「视觉上」显示了第一个模型，
            // 但 config.model 仍是空——赋 select.value 不触发 change，也不落盘。
            // 这里主动把自动选中的模型写回 config 并持久化，避免用户看到「已选模型」的假象、
            // 而 Run test / 对话却拿空模型发请求。仅当真实拿到了模型列表(非仅回退当前值)时写回。
            if (!currentModel && resolved && resolved !== '__failed__' && resolved !== '__loading__' && models.length > 0) {
                await this.plugin.modelService.switchModel(resolved, () => this.persistSettings());
            }
        } catch {
            if (token !== this.renderToken) return;

            select.empty();
            if (currentModel) {
                select.createEl('option', { value: currentModel, text: `${currentModel} (${t('Current')})` });
                select.value = currentModel;
                select.disabled = false;
            } else {
                select.createEl('option', { value: '__failed__', text: t('Model list unavailable') });
                select.value = '__failed__';
                select.disabled = true;
            }
        }
    }

    private renderRuntimeSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t('Context Window Limit'))
            .setDesc(t('Limit token usage. Higher values allow reading larger files but cost more.'))
            .addSlider(slider => slider
                .setLimits(10000, 1000000, 10000)
                .setValue(this.plugin.settings.contextWindow)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    this.plugin.settings.contextWindow = value;
                    // 滑块拖动逐格触发：debounce 落盘，避免一次拖动几十次写盘 + 重建 provider（P0-3）。
                    this.debouncedPersist();
                }));

        new Setting(containerEl)
            .setName(t('Thinking Level'))
            .setDesc(t('Controls how much reasoning the model uses. Lower = fewer tokens; higher = better results on complex tasks.'))
            .addDropdown(drop => drop
                .addOption('off', t('Off (no thinking)'))
                .addOption('minimal', t('Minimal'))
                .addOption('low', t('Low'))
                .addOption('medium', t('Medium (default)'))
                .addOption('high', t('High'))
                .addOption('xhigh', t('X-High (select models only)'))
                .setValue(this.plugin.settings.thinkingLevel ?? 'medium')
                .onChange(async (value: PluginSettings['thinkingLevel']) => {
                    this.plugin.settings.thinkingLevel = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('Customize System Prompt'))
            .setDesc(t('Override the default AI personality.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.customizePrompt)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.customizePrompt = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        if (this.plugin.settings.customizePrompt) {
            new Setting(containerEl)
                .setClass('baizer-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder(t('You are a helpful assistant...'))
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange((value: string) => {
                        this.plugin.settings.systemPrompt = value;
                        this.debouncedPersist();
                    }));

            const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
            this.createActionButton(actions, t('Restore Default Prompt'), () => {
                // P1-1: 恢复默认会覆盖用户自定义的系统提示词且不可撤销，做二次确认。
                new MemoryConfirmModal(
                    this.app,
                    t('Restore Default Prompt'),
                    t('Replace your custom system prompt with the default? Your current prompt will be lost.'),
                    async () => {
                        this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                        await this.persistSettings();
                        this.renderAccordion();
                    },
                ).open();
            });
        }
    }

    private renderGuardianSection(containerEl: HTMLElement): void {
        // 选中文字工具条:独立于 Guardian 补全,放在 enableGuardian 短路 return 之前,
        // 保证即使 Guardian 关闭也能单独控制这个开关。
        new Setting(containerEl)
            .setName(t('Selection Toolbar'))
            .setDesc(t('Show a floating AI toolbar (rewrite, explain, etc.) when you select text in the editor.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSelectionMenu)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableSelectionMenu = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('Enable Guardian'))
            .setDesc(t('Allow AI to passively analyze text and offer suggestions.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableGuardian)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableGuardian = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        if (!this.plugin.settings.enableGuardian) return;

        new Setting(containerEl)
            .setName(t('Auto Mode'))
            .setDesc(t('Automatically analyze text after 5 seconds of inactivity.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.guardianAutoMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.guardianAutoMode = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('Manual Mode Hotkey'))
            .setDesc(t('Open the Obsidian hotkey settings for Guardian.'))
            .addButton(btn => btn
                .setButtonText(t('Configure Hotkey'))
                .onClick(() => {
                    (this.app as any).setting.openTabById('hotkeys');
                    (this.app as any).setting.activeTab.setQuery('Guardian: Manual Trigger');
                }));

        new Setting(containerEl)
            .setName(t('Guardian Sensitivity'))
            .setDesc(t('Low (manual) to high (copilot style).'))
            .addSlider(slider => slider
                .setLimits(0, 100, 25)
                .setValue(this.plugin.settings.guardianSensitivity)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    this.plugin.settings.guardianSensitivity = value;
                    this.debouncedPersist();
                }));

        new Setting(containerEl)
            .setName(t('UI Style'))
            .setDesc(t('Choose how suggestions appear in the editor.'))
            .addDropdown(drop => drop
                .addOption('ghost', t('Ghost Text (Inline)'))
                .addOption('gutter', t('Gutter Dot (Subtle)'))
                .addOption('hybrid', t('Hybrid (Both)'))
                .setValue(this.plugin.settings.guardianUIStyle)
                .onChange(async (value: 'ghost' | 'gutter' | 'hybrid') => {
                    this.plugin.settings.guardianUIStyle = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('Auto deep-dive when fast completion is empty or weak'))
            .setDesc(t('When AI has no immediate suggestion or only a mediocre one while you stay put, it reads related notes and personal memory to attempt a deeper completion. Slower, uses more tokens, on by default.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.guardianAutoDeepEscalation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.guardianAutoDeepEscalation = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('Ignored Folders'))
            .setDesc(t('Path patterns to ignore, one per line.'))
            .setClass('baizer-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Private/\nSecrets/\nTemplates/')
                .setValue(this.plugin.settings.ignoredFolders)
                .onChange((value: string) => {
                    this.plugin.settings.ignoredFolders = value;
                    this.debouncedPersist();
                }));
    }

    private renderPermissionsSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            panel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Permission presets'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        const presetGrid = panel.createDiv({ cls: 'baizer-settings-panel-body' }).createDiv({ cls: 'baizer-settings-preset-grid' });
        this.renderPermissionPreset(presetGrid, 'read-only', t('Read only'), t('Read and analyze notes without writing to the vault.'));
        this.renderPermissionPreset(presetGrid, 'configured-folders', t('Scoped write'), t('Write only inside explicitly configured folders.'));
        this.renderPermissionPreset(presetGrid, 'automation', t('Automation'), t('Allow scoped writes with fewer repeated confirmations.'));
        this.renderPermissionPreset(presetGrid, 'open', t('Open access'), t('Allow full-vault writes and plugin control.'));

        const summaryPanel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            summaryPanel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Effective permissions'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        this.renderEffectivePermissions(summaryPanel.createDiv({ cls: 'baizer-settings-panel-body' }));

        const advanced = containerEl.createEl('details', { cls: 'baizer-settings-advanced' });
        advanced.createEl('summary', { text: t('Advanced permission switches') });
        this.trackAdvancedDetails(advanced, 'permissions-advanced');
        const advancedBody = advanced.createDiv({ cls: 'baizer-settings-advanced-body' });

        new Setting(advancedBody)
            .setName(t('Vault Write Scope'))
            .setDesc(t('Choose how broadly AI can write inside your vault.'))
            .addDropdown(drop => drop
                .addOption('read-only', t('Read Only'))
                .addOption('current-note', t('Current Note'))
                .addOption('configured-folders', t('Configured Folders'))
                .addOption('all-vault', t('All Vault'))
                .setValue(this.plugin.settings.vaultWriteScope)
                .onChange(async (value: VaultWriteScope) => {
                    this.plugin.settings.vaultWriteScope = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        if (this.plugin.settings.vaultWriteScope === 'configured-folders') {
            new Setting(advancedBody)
                .setName(t('Writable Folders'))
                .setDesc(t('One vault folder per line. AI can create or modify files only inside these folders.'))
                .setClass('baizer-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('Projects/\nInbox/')
                    .setValue(this.plugin.settings.vaultWriteAllowedFolders.join('\n'))
                    .onChange((value: string) => {
                        this.plugin.settings.vaultWriteAllowedFolders = value
                            .split(/\r?\n/)
                            .map(item => item.trim())
                            .filter(Boolean);
                        this.debouncedPersist();
                    }));
        }

        new Setting(advancedBody)
            .setName(t('Allow File Creation'))
            .setDesc(t('Allow note and file creation after the selected write scope is satisfied.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileCreation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileCreation = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        new Setting(advancedBody)
            .setName(t('Allow File Modification'))
            .setDesc(t('Allow note and file modification after the selected write scope is satisfied.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileModification)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileModification = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        new Setting(advancedBody)
            .setName(t('Allow Plugin Control'))
            .setDesc(t('Let AI execute commands from other plugins.'))
            .setClass('gemini-danger-setting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowPluginControl)
                .onChange(async (value: boolean) => {
                    // T12: 开启插件控制会放权 AI 执行其它插件命令，属提权操作，需二次确认。
                    if (value) {
                        new MemoryConfirmModal(
                            this.app,
                            t('Allow Plugin Control'),
                            t('Grant AI permission to execute commands from other plugins? This can trigger destructive plugin actions on your behalf.'),
                            async () => {
                                this.plugin.settings.allowPluginControl = true;
                                new Notice(t('Permission granted: AI can now control your plugins.'));
                                await this.persistSettings();
                                this.renderAccordion();
                            },
                        ).open();
                        // 取消或未确认前，UI 回退到原值（关闭）。
                        toggle.setValue(false);
                        return;
                    }
                    this.plugin.settings.allowPluginControl = false;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        new Setting(advancedBody)
            .setName(t('Confirm Executions'))
            .setDesc(t('Always ask for confirmation before writing files or running commands.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.confirmExecutions)
                .onChange(async (value: boolean) => {
                    // T12: 关闭执行确认等于让 AI 无阻写盘/跑命令，属降低安全档位，需二次确认。
                    if (!value) {
                        new MemoryConfirmModal(
                            this.app,
                            t('Disable Execution Confirmation'),
                            t('Turn off confirmation? AI will write files and run commands without asking each time.'),
                            async () => {
                                this.plugin.settings.confirmExecutions = false;
                                await this.persistSettings();
                                this.renderAccordion();
                            },
                        ).open();
                        // 取消或未确认前，UI 回退到原值（开启）。
                        toggle.setValue(true);
                        return;
                    }
                    this.plugin.settings.confirmExecutions = true;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        new Setting(advancedBody)
            .setName(t('Allow Reading Plugin Config Values'))
            .setDesc(t('Let AI read third-party plugin configuration values. When off, only key names and types are returned. API keys, tokens, and secrets are always redacted regardless of this setting.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowPluginConfigValues)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowPluginConfigValues = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));
    }

    private renderSkillsSection(containerEl: HTMLElement): void {
        containerEl.createDiv({
            cls: 'baizer-settings-inline-note',
            text: t('Enable or disable individual skills. This controls availability only — a skill being on does not bypass the read/write permissions above.'),
        });

        const skills = typeof this.plugin.modelService?.getSkillList === 'function'
            ? this.plugin.modelService.getSkillList()
            : [];
        if (!skills.length) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-muted', text: t('No skills registered.') });
            return;
        }

        const disabled = new Set(this.plugin.settings.disabledSkills ?? []);
        for (const skill of skills) {
            const cmdHint = skill.commands?.length ? ` (${skill.commands.join(', ')})` : '';
            new Setting(containerEl)
                .setName(skill.name)
                .setDesc(`${skill.description}${cmdHint}`)
                .addToggle(toggle => toggle
                    .setValue(!disabled.has(skill.name))
                    .onChange(async (value: boolean) => {
                        const next = new Set(this.plugin.settings.disabledSkills ?? []);
                        if (value) next.delete(skill.name);
                        else next.add(skill.name);
                        this.plugin.settings.disabledSkills = [...next];
                        await this.persistSettings();
                    }));
        }
    }

    private getPermissionPresetId(): 'read-only' | 'configured-folders' | 'automation' | 'open' | 'custom' {
        const settings = this.plugin.settings;
        if (settings.vaultWriteScope === 'read-only' && !settings.allowFileCreation && !settings.allowFileModification && !settings.allowPluginControl && settings.confirmExecutions) {
            return 'read-only';
        }
        if (settings.vaultWriteScope === 'configured-folders' && settings.allowFileCreation && settings.allowFileModification && !settings.allowPluginControl && settings.confirmExecutions) {
            return 'configured-folders';
        }
        if (settings.vaultWriteScope === 'configured-folders' && settings.allowFileCreation && settings.allowFileModification && !settings.allowPluginControl && !settings.confirmExecutions) {
            return 'automation';
        }
        if (settings.vaultWriteScope === 'all-vault' && settings.allowFileCreation && settings.allowFileModification && settings.allowPluginControl && settings.confirmExecutions) {
            return 'open';
        }
        return 'custom';
    }

    private renderPermissionPreset(parent: HTMLElement, id: 'read-only' | 'configured-folders' | 'automation' | 'open', title: string, desc: string): void {
        const button = parent.createEl('button', {
            cls: 'baizer-settings-preset' + (this.getPermissionPresetId() === id ? ' is-active' : ''),
            attr: { type: 'button' },
        });
        button.createEl('strong', { text: title });
        button.createEl('br');
        button.createSpan({ text: desc });
        button.addEventListener('click', async () => {
            // P1-1: 提权预设(open=开插件控制+全库写; automation=关执行确认)与单独开关保持一致的二次确认,
            // 避免一键预设静默绕过 allowPluginControl / confirmExecutions 的破坏性警告。
            const escalates = id === 'open' || id === 'automation';
            if (escalates) {
                const message = id === 'open'
                    ? t('Open access grants full-vault writes and plugin control. AI can trigger destructive plugin actions on your behalf. Continue?')
                    : t('Automation turns off per-action confirmation. AI will write files without asking each time. Continue?');
                new MemoryConfirmModal(this.app, title, message, async () => {
                    await this.applyPermissionPreset(id);
                    this.renderAccordion();
                }).open();
                return;
            }
            await this.applyPermissionPreset(id);
            this.renderAccordion();
        });
    }

    private async applyPermissionPreset(id: 'read-only' | 'configured-folders' | 'automation' | 'open'): Promise<void> {
        if (id === 'read-only') {
            this.plugin.settings.vaultWriteScope = 'read-only';
            this.plugin.settings.allowFileCreation = false;
            this.plugin.settings.allowFileModification = false;
            this.plugin.settings.allowPluginControl = false;
            this.plugin.settings.confirmExecutions = true;
        } else if (id === 'configured-folders') {
            this.plugin.settings.vaultWriteScope = 'configured-folders';
            this.plugin.settings.allowFileCreation = true;
            this.plugin.settings.allowFileModification = true;
            this.plugin.settings.allowPluginControl = false;
            this.plugin.settings.confirmExecutions = true;
        } else if (id === 'automation') {
            this.plugin.settings.vaultWriteScope = 'configured-folders';
            this.plugin.settings.allowFileCreation = true;
            this.plugin.settings.allowFileModification = true;
            this.plugin.settings.allowPluginControl = false;
            this.plugin.settings.confirmExecutions = false;
        } else {
            this.plugin.settings.vaultWriteScope = 'all-vault';
            this.plugin.settings.allowFileCreation = true;
            this.plugin.settings.allowFileModification = true;
            this.plugin.settings.allowPluginControl = true;
            this.plugin.settings.confirmExecutions = true;
        }
        await this.persistSettings();
    }

    private renderEffectivePermissions(parent: HTMLElement): void {
        const list = parent.createEl('ul', { cls: 'baizer-settings-summary-list' });
        const rows: Array<[string, string]> = [
            [t('Write scope'), this.plugin.settings.vaultWriteScope],
            [t('Writable folders'), this.plugin.settings.vaultWriteScope === 'configured-folders' ? (this.plugin.settings.vaultWriteAllowedFolders.join(', ') || t('Not configured')) : t('Not applicable')],
            [t('File creation'), this.plugin.settings.allowFileCreation ? t('Allowed') : t('Blocked')],
            [t('File modification'), this.plugin.settings.allowFileModification ? t('Allowed') : t('Blocked')],
            [t('Plugin control'), this.plugin.settings.allowPluginControl ? t('Allowed') : t('Blocked')],
            [t('Execution confirmation'), this.plugin.settings.confirmExecutions ? t('Required') : t('Automatic')],
        ];
        for (const [label, value] of rows) {
            const item = list.createEl('li');
            item.createEl('strong', { text: label });
            item.createSpan({ text: value });
        }
        if (this.plugin.settings.allowPluginControl || !this.plugin.settings.confirmExecutions || this.plugin.settings.vaultWriteScope === 'all-vault') {
            parent.createDiv({ cls: 'baizer-settings-inline-note is-danger', text: t('Current permissions are broad. Keep this enabled only when automation requires it.') });
        }
    }

    private renderAppearanceSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            panel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Workbench'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        // 底部预览行的值 span 引用：外观字段变更时只更新这一行文本，
        // 不再整页/整区重绘（P0-3：拖动滑块每格重建会中断拖拽手势）。
        const sample = body.createDiv({ cls: 'baizer-settings-sample-line' });
        const updatePreview = () => {
            previewValue.setText(
                this.plugin.settings.terminalTheme + ' / '
                + this.plugin.settings.terminalFontSize + 'px / '
                + Math.round(this.plugin.settings.terminalOpacity * 100) + '%'
            );
        };

        // 语言选择：切换后即时生效（重绘设置面板 + 所有打开的 ShellView），无需重启。
        new Setting(body)
            .setName(t('Language'))
            .setDesc(t('Interface language. Follow system uses your device language.'))
            .addDropdown(drop => drop
                .addOption('auto', t('Follow system'))
                .addOption('en', 'English')
                .addOption('zh', '中文')
                .setValue(getLocale())
                .onChange(async (value: string) => {
                    const locale = value as Locale;
                    if (typeof this.plugin.applyLanguageChange === 'function') {
                        await this.plugin.applyLanguageChange(locale);
                    } else {
                        this.plugin.settings.language = locale;
                        await this.persistSettingsLight();
                    }
                    // 设置面板自身即时重绘：分区标题/描述/各控件文案随新语言刷新。
                    this.renderAccordion();
                }));

        new Setting(body)
            .setName(t('Theme Style'))
            .setDesc(t('Adjust the terminal look and feel.'))
            .addDropdown(drop => drop
                .addOption('hacker-green', t('Hacker Green'))
                .addOption('cyberpunk', t('Cyberpunk Neon'))
                .addOption('obsidian-native', t('Obsidian Native'))
                .setValue(this.plugin.settings.terminalTheme)
                .onChange((value: 'hacker-green' | 'cyberpunk' | 'obsidian-native') => {
                    this.plugin.settings.terminalTheme = value;
                    updatePreview();
                    // 纯 UI 字段：debounce 轻量落盘，不重建 provider/guardian/knowledge。
                    this.debouncedPersistLight();
                }));

        new Setting(body)
            .setName(t('Font Size'))
            .setDesc(t('Workbench text size.'))
            .addSlider(slider => slider
                .setLimits(12, 24, 1)
                .setValue(this.plugin.settings.terminalFontSize)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    this.plugin.settings.terminalFontSize = value;
                    updatePreview();
                    this.debouncedPersistLight();
                }));

        new Setting(body)
            .setName(t('Background Opacity'))
            .setDesc(t('Workbench panel opacity.'))
            .addSlider(slider => slider
                .setLimits(0.5, 1.0, 0.05)
                .setValue(this.plugin.settings.terminalOpacity)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    this.plugin.settings.terminalOpacity = value;
                    updatePreview();
                    this.debouncedPersistLight();
                }));

        sample.createEl('strong', { text: t('Preview') });
        const previewValue = sample.createSpan();
        updatePreview();
    }

    private renderCaptureSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t('WeChat Inbox Path'))
            .setDesc(t('The file to monitor for new WeChat links.'))
            .addText(text => text
                .setPlaceholder('Inbox.md')
                .setValue(this.plugin.settings.wechatInboxPath)
                .onChange(async (value: string) => {
                    this.plugin.settings.wechatInboxPath = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName(t('WeChat Storage Path'))
            .setDesc(t('The folder to store saved articles.'))
            .addText(text => text
                .setPlaceholder('Clippings')
                .setValue(this.plugin.settings.wechatStoragePath)
                .onChange(async (value: string) => {
                    this.plugin.settings.wechatStoragePath = value;
                    await this.persistSettings();
                }));
        const mobileSchemeTemplate = 'obsidian://baizer-clip?text=<encoded-share-text>';
        new Setting(containerEl)
            .setName(t('Mobile WeChat Capture'))
            .setDesc(t('Use this URL scheme from iOS Shortcuts or Android automation. Fallback command: Save URL from clipboard.'))
            .addButton(btn => btn
                .setButtonText(t('Copy URL Scheme'))
                .onClick(async () => {
                    await navigator.clipboard?.writeText?.(mobileSchemeTemplate);
                    new Notice(t('Baizer mobile capture URL scheme copied.'));
                }));
    }

    private renderKnowledgeSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            panel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Knowledge Compile'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        new Setting(body)
            .setName(t('Source Folders'))
            .setDesc(t('Folders to watch, one per line.'))
            .setClass('baizer-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Clippings\nReading Notes')
                .setValue((this.plugin.settings.knowledgeSourceFolders || []).join('\n'))
                .onChange((value: string) => {
                    this.plugin.settings.knowledgeSourceFolders = value
                        .split('\n')
                        .map(entry => entry.trim())
                        .filter(entry => entry.length > 0);
                    this.debouncedPersist();
                }));

        new Setting(body)
            .setName(t('Wiki Output Folder'))
            .setDesc(t('The folder where compiled wiki pages are stored.'))
            .addText(text => text
                .setPlaceholder('Knowledge Wiki')
                .setValue(this.plugin.settings.knowledgeWikiFolder)
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeWikiFolder = value || 'Knowledge Wiki';
                    await this.persistSettings();
                }));

        new Setting(body)
            .setName(t('Auto Compile'))
            .setDesc(t('Compile notes automatically when watched folders change.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeAutoCompile)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeAutoCompile = value;
                    await this.persistSettings();
                }));

        new Setting(body)
            .setName(t('Max Compile Batch'))
            .setDesc(t('Maximum number of notes to compile in a single batch.'))
            .addSlider(slider => slider
                .setLimits(1, 200, 1)
                .setValue(this.plugin.settings.knowledgeMaxCompileBatch)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    this.plugin.settings.knowledgeMaxCompileBatch = value;
                    this.debouncedPersist();
                }));

        const ontologyStatusEl = containerEl.createDiv({
            cls: 'baizer-settings-inline-note',
            text: t('Ontology status: loading...'),
        });
        void this.refreshOntologyStatus(ontologyStatusEl);

        const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
        this.createActionButton(actions, t('Open ontology'), async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.openOntologyFile) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            await runtime.openOntologyFile();
            await this.refreshOntologyStatus(ontologyStatusEl);
        });
        this.createActionButton(actions, t('Discover'), async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.discoverOntology) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            const path = await runtime.discoverOntology();
            new Notice(path ? t('Ontology schema created') + ': ' + path : t('Ontology schema was not created.'));
            await this.refreshOntologyStatus(ontologyStatusEl);
        }, 'accent');
        this.createActionButton(actions, t('Preview'), async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.discoverOntologyPreview) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            const preview = await runtime.discoverOntologyPreview();
            if (preview.content) console.log('[Baizer] Ontology preview:\n', preview.content);
            new Notice(preview.message);
        });
        this.createActionButton(actions, t('Mark stale pending'), async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.markOntologyStaleFilesPending) {
                new Notice(t('Knowledge runtime is not available.'));
                return;
            }
            const count = await runtime.markOntologyStaleFilesPending();
            new Notice(`${t('Marked stale notes pending')}: ${count}`);
            await this.refreshOntologyStatus(ontologyStatusEl);
        });

        const advanced = containerEl.createEl('details', { cls: 'baizer-settings-advanced' });
        advanced.createEl('summary', { text: t('Ontology advanced settings') });
        this.trackAdvancedDetails(advanced, 'ontology-advanced');
        const advancedBody = advanced.createDiv({ cls: 'baizer-settings-advanced-body' });

        new Setting(advancedBody)
            .setName(t('Enable Ontology Schema'))
            .setDesc(t('Use Knowledge Wiki/_ontology.md to add stable categories and entity extraction to future compiles.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeOntologyEnabled !== false)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeOntologyEnabled = value;
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName(t('Ontology Update Mode'))
            .setDesc(t('Manual never discovers automatically. Suggest reports readiness without writing. Auto creates a missing schema when thresholds are met.'))
            .addDropdown(drop => drop
                .addOption('manual', t('Manual'))
                .addOption('suggest', t('Suggest (recommended)'))
                .addOption('auto', t('Auto create when missing'))
                .setValue(this.plugin.settings.knowledgeOntologyUpdateMode || 'suggest')
                .onChange(async (value: OntologyUpdateMode) => {
                    this.plugin.settings.knowledgeOntologyUpdateMode = value;
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName(t('Minimum Articles'))
            .setDesc(t('Minimum compiled wiki articles required before ontology discovery can run.'))
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinArticles ?? 10))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinArticles = clampInteger(value, 1, 500, 10);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName(t('Minimum Topic Frequency'))
            .setDesc(t('A topic must appear this many times before it can influence ontology discovery.'))
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinTopicFrequency ?? 3))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinTopicFrequency = clampInteger(value, 1, 100, 3);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName(t('Minimum Concept Frequency'))
            .setDesc(t('A concept must appear this many times before it can influence ontology discovery.'))
            .addText(text => text
                .setPlaceholder('2')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinConceptFrequency ?? 2))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinConceptFrequency = clampInteger(value, 1, 100, 2);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName(t('Auto Recompile Stale Articles'))
            .setDesc(t('Automatically recompile affected notes after ontology changes. Keep off if you want to review stale notes first.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.knowledgeOntologyAutoRecompileStale)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeOntologyAutoRecompileStale = value;
                    await this.persistSettings();
                }));
    }

    private async refreshOntologyStatus(statusEl: HTMLElement): Promise<void> {
        const runtime = (this.plugin as any).knowledgeRuntime;
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
            // 局部重绘会替换掉旧的 statusEl；异步回来时若该节点已脱离文档,放弃写入,避免向已卸载节点做无效写(P0-2 一致性)。
            if (!statusEl.isConnected) return;
            // P1-4: 状态串走 i18n,枚举值仍保留原值(供进阶用户识别),但前缀/字段名中文化。
            const parts = [
                `${t('Ontology')}: ${status.kind}`,
            ];
            if (readiness) parts.push(`${t('discovery')}: ${readiness.kind}`);
            if (counts) parts.push(`${t('stale notes')}: ${counts.stale}`);
            statusEl.textContent = parts.join('  ·  ');
            statusEl.title = `${t('path')}: ${status.path}`;
        } catch (e: any) {
            if (!statusEl.isConnected) return;
            statusEl.textContent = `${t('Ontology status unavailable')}: ${e.message}`;
        }
    }

    private renderPluginSkillsSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            panel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Generation'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        new Setting(body)
            .setName(t('Auto-generate plugin skills'))
            .setDesc(t('Generate AI skills for installed plugins on startup.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGeneratePluginSkills)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.autoGeneratePluginSkills = value;
                    await this.persistSettings();
                    this.renderAccordion();
                }));

        new Setting(body)
            .setName(t('Excluded plugins'))
            .setDesc(t('Plugin IDs to exclude from skill generation, comma-separated.'))
            .addText(text => text
                .setPlaceholder('plugin-id-1, plugin-id-2')
                .setValue(this.plugin.settings.pluginSkillExcludeList.join(', '))
                .onChange(async (value: string) => {
                    this.plugin.settings.pluginSkillExcludeList = value
                        .split(',')
                        .map(entry => entry.trim())
                        .filter(entry => entry.length > 0);
                    await this.persistSettings();
                }));

        const list = body.createEl('ul', { cls: 'baizer-settings-skill-list' });
        const autoItem = list.createEl('li');
        autoItem.createEl('strong', { text: t('Startup scan') });
        autoItem.createSpan({ text: this.plugin.settings.autoGeneratePluginSkills ? t('Enabled') : t('Off') });
        const excludeItem = list.createEl('li');
        excludeItem.createEl('strong', { text: t('Excluded plugins') });
        excludeItem.createSpan({ text: String(this.plugin.settings.pluginSkillExcludeList.length) });

        this.renderDerivedSkillList(containerEl);
    }

    /**
     * 派生技能的管理入口。文件在 .obsidian 隐藏目录，Obsidian 文件浏览器看不见,
     * 所以这里是用户唯一能查看与处置它们的地方。
     */
    private renderDerivedSkillList(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        renderSettingHeading(
            panel.createDiv({ cls: 'baizer-settings-panel-header' }),
            t('Generated plugin skills'),
            { nameClass: 'baizer-settings-panel-title' },
        );
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        const watcher = this.plugin.pluginWatcher;
        const rows = watcher
            ? getDerivedSkillRows(watcher.getDerivedSkillStatuses(), watcher.getGenerationFailures())
            : [];

        if (rows.length === 0) {
            body.createDiv({
                cls: 'baizer-settings-inline-note is-muted',
                text: t('No plugin skills have been generated yet.'),
            });
            return;
        }

        for (const row of rows) {
            this.renderDerivedSkillRow(body, row);
        }
    }

    private renderDerivedSkillRow(body: HTMLElement, row: DerivedSkillRow): void {
        const descParts = [row.versionLabel, ...row.badges];
        if (row.failureReason) {
            descParts.push(`${t('Last generation failed')}: ${row.failureReason}`);
        }

        const setting = new Setting(body)
            .setName(row.pluginId)
            .setDesc(descParts.join(' · '));

        setting.addButton(button => button
            .setButtonText(t('Regenerate'))
            .onClick(() => { void this.regenerateDerivedSkill(row.pluginId); }));

        setting.addButton(button => {
            button.setButtonText(t('Delete')).setWarning();
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
        this.renderAccordion();
    }

    private async deleteDerivedSkill(pluginId: string): Promise<void> {
        const watcher = this.plugin.pluginWatcher;
        if (!watcher) return;

        const deleted = await watcher.deleteDerivedSkill(pluginId);
        new Notice(deleted
            ? t('Deleted the skill for {plugin}.').replace('{plugin}', pluginId)
            : t('Failed to delete the skill for {plugin}.').replace('{plugin}', pluginId));
        this.renderAccordion();
    }

    private createActionButton(
        containerEl: HTMLElement,
        label: string,
        onClick: () => void | Promise<void>,
        variant: 'default' | 'primary' | 'danger' | 'accent' = 'default',
        disabled: boolean = false
    ): HTMLButtonElement {
        const button = containerEl.createEl('button', {
            text: label,
            cls: `baizer-settings-action is-${variant}`,
            attr: { type: 'button' },
        }) as HTMLButtonElement;
        button.disabled = disabled;
        button.addEventListener('click', () => {
            if (button.disabled) return;
            void onClick();
        });
        return button;
    }
}

class MemoryConfirmModal extends Modal {
    constructor(
        app: App,
        private titleText: string,
        private message: string,
        private onConfirm: () => Promise<void>,
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
            this.close();
            void this.onConfirm();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class AddProviderModal extends Modal {
    private onSubmit: (label: string, baseUrl: string) => void;

    constructor(app: App, onSubmit: (label: string, baseUrl: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        renderSettingHeading(contentEl, t('Add OpenAI Compatible Provider'));

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

        new Setting(contentEl)
            .setName(t('Base URL'))
            .setDesc(t('API endpoint URL'))
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1')
                .onChange((value: string) => {
                    baseUrlValue = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('Add'))
                .setCta()
                .onClick(() => {
                    if (!labelValue.trim()) {
                        new Notice(t('Please enter a provider name'));
                        return;
                    }
                    if (!baseUrlValue.trim()) {
                        new Notice(t('Please enter a base URL'));
                        return;
                    }
                    this.onSubmit(labelValue.trim(), baseUrlValue.trim());
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
