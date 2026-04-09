import { Plugin, debounce, Notice, MarkdownView, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ModelService } from './src/services/model-service';
import { ToolManager } from './src/mcp/tools';
import { PluginSettings, DEFAULT_SETTINGS, VIEW_TYPE_SHELL } from './src/mcp/types';
import { SettingTab } from './src/settings';
import { ShellView } from './src/ui/shell-view';
import { guardianGutterExtension, updateGuardianState, GuardianState, guardianModeField } from './src/ui/guardian-gutter';
import { ghostTextExtension, showGhostText } from './src/ui/ghost-text';
import { GuardianModal } from './src/ui/guardian-modal';
import { selectionMenuExtension, resetSelectionMenu, setSelectionMenuState } from './src/ui/selection-menu';
import { KnowledgeRuntime } from './src/knowledge/runtime';

export default class ObsidianCliPlugin extends Plugin {
    settings: PluginSettings;
    modelService: ModelService;
    toolManager: ToolManager;
    knowledgeRuntime: KnowledgeRuntime | null = null;


    // Debounce with trailing edge (default/false) for inactivity trigger
    private onEditorChangeDebounced = debounce(this.runGuardianCheck.bind(this), 3000);

    async onload() {
        await this.loadSettings();
        new Notice('Obsidian Shell: Plugin Loaded (v2)');

        this.toolManager = new ToolManager(this.app, this.settings);
        this.modelService = new ModelService(this.app, this.settings, this.toolManager);
        this.toolManager.setGeminiApi(this.modelService);

        // Initialize Knowledge Runtime
        this.knowledgeRuntime = new KnowledgeRuntime(
            this.app,
            this.settings,
            this.modelService,
            this.toolManager
        );
        await this.knowledgeRuntime.initialize();
        this.knowledgeRuntime.registerCommands(this);
        this.knowledgeRuntime.registerEvents(this);

        this.registerView(
            VIEW_TYPE_SHELL,
            (leaf) => new ShellView(leaf, this.modelService)
        );

        // Add ribbon icon for quick access to Obsidian Shell
        this.addRibbonIcon('terminal', 'Open Obsidian Shell', (evt: MouseEvent) => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-shell',
            name: 'Open Obsidian Shell',
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

        this.registerEditorExtension([
            guardianGutterExtension(),
            ghostTextExtension(),
            selectionMenuExtension(this.app, this.modelService)
        ]);

        // Always register the event; runGuardianCheck will check the setting
        this.registerEvent(
            this.app.workspace.on('editor-change', this.onEditorChangeDebounced)
        );

        // Register Inbox Monitor
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.onFileModify(file);
                }
            })
        );
    }

    onunload() {
        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.cleanup();
        }
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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.toolManager.updateSettings(this.settings);
        this.modelService.updateSettings(this.settings);
        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.updateSettings(this.settings);
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
            const result = await this.toolManager.execute('save_webpage', { url: m.url });

            if (result.success) {
                let finalPath = result.path;
                // Move logic (duplicated for now, could be helper)
                if (this.settings.wechatStoragePath) {
                    const folder = this.settings.wechatStoragePath;
                    if (!await this.app.vault.adapter.exists(folder)) {
                        await this.app.vault.createFolder(folder);
                    }
                    const fileName = finalPath.split('/').pop();
                    const newPath = `${folder}/${fileName}`;
                    let targetPath = newPath;
                    let counter = 1;
                    while (await this.app.vault.adapter.exists(targetPath)) {
                        targetPath = `${folder}/${fileName.replace('.md', '')} (${counter}).md`;
                        counter++;
                    }
                    const fileToMove = this.app.vault.getAbstractFileByPath(finalPath);
                    if (fileToMove) {
                        await this.app.vault.rename(fileToMove, targetPath);
                        finalPath = targetPath;
                    }
                }

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

            const response = await this.modelService.chat(prompt, [], systemPromptOverride);

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
