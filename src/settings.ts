import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Modal, TextComponent } from 'obsidian';
import { IPlugin, DEFAULT_SETTINGS, ProviderConfig, BUILTIN_PROVIDER_KEYS } from './mcp/types';
import { ModelOption } from './models/interfaces';

export class SettingTab extends PluginSettingTab {
    plugin: IPlugin;
    private renderToken: number = 0;

    constructor(app: App, plugin: IPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** 获取当前激活 provider 的配置 */
    private getActiveConfig(): ProviderConfig | undefined {
        const s = this.plugin.settings;
        return s.providers[s.activeProvider];
    }

    /** 动态加载 model 列表到下拉框 */
    private async loadDynamicModelOptions(
        dropdown: DropdownComponent,
        token: number,
        forceRefresh: boolean = false
    ) {
        const config = this.getActiveConfig();
        const currentModel = config?.model || '';

        dropdown.selectEl.empty();
        dropdown.addOption('__loading__', `Loading models...`);
        dropdown.setValue('__loading__');
        dropdown.setDisabled(true);

        try {
            const models = await this.plugin.modelService.getAvailableModels(forceRefresh);
            if (token !== this.renderToken) return;

            dropdown.selectEl.empty();

            const options: ModelOption[] = models.length > 0
                ? models
                : [{ value: currentModel, label: `${currentModel} (Current)` }];

            options.forEach(option => {
                dropdown.addOption(option.value, option.label);
            });

            if (currentModel && !options.some(option => option.value === currentModel)) {
                dropdown.addOption(currentModel, `${currentModel} (Current)`);
            }

            dropdown.setValue(currentModel || options[0]?.value || '');
            dropdown.setDisabled(false);
        } catch (error: any) {
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

        // Header
        containerEl.createEl('h2', { text: 'Obsidian Shell Configuration' });
        const desc = containerEl.createEl('p', { cls: 'setting-item-description' });
        desc.setText('Powered by multiple AI providers. Acting as your Vault OS.');

        // ============================================================
        // 1. 🔑 API Configuration
        // ============================================================
        containerEl.createEl('h3', { text: '🔑 API Configuration', cls: 'ocli-settings-header' });

        const settings = this.plugin.settings;
        const activeConfig = this.getActiveConfig();

        // Provider 选择
        new Setting(containerEl)
            .setName('AI Provider')
            .setDesc('Select the AI provider to use.')
            .addDropdown(drop => {
                for (const [id, config] of Object.entries(settings.providers)) {
                    const configured = !!config.apiKey;
                    drop.addOption(id, configured ? config.label : `${config.label} ⚠️`);
                }
                drop.setValue(settings.activeProvider);
                drop.onChange(async (value: string) => {
                    await this.plugin.modelService.switchProvider(value, () => this.plugin.saveSettings());
                    this.display();
                });
            });

        // 当前 provider 的配置项
        if (activeConfig) {
            new Setting(containerEl)
                .setName('API Key')
                .setDesc(`Enter your ${activeConfig.label} API key.`)
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(activeConfig.apiKey)
                    .onChange(async (value) => {
                        activeConfig.apiKey = value;
                        await this.plugin.saveSettings();
                    }));

            // Gemini 不需要 Base URL
            if (activeConfig.type === 'openai-compatible') {
                new Setting(containerEl)
                    .setName('Base URL')
                    .setDesc('API Base URL.')
                    .addText(text => text
                        .setPlaceholder('https://api.openai.com/v1')
                        .setValue(activeConfig.baseUrl)
                        .onChange(async (value) => {
                            activeConfig.baseUrl = value;
                            await this.plugin.saveSettings();
                        }));
            }

            // 所有 provider 统一动态 model 下拉
            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose the model (loaded dynamically from API).')
                .addDropdown(drop => {
                    drop.addOption(activeConfig.model, `${activeConfig.model} (Current)`);
                    drop.setValue(activeConfig.model);

                    void this.loadDynamicModelOptions(drop, token);

                    drop.onChange(async (value) => {
                        if (value === '__loading__' || value === '__failed__') return;
                        await this.plugin.modelService.switchModel(value, () => this.plugin.saveSettings());
                    });
                });
        }

        // 添加/删除 provider 按钮
        const providerActions = new Setting(containerEl);

        providerActions.addButton(btn => btn
            .setButtonText('+ Add Provider')
            .onClick(() => {
                new AddProviderModal(this.app, async (label, baseUrl) => {
                    const key = 'custom-' + Date.now();
                    settings.providers[key] = {
                        type: 'openai-compatible',
                        label,
                        apiKey: '',
                        baseUrl,
                        model: ''
                    };
                    settings.activeProvider = key;
                    await this.plugin.saveSettings();
                    this.plugin.modelService.updateSettings(settings);
                    this.display();
                }).open();
            }));

        // 当前 provider 是自定义的才显示删除按钮
        const isBuiltin = BUILTIN_PROVIDER_KEYS.includes(settings.activeProvider);
        if (!isBuiltin && activeConfig) {
            providerActions.addButton(btn => btn
                .setButtonText(`Delete "${activeConfig.label}"`)
                .setWarning()
                .onClick(async () => {
                    delete settings.providers[settings.activeProvider];
                    settings.activeProvider = 'gemini';
                    await this.plugin.saveSettings();
                    this.plugin.modelService.updateSettings(settings);
                    this.display();
                    new Notice('Provider deleted');
                }));
        }

        new Setting(containerEl)
            .addButton(btn => btn
                .setButtonText('Test Connection')
                .onClick(async () => {
                    try {
                        const label = activeConfig?.label || 'AI';
                        new Notice(`Testing connection to ${label}...`);
                        this.plugin.modelService.updateSettings(this.plugin.settings);
                        const success = await this.plugin.modelService.checkAvailability();
                        if (success) {
                            new Notice('✅ Connection successful!');
                        } else {
                            new Notice('❌ Connection failed. Check API key and settings.');
                        }
                    } catch (error: any) {
                        new Notice(`❌ Connection failed: ${error.message}`);
                    }
                }));

        new Setting(containerEl)
            .setName('Context Window Limit')
            .setDesc('Limit token usage. Higher values allow reading larger files but cost more.')
            .addSlider(slider => slider
                .setLimits(10000, 1000000, 10000)
                .setValue(this.plugin.settings.contextWindow)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.contextWindow = value;
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // 2. 🛡️ Guardian Behavior
        // ============================================================
        containerEl.createEl('h3', { text: '🛡️ Guardian Behavior', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('Enable Guardian')
            .setDesc('Allow AI to passively analyze text and offer suggestions.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableGuardian)
                .onChange(async (value) => {
                    this.plugin.settings.enableGuardian = value;
                    await this.plugin.saveSettings();
                    // Reload to show/hide sub-settings
                    this.display();
                }));

        if (this.plugin.settings.enableGuardian) {
            new Setting(containerEl)
                .setName('Auto Mode')
                .setDesc('Automatically analyze text after 5 seconds of inactivity.')
                .addToggle(toggle => toggle
                    .setValue(!!this.plugin.settings.guardianAutoMode)
                    .onChange(async (value) => {
                        this.plugin.settings.guardianAutoMode = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Manual Mode Hotkey')
                .setDesc('Configure the hotkey to manually trigger Guardian (Default: Mod+Shift+G).')
                .addButton(btn => btn
                    .setButtonText('Configure Hotkey')
                    .onClick(() => {
                        (this.app as any).setting.openTabById('hotkeys');
                        (this.app as any).setting.activeTab.setQuery('Guardian: Manual Trigger');
                    }));

            new Setting(containerEl)
                .setName('Guardian Sensitivity')
                .setDesc('Low (Manual) <-> High (Copilot Style)')
                .addSlider(slider => slider
                    .setLimits(0, 100, 25)
                    .setValue(this.plugin.settings.guardianSensitivity)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.guardianSensitivity = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('UI Style')
                .setDesc('How suggestions appear in the editor.')
                .addDropdown(drop => drop
                    .addOption('ghost', 'Ghost Text (Inline)')
                    .addOption('gutter', 'Gutter Dot (Subtle)')
                    .addOption('hybrid', 'Hybrid (Both)')
                    .setValue(this.plugin.settings.guardianUIStyle)
                    .onChange(async (value: any) => {
                        this.plugin.settings.guardianUIStyle = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Privacy Mode')
                .setDesc('Anonymize data before sending (Replace names/emails). Reduces accuracy.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.privacyMode)
                    .onChange(async (value) => {
                        this.plugin.settings.privacyMode = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Ignored Folders')
                .setDesc('Path patterns to ignore (one per line). e.g. "Private/"')
                .setClass('ocli-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('Private/\nSecrets/\nTemplates/')
                    .setValue(this.plugin.settings.ignoredFolders)
                    .onChange(async (value) => {
                        this.plugin.settings.ignoredFolders = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // ============================================================
        // 3. ⚡ Permissions & Capabilities
        // ============================================================
        containerEl.createEl('h3', { text: '⚡ Permissions & Capabilities', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('Allow File Creation')
            .setDesc('Let AI create new notes (`/new`).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileCreation)
                .onChange(async (value) => {
                    this.plugin.settings.allowFileCreation = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Allow File Modification')
            .setDesc('Let AI modify notes other than the one you are editing (e.g. Append to Daily Note).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowFileModification)
                .onChange(async (value) => {
                    this.plugin.settings.allowFileModification = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Allow Plugin Control')
            .setDesc('WARNING: Let AI execute commands from OTHER plugins (Dataview, Kanban, etc).')
            .setClass('gemini-danger-setting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowPluginControl)
                .onChange(async (value) => {
                    if (value) new Notice('⚠️ Permission Granted: AI can now control your plugins.');
                    this.plugin.settings.allowPluginControl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Confirm Executions')
            .setDesc('Human-in-the-loop: Always ask for confirmation before writing files or running commands.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.confirmExecutions)
                .onChange(async (value) => {
                    this.plugin.settings.confirmExecutions = value;
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // 4. 🖥️ Terminal Appearance
        // ============================================================
        containerEl.createEl('h3', { text: '🖥️ Terminal Appearance', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('Theme Style')
            .addDropdown(drop => drop
                .addOption('hacker-green', 'Hacker Green')
                .addOption('cyberpunk', 'Cyberpunk Neon')
                .addOption('obsidian-native', 'Obsidian Native')
                .setValue(this.plugin.settings.terminalTheme)
                .onChange(async (value: any) => {
                    this.plugin.settings.terminalTheme = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Font Size')
            .addSlider(slider => slider
                .setLimits(12, 24, 1)
                .setValue(this.plugin.settings.terminalFontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.terminalFontSize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Background Opacity')
            .addSlider(slider => slider
                .setLimits(0.5, 1.0, 0.05)
                .setValue(this.plugin.settings.terminalOpacity)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.terminalOpacity = value;
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // 5. 🧠 System Prompt
        // ============================================================
        containerEl.createEl('h3', { text: '🧠 System Persona', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('Customize System Prompt')
            .setDesc('Override the default AI personality.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.customizePrompt)
                .onChange(async (value) => {
                    this.plugin.settings.customizePrompt = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide textarea
                }));

        if (this.plugin.settings.customizePrompt) {
            new Setting(containerEl)
                .setClass('ocli-full-width-textarea')
                .addTextArea(text => text
                    .setPlaceholder('You are a helpful assistant...')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .addButton(btn => btn
                    .setButtonText('Restore Default Prompt')
                    .onClick(async () => {
                        this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        }

        // ============================================================
        // 6. 📨 WeChat Inbox
        // ============================================================
        containerEl.createEl('h3', { text: '📨 WeChat Inbox', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('WeChat Inbox Path')
            .setDesc('The file to monitor for new WeChat links (e.g., "Inbox.md").')
            .addText(text => text
                .setPlaceholder('Inbox.md')
                .setValue(this.plugin.settings.wechatInboxPath)
                .onChange(async (value) => {
                    this.plugin.settings.wechatInboxPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('WeChat Storage Path')
            .setDesc('The folder to store saved articles (e.g., "Clippings").')
            .addText(text => text
                .setPlaceholder('Clippings')
                .setValue(this.plugin.settings.wechatStoragePath)
                .onChange(async (value) => {
                    this.plugin.settings.wechatStoragePath = value;
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // 7. 📚 Knowledge Compiler
        // ============================================================
        containerEl.createEl('h3', { text: '📚 Knowledge Compiler', cls: 'ocli-settings-header' });

        const knowledgeDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
        knowledgeDesc.setText('Compile notes from watched folders into a structured knowledge wiki.');

        new Setting(containerEl)
            .setName('Auto Compile')
            .setDesc('Automatically compile notes when they are created or modified in watched folders.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.knowledgeAutoCompile)
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeAutoCompile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Wiki Output Folder')
            .setDesc('The folder where compiled wiki pages are stored.')
            .addText(text => text
                .setPlaceholder('Knowledge Wiki')
                .setValue(this.plugin.settings.knowledgeWikiFolder)
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeWikiFolder = value || 'Knowledge Wiki';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Compile Batch')
            .setDesc('Maximum number of notes to compile in a single batch.')
            .addSlider(slider => slider
                .setLimits(1, 200, 1)
                .setValue(this.plugin.settings.knowledgeMaxCompileBatch)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeMaxCompileBatch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Source Folders')
            .setDesc('Folders to watch for notes to compile (one per line).')
            .setClass('ocli-full-width-textarea')
            .addTextArea(text => text
                .setPlaceholder('Clippings\nReading Notes')
                .setValue((this.plugin.settings.knowledgeSourceFolders || []).join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.knowledgeSourceFolders = value
                        .split('\n')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // 8. 🔌 Plugin Skill Generator
        // ============================================================
        containerEl.createEl('h3', { text: '🔌 Plugin Skill Generator', cls: 'ocli-settings-header' });

        new Setting(containerEl)
            .setName('Auto-generate plugin skills')
            .setDesc('Automatically generate AI skills for installed plugins on startup.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGeneratePluginSkills)
                .onChange(async (value) => {
                    this.plugin.settings.autoGeneratePluginSkills = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Excluded plugins')
            .setDesc('Plugin IDs to exclude from skill generation (comma-separated).')
            .addText(text => text
                .setPlaceholder('plugin-id-1, plugin-id-2')
                .setValue(this.plugin.settings.pluginSkillExcludeList.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.pluginSkillExcludeList = value
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                    await this.plugin.saveSettings();
                }));
    }
}

/** 添加自定义 Provider 的弹窗 */
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
            .setDesc('Display name (e.g., SiliconFlow, Groq, Ollama)')
            .addText(text => text
                .setPlaceholder('My Provider')
                .onChange(v => { labelValue = v; }));

        new Setting(contentEl)
            .setName('Base URL')
            .setDesc('API endpoint URL')
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1')
                .onChange(v => { baseUrlValue = v; }));

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
