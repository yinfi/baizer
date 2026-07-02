import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Modal, TextComponent } from 'obsidian';
import { BUILTIN_PROVIDER_KEYS, DEFAULT_SETTINGS, IPlugin, MEMORY_DIR, PLUGIN_NAME, PluginSettings, ProviderConfig, VaultWriteScope } from './mcp/types';
import { ModelOption } from './models/interfaces';
import { OntologyUpdateMode } from './knowledge/types';

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
.baizer-settings-badge.is-warning { color: #8b5e00; background: color-mix(in srgb, var(--color-yellow) 18%, transparent); }
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
    display: grid;
    grid-template-columns: minmax(120px, .8fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
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
.baizer-settings-inline-note.is-warning { color: #8b5e00; background: color-mix(in srgb, var(--color-yellow) 16%, transparent); }
.baizer-settings-inline-note.is-success { color: var(--color-green); background: color-mix(in srgb, var(--color-green) 10%, transparent); }
.baizer-settings-inline-note.is-danger { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 12%, transparent); }
.baizer-settings-inline-note.is-accent { color: var(--text-accent); background: color-mix(in srgb, var(--interactive-accent) 10%, transparent); }
.baizer-settings-inline-hint { color: var(--text-muted); font-size: var(--font-smallest); }
.baizer-full-width-textarea textarea { width: 100%; min-height: 110px; resize: vertical; }
.gemini-danger-setting { border-left: 3px solid color-mix(in srgb, var(--text-error) 75%, transparent); padding-left: 10px; }
@container (max-width: 560px) {
    .baizer-settings-hero {
        grid-template-columns: 1fr;
        grid-template-areas: "title" "subtitle" "search";
    }
    .baizer-settings-section-summary,
    .baizer-settings-provider-card-main,
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
    .baizer-settings-provider-card-main,
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

const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
    { id: 'overview', title: 'Overview', description: 'Configuration health and actions that need attention.', keywords: ['overview', 'health', 'risk', 'status'] },
    { id: 'connection', title: 'Connection', description: 'Provider, API key, endpoint, model, and connection tests.', keywords: ['provider', 'api key', 'base url', 'model', 'connection', 'openai', 'gemini', 'deepseek', 'qwen'] },
    { id: 'behavior', title: 'Behavior', description: 'Context budget, system prompt, and runtime behavior.', keywords: ['behavior', 'runtime', 'context window', 'token', 'system prompt', 'persona', 'prompt', 'thinking', 'reasoning'] },
    { id: 'memory', title: 'Memory', description: 'Memory retention, recall, search, and deletion.', keywords: ['memory', 'hindsight', 'recall', 'forget', 'profile', 'privacy', 'observation'] },
    { id: 'permissions', title: 'Permissions', description: 'Vault write scope, file operations, plugin control, and confirmations.', keywords: ['permissions', 'file creation', 'file modification', 'plugin control', 'confirm'] },
    { id: 'skills', title: 'Skills', description: 'Enable or disable individual skills (availability, separate from permissions).', keywords: ['skills', 'skill', 'enable', 'disable', 'workflow', 'available'] },
    { id: 'capture', title: 'Capture', description: 'Inbox, clipping storage, WeChat import, and URL capture.', keywords: ['wechat', 'capture', 'inbox', 'storage', 'clippings', 'web clipper'] },
    { id: 'knowledge', title: 'Knowledge', description: 'Source folders, output folder, compile state, and ontology.', keywords: ['knowledge', 'wiki', 'compile', 'source folders', 'batch', 'ontology', 'schema'] },
    { id: 'guardian', title: 'Guardian', description: 'Inline writing assistance, trigger mode, and ignored folders.', keywords: ['guardian', 'auto mode', 'manual mode', 'ignored folders', 'sensitivity'] },
    { id: 'appearance', title: 'Appearance', description: 'Workbench theme, font size, and opacity.', keywords: ['appearance', 'theme', 'font', 'opacity', 'terminal', 'workbench'] },
    { id: 'plugin-skills', title: 'Plugin Skills', description: 'Skill generation, excluded plugins, and startup scanning.', keywords: ['plugin', 'skills', 'generator', 'exclude', 'startup'] },
];

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
    if (!normalized) return SETTINGS_SECTIONS.map(section => section.id);

    return SETTINGS_SECTIONS
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

    if (!activeConfig?.apiKey?.trim()) {
        statuses.connection = { label: 'Needs key', tone: 'warning' };
    } else if (!BUILTIN_PROVIDER_KEYS.includes(settings.activeProvider)) {
        statuses.connection = { label: 'Custom', tone: 'accent' };
    }

    if (!settings.enableGuardian) {
        statuses.guardian = { label: 'Off', tone: 'muted' };
    }

    if (settings.privacyMode) {
        statuses.memory = { label: 'Private', tone: 'accent' };
    }

    if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
        statuses.permissions = { label: 'Risk', tone: 'danger' };
    }

    if (!settings.autoGeneratePluginSkills) {
        statuses['plugin-skills'] = { label: 'Off', tone: 'muted' };
    }

    const overviewActions = getSettingsOverviewActions(settings);
    if (overviewActions.length > 0) {
        statuses.overview = {
            label: overviewActions.length + ' actions',
            tone: overviewActions.some(action => action.tone === 'danger') ? 'danger' : 'warning',
        };
    }

    return statuses;
}

