import { ItemView, WorkspaceLeaf, MarkdownRenderer, TFile } from 'obsidian';
import { GeminiAPI } from '../gemini-api';

export const VIEW_TYPE_GEMINI_SHELL = 'gemini-shell-view';

export class GeminiShellView extends ItemView {
    private api: GeminiAPI;
    private outputContainer: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private suggestionContainer: HTMLElement;
    private currentSelection: string = "";
    private editor: any = null;

    // Suggestion State
    private isSuggesting = false;
    private suggestionType: 'command' | 'file' | null = null;
    private selectedIndex = 0;
    private suggestions: any[] = [];

    // File Selection State
    private pendingFileSelection: TFile[] | null = null;

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

        // Create a wrapper container to ensure proper flexbox layout
        const container = contentEl.createDiv({ cls: 'gemini-shell-view' });

        // 1. Header
        const header = container.createDiv({ cls: 'shell-header' });
        header.createSpan({ text: 'GEMINI SHELL' });
        header.createSpan({ text: '● ONLINE', attr: { style: 'color: #00e676;' } });

        // 2. Output Area (Scrollable)
        this.outputContainer = container.createDiv({ cls: 'shell-output-area' });

        // Welcome Message
        this.appendLog('System', 'Kernel initialized.', 'system');

        // 3. Input Area (Fixed at bottom)
        const inputContainer = container.createDiv({ cls: 'shell-input-container' });

        // Suggestion Popup
        this.suggestionContainer = inputContainer.createDiv({ cls: 'shell-suggestions' });

        const inputWrapper = inputContainer.createDiv({ cls: 'shell-input-wrapper' });
        const promptIcon = inputWrapper.createSpan({ cls: 'shell-prompt' });
        promptIcon.setText('>_');

        this.inputEl = inputWrapper.createEl('textarea', {
            cls: 'shell-input',
            attr: {
                placeholder: 'Ask Gemini... (/ for commands, @ for files)',
                spellcheck: 'false',
                autocomplete: 'off',
                rows: '1'
            }
        });

        // 4. Action Bar (inside inputContainer)
        const footer = inputContainer.createDiv({ cls: 'shell-footer' });
        const rightActions = footer.createDiv({ cls: 'action-group' });

        const createAction = (container: HTMLElement, key: string, label: string) => {
            const item = container.createDiv({ cls: 'action-item' });
            item.createSpan({ cls: 'key-badge', text: key });
            item.createSpan({ cls: 'action-label', text: label });
        };

        createAction(rightActions, '↵', 'Send');
        createAction(rightActions, '⇧↵', 'New Line');

        // Event Listeners
        this.inputEl.addEventListener('input', () => {
            this.adjustHeight();
            this.handleInput();
        });

