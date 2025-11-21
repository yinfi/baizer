import { Plugin, debounce, Notice, MarkdownView } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { GeminiAPI } from './src/gemini-api';
import { ToolManager } from './src/mcp/tools';
import { GeminiSettings, DEFAULT_SETTINGS } from './src/mcp/types';
import { GeminiShellSettingTab } from './src/settings';
import { GeminiShellView, VIEW_TYPE_GEMINI_SHELL } from './src/ui/shell-view';
import { guardianGutterExtension, updateGuardianState, GuardianState, guardianModeField } from './src/ui/guardian-gutter';
import { ghostTextExtension, showGhostText } from './src/ui/ghost-text';
import { GuardianModal } from './src/ui/guardian-modal';

export default class GeminiShellPlugin extends Plugin {
    settings: GeminiSettings;
    geminiApi: GeminiAPI;
    toolManager: ToolManager;
    private lastGuardianError: number = 0;

    // Debounce with trailing edge (default/false) for inactivity trigger
    private onEditorChangeDebounced = debounce(this.runGuardianCheck.bind(this), 5000);

    async onload() {
        await this.loadSettings();
        new Notice('Gemini Shell: Plugin Loaded (v2)');

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

        // Manual Guardian Trigger
        this.addCommand({
            id: 'guardian-manual-trigger',
            name: 'Guardian: Manual Trigger',
            callback: () => this.activateGuardianModal(),
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }]
        });

        this.addSettingTab(new GeminiShellSettingTab(this.app, this));

        this.registerEditorExtension([
            guardianGutterExtension(),
            ghostTextExtension()
        ]);

        // Always register the event; runGuardianCheck will check the setting
        this.registerEvent(
            this.app.workspace.on('editor-change', this.onEditorChangeDebounced)
        );
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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.toolManager = new ToolManager(this.app, this.settings.allowPluginControl);
        this.geminiApi = new GeminiAPI(this.app, this.settings, this.toolManager);
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

            const response = await this.geminiApi.chat(prompt, "Guardian", systemPromptOverride);

            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

            const data = JSON.parse(jsonMatch[0]);

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