import { Plugin, debounce, Notice, MarkdownView, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ModelService } from './src/services/model-service';
import { PluginSettings, DEFAULT_SETTINGS, VIEW_TYPE_SHELL, DEFAULT_PROVIDERS, ProviderConfig, PLUGIN_NAME } from './src/mcp/types';
import { SettingTab } from './src/settings';
import { ShellView } from './src/ui/shell-view';
import { guardianGutterExtension, updateGuardianState, GuardianState, guardianModeField } from './src/ui/guardian-gutter';
import { ghostTextExtension, showGhostText } from './src/ui/ghost-text';
import { GuardianModal } from './src/ui/guardian-modal';
import { requestGuardianResponse } from './src/ui/guardian-request';
import { selectionMenuExtension } from './src/ui/selection-menu';
import { KnowledgeRuntime } from './src/knowledge/runtime';
import { ToolRegistry } from './src/skills/tool-registry';
import { SkillRegistry } from './src/skills/skill-registry';
import { registerVaultTools } from './src/skills/builtin/vault-ops';
import { executor as webSearchSkillExecutor, registerTools as registerWebSearchTools } from './src/skills/builtin/web-search/executor';
import { createExecutor as createWebClipperSkillExecutor, registerTools as registerWebClipperTools } from './src/skills/builtin/web-clipper/executor';
import { createExecutor as createKnowledgeSkillExecutor, registerTools as registerKnowledgeTools } from './src/skills/builtin/knowledge/executor';
import { executor as pluginCtrlSkillExecutor, registerTools as registerPluginCtrlTools } from './src/skills/builtin/plugin-ctrl/executor';
import { executor as jsonCanvasSkillExecutor, registerTools as registerJsonCanvasTools } from './src/skills/builtin/json-canvas/executor';
import { executor as obsidianBasesSkillExecutor, registerTools as registerObsidianBasesTools } from './src/skills/builtin/obsidian-bases/executor';
// SKILL.md 通过 esbuild text loader 导入
import webSearchSkillMd from './src/skills/builtin/web-search/SKILL.md';
import webClipperSkillMd from './src/skills/builtin/web-clipper/SKILL.md';
import knowledgeSkillMd from './src/skills/builtin/knowledge/SKILL.md';
import pluginCtrlSkillMd from './src/skills/builtin/plugin-ctrl/SKILL.md';
import obsidianMarkdownSkillMd from './src/skills/builtin/obsidian-markdown/SKILL.md';
import jsonCanvasSkillMd from './src/skills/builtin/json-canvas/SKILL.md';
import obsidianBasesSkillMd from './src/skills/builtin/obsidian-bases/SKILL.md';
import { PluginWatcher } from './src/skills/builtin/plugin-ctrl/plugin-watcher';
import { PluginSkillGenerator } from './src/skills/builtin/plugin-ctrl/skill-generator';
import { InboxAutosaveCoordinator } from './src/services/inbox-autosave';
import { ObsidianContextService } from './src/services/obsidian-context-service';
import { USER_SKILLS_DIR } from './src/skills/skill-files';

export default class BaizerPlugin extends Plugin {
    settings: PluginSettings;
    modelService: ModelService;
    knowledgeRuntime: KnowledgeRuntime | null = null;
    toolRegistry: ToolRegistry;
    skillRegistry: SkillRegistry;
    private editorExtensionsRegistered = false;
    private pluginWatcher: PluginWatcher | null = null;
    private inboxAutosave: InboxAutosaveCoordinator | null = null;


    // Debounce with trailing edge (default/false) for inactivity trigger
    private onEditorChangeDebounced = debounce(this.runGuardianCheck.bind(this), 3000);

