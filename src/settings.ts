import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import GeminiShellPlugin from '../main';
import { DEFAULT_SETTINGS } from './mcp/types';

export class GeminiShellSettingTab extends PluginSettingTab {
    plugin: GeminiShellPlugin;

    constructor(app: App, plugin: GeminiShellPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Header
        containerEl.createEl('h2', { text: 'Gemini Shell Configuration' });
        const desc = containerEl.createEl('p', { cls: 'setting-item-description' });
        desc.setText('Powered by Google Gemini 2.5. acting as your Vault OS.');

        // ============================================================
        // 1. 🔑 API Configuration
        // ============================================================
        containerEl.createEl('h3', { text: '🔑 API Configuration', cls: 'gemini-settings-header' });

        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Enter your Google Gemini API key.')
            .addText(text => text
                .setPlaceholder('AIzaSy...')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }))
            .addButton(btn => btn
                .setButtonText('Test Connection')
                .onClick(async () => {
                    if (!this.plugin.settings.apiKey) {
                        new Notice('⚠️ Please enter an API key first.');
                        return;
                    }
                    try {
                        new Notice('Testing connection...');
                        await this.plugin.geminiApi.checkAvailability();
                        new Notice('✅ Connection successful!');
                    } catch (error: any) {
                        new Notice(`❌ Connection failed: ${error.message}`);
                    }
                }));

        new Setting(containerEl)
            .setName('Model Selection')
            .setDesc('Choose the Gemini model to use.')
            .addDropdown(drop => drop
                .addOption('gemini-2.5-flash', 'Gemini 2.5 Flash (Fastest)')
                .addOption('gemini-2.5-pro', 'Gemini 2.5 Pro (Reasoning)')
                .addOption('gemini-2.0-flash', 'Gemini 2.0 Flash')
                .addOption('gemini-1.5-pro', 'Gemini 1.5 Pro')
                .setValue(this.plugin.settings.primaryModel)
                .onChange(async (value) => {
                    this.plugin.settings.primaryModel = value;
                    await this.plugin.saveSettings();
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
        containerEl.createEl('h3', { text: '🛡️ Guardian Behavior', cls: 'gemini-settings-header' });

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
                .setName('Trigger Sensitivity')
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
                .setClass('gemini-full-width-textarea')
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
        containerEl.createEl('h3', { text: '⚡ Permissions & Capabilities', cls: 'gemini-settings-header' });

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
        containerEl.createEl('h3', { text: '🖥️ Terminal Appearance', cls: 'gemini-settings-header' });

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
        containerEl.createEl('h3', { text: '🧠 System Persona', cls: 'gemini-settings-header' });

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
                .setClass('gemini-full-width-textarea')
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
    }
}