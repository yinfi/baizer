import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Modal, TextComponent } from 'obsidian';
import { BUILTIN_PROVIDER_KEYS, DEFAULT_SETTINGS, IPlugin, MEMORY_DIR, PLUGIN_NAME, PluginSettings, ProviderConfig, VaultWriteScope } from './mcp/types';
import { ModelOption } from './models/interfaces';

export type SettingsSectionId =
    | 'connection'
    | 'runtime'
    | 'memory'
    | 'guardian'
    | 'permissions'
    | 'appearance'
    | 'capture'
    | 'knowledge'
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

interface SettingsSectionMeta {
    id: SettingsSectionId;
    title: string;
    description: string;
    keywords: string[];
}

const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
    {
        id: 'connection',
        title: 'Connection',
        description: 'Provider, API key, model selection, and connection checks.',
        keywords: ['provider', 'api key', 'base url', 'model', 'connection', 'openai', 'gemini', 'deepseek', 'qwen'],
    },
    {
        id: 'runtime',
        title: 'Runtime',
        description: 'Context window and system prompt behavior.',
        keywords: ['runtime', 'context window', 'token', 'system prompt', 'persona', 'prompt'],
    },
    {
        id: 'memory',
        title: 'Memory',
        description: 'Local Hindsight memory, recall, retention, and deletion.',
        keywords: ['memory', 'hindsight', 'recall', 'forget', 'profile', 'privacy', 'observation'],
    },
    {
        id: 'guardian',
        title: 'Guardian',
        description: 'Inline assistance, trigger behavior, and ignored folders.',
        keywords: ['guardian', 'auto mode', 'manual mode', 'ignored folders', 'sensitivity'],
    },
    {
        id: 'permissions',
        title: 'Permissions',
        description: 'File, plugin, and execution safeguards.',
        keywords: ['permissions', 'file creation', 'file modification', 'plugin control', 'confirm'],
    },
    {
        id: 'appearance',
        title: 'Appearance',
        description: 'Terminal theme and visual density.',
        keywords: ['appearance', 'theme', 'font', 'opacity', 'terminal'],
    },
    {
        id: 'capture',
        title: 'Capture',
        description: 'WeChat inbox monitoring and storage paths.',
        keywords: ['wechat', 'capture', 'inbox', 'storage', 'clippings'],
    },
    {
        id: 'knowledge',
        title: 'Knowledge',
        description: 'Knowledge compiler sources, output, and batching.',
        keywords: ['knowledge', 'wiki', 'compile', 'source folders', 'batch'],
    },
    {
        id: 'plugin-skills',
        title: 'Plugin Skills',
        description: 'Auto-generated plugin workflows and exclusions.',
        keywords: ['plugin', 'skills', 'generator', 'exclude', 'startup'],
    },
];

