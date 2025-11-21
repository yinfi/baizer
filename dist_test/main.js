"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const gemini_api_1 = require("./src/gemini-api");
const tools_1 = require("./src/mcp/tools");
const types_1 = require("./src/mcp/types");
const settings_1 = require("./src/settings");
const shell_view_1 = require("./src/ui/shell-view");
const guardian_gutter_1 = require("./src/ui/guardian-gutter");
const ghost_text_1 = require("./src/ui/ghost-text");
class GeminiShellPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.lastGuardianError = 0;
        this.onEditorChangeDebounced = (0, obsidian_1.debounce)(this.runGuardianCheck.bind(this), 2000, true);
    }
    async onload() {
        await this.loadSettings();
        this.toolManager = new tools_1.ToolManager(this.app, this.settings.allowPluginControl);
        this.geminiApi = new gemini_api_1.GeminiAPI(this.app, this.settings, this.toolManager);
        this.registerView(shell_view_1.VIEW_TYPE_GEMINI_SHELL, (leaf) => new shell_view_1.GeminiShellView(leaf, this.geminiApi));
        this.addCommand({
            id: 'open-gemini-shell',
            name: 'Open Shell',
            callback: () => this.activateView(),
            hotkeys: [{ modifiers: ["Mod"], key: "j" }]
        });
        this.addSettingTab(new settings_1.GeminiShellSettingTab(this.app, this));
        this.registerEditorExtension([
            (0, guardian_gutter_1.guardianGutterExtension)(),
            (0, ghost_text_1.ghostTextExtension)()
        ]);
        if (this.settings.enableGuardian) {
            this.registerEvent(this.app.workspace.on('editor-change', this.onEditorChangeDebounced));
        }
    }
    async activateView() {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(shell_view_1.VIEW_TYPE_GEMINI_SHELL);
        if (leaves.length > 0) {
            leaves[0].detach();
        }
        else {
            const leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: shell_view_1.VIEW_TYPE_GEMINI_SHELL, active: true });
            workspace.revealLeaf(leaf);
        }
    }
    async runGuardianCheck(editor, info) {
        if (!this.settings.enableGuardian)
            return;
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const lineNumber = cursor.line + 1;
        const view = editor.cm;
        if (!view || !line.trim() || line.trim().length < 3)
            return;
        (0, guardian_gutter_1.updateGuardianState)(view, lineNumber, guardian_gutter_1.GuardianState.Thinking);
        try {
            const prompt = `分析文本并提供改进建议（只返回JSON）：
"${line}"

场景判断：
1. 待办事项 → {"type":"task","suggestion":"- [ ] 文本"}
2. 链接 → {"type":"link","suggestion":"[描述](URL)"}
3. 标签 → {"type":"tag","suggestion":"文本 #标签"}
4. 代码 → {"type":"code","suggestion":"\`代码\`"}
5. 引用 → {"type":"quote","suggestion":"> 引用"}
6. 日期 → {"type":"date","suggestion":"YYYY-MM-DD"}
7. 无需建议 → {"type":"none"}`;
            const response = await this.geminiApi.chat(prompt, "Guardian", "");
            const jsonMatch = response.trim().match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                if (result.type !== 'none' && result.suggestion) {
                    (0, guardian_gutter_1.updateGuardianState)(view, lineNumber, guardian_gutter_1.GuardianState.HasSuggestion);
                    const typeNames = {
                        task: '任务', link: '链接', tag: '标签',
                        code: '代码', quote: '引用', date: '日期'
                    };
                    (0, ghost_text_1.showGhostText)(view, "\n" + result.suggestion, lineNumber, line.length);
                    new obsidian_1.Notice(`Guardian: ${typeNames[result.type] || ''}建议 - Tab接受`, 3000);
                }
                else {
                    (0, guardian_gutter_1.updateGuardianState)(view, lineNumber, guardian_gutter_1.GuardianState.Idle);
                }
            }
            else {
                (0, guardian_gutter_1.updateGuardianState)(view, lineNumber, guardian_gutter_1.GuardianState.Idle);
            }
        }
        catch (error) {
            console.error('Guardian failed:', error);
            (0, guardian_gutter_1.updateGuardianState)(view, lineNumber, guardian_gutter_1.GuardianState.Idle);
            const now = Date.now();
            if (now - this.lastGuardianError > 300000) {
                if (error?.message?.includes('503') || error?.message?.includes('overloaded')) {
                    new obsidian_1.Notice('Guardian: API 暂时过载，已自动禁用。请稍后在设置中重新启用。', 8000);
                    this.settings.enableGuardian = false;
                    await this.saveSettings();
                }
                this.lastGuardianError = now;
            }
        }
    }
    async loadSettings() {
        this.settings = Object.assign({}, types_1.DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
        this.toolManager = new tools_1.ToolManager(this.app, this.settings.allowPluginControl);
        this.geminiApi = new gemini_api_1.GeminiAPI(this.app, this.settings, this.toolManager);
    }
}
exports.default = GeminiShellPlugin;
