import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Modal, TextComponent } from 'obsidian';
import { BUILTIN_PROVIDER_KEYS, DEFAULT_SETTINGS, IPlugin, PluginSettings, ProviderConfig } from './mcp/types';
import { ModelOption } from './models/interfaces';

export type SettingsSectionId =
    | 'connection'
    | 'runtime'
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
        id: 'guardian',
        title: 'Guardian',
        description: 'Inline assistance, trigger behavior, and privacy controls.',
        keywords: ['guardian', 'auto mode', 'manual mode', 'privacy', 'ignored folders', 'sensitivity'],
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

        const root = containerEl.createDiv({ cls: 'ocli-settings-page' });
        this.renderHeader(root);
        this.renderSummary(root);

        const layout = root.createDiv({ cls: 'ocli-settings-layout' });
        this.renderSidebar(layout.createDiv({ cls: 'ocli-settings-sidebar' }), visibleSections);
        this.renderMain(layout.createDiv({ cls: 'ocli-settings-main' }), visibleSections, token);
    }

    private renderHeader(containerEl: HTMLElement): void {
        const hero = containerEl.createDiv({ cls: 'ocli-settings-hero' });
        hero.createEl('h2', { text: 'Obsidian Shell Configuration', cls: 'ocli-settings-title' });
        hero.createEl('p', {
            text: 'A cleaner control center for provider setup, runtime behavior, and plugin capabilities.',
            cls: 'ocli-settings-subtitle',
        });

        const searchRow = hero.createDiv({ cls: 'ocli-settings-search-row' });
        const searchInput = searchRow.createEl('input', {
            cls: 'ocli-settings-search',
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

    private renderSummary(containerEl: HTMLElement): void {
        const summary = containerEl.createDiv({ cls: 'ocli-settings-summary' });
        const activeConfig = this.getActiveConfig();
        const statuses = getSettingsSectionStatuses(this.plugin.settings);
        const providerBadge = statuses.connection;

        this.renderSummaryCard(
            summary,
            'Active Provider',
            activeConfig?.label || 'Not configured',
            providerBadge?.label || 'Ready',
            providerBadge?.tone || 'success'
        );

        this.renderSummaryCard(
            summary,
            'Current Model',
            activeConfig?.model || 'Not selected',
            activeConfig?.type === 'gemini' ? 'Gemini API' : 'OpenAI-compatible',
            'accent'
        );

        const safetyTone: SettingsBadgeTone = statuses.permissions?.tone || (this.plugin.settings.confirmExecutions ? 'success' : 'warning');
        const safetyValue = this.plugin.settings.allowPluginControl
            ? 'Plugin control enabled'
            : this.plugin.settings.confirmExecutions
                ? 'Confirm before writes'
                : 'Direct execution';
        const safetyDetail = this.plugin.settings.allowPluginControl ? 'High-risk actions unlocked' : 'Approval flow active';
        this.renderSummaryCard(summary, 'Safety', safetyValue, safetyDetail, safetyTone);
    }

    private renderSummaryCard(
        containerEl: HTMLElement,
        label: string,
        value: string,
        detail: string,
        tone: SettingsBadgeTone
    ): void {
        const card = containerEl.createDiv({ cls: 'ocli-settings-summary-card' });
        card.createDiv({ cls: 'ocli-settings-summary-label', text: label });
        card.createDiv({ cls: 'ocli-settings-summary-value', text: value });
        const footer = card.createDiv({ cls: 'ocli-settings-summary-footer' });
        footer.createSpan({ cls: `ocli-settings-badge is-${tone}`, text: detail });
    }

    private renderSidebar(containerEl: HTMLElement, visibleSections: SettingsSectionId[]): void {
        const nav = containerEl.createDiv({ cls: 'ocli-settings-nav' });
        const navHeader = nav.createDiv({ cls: 'ocli-settings-nav-header' });
        navHeader.createDiv({ cls: 'ocli-settings-nav-title', text: 'Sections' });
        navHeader.createDiv({ cls: 'ocli-settings-nav-kicker', text: 'Jump between groups' });

        if (!visibleSections.length) {
            nav.createDiv({ cls: 'ocli-settings-empty-nav', text: 'No matching sections.' });
            return;
        }

        const list = nav.createDiv({ cls: 'ocli-settings-nav-list' });
        const statuses = getSettingsSectionStatuses(this.plugin.settings);

        visibleSections.forEach(sectionId => {
            const meta = getSectionMeta(sectionId);
            const button = list.createEl('button', {
                cls: `ocli-settings-nav-item${sectionId === this.activeSectionId ? ' is-active' : ''}`,
                attr: { type: 'button' },
            }) as HTMLButtonElement;

            const row = button.createDiv({ cls: 'ocli-settings-nav-row' });
            const copy = row.createDiv({ cls: 'ocli-settings-nav-copy' });
            copy.createDiv({ cls: 'ocli-settings-nav-label', text: meta.title });

            const status = statuses[sectionId];
            if (status) {
                row.createSpan({ cls: `ocli-settings-badge is-${status.tone}`, text: status.label });
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
            const empty = containerEl.createDiv({ cls: 'ocli-settings-empty-state' });
            empty.createEl('h3', { text: 'No matching settings' });
            empty.createEl('p', { text: 'Try searching by provider, prompt, permissions, or knowledge.' });
            return;
        }

        const query = normalizeSearchQuery(this.searchQuery);
        const sectionsToRender = query ? visibleSections : [this.activeSectionId];

        sectionsToRender.forEach(sectionId => {
            const meta = getSectionMeta(sectionId);
            const status = getSettingsSectionStatuses(this.plugin.settings)[sectionId];
            const card = containerEl.createDiv({ cls: 'ocli-settings-section-card' });
            const header = card.createDiv({ cls: 'ocli-settings-section-header' });
            const headerCopy = header.createDiv({ cls: 'ocli-settings-section-copy' });
            headerCopy.createEl(query ? 'h3' : 'h2', { text: meta.title, cls: 'ocli-settings-section-title' });
            headerCopy.createEl('p', { text: meta.description, cls: 'ocli-settings-section-description' });
            if (status) {
                header.createSpan({ cls: `ocli-settings-badge is-${status.tone}`, text: status.label });
            }

            const content = card.createDiv({ cls: 'ocli-settings-section-content' });
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

    private renderConnectionSection(containerEl: HTMLElement, token: number): void {
        const settings = this.plugin.settings;
        const activeConfig = this.getActiveConfig();

        if (!activeConfig) {
            containerEl.createDiv({ cls: 'ocli-settings-inline-note is-warning', text: 'No active provider found.' });
            return;
        }

        const badgeStatus = !activeConfig.apiKey.trim()
            ? `No API key configured for ${activeConfig.label}.`
            : `Using ${activeConfig.type === 'gemini' ? 'Gemini API' : 'OpenAI-compatible API'}.`;
        containerEl.createDiv({
            cls: `ocli-settings-inline-note ${activeConfig.apiKey.trim() ? 'is-success' : 'is-warning'}`,
            text: badgeStatus,
        });

        new Setting(containerEl)
            .setName('AI Provider')
            .setDesc('Select the provider configuration to use.')
            .addDropdown(drop => {
                Object.entries(settings.providers).forEach(([id, config]) => {
                    const configured = !!config.apiKey.trim();
                    drop.addOption(id, configured ? config.label : `${config.label} !`);
                });
                drop.setValue(settings.activeProvider);
                drop.onChange(async (value: string) => {
                    this.resetConnectionTestStatus();
                    await this.plugin.modelService.switchProvider(value, () => this.persistSettings());
                    this.revealApiKey = false;
                    this.activeSectionId = 'connection';
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('API Key')
            .setDesc(`Enter your ${activeConfig.label} API key.`)
            .addText(text => this.configureSecretInput(text, activeConfig))
            .addButton(btn => btn
                .setButtonText(this.revealApiKey ? 'Hide' : 'Reveal')
                .onClick(() => {
                    this.revealApiKey = !this.revealApiKey;
                    this.display();
                }))
            .addButton(btn => btn
                .setButtonText('Clear')
                .onClick(async () => {
                    activeConfig.apiKey = '';
                    this.revealApiKey = false;
                    this.resetConnectionTestStatus();
                    await this.persistSettings();
                    this.display();
                }));

        if (this.plugin.modelService.getProviderCapabilities().supportsCustomBaseUrl) {
            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('Override the API endpoint for compatible providers.')
                .addText(text => text
                    .setPlaceholder('https://api.openai.com/v1')
                    .setValue(activeConfig.baseUrl)
                    .onChange(async (value: string) => {
                        activeConfig.baseUrl = value;
                        this.resetConnectionTestStatus();
                        await this.persistSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('Model')
            .setDesc('Choose the model loaded from the active provider.')
            .addDropdown(drop => {
                if (activeConfig.model) {
                    drop.addOption(activeConfig.model, `${activeConfig.model} (Current)`);
                } else {
                    drop.addOption('__empty__', 'Select a model');
                }

                drop.setValue(activeConfig.model || '__empty__');
                void this.loadDynamicModelOptions(drop, token);

                drop.onChange(async (value: string) => {
                    if (value === '__loading__' || value === '__failed__' || value === '__empty__') return;
                    this.resetConnectionTestStatus();
                    await this.plugin.modelService.switchModel(value, () => this.persistSettings());
                    this.display();
                });
            });

        const actions = containerEl.createDiv({ cls: 'ocli-settings-actions' });
        this.createActionButton(actions, '+ Add Provider', async () => {
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

        const deletion = getProviderDeletionState(settings);
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

        const connectionStatus = getConnectionTestStatusPresentation(this.connectionTestStatus);
        if (!deletion.canDelete) {
            containerEl.createDiv({ cls: 'ocli-settings-inline-hint', text: deletion.helperText });
        }
        if (connectionStatus) {
            containerEl.createDiv({
                cls: `ocli-settings-inline-note is-${connectionStatus.tone}`,
                text: connectionStatus.label,
            });
        }
    }

    private configureSecretInput(text: TextComponent, config: ProviderConfig): TextComponent {
        text.setPlaceholder('sk-...');
        text.setValue(config.apiKey);
        text.onChange(async (value: string) => {
            config.apiKey = value;
            this.resetConnectionTestStatus();
            await this.persistSettings();
        });

        if ((text as any).inputEl) {
            const inputEl = (text as any).inputEl as HTMLInputElement;
            inputEl.type = this.revealApiKey ? 'text' : 'password';
            inputEl.autocomplete = 'off';
            inputEl.spellcheck = false;
        }

        return text;
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
                .setClass('ocli-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('You are a helpful assistant...')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.persistSettings();
                    }));

            const actions = containerEl.createDiv({ cls: 'ocli-settings-actions' });
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
            .setName('Privacy Mode')
            .setDesc('Anonymize names and emails before sending. Reduces accuracy.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.privacyMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.privacyMode = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Ignored Folders')
            .setDesc('Path patterns to ignore, one per line.')
            .setClass('ocli-full-width-textarea')
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
            .setName('Allow File Creation')
            .setDesc('Let AI create new notes (`/new`).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileCreation)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.allowFileCreation = value;
                    await this.persistSettings();
                }));

        new Setting(containerEl)
            .setName('Allow File Modification')
            .setDesc('Let AI modify notes other than the one you are editing.')
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
            .setClass('ocli-full-width-textarea')
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
            cls: `ocli-settings-action is-${variant}`,
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
