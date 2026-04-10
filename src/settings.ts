import { App, PluginSettingTab, Setting, Notice, Modal, DropdownComponent } from 'obsidian';
import { IPlugin, DEFAULT_SETTINGS } from './mcp/types';
import { ModelOption } from './models/interfaces';

export class SettingTab extends PluginSettingTab {
    plugin: IPlugin;
    private renderToken: number = 0;

    constructor(app: App, plugin: IPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private getCurrentModelByProvider(): string {
        switch (this.plugin.settings.provider) {
            case 'gemini':
                return this.plugin.settings.primaryModel;
            case 'openai':
                return this.plugin.settings.openaiModel;
            case 'deepseek':
                return this.plugin.settings.deepseekModel;
            case 'qwen':
                return this.plugin.settings.qwenModel;
            default:
                return '';
        }
    }

    private async loadDynamicModelOptions(
        dropdown: DropdownComponent,
        provider: 'gemini' | 'openai' | 'deepseek' | 'qwen',
        token: number,
        forceRefresh: boolean = false
    ) {
        dropdown.selectEl.empty();
        dropdown.addOption('__loading__', `Loading ${provider} models...`);
        dropdown.setValue('__loading__');
        dropdown.setDisabled(true);

        const currentModel = this.getCurrentModelByProvider();

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

        new Setting(containerEl)
            .setName('AI Provider')
            .setDesc('Select the AI provider to use.')
            .addDropdown(drop => drop
                .addOption('gemini', 'Google Gemini')
                .addOption('openai', 'OpenAI Compatible')
                .addOption('deepseek', 'DeepSeek')
                .addOption('qwen', 'Qwen (Tongyi Qianwen)')
                .setValue(this.plugin.settings.provider)
                .onChange(async (value: any) => {
                    this.plugin.settings.provider = value;
                    await this.plugin.saveSettings();
                    this.plugin.modelService.reloadProvider();
                    this.display(); // Refresh to show/hide relevant settings
                }));

        // --- Gemini Settings ---
        if (this.plugin.settings.provider === 'gemini') {
            new Setting(containerEl)
                .setName('Gemini API Key')
                .setDesc('Enter your Google Gemini API key.')
                .addText(text => text
                    .setPlaceholder('AIzaSy...')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose the Gemini model (loaded dynamically from API).')
                .addDropdown(drop => {
                    drop.addOption(this.plugin.settings.primaryModel, `${this.plugin.settings.primaryModel} (Current)`);
                    drop.setValue(this.plugin.settings.primaryModel);

                    void this.loadDynamicModelOptions(drop, 'gemini', token);

                    drop.onChange(async (value) => {
                        if (value === '__loading__' || value === '__failed__') return;
                        this.plugin.settings.primaryModel = value;
                        await this.plugin.saveSettings();
                    });
                });
        }

        // --- OpenAI Settings ---
        if (this.plugin.settings.provider === 'openai') {
            new Setting(containerEl)
                .setName('OpenAI API Key')
                .setDesc('Enter your OpenAI API key.')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.openaiApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiApiKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('API Base URL (optional).')
                .addText(text => text
                    .setPlaceholder('https://api.openai.com/v1')
                    .setValue(this.plugin.settings.openaiBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiBaseUrl = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Model Name')
                .setDesc('Enter the model ID (e.g., gpt-4o, gpt-3.5-turbo).')
                .addText(text => text
                    .setPlaceholder('gpt-4o')
                    .setValue(this.plugin.settings.openaiModel)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiModel = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // --- DeepSeek Settings ---
        if (this.plugin.settings.provider === 'deepseek') {
            new Setting(containerEl)
                .setName('DeepSeek API Key')
                .setDesc('Enter your DeepSeek API key.')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.deepseekApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.deepseekApiKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('DeepSeek API Base URL.')
                .addText(text => text
                    .setPlaceholder('https://api.deepseek.com')
                    .setValue(this.plugin.settings.deepseekBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.deepseekBaseUrl = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Model Name')
                .setDesc('e.g., deepseek-chat, deepseek-coder')
                .addText(text => text
                    .setPlaceholder('deepseek-chat')
                    .setValue(this.plugin.settings.deepseekModel)
                    .onChange(async (value) => {
                        this.plugin.settings.deepseekModel = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // --- Qwen Settings ---
        if (this.plugin.settings.provider === 'qwen') {
            new Setting(containerEl)
                .setName('Qwen API Key')
                .setDesc('Enter your DashScope API key.')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.qwenApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.qwenApiKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('DashScope Compatible API URL.')
                .addText(text => text
                    .setPlaceholder('https://dashscope.aliyuncs.com/compatible-mode/v1')
                    .setValue(this.plugin.settings.qwenBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.qwenBaseUrl = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Model Name')
                .setDesc('e.g., qwen-turbo, qwen-plus')
                .addText(text => text
                    .setPlaceholder('qwen-turbo')
                    .setValue(this.plugin.settings.qwenModel)
                    .onChange(async (value) => {
                        this.plugin.settings.qwenModel = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .addButton(btn => btn
                .setButtonText('Test Connection')
                .onClick(async () => {
                    try {
                        new Notice(`Testing connection to ${this.plugin.settings.provider}...`);
                        // Force reload to ensure latest settings are used
                        this.plugin.modelService.reloadProvider();
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
                .setLimits(10000, 1000000, 10000) // 10k to 1M
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
        // 8. 🔌 MCP Servers
        // ============================================================
        containerEl.createEl('h3', { text: '🔌 MCP Servers', cls: 'ocli-settings-header' });

        const mcpDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
        mcpDesc.setText('Connect to external tools via Model Context Protocol (MCP).');

        // List existing servers
        const servers = this.plugin.settings.mcpServers || {};
        for (const [name, config] of Object.entries(servers)) {
            new Setting(containerEl)
                .setName(name)
                .setDesc(`${config.command} ${config.args.join(' ')}`)
                .addButton(btn => btn
                    .setButtonText('Edit')
                    .setIcon('pencil')
                    .onClick(() => {
                        this.removeMcpServer(name);
                        this.addMcpServerModal(name, config);
                    }))
                .addButton(btn => btn
                    .setButtonText('Remove')
                    .setIcon('trash')
                    .setWarning()
                    .onClick(async () => {
                        await this.removeMcpServer(name);
                    }));
        }

        new Setting(containerEl)
            .addButton(btn => btn
                .setButtonText('Add MCP Server')
                .setCta()
                .onClick(() => {
                    this.addMcpServerModal();
                }));
    }

    async removeMcpServer(name: string) {
        const settings = this.plugin.settings;
        if (settings.mcpServers && settings.mcpServers[name]) {
            delete settings.mcpServers[name];
            await this.plugin.saveSettings();
            this.display();
        }
    }

    addMcpServerModal(existingName?: string, existingConfig?: { command: string, args: string[] }) {
        class McpModal extends Modal {
            name: string;
            command: string;
            args: string;
            onSubmit: (name: string, command: string, args: string[]) => void;

            constructor(app: App, onSubmit: (name: string, command: string, args: string[]) => void, name = '', command = '', args = '') {
                super(app);
                this.onSubmit = onSubmit;
                this.name = name;
                this.command = command;
                this.args = args;
            }

            onOpen() {
                const { contentEl } = this;
                contentEl.createEl('h2', { text: existingName ? 'Edit MCP Server' : 'Add MCP Server' });

                new Setting(contentEl)
                    .setName('Server Name')
                    .setDesc('Unique identifier (e.g., "weather")')
                    .addText(text => text
                        .setValue(this.name)
                        .onChange(value => this.name = value));

                new Setting(contentEl)
                    .setName('Command')
                    .setDesc('Executable (e.g., "node", "python", "uv")')
                    .addText(text => text
                        .setValue(this.command)
                        .onChange(value => this.command = value));

                new Setting(contentEl)
                    .setName('Arguments')
                    .setDesc('Space-separated arguments (e.g., "path/to/server.js")')
                    .addText(text => text
                        .setValue(this.args)
                        .onChange(value => this.args = value));

                new Setting(contentEl)
                    .addButton(btn => btn
                        .setButtonText('Save')
                        .setCta()
                        .onClick(() => {
                            if (this.name && this.command) {
                                const argsList = this.args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(a => a.replace(/^"|"$/g, '')) || [];
                                this.onSubmit(this.name, this.command, argsList);
                                this.close();
                            } else {
                                new Notice('Name and Command are required.');
                            }
                        }));
            }

            onClose() {
                const { contentEl } = this;
                contentEl.empty();
            }
        }

        new McpModal(this.app, async (name, command, args) => {
            if (!this.plugin.settings.mcpServers) this.plugin.settings.mcpServers = {};
            this.plugin.settings.mcpServers[name] = { command, args };
            await this.plugin.saveSettings();
            this.display();
        }, existingName || '', existingConfig?.command || '', existingConfig?.args.join(' ') || '').open();
    }
}
