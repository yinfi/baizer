import { ItemView, WorkspaceLeaf, MarkdownRenderer } from 'obsidian';
import { GeminiAPI } from '../gemini-api';

export const VIEW_TYPE_GEMINI_SHELL = 'gemini-shell-view';

export class GeminiShellView extends ItemView {
    private api: GeminiAPI;
    private outputContainer: HTMLElement;
    private inputEl: HTMLInputElement;
    private currentSelection: string = "";
    private editor: any = null;

    constructor(leaf: WorkspaceLeaf, api: GeminiAPI) {
        super(leaf);
        this.api = api;
    }

    getViewType() {
        return VIEW_TYPE_GEMINI_SHELL;
    }

    getDisplayText() {
        return 'Gemini Shell';
    }

    getIcon() {
        return 'terminal-square';
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('gemini-shell-view');

        // 1. Header
        const header = contentEl.createDiv({ cls: 'shell-header' });
        header.createSpan({ text: 'GEMINI SHELL' });
        header.createSpan({ text: '● ONLINE', attr: { style: 'color: #00e676;' } });

        // 2. Output Area (Scrollable)
        this.outputContainer = contentEl.createDiv({ cls: 'shell-output-area' });

        // Welcome Message
        this.appendLog('System', 'Kernel initialized.', 'system');

        // 3. Input Area (Fixed at bottom)
        const inputContainer = contentEl.createDiv({ cls: 'shell-input-container' });

        const promptIcon = inputContainer.createSpan({ cls: 'shell-prompt' });
        promptIcon.setText('>_');

        this.inputEl = inputContainer.createEl('input', {
            cls: 'shell-input',
            type: 'text',
            attr: {
                placeholder: 'Ask Gemini...',
                spellcheck: 'false',
                autocomplete: 'off'
            }
        });

        // 4. Action Bar (Compact for sidebar)
        const footer = contentEl.createDiv({ cls: 'shell-footer' });
        // Simplified actions for sidebar
        const createAction = (key: string, label: string) => {
            const item = footer.createDiv({ cls: 'action-item' });
            item.createSpan({ cls: 'key-badge', text: key });
            item.createSpan({ cls: 'action-label', text: label });
        };
        createAction('↵', 'Send');
        createAction('Esc', 'Clear');

        // Event Listeners
        this.inputEl.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (e.isComposing) return;
                const query = this.inputEl.value.trim();
                if (!query) return;

                this.inputEl.value = '';
                await this.processCommand(query);
            }
            if (e.key === 'Escape') {
                this.inputEl.value = '';
            }
        });

        // Focus input on click
        contentEl.addEventListener('click', (e) => {
            // Don't steal focus if user is selecting text in output
            if (window.getSelection()?.toString()) return;
            this.inputEl.focus();
        });
    }

    async processCommand(query: string) {
        this.appendLog('You', query, 'user');

        // ==================== Memory Commands ====================

        // /clear - 清除当前会话
        if (query === '/clear') {
            await this.api.clearSession();
            this.appendLog('System', '✓ 会话已清除，用户画像保留', 'system');
            return;
        }

        // /profile - 查看用户画像
        if (query === '/profile') {
            const profile = this.api.getUserProfile();
            if (!profile) {
                this.appendLog('System', '暂无用户画像数据', 'system');
                return;
            }

            let profileText = '## 用户画像\n\n';
            if (profile.name) profileText += `**姓名**: ${profile.name}\n`;
            if (profile.profession) profileText += `**职业**: ${profile.profession}\n`;
            if (profile.expertise.length > 0) {
                profileText += `**专业领域**: ${profile.expertise.join(', ')}\n`;
            }
            if (profile.preferences.responseStyle) {
                profileText += `**回答风格**: ${profile.preferences.responseStyle}\n`;
            }
            this.appendLog('System', profileText, 'system');
            return;
        }

        let contextStr = '';
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            contextStr = `Current Note: [[${activeFile.path}]]`;
        }

        // Try to get selection from the active editor
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        if (activeLeaf && activeLeaf.view) {
            const editor = (activeLeaf.view as any).editor;
            if (editor) {
                this.editor = editor;
                this.currentSelection = editor.getSelection();
                if (this.currentSelection) {
                    this.appendLog('System', `With selection (${this.currentSelection.length} chars)`, 'system');
                }
            }
        }

        // Loading Indicator
        const loadingId = 'loading-' + Date.now();
        const loadingDiv = this.outputContainer.createDiv({ cls: 'shell-entry system' });
        loadingDiv.id = loadingId;
        loadingDiv.createSpan({ cls: 'shell-loading' });
        loadingDiv.createSpan({ text: 'Thinking...' });
        this.scrollToBottom();

        try {
            const response = await this.api.chat(query, contextStr, this.currentSelection);

            const loader = document.getElementById(loadingId);
            if (loader) loader.remove();

            if (query.startsWith("/edit") && this.editor && this.currentSelection) {
                this.editor.replaceSelection(response);
                this.appendLog('System', 'Text replaced.', 'system');
            } else {
                this.appendLog('Gemini', response, 'ai');
            }
        } catch (e) {
            const loader = document.getElementById(loadingId);
            if (loader) loader.remove();
            this.appendLog('Error', e.message, 'system');
        }
    }

    appendLog(author: string, content: string, type: 'user' | 'ai' | 'system') {
        const entry = this.outputContainer.createDiv({ cls: `shell-entry ${type}` });

        if (type === 'ai') {
            MarkdownRenderer.render(this.app, content, entry, '', this as any);
        } else if (type === 'user') {
            entry.setText(content);
        } else {
            entry.setText(`[${author}] ${content}`);
        }
        this.scrollToBottom();
    }

    scrollToBottom() {
        this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
    }

    async onClose() {
        // Cleanup if needed
    }
}