        this.inputEl.addEventListener('keydown', async (e) => {
            if (this.isSuggesting) {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.navigateSuggestions(-1);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.navigateSuggestions(1);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.selectSuggestion();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideSuggestions();
                }
                return;
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Prevent newline
                if (e.isComposing) return;

                const query = this.inputEl.value.trim();
                if (!query) return;

                this.inputEl.value = '';
                this.adjustHeight(); // Reset height
                await this.processCommand(query);
            }
        });

        // Focus input on click
        container.addEventListener('click', (e) => {
            if (window.getSelection()?.toString()) return;
            // Don't focus if clicking on suggestions
            if ((e.target as HTMLElement).closest('.shell-suggestions')) return;
            this.inputEl.focus();
        });
    }

    adjustHeight() {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = this.inputEl.scrollHeight + 'px';
    }

    // ==================== Suggestion Logic ====================

    handleInput() {
        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart;

        // Check for triggers
        // Simple logic: look at the last word or character
        const textBeforeCursor = val.substring(0, cursor);
        const lastWord = textBeforeCursor.split(/\s+/).pop() || '';

        if (lastWord.startsWith('/')) {
            this.showSuggestions('command', lastWord.substring(1));
        } else if (lastWord.startsWith('@')) {
            this.showSuggestions('file', lastWord.substring(1));
        } else {
            this.hideSuggestions();
        }
    }

    showSuggestions(type: 'command' | 'file', query: string) {
        this.isSuggesting = true;
        this.suggestionType = type;
        this.suggestionContainer.empty();
        this.suggestionContainer.style.display = 'block';
        this.selectedIndex = 0;

        if (type === 'command') {
            const commands = [
                { label: '/clear', desc: 'Clear session history' },
                { label: '/profile', desc: 'View user profile' },
                { label: '/forget', desc: 'Forget context' },
                { label: '/new', desc: 'Create new note' },
                { label: '/edit', desc: 'Edit current selection' },
                { label: '/open', desc: 'Open file' }
            ];
            this.suggestions = commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()));
        } else {
            const files = this.app.vault.getFiles();
            this.suggestions = files
                .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(f => ({ label: f.basename, desc: f.path, value: `[[${f.path}]]` }));
        }

        if (this.suggestions.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.renderSuggestions();
    }

    renderSuggestions() {
        this.suggestionContainer.empty();
        this.suggestions.forEach((item, index) => {
            const el = this.suggestionContainer.createDiv({
                cls: `suggestion-item ${index === this.selectedIndex ? 'is-selected' : ''}`
            });
            el.createSpan({ cls: 'suggestion-icon', text: this.suggestionType === 'command' ? '/' : '@' });
            el.createSpan({ cls: 'suggestion-text', text: item.label });
            if (item.desc) {
                el.createSpan({ cls: 'suggestion-desc', text: item.desc });
            }

            el.addEventListener('click', () => {
                this.selectedIndex = index;
                this.selectSuggestion();
            });
        });
    }

    navigateSuggestions(dir: number) {
        this.selectedIndex += dir;
        if (this.selectedIndex < 0) this.selectedIndex = this.suggestions.length - 1;
        if (this.selectedIndex >= this.suggestions.length) this.selectedIndex = 0;
        this.renderSuggestions();

        // Scroll into view
        const selectedEl = this.suggestionContainer.children[this.selectedIndex] as HTMLElement;
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }

    selectSuggestion() {
        const item = this.suggestions[this.selectedIndex];
        if (!item) return;

        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart;
        const textBeforeCursor = val.substring(0, cursor);
        const lastWord = textBeforeCursor.split(/\s+/).pop() || '';

        const replacement = this.suggestionType === 'command' ? item.label : item.value;

        // Replace the trigger word with the selection
        const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - lastWord.length) + replacement + ' ';
        const newText = newTextBefore + val.substring(cursor);

        this.inputEl.value = newText;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = newTextBefore.length;

        this.hideSuggestions();
        this.inputEl.focus();
    }

    hideSuggestions() {
        this.isSuggesting = false;
        this.suggestionContainer.style.display = 'none';
        this.suggestionContainer.empty();
    }

    async processCommand(query: string) {
        this.appendLog('You', query, 'user');

        // ==================== File Selection ====================

        // Check if user is selecting from file list
        if (this.pendingFileSelection && /^\d+$/.test(query)) {
            const index = parseInt(query) - 1;
            if (index >= 0 && index < this.pendingFileSelection.length) {
                await this.openFile(this.pendingFileSelection[index]);
                this.pendingFileSelection = null;
            } else {
                this.appendLog('System', `✗ 无效的选择。请输入 1-${this.pendingFileSelection.length} 之间的数字`, 'system');
            }
            return;
        }

        // ==================== File Opening ====================

        // /open - 打开文件
        if (query.startsWith('/open ')) {
            const searchTerm = query.substring(6).trim();
            if (!searchTerm) {
                this.appendLog('System', '✗ 请提供文件名或路径，例如：/open readme', 'system');
                return;
            }
            await this.handleOpenFile(searchTerm);
            return;
        }

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

    // ==================== File Opening Methods ====================

    private async handleOpenFile(searchTerm: string) {
        const files = this.app.vault.getFiles();
        const matches = files.filter(f =>
            f.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.basename.toLowerCase().includes(searchTerm.toLowerCase())
        );

        if (matches.length === 0) {
            this.appendLog('System', `✗ 未找到匹配 "${searchTerm}" 的文件`, 'system');
            return;
        }

        if (matches.length === 1) {
            await this.openFile(matches[0]);
            return;
        }

        // Multiple matches - show selection list
        this.showFileSelection(matches, searchTerm);
    }

    private showFileSelection(files: TFile[], searchTerm: string) {
        let message = `找到 ${files.length} 个匹配 "${searchTerm}" 的文件：\n\n`;
        files.forEach((f, i) => {
            message += `  ${i + 1}. ${f.path}\n`;
        });
        message += '\n输入数字选择文件';

        this.appendLog('System', message, 'system');
        this.pendingFileSelection = files;
    }

    private async openFile(file: TFile) {
        try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            this.appendLog('System', `✓ 已打开: ${file.path}`, 'system');
            this.pendingFileSelection = null; // Clear selection state
        } catch (e) {
            this.appendLog('System', `✗ 打开失败: ${e.message}`, 'system');
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}