export function getSettingsOverviewActions(settings: PluginSettings): SettingsOverviewAction[] {
    const actions: SettingsOverviewAction[] = [];

    if (settings.allowPluginControl || !settings.confirmExecutions || settings.vaultWriteScope === 'all-vault') {
        actions.push({ label: '\u6743\u9650\u8FC7\u5BBD', sectionId: 'permissions', tone: 'danger' });
    }

    for (const [_providerId, provider] of Object.entries(settings.providers || {})) {
        if (!provider.apiKey?.trim()) {
            actions.push({ label: provider.label + ' \u7F3A\u5C11 API Key', sectionId: 'connection', tone: 'warning' });
        }
    }

    return actions;
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

    const protocolLabel = config.type === 'gemini' ? 'Gemini API' : 'OpenAI-compatible';
    const hasApiKey = !!config.apiKey?.trim();
    const rawEndpoint = config.baseUrl?.trim() || 'Default provider endpoint';
    const endpointSummary = rawEndpoint.replace(/^https?:\/\//, '');
    const modelSummary = config.model?.trim() ? `Model: ${config.model.trim()}` : 'Model: Not selected';

    return {
        id: providerId,
        label: config.label,
        protocolLabel,
        endpointSummary,
        modelSummary,
        statusLabel: hasApiKey ? 'Key configured' : 'No API key',
        statusTone: hasApiKey ? 'success' : 'warning',
        isActive: settings.activeProvider === providerId,
        compactMeta: config.model?.trim() ? `Model: ${config.model.trim()}` : 'Model: Not selected',
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
    const section = SETTINGS_SECTIONS.find(candidate => candidate.id === id);
    if (!section) {
        throw new Error(`Unknown settings section: ${id}`);
    }
    return section;
}

export class SettingTab extends PluginSettingTab {
    plugin: IPlugin;
    private renderToken = 0;
    private openSectionIds = new Set<SettingsSectionId>();
    private searchQuery = '';
    private revealApiKey = false;
    private connectionTestStatus: ConnectionTestStatus = { state: 'idle', message: '' };
    private memoryView: any = null;
    private memorySearchQuery = '';
    private memoryActiveTab: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = 'overview';
    private memoryLoading = false;
    private memoryError = '';

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

    private resetConnectionTestStatus(): void {
        this.connectionTestStatus = { state: 'idle', message: '' };
    }

    private async loadDynamicModelOptions(
        dropdown: DropdownComponent,
        token: number,
        forceRefresh: boolean = false
    ) {
        const config = this.getActiveConfig();
        const currentModel = config?.model || '';

        dropdown.selectEl.empty();
        dropdown.addOption('__loading__', 'Loading models...');
        dropdown.setValue('__loading__');
        dropdown.setDisabled(true);

        try {
            const models = await this.plugin.modelService.getAvailableModels(forceRefresh);
            if (token !== this.renderToken) return;

            dropdown.selectEl.empty();

            const options: ModelOption[] = models.length > 0
                ? models
                : [{ value: currentModel, label: `${currentModel} (Current)` }];

            options.forEach(option => dropdown.addOption(option.value, option.label));

            if (currentModel && !options.some(option => option.value === currentModel)) {
                dropdown.addOption(currentModel, `${currentModel} (Current)`);
            }

            dropdown.setValue(currentModel || options[0]?.value || '');
            dropdown.setDisabled(false);
        } catch (_error: any) {
            if (token !== this.renderToken) return;

            dropdown.selectEl.empty();
            if (currentModel) {
                dropdown.addOption(currentModel, `${currentModel} (Current)`);
                dropdown.setValue(currentModel);
                dropdown.setDisabled(false);
            } else {
                dropdown.addOption('__failed__', 'Model list unavailable');
                dropdown.setValue('__failed__');
                dropdown.setDisabled(true);
            }
        }
    }

    display(): void {
        const token = ++this.renderToken;
        const { containerEl } = this;
        ensureSettingsFallbackStyles();
        containerEl.empty();

        const visibleSections = this.getVisibleSections();

        const root = containerEl.createDiv({ cls: 'baizer-settings-page' });
        this.renderHeader(root);
        this.renderMain(root, visibleSections, token);
    }

    private renderHeader(containerEl: HTMLElement): void {
        const hero = containerEl.createDiv({ cls: 'baizer-settings-hero' });
        hero.createEl('h2', { text: `${PLUGIN_NAME} Configuration`, cls: 'baizer-settings-title' });
        hero.createEl('p', {
            text: 'A cleaner control center for provider setup, runtime behavior, and plugin capabilities.',
            cls: 'baizer-settings-subtitle',
        });

        const searchRow = hero.createDiv({ cls: 'baizer-settings-search-row' });
        const searchInput = searchRow.createEl('input', {
            cls: 'baizer-settings-search',
            attr: {
                type: 'search',
                placeholder: 'Search settings',
                'aria-label': 'Search settings',
            },
        }) as HTMLInputElement;
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', () => {
            this.searchQuery = searchInput.value;
            this.display();
        });
    }

    private renderMain(containerEl: HTMLElement, visibleSections: SettingsSectionId[], token: number): void {
        if (!visibleSections.length) {
            const empty = containerEl.createDiv({ cls: 'baizer-settings-empty-state' });
            empty.createEl('h3', { text: 'No matching settings' });
            empty.createEl('p', { text: 'Try searching by provider, prompt, permissions, or knowledge.' });
            return;
        }

        const accordion = containerEl.createDiv({ cls: 'baizer-settings-accordion' });
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
                    if (!renderableSections.has(sectionId)) this.display();
                    return;
                }
                this.openSectionIds.delete(sectionId);
            });

            const summary = card.createEl('summary', { cls: 'baizer-settings-section-summary' });
            const copy = summary.createSpan({ cls: 'baizer-settings-section-copy' });
            copy.createEl('h3', { text: meta.title, cls: 'baizer-settings-section-title' });
            copy.createEl('p', { text: meta.description, cls: 'baizer-settings-section-description' });
            const metaEl = summary.createSpan({ cls: 'baizer-settings-section-meta' });
            if (status) {
                metaEl.createSpan({ cls: 'baizer-settings-badge is-' + status.tone, text: status.label });
            }
            summary.createSpan({ cls: 'baizer-settings-section-chevron', text: '>' });

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

    private renderOverviewSection(containerEl: HTMLElement): void {
        const actions = getSettingsOverviewActions(this.plugin.settings);
        if (!actions.length) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-success', text: 'No immediate configuration actions.' });
            return;
        }

        for (const action of actions) {
            const row = containerEl.createDiv({ cls: 'baizer-settings-task' });
            const copy = row.createSpan();
            copy.createEl('strong', { text: action.label });
            copy.createEl('br');
            copy.appendText(getSectionMeta(action.sectionId).title);
            const button = row.createEl('button', {
                text: getSectionMeta(action.sectionId).title,
                cls: 'baizer-settings-badge is-' + action.tone,
                attr: { type: 'button' },
            });
            button.addEventListener('click', () => {
                this.openSectionIds.add(action.sectionId);
                this.display();
            });
        }
    }

    private renderMemorySection(containerEl: HTMLElement): void {
        const toolbar = containerEl.createDiv({ cls: 'baizer-memory-toolbar' });
        new Setting(toolbar)
            .setName('Privacy Mode')
            .setDesc('When enabled, new conversation turns are not retained as Hindsight memory.')
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

        toolbar.createDiv({
            cls: 'baizer-memory-path',
            text: `Data folder: ${MEMORY_DIR}`,
        });

        const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
        this.createActionButton(actions, this.memoryLoading ? 'Refreshing...' : 'Refresh', async () => {
            await this.refreshMemoryView();
        }, 'default', this.memoryLoading);

        this.renderMemorySearch(containerEl);
        this.renderMemoryTabs(containerEl);
        this.renderMemoryList(containerEl);
        this.renderMemoryDangerZone(containerEl);

        if (!this.memoryView && !this.memoryLoading) {
            void this.refreshMemoryView();
        }
    }

    private async refreshMemoryView(
        mode: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = this.memoryActiveTab
    ): Promise<void> {
        if (typeof this.plugin.modelService?.getMemoryView !== 'function') {
            this.memoryError = 'Memory service is not available.';
            this.display();
            return;
        }

        this.memoryLoading = true;
        this.memoryError = '';
        this.display();
        try {
            this.memoryView = await this.plugin.modelService.getMemoryView({
                mode,
                query: mode === 'search' ? this.memorySearchQuery : undefined,
                limit: 25,
            });
        } catch (error: any) {
            this.memoryError = error?.message || 'Failed to load memory.';
        } finally {
            this.memoryLoading = false;
            this.display();
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
            attr: { type: 'search', placeholder: 'Search memories' },
        }) as HTMLInputElement;
        input.value = this.memorySearchQuery;
        input.addEventListener('input', () => {
            this.memorySearchQuery = input.value;
        });
        this.createActionButton(row, 'Search', async () => {
            this.memoryActiveTab = 'search';
            await this.refreshMemoryView('search');
        }, 'accent', !this.memorySearchQuery.trim());
    }

    private renderMemoryTabs(containerEl: HTMLElement): void {
        const tabs = containerEl.createDiv({ cls: 'baizer-memory-tabs' });
        const entries: Array<[typeof this.memoryActiveTab, string]> = [
            ['overview', 'Overview'],
            ['observations', 'Observations'],
            ['facts', 'Facts'],
            ['recent', 'Recent'],
            ['search', 'Search Results'],
        ];
        for (const [id, label] of entries) {
            const button = tabs.createEl('button', {
                text: label,
                cls: `baizer-memory-tab${this.memoryActiveTab === id ? ' is-active' : ''}`,
                attr: { type: 'button' },
            });
            button.addEventListener('click', () => {
                this.memoryActiveTab = id;
                void this.refreshMemoryView(id);
            });
        }
    }

    private renderMemoryList(containerEl: HTMLElement): void {
        if (this.memoryError) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-warning', text: this.memoryError });
            return;
        }

        const list = containerEl.createDiv({ cls: 'baizer-memory-list' });
        const records = this.getVisibleMemoryRecords();
        if (records.length === 0) {
            list.createDiv({
                cls: 'baizer-settings-empty-state',
                text: this.memoryLoading ? 'Loading memory...' : 'No memories to show.',
            });
            return;
        }

        for (const record of records) {
            const row = list.createDiv({ cls: 'baizer-memory-row' });
            const meta = row.createDiv({ cls: 'baizer-memory-row-meta' });
            meta.createSpan({ cls: `baizer-memory-type is-${record.type}`, text: record.type });
            meta.createSpan({ text: `confidence ${Number(record.confidence || 0).toFixed(2)}` });
            meta.createSpan({ text: `updated ${new Date(record.updatedAt || record.mentionedAt).toLocaleString()}` });
            row.createDiv({ cls: 'baizer-memory-row-text', text: this.truncateSettingMemoryText(record.text || '', 260) });
            if (record.tags?.length) {
                row.createDiv({ cls: 'baizer-memory-row-tags', text: `tags: ${record.tags.join(', ')}` });
            }
            this.createActionButton(row, 'Delete', async () => {
                this.confirmDeleteMemoryRecord(record.id);
            }, 'danger');
        }
    }

    private renderMemoryDangerZone(containerEl: HTMLElement): void {
        const zone = containerEl.createDiv({ cls: 'baizer-memory-danger' });
        const copy = zone.createDiv({ cls: 'baizer-memory-danger-copy' });
        copy.createDiv({ cls: 'baizer-settings-panel-title', text: 'Danger Zone' });
        copy.createDiv({ cls: 'baizer-settings-inline-hint', text: 'Clear all remembered Hindsight memory.' });
        this.createActionButton(zone, 'Clear Memory', async () => {
            this.confirmClearAllMemory();
        }, 'danger');
    }

    private truncateSettingMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }

    private confirmDeleteMemoryRecord(id: string): void {
        new MemoryConfirmModal(
            this.app,
            'Delete Memory',
            'Delete this remembered Hindsight memory record?',
            async () => {
                await this.deleteMemoryRecord(id);
            },
        ).open();
    }

    private confirmClearAllMemory(): void {
        new MemoryConfirmModal(
            this.app,
            'Clear Memory',
            'Clear all remembered Hindsight memory and legacy profile fields?',
            async () => {
                await this.clearAllMemory();
            },
        ).open();
    }

    private async deleteMemoryRecord(id: string): Promise<void> {
        if (typeof this.plugin.modelService?.deleteMemoryById !== 'function') {
            new Notice('Memory deletion is not available.');
            return;
        }

        const result = await this.plugin.modelService.deleteMemoryById(id);
        new Notice(result?.message || `Deleted memory: ${id}`);
        await this.refreshMemoryView();
    }

    private async clearAllMemory(): Promise<void> {
        if (typeof this.plugin.modelService?.forgetMemory !== 'function') {
            new Notice('Memory clearing is not available.');
            return;
        }

        const result = await this.plugin.modelService.forgetMemory('all');
        new Notice(result?.message || 'Cleared all remembered Hindsight memory.');
        await this.refreshMemoryView();
    }

    private renderConnectionSection(containerEl: HTMLElement, token: number): void {
        const settings = this.plugin.settings;
        const activeConfig = this.getActiveConfig();

        if (!activeConfig) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-warning', text: 'No active provider found.' });
            return;
        }

        const shell = containerEl.createDiv({ cls: 'baizer-settings-provider-shell' });
        const toolbar = shell.createDiv({ cls: 'baizer-settings-provider-toolbar' });
        toolbar.createDiv({ cls: 'baizer-settings-panel-title', text: 'Providers' });
        this.createActionButton(toolbar, '+ Add', async () => {
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
                this.display();
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

            const button = card.createEl('button', {
                cls: 'baizer-settings-provider-card-main',
                attr: {
                    type: 'button',
                    'aria-pressed': meta.isActive ? 'true' : 'false',
                },
            }) as HTMLButtonElement;
            button.createDiv({ cls: 'baizer-settings-provider-card-title', text: meta.label });
            button.createDiv({ cls: 'baizer-settings-provider-card-meta', text: meta.compactMeta });
            button.createSpan({ cls: `baizer-settings-badge is-${badgeTone}`, text: badgeLabel });

            button.addEventListener('click', async () => {
                if (providerId === settings.activeProvider) return;
                this.resetConnectionTestStatus();
                await this.plugin.modelService.switchProvider(providerId, () => this.persistSettings());
                this.revealApiKey = false;
                this.openSectionIds.add('connection');
                this.display();
            });

            if (meta.isActive) {
                this.renderActiveProviderDetail(card, activeConfig, token);
            }
        });
    }

    private renderActiveProviderDetail(parent: HTMLElement, activeConfig: ProviderConfig, token: number): void {
        const settings = this.plugin.settings;
        const detail = parent.createDiv({ cls: 'baizer-settings-provider-detail-inline' });
        const grid = detail.createDiv({ cls: 'baizer-settings-connection-detail-grid' });
        const basic = grid.createDiv({ cls: 'baizer-settings-connection-card' });
        basic.createDiv({ cls: 'baizer-settings-connection-card-header' })
            .createEl('h4', { text: 'Basic', cls: 'baizer-settings-connection-card-title' });

        this.renderConnectionField(basic, 'Provider Name', (valueEl) => {
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: { type: 'text', value: activeConfig.label, 'aria-label': 'Provider name' },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.label = input.value.trim() || activeConfig.label;
                this.openSectionIds.add('connection');
                await this.persistSettings();
                this.display();
            });
        });

        this.renderConnectionField(basic, 'Protocol', (valueEl) => {
            const select = valueEl.createEl('select', {
                cls: 'baizer-settings-detail-input',
                attr: { 'aria-label': 'Provider protocol' },
            }) as HTMLSelectElement;
            select.createEl('option', { value: 'gemini', text: 'Gemini API' });
            select.createEl('option', { value: 'openai-compatible', text: 'OpenAI-compatible' });
            select.value = activeConfig.type;
            select.addEventListener('change', async () => {
                activeConfig.type = select.value as ProviderConfig['type'];
                if (activeConfig.type === 'gemini') activeConfig.baseUrl = '';
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.plugin.modelService.updateSettings(this.plugin.settings);
                await this.persistSettings();
                this.display();
            });
        });

        this.renderConnectionField(basic, 'Model', (valueEl) => {
            const select = valueEl.createEl('select', {
                cls: 'baizer-settings-detail-input',
                attr: { 'aria-label': 'Model' },
            }) as HTMLSelectElement;
            if (activeConfig.model) {
                select.createEl('option', { value: activeConfig.model, text: activeConfig.model });
            } else {
                select.createEl('option', { value: '__empty__', text: 'Select a model' });
            }
            this.loadDynamicModelSelect(select, token).catch(() => undefined);
            select.value = activeConfig.model || '__empty__';
            select.addEventListener('change', async () => {
                const value = select.value;
                if (value === '__loading__' || value === '__failed__' || value === '__empty__') return;
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.plugin.modelService.switchModel(value, () => this.persistSettings());
                this.display();
            });
        });

        const credentials = grid.createDiv({ cls: 'baizer-settings-connection-card' });
        credentials.createDiv({ cls: 'baizer-settings-connection-card-header' })
            .createEl('h4', { text: 'Credentials', cls: 'baizer-settings-connection-card-title' });

        this.renderConnectionField(credentials, 'API Endpoint', (valueEl) => {
            const supportsCustomBaseUrl = this.plugin.modelService.getProviderCapabilities().supportsCustomBaseUrl;
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: 'text',
                    placeholder: 'https://api.openai.com/v1',
                    value: supportsCustomBaseUrl ? activeConfig.baseUrl : (activeConfig.baseUrl || 'Default Gemini endpoint'),
                    'aria-label': 'API endpoint',
                    disabled: supportsCustomBaseUrl ? undefined : 'true',
                },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.baseUrl = input.value;
                this.resetConnectionTestStatus();
                await this.persistSettings();
            });
        });

        this.renderConnectionField(credentials, 'API Key', (valueEl) => {
            const keyRow = valueEl.createDiv({ cls: 'baizer-settings-detail-secret' });
            const input = keyRow.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: this.revealApiKey ? 'text' : 'password',
                    placeholder: 'sk-...',
                    value: activeConfig.apiKey,
                    autocomplete: 'off',
                    spellcheck: 'false',
                    'aria-label': 'API key',
                },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.apiKey = input.value;
                this.resetConnectionTestStatus();
                await this.persistSettings();
            });

            const secretActions = keyRow.createDiv({ cls: 'baizer-settings-detail-secret-actions' });
            this.createActionButton(secretActions, this.revealApiKey ? 'Hide' : 'Reveal', async () => {
                this.revealApiKey = !this.revealApiKey;
                this.openSectionIds.add('connection');
                this.display();
            });
            this.createActionButton(secretActions, 'Clear', async () => {
                activeConfig.apiKey = '';
                this.revealApiKey = false;
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.persistSettings();
                this.display();
            }, 'danger');
        });

        this.renderConnectionField(credentials, 'Test', (valueEl) => {
            const actions = valueEl.createDiv({ cls: 'baizer-settings-actions' });
            this.createActionButton(actions, this.connectionTestStatus.state === 'testing' ? 'Testing...' : 'Run test', async () => {
                const label = activeConfig.label || 'AI provider';
                if (!activeConfig.apiKey.trim()) {
                    this.connectionTestStatus = { state: 'error', message: `No API key configured for ${label}.` };
                    this.openSectionIds.add('connection');
                    this.display();
                    return;
                }

                try {
                    this.connectionTestStatus = { state: 'testing', message: `Testing connection to ${label}...` };
                    this.openSectionIds.add('connection');
                    this.display();
                    await this.plugin.modelService.updateSettings(this.plugin.settings);
                    const success = await this.plugin.modelService.checkAvailability();
                    this.connectionTestStatus = success
                        ? { state: 'success', message: `Connection successful for ${label}.` }
                        : { state: 'error', message: 'Connection failed. Check API key, base URL, and model.' };
                } catch (error: any) {
                    this.connectionTestStatus = { state: 'error', message: `Connection failed: ${error.message}` };
                }

                this.openSectionIds.add('connection');
                this.display();
            }, 'primary', this.connectionTestStatus.state === 'testing');

            const deletion = getProviderDeletionState(settings);
            this.createActionButton(actions, deletion.label, async () => {
                if (!deletion.canDelete) return;
                const deletedProviderId = settings.activeProvider;
                delete settings.providers[deletedProviderId];
                if (BUILTIN_PROVIDER_KEYS.includes(deletedProviderId)) {
                    settings.deletedProviderIds = Array.from(new Set([...(settings.deletedProviderIds || []), deletedProviderId]));
                }
                settings.activeProvider = settings.providers.gemini ? 'gemini' : Object.keys(settings.providers)[0];
                this.revealApiKey = false;
                this.resetConnectionTestStatus();
                this.openSectionIds.add('connection');
                await this.persistSettings();
                new Notice('Provider deleted');
                this.display();
            }, 'danger', !deletion.canDelete);

            const status = getConnectionTestStatusPresentation(this.connectionTestStatus);
            if (status) {
                valueEl.createDiv({ cls: `baizer-settings-inline-note is-${status.tone}`, text: status.label });
            }
            valueEl.createDiv({ cls: 'baizer-settings-inline-hint', text: getProviderDeletionState(settings).helperText });
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

        select.innerHTML = '';
        select.createEl('option', { value: '__loading__', text: 'Loading models...' });
        select.value = '__loading__';
        select.disabled = true;

        try {
            const models = await this.plugin.modelService.getAvailableModels(forceRefresh);
            if (token !== this.renderToken) return;

            select.innerHTML = '';
            const options: ModelOption[] = models.length > 0
                ? models
                : [{ value: currentModel, label: `${currentModel} (Current)` }];

            options.forEach(option => select.createEl('option', { value: option.value, text: option.label }));

            if (currentModel && !options.some(option => option.value === currentModel)) {
                select.createEl('option', { value: currentModel, text: `${currentModel} (Current)` });
            }

            select.value = currentModel || options[0]?.value || '';
            select.disabled = false;
        } catch {
            if (token !== this.renderToken) return;

            select.innerHTML = '';
            if (currentModel) {
                select.createEl('option', { value: currentModel, text: `${currentModel} (Current)` });
                select.value = currentModel;
                select.disabled = false;
            } else {
                select.createEl('option', { value: '__failed__', text: 'Model list unavailable' });
                select.value = '__failed__';
                select.disabled = true;
            }
        }
    }

    private renderRuntimeSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Context Window Limit')
            .setDesc('Limit token usage. Higher values allow reading larger files but cost more.')
            .addSlider(slider => slider
                .setLimits(10000, 1000000, 10000)
                .setValue(this.plugin.settings.contextWindow)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.contextWindow = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Thinking Level')
            .setDesc('Controls how much reasoning the model uses. Lower = fewer tokens; higher = better results on complex tasks.')
            .addDropdown(drop => drop
                .addOption('off', 'Off (no thinking)')
                .addOption('minimal', 'Minimal')
                .addOption('low', 'Low')
                .addOption('medium', 'Medium (default)')
                .addOption('high', 'High')
                .addOption('xhigh', 'X-High (select models only)')
                .setValue(this.plugin.settings.thinkingLevel ?? 'medium')
                .onChange(async (value: PluginSettings['thinkingLevel']) => {
                    this.plugin.settings.thinkingLevel = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Customize System Prompt')
            .setDesc('Override the default AI personality.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.customizePrompt)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.customizePrompt = value;
                    await this.persistSettings();
                    this.display();
                }));

        if (this.plugin.settings.customizePrompt) {
            new Setting(containerEl)
                .setClass('baizer-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('You are a helpful assistant...')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.persistSettings();
                    }));

            const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
            this.createActionButton(actions, 'Restore Default Prompt', async () => {
                this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                await this.persistSettings();
                this.display();
            });
        }
    }

    private renderGuardianSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Enable Guardian')
            .setDesc('Allow AI to passively analyze text and offer suggestions.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableGuardian)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableGuardian = value;
                    await this.persistSettings();
                    this.display();
                }));

        if (!this.plugin.settings.enableGuardian) return;

        new Setting(containerEl)
            .setName('Auto Mode')
            .setDesc('Automatically analyze text after 5 seconds of inactivity.')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.guardianAutoMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.guardianAutoMode = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Manual Mode Hotkey')
            .setDesc('Open the Obsidian hotkey settings for Guardian.')
            .addButton(btn => btn
                .setButtonText('Configure Hotkey')
                .onClick(() => {
                    (this.app as any).setting.openTabById('hotkeys');
                    (this.app as any).setting.activeTab.setQuery('Guardian: Manual Trigger');
                }));

        new Setting(containerEl)
            .setName('Guardian Sensitivity')
            .setDesc('Low (manual) to high (copilot style).')
            .addSlider(slider => slider
                .setLimits(0, 100, 25)
                .setValue(this.plugin.settings.guardianSensitivity)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.guardianSensitivity = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('UI Style')
            .setDesc('Choose how suggestions appear in the editor.')
            .addDropdown(drop => drop
                .addOption('ghost', 'Ghost Text (Inline)')
                .addOption('gutter', 'Gutter Dot (Subtle)')
                .addOption('hybrid', 'Hybrid (Both)')
                .setValue(this.plugin.settings.guardianUIStyle)
                .onChange(async (value: 'ghost' | 'gutter' | 'hybrid') => {
                    this.plugin.settings.guardianUIStyle = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('快补无果时自动深挖笔记')
            .setDesc('当 AI 没有即时建议、而你停留在原地时，自动读取相关笔记尝试更深的补全。较慢、消耗更多 token，默认关闭。')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.guardianAutoDeepEscalation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.guardianAutoDeepEscalation = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Ignored Folders')
            .setDesc('Path patterns to ignore, one per line.')
            .setClass('baizer-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Private/\nSecrets/\nTemplates/')
                .setValue(this.plugin.settings.ignoredFolders)
                .onChange(async (value: string) => {
                    this.plugin.settings.ignoredFolders = value;
                    await this.persistSettings();
                }));
    }

    private renderPermissionsSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        panel.createDiv({ cls: 'baizer-settings-panel-header' })
            .createEl('h4', { text: 'Permission presets', cls: 'baizer-settings-panel-title' });
        const presetGrid = panel.createDiv({ cls: 'baizer-settings-panel-body' }).createDiv({ cls: 'baizer-settings-preset-grid' });
        this.renderPermissionPreset(presetGrid, 'read-only', 'Read only', 'Read and analyze notes without writing to the vault.');
        this.renderPermissionPreset(presetGrid, 'configured-folders', 'Scoped write', 'Write only inside explicitly configured folders.');
        this.renderPermissionPreset(presetGrid, 'automation', 'Automation', 'Allow scoped writes with fewer repeated confirmations.');
        this.renderPermissionPreset(presetGrid, 'open', 'Open access', 'Allow full-vault writes and plugin control.');

        const summaryPanel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        summaryPanel.createDiv({ cls: 'baizer-settings-panel-header' })
            .createEl('h4', { text: 'Effective permissions', cls: 'baizer-settings-panel-title' });
        this.renderEffectivePermissions(summaryPanel.createDiv({ cls: 'baizer-settings-panel-body' }));

        const advanced = containerEl.createEl('details', { cls: 'baizer-settings-advanced' });
        advanced.createEl('summary', { text: 'Advanced permission switches' });
        const advancedBody = advanced.createDiv({ cls: 'baizer-settings-advanced-body' });

        new Setting(advancedBody)
            .setName('Vault Write Scope')
            .setDesc('Choose how broadly AI can write inside your vault.')
            .addDropdown(drop => drop
                .addOption('read-only', 'Read Only')
                .addOption('current-note', 'Current Note')
                .addOption('configured-folders', 'Configured Folders')
                .addOption('all-vault', 'All Vault')
                .setValue(this.plugin.settings.vaultWriteScope)
                .onChange(async (value: VaultWriteScope) => {
                    this.plugin.settings.vaultWriteScope = value;
                    await this.persistSettings();
                    this.display();
                }));

        if (this.plugin.settings.vaultWriteScope === 'configured-folders') {
            new Setting(advancedBody)
                .setName('Writable Folders')
                .setDesc('One vault folder per line. AI can create or modify files only inside these folders.')
                .setClass('baizer-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('Projects/\nInbox/')
                    .setValue(this.plugin.settings.vaultWriteAllowedFolders.join('\n'))
                    .onChange(async (value: string) => {
                        this.plugin.settings.vaultWriteAllowedFolders = value
                            .split(/\r?\n/)
                            .map(item => item.trim())
                            .filter(Boolean);
                        await this.persistSettings();
                    }));
        }

        new Setting(advancedBody)
            .setName('Allow File Creation')
            .setDesc('Allow note and file creation after the selected write scope is satisfied.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileCreation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileCreation = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(advancedBody)
            .setName('Allow File Modification')
            .setDesc('Allow note and file modification after the selected write scope is satisfied.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileModification)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileModification = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(advancedBody)
            .setName('Allow Plugin Control')
            .setDesc('Let AI execute commands from other plugins.')
            .setClass('gemini-danger-setting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowPluginControl)
                .onChange(async (value: boolean) => {
                    if (value) new Notice('Permission granted: AI can now control your plugins.');
                    this.plugin.settings.allowPluginControl = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(advancedBody)
            .setName('Confirm Executions')
            .setDesc('Always ask for confirmation before writing files or running commands.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.confirmExecutions)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.confirmExecutions = value;
                    await this.persistSettings();
                    this.display();
                }));
    }

    private renderSkillsSection(containerEl: HTMLElement): void {
        containerEl.createDiv({
            cls: 'baizer-settings-inline-note',
            text: 'Enable or disable individual skills. This controls availability only — a skill being on does not bypass the read/write permissions above.',
        });

        const skills = typeof this.plugin.modelService?.getSkillList === 'function'
            ? this.plugin.modelService.getSkillList()
            : [];
        if (!skills.length) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-muted', text: 'No skills registered.' });
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
            await this.applyPermissionPreset(id);
            this.display();
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
            ['Write scope', this.plugin.settings.vaultWriteScope],
            ['Writable folders', this.plugin.settings.vaultWriteScope === 'configured-folders' ? (this.plugin.settings.vaultWriteAllowedFolders.join(', ') || 'Not configured') : 'Not applicable'],
            ['File creation', this.plugin.settings.allowFileCreation ? 'Allowed' : 'Blocked'],
            ['File modification', this.plugin.settings.allowFileModification ? 'Allowed' : 'Blocked'],
            ['Plugin control', this.plugin.settings.allowPluginControl ? 'Allowed' : 'Blocked'],
            ['Execution confirmation', this.plugin.settings.confirmExecutions ? 'Required' : 'Automatic'],
        ];
        for (const [label, value] of rows) {
            const item = list.createEl('li');
            item.createEl('strong', { text: label });
            item.createSpan({ text: value });
        }
        if (this.plugin.settings.allowPluginControl || !this.plugin.settings.confirmExecutions || this.plugin.settings.vaultWriteScope === 'all-vault') {
            parent.createDiv({ cls: 'baizer-settings-inline-note is-danger', text: 'Current permissions are broad. Keep this enabled only when automation requires it.' });
        }
    }

    private renderAppearanceSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        panel.createDiv({ cls: 'baizer-settings-panel-header' })
            .createEl('h4', { text: 'Workbench', cls: 'baizer-settings-panel-title' });
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        new Setting(body)
            .setName('Theme Style')
            .setDesc('Adjust the terminal look and feel.')
            .addDropdown(drop => drop
                .addOption('hacker-green', 'Hacker Green')
                .addOption('cyberpunk', 'Cyberpunk Neon')
                .addOption('obsidian-native', 'Obsidian Native')
                .setValue(this.plugin.settings.terminalTheme)
                .onChange(async (value: 'hacker-green' | 'cyberpunk' | 'obsidian-native') => {
                    this.plugin.settings.terminalTheme = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(body)
            .setName('Font Size')
            .setDesc('Workbench text size.')
            .addSlider(slider => slider
                .setLimits(12, 24, 1)
                .setValue(this.plugin.settings.terminalFontSize)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.terminalFontSize = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(body)
            .setName('Background Opacity')
            .setDesc('Workbench panel opacity.')
            .addSlider(slider => slider
                .setLimits(0.5, 1.0, 0.05)
                .setValue(this.plugin.settings.terminalOpacity)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.terminalOpacity = value;
                    await this.persistSettings();
                    this.display();
                }));

        const sample = body.createDiv({ cls: 'baizer-settings-sample-line' });
        sample.createEl('strong', { text: 'Preview' });
        sample.createSpan({ text: this.plugin.settings.terminalTheme + ' / ' + this.plugin.settings.terminalFontSize + 'px / ' + Math.round(this.plugin.settings.terminalOpacity * 100) + '%' });
    }

    private renderCaptureSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('WeChat Inbox Path')
            .setDesc('The file to monitor for new WeChat links.')
            .addText(text => text
                .setPlaceholder('Inbox.md')
                .setValue(this.plugin.settings.wechatInboxPath)
                .onChange(async (value: string) => {
                    this.plugin.settings.wechatInboxPath = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('WeChat Storage Path')
            .setDesc('The folder to store saved articles.')
            .addText(text => text
                .setPlaceholder('Clippings')
                .setValue(this.plugin.settings.wechatStoragePath)
                .onChange(async (value: string) => {
                    this.plugin.settings.wechatStoragePath = value;
                    await this.persistSettings();
                }));
        const mobileSchemeTemplate = 'obsidian://baizer-clip?text=<encoded-share-text>';
        new Setting(containerEl)
            .setName('Mobile WeChat Capture')
            .setDesc('Use this URL scheme from iOS Shortcuts or Android automation. Fallback command: Baizer: Save URL from clipboard.')
            .addButton(btn => btn
                .setButtonText('Copy URL Scheme')
                .onClick(async () => {
                    await globalThis.navigator?.clipboard?.writeText?.(mobileSchemeTemplate);
                    new Notice('Baizer mobile capture URL scheme copied.');
                }));
    }

    private renderKnowledgeSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        panel.createDiv({ cls: 'baizer-settings-panel-header' })
            .createEl('h4', { text: 'Knowledge Compile', cls: 'baizer-settings-panel-title' });
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        new Setting(body)
            .setName('Source Folders')
            .setDesc('Folders to watch, one per line.')
            .setClass('baizer-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Clippings\nReading Notes')
                .setValue((this.plugin.settings.knowledgeSourceFolders || []).join('\n'))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeSourceFolders = value
                        .split('\n')
                        .map(entry => entry.trim())
                        .filter(entry => entry.length > 0);
                    await this.persistSettings();
                }));

        new Setting(body)
            .setName('Wiki Output Folder')
            .setDesc('The folder where compiled wiki pages are stored.')
            .addText(text => text
                .setPlaceholder('Knowledge Wiki')
                .setValue(this.plugin.settings.knowledgeWikiFolder)
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeWikiFolder = value || 'Knowledge Wiki';
                    await this.persistSettings();
                }));

        new Setting(body)
            .setName('Auto Compile')
            .setDesc('Compile notes automatically when watched folders change.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeAutoCompile)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeAutoCompile = value;
                    await this.persistSettings();
                }));

        new Setting(body)
            .setName('Max Compile Batch')
            .setDesc('Maximum number of notes to compile in a single batch.')
            .addSlider(slider => slider
                .setLimits(1, 200, 1)
                .setValue(this.plugin.settings.knowledgeMaxCompileBatch)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.knowledgeMaxCompileBatch = value;
                    await this.persistSettings();
                }));

        const ontologyStatusEl = containerEl.createDiv({
            cls: 'baizer-settings-inline-note',
            text: 'Ontology status: loading...',
        });
        void this.refreshOntologyStatus(ontologyStatusEl);

        const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
        this.createActionButton(actions, 'Open ontology', async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.openOntologyFile) {
                new Notice('Knowledge runtime is not available.');
                return;
            }
            await runtime.openOntologyFile();
            await this.refreshOntologyStatus(ontologyStatusEl);
        });
        this.createActionButton(actions, 'Discover', async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.discoverOntology) {
                new Notice('Knowledge runtime is not available.');
                return;
            }
            const path = await runtime.discoverOntology();
            new Notice(path ? 'Ontology schema created: ' + path : 'Ontology schema was not created.');
            await this.refreshOntologyStatus(ontologyStatusEl);
        }, 'accent');
        this.createActionButton(actions, 'Preview', async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.discoverOntologyPreview) {
                new Notice('Knowledge runtime is not available.');
                return;
            }
            const preview = await runtime.discoverOntologyPreview();
            if (preview.content) console.log('[Baizer] Ontology preview:\n', preview.content);
            new Notice(preview.message);
        });
        this.createActionButton(actions, 'Mark stale pending', async () => {
            const runtime = (this.plugin as any).knowledgeRuntime;
            if (!runtime?.markOntologyStaleFilesPending) {
                new Notice('Knowledge runtime is not available.');
                return;
            }
            const count = await runtime.markOntologyStaleFilesPending();
            new Notice('Marked ' + count + ' stale notes pending.');
            await this.refreshOntologyStatus(ontologyStatusEl);
        });

        const advanced = containerEl.createEl('details', { cls: 'baizer-settings-advanced' });
        advanced.createEl('summary', { text: 'Ontology advanced settings' });
        const advancedBody = advanced.createDiv({ cls: 'baizer-settings-advanced-body' });

        new Setting(advancedBody)
            .setName('Enable Ontology Schema')
            .setDesc('Use Knowledge Wiki/_ontology.md to add stable categories and entity extraction to future compiles.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeOntologyEnabled !== false)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeOntologyEnabled = value;
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName('Ontology Update Mode')
            .setDesc('Manual never discovers automatically. Suggest reports readiness without writing. Auto creates a missing schema when thresholds are met.')
            .addDropdown(drop => drop
                .addOption('manual', 'Manual')
                .addOption('suggest', 'Suggest (recommended)')
                .addOption('auto', 'Auto create when missing')
                .setValue(this.plugin.settings.knowledgeOntologyUpdateMode || 'suggest')
                .onChange(async (value: OntologyUpdateMode) => {
                    this.plugin.settings.knowledgeOntologyUpdateMode = value;
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName('Minimum Articles')
            .setDesc('Minimum compiled wiki articles required before ontology discovery can run.')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinArticles ?? 10))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinArticles = clampInteger(value, 1, 500, 10);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName('Minimum Topic Frequency')
            .setDesc('A topic must appear this many times before it can influence ontology discovery.')
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinTopicFrequency ?? 3))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinTopicFrequency = clampInteger(value, 1, 100, 3);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName('Minimum Concept Frequency')
            .setDesc('A concept must appear this many times before it can influence ontology discovery.')
            .addText(text => text
                .setPlaceholder('2')
                .setValue(String(this.plugin.settings.knowledgeOntologyMinConceptFrequency ?? 2))
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeOntologyMinConceptFrequency = clampInteger(value, 1, 100, 2);
                    await this.persistSettings();
                }));

        new Setting(advancedBody)
            .setName('Auto Recompile Stale Articles')
            .setDesc('Automatically recompile affected notes after ontology changes. Keep off if you want to review stale notes first.')
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
            statusEl.textContent = 'Ontology status: Knowledge runtime is not available.';
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
            const parts = [
                `Ontology status: ${status.kind}`,
                `path: ${status.path}`,
            ];
            if (readiness) parts.push(`discovery: ${readiness.kind}`);
            if (counts) parts.push(`stale notes: ${counts.stale}`);
            statusEl.textContent = parts.join(' | ');
        } catch (e: any) {
            statusEl.textContent = `Ontology status unavailable: ${e.message}`;
        }
    }

    private renderPluginSkillsSection(containerEl: HTMLElement): void {
        const panel = containerEl.createDiv({ cls: 'baizer-settings-panel' });
        panel.createDiv({ cls: 'baizer-settings-panel-header' })
            .createEl('h4', { text: 'Generation', cls: 'baizer-settings-panel-title' });
        const body = panel.createDiv({ cls: 'baizer-settings-panel-body' });

        new Setting(body)
            .setName('Auto-generate plugin skills')
            .setDesc('Generate AI skills for installed plugins on startup.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGeneratePluginSkills)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.autoGeneratePluginSkills = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(body)
            .setName('Excluded plugins')
            .setDesc('Plugin IDs to exclude from skill generation, comma-separated.')
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
        autoItem.createEl('strong', { text: 'Startup scan' });
        autoItem.createSpan({ text: this.plugin.settings.autoGeneratePluginSkills ? 'Enabled' : 'Off' });
        const excludeItem = list.createEl('li');
        excludeItem.createEl('strong', { text: 'Excluded plugins' });
        excludeItem.createSpan({ text: String(this.plugin.settings.pluginSkillExcludeList.length) });
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
        contentEl.createEl('h2', { text: this.titleText });
        contentEl.createEl('p', { text: this.message });

        const actions = contentEl.createDiv({ cls: 'baizer-memory-confirm-actions' });
        const cancel = actions.createEl('button', {
            text: 'Cancel',
            cls: 'baizer-settings-action is-default',
            attr: { type: 'button' },
        });
        cancel.addEventListener('click', () => this.close());

        const confirm = actions.createEl('button', {
            text: 'Confirm',
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
        contentEl.createEl('h3', { text: 'Add OpenAI Compatible Provider' });

        let labelValue = '';
        let baseUrlValue = '';

        new Setting(contentEl)
            .setName('Provider Name')
            .setDesc('Display name (for example: SiliconFlow, Groq, Ollama)')
            .addText(text => text
                .setPlaceholder('My Provider')
                .onChange((value: string) => {
                    labelValue = value;
                }));

        new Setting(contentEl)
            .setName('Base URL')
            .setDesc('API endpoint URL')
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1')
                .onChange((value: string) => {
                    baseUrlValue = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Add')
                .setCta()
                .onClick(() => {
                    if (!labelValue.trim()) {
                        new Notice('Please enter a provider name');
                        return;
                    }
                    if (!baseUrlValue.trim()) {
                        new Notice('Please enter a base URL');
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
