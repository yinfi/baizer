import { Plugin, debounce, Notice } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { GeminiAPI } from './src/gemini-api';
import { ToolManager } from './src/mcp/tools';
import { GeminiSettings, DEFAULT_SETTINGS } from './src/mcp/types';
import { GeminiShellSettingTab } from './src/settings';
import { GeminiShellView, VIEW_TYPE_GEMINI_SHELL } from './src/ui/shell-view';
import { guardianGutterExtension, updateGuardianState, GuardianState } from './src/ui/guardian-gutter';
import { ghostTextExtension, showGhostText } from './src/ui/ghost-text';

export default class GeminiShellPlugin extends Plugin {
    settings: GeminiSettings;
    geminiApi: GeminiAPI;
    toolManager: ToolManager;
    private lastGuardianError: number = 0;

    private onEditorChangeDebounced = debounce(this.runGuardianCheck.bind(this), 2000, true);

    async onload() {
        await this.loadSettings();

        this.toolManager = new ToolManager(this.app, this.settings.allowPluginControl);
        this.geminiApi = new GeminiAPI(this.app, this.settings, this.toolManager);

        this.registerView(
            VIEW_TYPE_GEMINI_SHELL,
            (leaf) => new GeminiShellView(leaf, this.geminiApi)
        );

        this.addCommand({
            id: 'open-gemini-shell',
            name: 'Open Shell',
            callback: () => this.activateView(),
            hotkeys: [{ modifiers: ["Mod"], key: "j" }]
        });

        this.addSettingTab(new GeminiShellSettingTab(this.app, this));

        this.registerEditorExtension([
            guardianGutterExtension(),
            ghostTextExtension()
        ]);

        if (this.settings.enableGuardian) {
            this.registerEvent(
                this.app.workspace.on('editor-change', this.onEditorChangeDebounced)
            );
        }
    }

    async activateView() {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_SHELL);

        if (leaves.length > 0) {
            leaves[0].detach();
        } else {
            const leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: VIEW_TYPE_GEMINI_SHELL, active: true });
            workspace.revealLeaf(leaf!);
        }
    }

    async runGuardianCheck(editor: any, info: any) {
        if (!this.settings.enableGuardian) return;

        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const lineNumber = cursor.line + 1;
        const view = (editor as any).cm as EditorView;

        if (!view || !line.trim() || line.trim().length < 3) return;

        updateGuardianState(view, lineNumber, GuardianState.Thinking);

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
                    updateGuardianState(view, lineNumber, GuardianState.HasSuggestion);

                    const typeNames: Record<string, string> = {
                        task: '任务', link: '链接', tag: '标签',
                        code: '代码', quote: '引用', date: '日期'
                    };

                    showGhostText(view, "\n" + result.suggestion, lineNumber, line.length);
                    new Notice(`Guardian: ${typeNames[result.type] || ''}建议 - Tab接受`, 3000);
                } else {
                    updateGuardianState(view, lineNumber, GuardianState.Idle);
                }
            } else {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
            }
        } catch (error: any) {
            console.error('Guardian failed:', error);
            updateGuardianState(view, lineNumber, GuardianState.Idle);

            const now = Date.now();
            if (now - this.lastGuardianError > 300000) {
                if (error?.message?.includes('503') || error?.message?.includes('overloaded')) {
                    new Notice('Guardian: API 暂时过载，已自动禁用。请稍后在设置中重新启用。', 8000);
                    this.settings.enableGuardian = false;
                    await this.saveSettings();
                }
                this.lastGuardianError = now;
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.toolManager = new ToolManager(this.app, this.settings.allowPluginControl);
        this.geminiApi = new GeminiAPI(this.app, this.settings, this.toolManager);
    }
}