function normalizeSearchQuery(query: string): string {
    return query.trim().toLowerCase();
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

    if (settings.allowPluginControl || !settings.confirmExecutions) {
        statuses.permissions = { label: 'Risk', tone: 'danger' };
    }

    if (!settings.autoGeneratePluginSkills) {
        statuses['plugin-skills'] = { label: 'Off', tone: 'muted' };
    }

    return statuses;
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

    if (BUILTIN_PROVIDER_KEYS.includes(settings.activeProvider)) {
        return {
            canDelete: false,
            helperText: 'Built-in providers cannot be deleted.',
            label: 'Delete Provider',
        };
    }

    return {
        canDelete: true,
        helperText: 'Remove the selected custom provider from this workspace.',
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
    private activeSectionId: SettingsSectionId = 'connection';
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

    private ensureActiveSection(visibleSections: SettingsSectionId[]): void {
        if (!visibleSections.length) return;
        if (!visibleSections.includes(this.activeSectionId)) {
            this.activeSectionId = visibleSections[0];
        }
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
        containerEl.empty();

        const visibleSections = this.getVisibleSections();
        this.ensureActiveSection(visibleSections);

        const root = containerEl.createDiv({ cls: 'baizer-settings-page' });
        this.renderHeader(root);
        this.renderSidebar(root, visibleSections);
        this.renderMain(root.createDiv({ cls: 'baizer-settings-main' }), visibleSections, token);
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

    private renderSidebar(containerEl: HTMLElement, visibleSections: SettingsSectionId[]): void {
        const nav = containerEl.createDiv({ cls: 'baizer-settings-nav' });
        const navHeader = nav.createDiv({ cls: 'baizer-settings-nav-header' });
        navHeader.createDiv({ cls: 'baizer-settings-nav-title', text: 'Sections' });
        navHeader.createDiv({ cls: 'baizer-settings-nav-kicker', text: 'Switch between groups' });

        if (!visibleSections.length) {
            nav.createDiv({ cls: 'baizer-settings-empty-nav', text: 'No matching sections.' });
            return;
        }

        const list = nav.createDiv({ cls: 'baizer-settings-nav-list' });
        const statuses = getSettingsSectionStatuses(this.plugin.settings);

        visibleSections.forEach(sectionId => {
            const meta = getSectionMeta(sectionId);
            const button = list.createEl('button', {
                cls: `baizer-settings-nav-item${sectionId === this.activeSectionId ? ' is-active' : ''}`,
                attr: { type: 'button' },
            }) as HTMLButtonElement;

            const row = button.createDiv({ cls: 'baizer-settings-nav-row' });
            const copy = row.createDiv({ cls: 'baizer-settings-nav-copy' });
            copy.createDiv({ cls: 'baizer-settings-nav-label', text: meta.title });

            const status = statuses[sectionId];
            if (status) {
                row.createSpan({ cls: `baizer-settings-badge is-${status.tone}`, text: status.label });
            }

            button.addEventListener('click', () => {
                this.activeSectionId = sectionId;
                if (this.searchQuery.trim()) {
                    this.searchQuery = '';
                }
                this.display();
            });
        });
    }

    private renderMain(containerEl: HTMLElement, visibleSections: SettingsSectionId[], token: number): void {
        if (!visibleSections.length) {
            const empty = containerEl.createDiv({ cls: 'baizer-settings-empty-state' });
            empty.createEl('h3', { text: 'No matching settings' });
            empty.createEl('p', { text: 'Try searching by provider, prompt, permissions, or knowledge.' });
            return;
        }

        const query = normalizeSearchQuery(this.searchQuery);
        const sectionsToRender = query ? visibleSections : [this.activeSectionId];

        sectionsToRender.forEach(sectionId => {
            const meta = getSectionMeta(sectionId);
            const status = getSettingsSectionStatuses(this.plugin.settings)[sectionId];
            const card = containerEl.createDiv({ cls: 'baizer-settings-section-card' });
            const header = card.createDiv({ cls: 'baizer-settings-section-header' });
            const headerCopy = header.createDiv({ cls: 'baizer-settings-section-copy' });
            headerCopy.createEl(query ? 'h3' : 'h2', { text: meta.title, cls: 'baizer-settings-section-title' });
            headerCopy.createEl('p', { text: meta.description, cls: 'baizer-settings-section-description' });
            if (status) {
                header.createSpan({ cls: `baizer-settings-badge is-${status.tone}`, text: status.label });
            }

            const content = card.createDiv({ cls: 'baizer-settings-section-content' });
            this.renderSectionContent(sectionId, content, token);
        });
    }

    private renderSectionContent(sectionId: SettingsSectionId, containerEl: HTMLElement, token: number): void {
        switch (sectionId) {
            case 'connection':
                this.renderConnectionSection(containerEl, token);
                return;
            case 'runtime':
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

        this.renderMemoryStats(containerEl);
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

    private renderMemoryStats(containerEl: HTMLElement): void {
        const stats = this.memoryView?.stats;
        const row = containerEl.createDiv({ cls: 'baizer-memory-stats' });
        this.createMemoryStat(row, 'Total', stats?.total ?? 0);
        this.createMemoryStat(row, 'Facts', stats?.world ?? 0);
        this.createMemoryStat(row, 'Experiences', stats?.experience ?? 0);
        this.createMemoryStat(row, 'Observations', stats?.observation ?? 0);
    }

    private createMemoryStat(parent: HTMLElement, label: string, value: number): void {
        const item = parent.createDiv({ cls: 'baizer-memory-stat' });
        item.createDiv({ cls: 'baizer-memory-stat-value', text: String(value) });
        item.createDiv({ cls: 'baizer-memory-stat-label', text: label });
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
        copy.createDiv({ cls: 'baizer-settings-workspace-title', text: 'Danger Zone' });
        copy.createDiv({ cls: 'baizer-settings-workspace-subtitle', text: 'Clear all remembered Hindsight memory.' });
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

        const workspace = containerEl.createDiv({ cls: 'baizer-settings-workspace' });
        const listPanel = workspace.createDiv({ cls: 'baizer-settings-workspace-panel is-list' });
        const detailPanel = workspace.createDiv({ cls: 'baizer-settings-workspace-panel is-detail' });

        const listHeader = listPanel.createDiv({ cls: 'baizer-settings-workspace-header' });
        const listCopy = listHeader.createDiv({ cls: 'baizer-settings-workspace-copy' });
        listCopy.createDiv({ cls: 'baizer-settings-workspace-title', text: 'Providers' });
        listCopy.createDiv({ cls: 'baizer-settings-workspace-subtitle', text: 'Select a provider' });
        this.createActionButton(listHeader, '+ Add', async () => {
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
                await this.persistSettings();
                this.revealApiKey = false;
                this.activeSectionId = 'connection';
                this.display();
            }).open();
        }, 'accent');

        const providerList = listPanel.createDiv({ cls: 'baizer-settings-provider-list' });
        Object.keys(settings.providers).forEach(providerId => {
            const meta = getProviderCardMeta(settings, providerId);
            const card = providerList.createDiv({
                cls: `baizer-settings-provider-card${meta.isActive ? ' is-active' : ''}`,
            });
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-pressed', meta.isActive ? 'true' : 'false');

            const cardHeader = card.createDiv({ cls: 'baizer-settings-provider-card-header' });
            const cardIdentity = cardHeader.createDiv({ cls: 'baizer-settings-provider-card-identity' });
            cardIdentity.createDiv({ cls: 'baizer-settings-provider-card-title', text: meta.label });
            cardIdentity.createSpan({
                cls: 'baizer-settings-provider-card-icon is-protocol',
                text: meta.protocolGlyph,
                attr: { 'aria-label': meta.protocolLabel, title: meta.protocolLabel },
            });

            const cardStatus = cardHeader.createDiv({ cls: 'baizer-settings-provider-card-statuses' });
            if (meta.isActive) {
                cardStatus.createSpan({
                    cls: 'baizer-settings-provider-card-icon is-active',
                    text: '✓',
                    attr: { 'aria-label': 'Active provider', title: 'Active provider' },
                });
            }
            cardStatus.createSpan({
                cls: `baizer-settings-provider-card-icon is-${meta.statusTone}`,
                text: meta.statusGlyph,
                attr: { 'aria-label': meta.statusLabel, title: meta.statusLabel },
            });

            card.createDiv({ cls: 'baizer-settings-provider-card-meta', text: meta.compactMeta });

            const activateProvider = async () => {
                if (providerId === settings.activeProvider) return;
                this.resetConnectionTestStatus();
                await this.plugin.modelService.switchProvider(providerId, () => this.persistSettings());
                this.revealApiKey = false;
                this.activeSectionId = 'connection';
                this.display();
            };

            card.addEventListener('click', () => {
                void activateProvider();
            });
            card.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void activateProvider();
                }
            });
        });

        const listSummary = getProviderListSummary(settings);
        listPanel.createDiv({ cls: 'baizer-settings-provider-summary', text: listSummary.label });

        const detailHeader = detailPanel.createDiv({ cls: 'baizer-settings-workspace-header is-detail' });
        const detailCopy = detailHeader.createDiv({ cls: 'baizer-settings-workspace-copy' });
        detailCopy.createDiv({ cls: 'baizer-settings-workspace-title', text: 'Provider Detail' });
        detailCopy.createDiv({ cls: 'baizer-settings-workspace-subtitle', text: 'Fill the selected provider configuration.' });

        const detailBody = detailPanel.createDiv({ cls: 'baizer-settings-detail-body' });
        this.renderConnectionField(detailBody, 'Provider Name', (valueEl) => {
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: 'text',
                    value: activeConfig.label,
                    'aria-label': 'Provider name',
                },
            }) as HTMLInputElement;
            input.addEventListener('change', async () => {
                activeConfig.label = input.value.trim() || activeConfig.label;
                await this.persistSettings();
                this.display();
            });
        });

        this.renderConnectionField(detailBody, 'Protocol', (valueEl) => {
            const select = valueEl.createEl('select', {
                cls: 'baizer-settings-detail-input',
                attr: { 'aria-label': 'Provider protocol' },
            }) as HTMLSelectElement;
            select.createEl('option', { value: 'gemini', text: 'Gemini API' });
            select.createEl('option', { value: 'openai-compatible', text: 'OpenAI-compatible' });
            select.value = activeConfig.type;
            select.addEventListener('change', async () => {
                activeConfig.type = select.value as ProviderConfig['type'];
                if (activeConfig.type === 'gemini') {
                    activeConfig.baseUrl = '';
                }
                this.resetConnectionTestStatus();
                await this.plugin.modelService.updateSettings(this.plugin.settings);
                await this.persistSettings();
                this.display();
            });
        });

        const deletion = getProviderDeletionState(settings);

        this.renderConnectionField(detailBody, 'API Endpoint', (valueEl) => {
            const input = valueEl.createEl('input', {
                cls: 'baizer-settings-detail-input',
                attr: {
                    type: 'text',
                    placeholder: 'https://api.openai.com/v1',
                    value: activeConfig.baseUrl,
                    'aria-label': 'API endpoint',
                    disabled: this.plugin.modelService.getProviderCapabilities().supportsCustomBaseUrl ? undefined : 'true',
                },
            }) as HTMLInputElement;
            if (!this.plugin.modelService.getProviderCapabilities().supportsCustomBaseUrl) {
                input.value = activeConfig.baseUrl || 'Default Gemini endpoint';
            }
            input.addEventListener('change', async () => {
                activeConfig.baseUrl = input.value;
                this.resetConnectionTestStatus();
                await this.persistSettings();
            });
        });

        this.renderConnectionField(detailBody, 'API Key', (valueEl) => {
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
                this.display();
            });
            this.createActionButton(secretActions, 'Clear', async () => {
                activeConfig.apiKey = '';
                this.revealApiKey = false;
                this.resetConnectionTestStatus();
                await this.persistSettings();
                this.display();
            }, 'danger');
        });

        this.renderConnectionField(detailBody, 'Model', (valueEl) => {
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
                await this.plugin.modelService.switchModel(value, () => this.persistSettings());
                this.display();
            });
        });

        const connectionStatus = getConnectionTestStatusPresentation(this.connectionTestStatus)
            || {
                tone: activeConfig.apiKey.trim() ? 'muted' : 'warning',
                label: activeConfig.apiKey.trim()
                    ? 'Run a connection test after updating credentials.'
                    : `No API key configured for ${activeConfig.label}.`,
            };

        this.renderConnectionField(detailBody, 'Connection Status', (valueEl) => {
            valueEl.createDiv({
                cls: `baizer-settings-inline-note is-${connectionStatus.tone} baizer-settings-inline-note-compact`,
                text: connectionStatus.label,
            });
        });

        const actions = detailPanel.createDiv({ cls: 'baizer-settings-actions baizer-settings-detail-actions' });
        this.createActionButton(actions, this.connectionTestStatus.state === 'testing' ? 'Testing...' : 'Test Connection', async () => {
            const label = activeConfig.label || 'AI provider';
            if (!activeConfig.apiKey.trim()) {
                this.connectionTestStatus = {
                    state: 'error',
                    message: `No API key configured for ${label}.`,
                };
                this.display();
                return;
            }

            try {
                this.connectionTestStatus = {
                    state: 'testing',
                    message: `Testing connection to ${label}...`,
                };
                this.display();
                await this.plugin.modelService.updateSettings(this.plugin.settings);
                const success = await this.plugin.modelService.checkAvailability();
                this.connectionTestStatus = success
                    ? { state: 'success', message: `Connection successful for ${label}.` }
                    : { state: 'error', message: 'Connection failed. Check API key, base URL, and model.' };
            } catch (error: any) {
                this.connectionTestStatus = {
                    state: 'error',
                    message: `Connection failed: ${error.message}`,
                };
            }

            this.display();
        }, 'primary', this.connectionTestStatus.state === 'testing');

        this.createActionButton(actions, deletion.label, async () => {
            if (!deletion.canDelete) return;
            delete settings.providers[settings.activeProvider];
            settings.activeProvider = 'gemini';
            this.revealApiKey = false;
            this.resetConnectionTestStatus();
            await this.persistSettings();
            new Notice('Provider deleted');
            this.display();
        }, 'danger', !deletion.canDelete);

        detailPanel.createDiv({ cls: 'baizer-settings-inline-hint', text: deletion.helperText });
        detailPanel.createDiv({
            cls: 'baizer-settings-inline-hint baizer-settings-inline-hint-strong',
            text: 'Available models are loaded from the selected provider API.',
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
        new Setting(containerEl)
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
            new Setting(containerEl)
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

        new Setting(containerEl)
            .setName('Allow File Creation')
            .setDesc('Allow note and file creation after the selected write scope is satisfied.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileCreation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileCreation = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Allow File Modification')
            .setDesc('Allow note and file modification after the selected write scope is satisfied.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileModification)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileModification = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
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

        new Setting(containerEl)
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

    private renderAppearanceSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
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
                }));

        new Setting(containerEl)
            .setName('Font Size')
            .addSlider(slider => slider
                .setLimits(12, 24, 1)
                .setValue(this.plugin.settings.terminalFontSize)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.terminalFontSize = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Background Opacity')
            .addSlider(slider => slider
                .setLimits(0.5, 1.0, 0.05)
                .setValue(this.plugin.settings.terminalOpacity)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.terminalOpacity = value;
                    await this.persistSettings();
                }));
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
    }

    private renderKnowledgeSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Auto Compile')
            .setDesc('Compile notes automatically when watched folders change.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeAutoCompile)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.knowledgeAutoCompile = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Wiki Output Folder')
            .setDesc('The folder where compiled wiki pages are stored.')
            .addText(text => text
                .setPlaceholder('Knowledge Wiki')
                .setValue(this.plugin.settings.knowledgeWikiFolder)
                .onChange(async (value: string) => {
                    this.plugin.settings.knowledgeWikiFolder = value || 'Knowledge Wiki';
                    await this.persistSettings();
                }));

        new Setting(containerEl)
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

        new Setting(containerEl)
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
    }

    private renderPluginSkillsSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Auto-generate plugin skills')
            .setDesc('Generate AI skills for installed plugins on startup.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGeneratePluginSkills)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.autoGeneratePluginSkills = value;
                    await this.persistSettings();
                    this.display();
                }));

        new Setting(containerEl)
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