    async onload() {
        await this.loadSettings();
        new Notice(`${PLUGIN_NAME}: Plugin loaded`);

        // Initialize Skill Architecture
        this.toolRegistry = new ToolRegistry(this.app, this.settings);
        this.skillRegistry = new SkillRegistry(this.toolRegistry);
        this.modelService = new ModelService(this.app, this.settings, this.toolRegistry, this.skillRegistry);
        this.inboxAutosave = new InboxAutosaveCoordinator({
            app: this.app,
            getInboxPath: () => this.settings.wechatInboxPath,
            saveUrl: async (url: string) => this.toolRegistry.execute('save_webpage', { url }),
            notify: (message: string) => new Notice(message),
        });

        // 注册原子工具
        registerVaultTools(this.toolRegistry);
        registerWebSearchTools(this.toolRegistry);
        registerWebClipperTools(this.toolRegistry, this.modelService);
        registerPluginCtrlTools(this.toolRegistry);
        registerJsonCanvasTools(this.toolRegistry);
        registerObsidianBasesTools(this.toolRegistry);

        // 注册 Skill（从 SKILL.md，executor 为 noop — instructions 注入模式）
        this.skillRegistry.registerBuiltinFromMd(webSearchSkillMd, webSearchSkillExecutor);
        this.skillRegistry.registerBuiltinFromMd(webClipperSkillMd, createWebClipperSkillExecutor(this.modelService));
        this.skillRegistry.registerBuiltinFromMd(obsidianMarkdownSkillMd, { execute: async () => ({ ok: true }) });
        this.skillRegistry.registerBuiltinFromMd(jsonCanvasSkillMd, jsonCanvasSkillExecutor);
        this.skillRegistry.registerBuiltinFromMd(obsidianBasesSkillMd, obsidianBasesSkillExecutor);
        this.skillRegistry.registerBuiltinFromMd(pluginCtrlSkillMd, pluginCtrlSkillExecutor,
            (settings) => settings.allowPluginControl,
        );

        console.log(`[Baizer] SkillRegistry initialized: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // Initialize Knowledge Runtime
        this.knowledgeRuntime = new KnowledgeRuntime(
            this.app,
            this.settings,
            this.modelService,
        );
        await this.knowledgeRuntime.initialize();
        this.knowledgeRuntime.registerCommands(this);
        this.knowledgeRuntime.registerEvents(this);

        // Knowledge 工具需要 executor，在 runtime 初始化后注册
        registerKnowledgeTools(
            this.toolRegistry,
            this.knowledgeRuntime.getQueryExecutor(),
            this.knowledgeRuntime.getFileBackExecutor(),
        );
        this.skillRegistry.registerBuiltinFromMd(knowledgeSkillMd, createKnowledgeSkillExecutor(this.toolRegistry));

        console.log(`[Baizer] Final: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // 加载用户自定义 Skill
        await this.skillRegistry.loadUserSkills(USER_SKILLS_DIR, this.app);

        console.log(`[Baizer] Skill system ready: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // 防止 hot reload 时重复注册
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SHELL);
        try {
            this.registerView(
                VIEW_TYPE_SHELL,
                (leaf) => new ShellView(leaf, this.modelService, this)
            );
        } catch (e) {
            // hot reload 时 view type 可能已注册，忽略
            console.log('[Baizer] View type already registered, skipping.');
        }

        // Add ribbon icon for quick access to Baizer
        this.addRibbonIcon('terminal', `Open ${PLUGIN_NAME}`, (evt: MouseEvent) => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-shell',
            name: `Open ${PLUGIN_NAME}`,
            callback: () => this.activateView(),
            hotkeys: [{ modifiers: ["Mod"], key: "j" }]
        });

        // Manual Guardian Trigger
        this.addCommand({
            id: 'guardian-manual-trigger',
            name: 'Guardian: Manual Trigger',
            callback: () => this.activateGuardianModal(),
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }]
        });

        this.addSettingTab(new SettingTab(this.app, this));

        if (!this.editorExtensionsRegistered) {
            this.registerEditorExtension([
                guardianGutterExtension(),
                ghostTextExtension(),
                selectionMenuExtension(this.app, this.modelService)
            ]);
            this.editorExtensionsRegistered = true;
        }

        // Always register the event; runGuardianCheck will check the setting
        this.registerEvent(
            this.app.workspace.on('editor-change', this.onEditorChangeDebounced)
        );

        // Register Inbox Monitor
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    void this.inboxAutosave?.handleFileModify(file);
                }
            })
        );

        // 启动插件 Skill 自动生成（后台异步，不阻塞）
        const skillGenerator = new PluginSkillGenerator(
            this.app, this.modelService, this.settings,
        );
        this.pluginWatcher = new PluginWatcher(
            this.app, this.skillRegistry, skillGenerator, this.settings,
        );
        this.pluginWatcher.start();
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SHELL);
        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.cleanup();
        }
        this.pluginWatcher?.stop();
        this.modelService.shutdown();
    }

    async activateView() {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_SHELL);

        if (leaves.length > 0) {
            leaves[0].detach();
        } else {
            const leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: VIEW_TYPE_SHELL, active: true });
            workspace.revealLeaf(leaf!);
        }
    }

    activateGuardianModal() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            new Notice('Please open a Markdown file first.');
            return;
        }

        new GuardianModal(this.app, (instruction: string) => {
            this.runGuardianCheck(view.editor, null, instruction);
        }).open();
    }

    async loadSettings() {
        const raw = await this.loadData() || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

        // 数据迁移：旧扁平格式 → 新 providers map
        if (!raw.providers && (raw as any).provider) {
            const old = raw as any;
            this.settings.activeProvider = old.provider || 'gemini';
            this.settings.providers = {
                'gemini': {
                    type: 'gemini' as const,
                    label: 'Google Gemini',
                    apiKey: old.apiKey || '',
                    baseUrl: '',
                    model: old.primaryModel || 'gemini-2.5-flash'
                },
                'openai': {
                    type: 'openai-compatible' as const,
                    label: 'OpenAI',
                    apiKey: old.openaiApiKey || '',
                    baseUrl: old.openaiBaseUrl || 'https://api.openai.com/v1',
                    model: old.openaiModel || 'gpt-4o'
                },
                'deepseek': {
                    type: 'openai-compatible' as const,
                    label: 'DeepSeek',
                    apiKey: old.deepseekApiKey || '',
                    baseUrl: old.deepseekBaseUrl || 'https://api.deepseek.com',
                    model: old.deepseekModel || 'deepseek-chat'
                },
                'qwen': {
                    type: 'openai-compatible' as const,
                    label: 'Qwen',
                    apiKey: old.qwenApiKey || '',
                    baseUrl: old.qwenBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    model: old.qwenModel || 'qwen-turbo'
                }
            };
            // 持久化迁移结果
            await this.saveData(this.settings);
        }

        // 确保 providers 中包含所有默认 provider（防止新增 provider 时旧数据缺失）
        if (this.settings.providers) {
            for (const [id, defaultConfig] of Object.entries(DEFAULT_PROVIDERS)) {
                if (!this.settings.providers[id]) {
                    this.settings.providers[id] = { ...defaultConfig };
                }
            }
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        await this.modelService.updateSettings(this.settings);
        this.toolRegistry.updateContext(this.settings);
        if (this.knowledgeRuntime) {
            await this.knowledgeRuntime.updateSettings(this.settings);
        }
    }

    async onFileModify(file: TFile) {
        if (file.path !== this.settings.wechatInboxPath) return;

        const content = await this.app.vault.read(file);

        // Robust Regex: Matches Wikilinks, Markdown Links, OR Raw URLs
        // Group 1: Wikilink [[...]]
        // Group 2: Markdown Link [text](url)
        // Group 3: Raw URL http...
        const regex = /(\[\[.*?\]\])|(\[.*?\]\(.*?\))|(https?:\/\/[^\s\)]+)/g;

        let newContent = content;
        let modified = false;

        const rawUrlMatches = [];
        for (const m of content.matchAll(regex)) {
            if (!m[1] && !m[2] && m[3]) {
                rawUrlMatches.push({
                    url: m[3],
                    index: m.index,
                    length: m[0].length
                });
            }
        }

        if (rawUrlMatches.length === 0) return;

        // We process in reverse order so indices remain valid
        rawUrlMatches.sort((a, b) => b.index! - a.index!);

        for (const m of rawUrlMatches) {
            new Notice(`📥 Auto-saving: ${m.url}`);
            const result = await this.toolRegistry.execute('save_webpage', { url: m.url });

            if (result.success) {
                const finalPath = result.path;
                const linkText = `[[${finalPath}|Saved: ${finalPath.split('/').pop()?.replace('.md', '')}]]`;

                // Apply replacement at specific index
                newContent = newContent.substring(0, m.index) + linkText + newContent.substring(m.index! + m.length);
                modified = true;
            } else {
                new Notice(`❌ Failed to save ${m.url}: ${result.error}`);
            }
        }

        if (modified) {
            await this.app.vault.modify(file, newContent);
        }
    }

    async runGuardianCheck(editor: any, info: any, manualInstruction?: string) {
        if (!this.settings.enableGuardian) return;

        // Auto Mode Check: If not manual instruction and auto mode is disabled, skip.
        if (!manualInstruction && !this.settings.guardianAutoMode) return;

        const cursor = editor.getCursor();
        const lineNumber = cursor.line + 1;
        const view = (editor as any).cm as EditorView;

        if (!view) return;

        // Check Global Guardian Mode (Paused/Active)
        const isGuardianEnabled = view.state.field(guardianModeField);
        if (!manualInstruction && !isGuardianEnabled) return;

        const line = editor.getLine(cursor.line);
        // For auto mode, ensure line has content. For manual mode, we might process empty lines too.
        if (!manualInstruction && (!line.trim() || line.trim().length < 3)) return;

        // Get context: Last 10 lines (approx) to provide better context
        const startLine = Math.max(0, cursor.line - 10);
        const contextLines = [];
        for (let i = startLine; i <= cursor.line; i++) {
            contextLines.push(editor.getLine(i));
        }
        const contextText = contextLines.join('\n');

        updateGuardianState(view, lineNumber, GuardianState.Thinking);

        try {
            let prompt = "";
            let systemPromptOverride = "";

            if (manualInstruction) {
                prompt = `User Instruction: "${manualInstruction}"
Context:
"${contextText}"

Please execute the instruction.
- If it's an edit, return JSON: {"type":"edit", "suggestion":"REPLACED_TEXT"}
- If it's a question, return JSON: {"type":"answer", "suggestion":"ANSWER_TEXT"}
- If no action needed, return JSON: {"type":"none"}
- Ensure the suggestion uses proper Markdown formatting.`;
                systemPromptOverride = "You are a helpful assistant. Return ONLY JSON.";
            } else {
                // Generalized Co-writer Prompt
                prompt = `Role: ${this.settings.systemPrompt || "You are a helpful AI assistant."}
Task: You are a helpful co-writer. Complete the user's thought or continue the text naturally.

Context:
${contextText}

Instructions:
1. Suggest a continuation that flows naturally based on the context.
2. Do NOT repeat the input text.
3. If the text is complete or you have no good suggestion, return "type": "none".
4. Output JSON: {"type": "completion", "suggestion": "MARKDOWN_FORMATTED_TEXT"}
5. Ensure the suggestion uses proper Markdown formatting (bold, italic, lists, code blocks) where appropriate.`;
            }

            const obsidianContext = await new ObsidianContextService(this.app).collect();
            const response = await requestGuardianResponse(this.modelService, {
                prompt,
                systemPromptOverride,
                obsidianContext,
                userProfile: this.modelService.getUserProfile(),
            });

            // 提取第一个完整 JSON 对象（平衡括号计数，避免贪婪 regex 抓到多余内容）
            let data: any;
            const braceStart = response.indexOf('{');
            if (braceStart === -1) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            let depth = 0;
            let inString = false;
            let escape = false;
            let jsonEnd = -1;
            for (let i = braceStart; i < response.length; i++) {
                const ch = response[i];
                if (escape) { escape = false; continue; }
                if (ch === '\\' && inString) { escape = true; continue; }
                if (ch === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
            }
            if (jsonEnd === -1) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            try {
                data = JSON.parse(response.substring(braceStart, jsonEnd + 1));
            } catch {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

            // For edits/suggestions
            if (data.suggestion && typeof data.suggestion === 'string') {
                // Re-validate position as document might have changed
                const currentLineCount = view.state.doc.lines;
                if (lineNumber > currentLineCount) {
                    console.warn("Guardian: Line number out of bounds after generation.");
                    updateGuardianState(view, lineNumber, GuardianState.Idle);
                    return;
                }

                const currentLine = view.state.doc.line(lineNumber);
                const safeCh = Math.min(cursor.ch, currentLine.length);

                console.log("Guardian: Showing ghost text", { suggestion: data.suggestion, line: lineNumber, ch: safeCh });
                showGhostText(view, data.suggestion, lineNumber, safeCh);
                updateGuardianState(view, lineNumber, GuardianState.HasSuggestion);
            } else {
                // console.warn("Guardian: Invalid suggestion data", data);
                updateGuardianState(view, lineNumber, GuardianState.Idle);
            }

            if (data.type === 'none') {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

        } catch (error: any) {
            console.error("Guardian Error:", error);
            updateGuardianState(view, lineNumber, GuardianState.Error);
        }
    }
}
