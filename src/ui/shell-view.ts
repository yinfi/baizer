import { ItemView, WorkspaceLeaf, MarkdownRenderer } from 'obsidian';
import { GeminiAPI } from '../gemini-api';
import { logger } from '../utils/logger';
import { ChatController, ChatMessage } from './chat-controller';

export const VIEW_TYPE_GEMINI_SHELL = 'gemini-shell-view';

export class GeminiShellView extends ItemView {
    private api: GeminiAPI;
    private chatController: ChatController;
    private outputContainer: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private suggestionContainer: HTMLElement;
    private currentSelection: string = "";
    // private editor: any = null; // Removed as it was unused in the new implementation

    // Suggestion State
    private isSuggesting = false;
    private suggestionType: 'command' | 'file' | null = null;
    private selectedIndex = 0;
    private suggestions: any[] = [];

    // Heartbeat monitoring
    private heartbeatInterval: number | null = null;
    private lastActivityTime: number = Date.now();
    private heartbeatIntervalMs: number = 30000; // 30s check
    private isResponding: boolean = false;

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

        // Initialize ChatController
        this.chatController = new ChatController({
            app: this.app,
            api: this.api,
            onMessageAdded: (msg) => this.appendMessage(msg),
            onStatusChanged: (status) => this.handleStatusChange(status)
        });

        // Create a wrapper container to ensure proper flexbox layout
        const container = contentEl.createDiv({ cls: 'gemini-shell-view' });

        // 1. Header
        const header = container.createDiv({ cls: 'shell-header' });
        header.createSpan({ text: 'GEMINI SHELL' });
        const statusContainer = header.createDiv({ cls: 'shell-status-container' });
        statusContainer.createSpan({ cls: 'shell-status-dot' });
        statusContainer.createSpan({ text: 'ONLINE' });

        // 2. Output Area (Scrollable)
        this.outputContainer = container.createDiv({ cls: 'shell-output-area' });

        // Welcome Message (Simulated)
        this.appendMessage({
            id: 'init',
            role: 'system',
            content: 'Kernel initialized.',
            timestamp: Date.now()
        });

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

        // Start heartbeat monitoring
        this.startHeartbeat();
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
                { label: '/forget', desc: 'Forget context' }, // Note: ChatController doesn't implement forget yet, but keeping for UI consistency or future
                { label: '/new', desc: 'Create new note' },
                { label: '/edit', desc: 'Edit current selection' },
                { label: '/open', desc: 'Open file' },
                { label: '/tools', desc: 'List available MCP tools' }
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

    // ==================== Chat Logic ====================

    async processCommand(query: string) {
        // Context gathering
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
                // this.editor = editor; // Unused
                this.currentSelection = editor.getSelection();
                if (this.currentSelection) {
                    // We don't need to log this explicitly as system message anymore, 
                    // or we can if we want to mimic exact previous behavior.
                    // Let's keep it clean for now.
                }
            }
        }

        this.updateActivity();
        await this.chatController.processCommand(query, contextStr, this.currentSelection);
    }

    appendMessage(msg: ChatMessage) {
        const entry = this.outputContainer.createDiv({ cls: `shell-entry ${msg.role}` });

        if (msg.role === 'ai') {
            MarkdownRenderer.render(this.app, msg.content, entry, '', this as any);
        } else if (msg.role === 'user') {
            entry.setText(msg.content);
        } else {
            entry.setText(`[System] ${msg.content}`);
        }

        this.scrollToBottom();
        this.updateActivity();
    }

    handleStatusChange(isResponding: boolean) {
        this.isResponding = isResponding;
        if (isResponding) {
            // Show loading indicator
            const loadingId = 'loading-indicator';
            let loadingDiv = document.getElementById(loadingId);
            if (!loadingDiv) {
                loadingDiv = this.outputContainer.createDiv({ cls: 'shell-entry system' });
                loadingDiv.id = loadingId;
                loadingDiv.createSpan({ cls: 'shell-loading' });
                loadingDiv.createSpan({ text: 'Thinking...' });
            }
            this.scrollToBottom();
        } else {
            // Remove loading indicator
            const loadingDiv = document.getElementById('loading-indicator');
            if (loadingDiv) loadingDiv.remove();
        }
    }

    scrollToBottom() {
        this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
    }

    async onClose() {
        this.stopHeartbeat();
    }

    // ==================== Heartbeat Monitoring ====================

    private startHeartbeat() {
        this.heartbeatInterval = window.setInterval(() => {
            this.checkHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private checkHeartbeat() {
        const now = Date.now();
        const timeSinceLastActivity = now - this.lastActivityTime;

        if (this.isResponding && timeSinceLastActivity > 120000) {
            const warning = '⚠️ 检测到长时间无响应，系统可能出现问题';
            logger.warn(warning, 'GeminiShellView.heartbeat');
            this.appendMessage({
                id: 'warn',
                role: 'system',
                content: warning,
                timestamp: Date.now()
            });
            this.isResponding = false;
        }
    }

    private updateActivity() {
        this.lastActivityTime = Date.now();
    }
}
