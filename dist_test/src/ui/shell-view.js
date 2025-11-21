"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiShellView = exports.VIEW_TYPE_GEMINI_SHELL = void 0;
const obsidian_1 = require("obsidian");
const logger_1 = require("../utils/logger");
exports.VIEW_TYPE_GEMINI_SHELL = 'gemini-shell-view';
class GeminiShellView extends obsidian_1.ItemView {
    constructor(leaf, api) {
        super(leaf);
        this.currentSelection = "";
        this.editor = null;
        // Suggestion State
        this.isSuggesting = false;
        this.suggestionType = null;
        this.selectedIndex = 0;
        this.suggestions = [];
        // File Selection State
        this.pendingFileSelection = null;
        // Heartbeat monitoring
        this.heartbeatInterval = null;
        this.lastActivityTime = Date.now();
        this.heartbeatIntervalMs = 30000; // 30秒检查一次
        this.isResponding = false;
        this.api = api;
    }
    getViewType() {
        return exports.VIEW_TYPE_GEMINI_SHELL;
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
        const createAction = (container, key, label) => {
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
                }
                else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.navigateSuggestions(1);
                }
                else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.selectSuggestion();
                }
                else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideSuggestions();
                }
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Prevent newline
                if (e.isComposing)
                    return;
                const query = this.inputEl.value.trim();
                if (!query)
                    return;
                this.inputEl.value = '';
                this.adjustHeight(); // Reset height
                await this.processCommand(query);
            }
        });
        // Focus input on click
        container.addEventListener('click', (e) => {
            if (window.getSelection()?.toString())
                return;
            // Don't focus if clicking on suggestions
            if (e.target.closest('.shell-suggestions'))
                return;
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
        }
        else if (lastWord.startsWith('@')) {
            this.showSuggestions('file', lastWord.substring(1));
        }
        else {
            this.hideSuggestions();
        }
    }
    showSuggestions(type, query) {
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
                { label: '/open', desc: 'Open file' },
                { label: '/tools', desc: 'List available MCP tools' }
            ];
            this.suggestions = commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()));
        }
        else {
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
    navigateSuggestions(dir) {
        this.selectedIndex += dir;
        if (this.selectedIndex < 0)
            this.selectedIndex = this.suggestions.length - 1;
        if (this.selectedIndex >= this.suggestions.length)
            this.selectedIndex = 0;
        this.renderSuggestions();
        // Scroll into view
        const selectedEl = this.suggestionContainer.children[this.selectedIndex];
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
    selectSuggestion() {
        const item = this.suggestions[this.selectedIndex];
        if (!item)
            return;
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
    async processCommand(query) {
        this.appendLog('You', query, 'user');
        // ==================== File Selection ====================
        // Check if user is selecting from file list
        if (this.pendingFileSelection && /^\d+$/.test(query)) {
            const index = parseInt(query) - 1;
            if (index >= 0 && index < this.pendingFileSelection.length) {
                await this.openFile(this.pendingFileSelection[index]);
                this.pendingFileSelection = null;
            }
            else {
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
            if (profile.name)
                profileText += `**姓名**: ${profile.name}\n`;
            if (profile.profession)
                profileText += `**职业**: ${profile.profession}\n`;
            if (profile.expertise.length > 0) {
                profileText += `**专业领域**: ${profile.expertise.join(', ')}\n`;
            }
            if (profile.preferences.responseStyle) {
                profileText += `**回答风格**: ${profile.preferences.responseStyle}\n`;
            }
            this.appendLog('System', profileText, 'system');
            return;
        }
        // /tools - List available MCP tools
        if (query === '/tools') {
            const tools = this.api.getAvailableTools();
            let toolsText = '## Available MCP Tools\n\n';
            tools.forEach((tool) => {
                toolsText += `### ${tool.name}\n`;
                toolsText += `${tool.description}\n\n`;
                if (tool.parameters && tool.parameters.properties) {
                    toolsText += '**Parameters:**\n';
                    Object.keys(tool.parameters.properties).forEach(param => {
                        const prop = tool.parameters.properties[param];
                        const required = tool.parameters.required?.includes(param) ? ' (required)' : '';
                        toolsText += `- \`${param}\`${required}: ${prop.description || 'No description'}\n`;
                    });
                }
                toolsText += '\n';
            });
            this.appendLog('System', toolsText, 'system');
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
            const editor = activeLeaf.view.editor;
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
        // 设置响应状态
        this.isResponding = true;
        try {
            this.updateActivity(); // 更新活动时间
            const response = await this.api.chat(query, contextStr, this.currentSelection);
            const loader = document.getElementById(loadingId);
            if (loader)
                loader.remove();
            if (query.startsWith("/edit") && this.editor && this.currentSelection) {
                this.editor.replaceSelection(response);
                this.appendLog('System', 'Text replaced.', 'system');
            }
            else {
                this.appendLog('Gemini', response, 'ai');
            }
        }
        catch (e) {
            const loader = document.getElementById(loadingId);
            if (loader)
                loader.remove();
            this.handleError(e, 'Gemini API调用');
        }
        finally {
            this.isResponding = false; // 重置响应状态
        }
    }
    appendLog(author, content, type) {
        const entry = this.outputContainer.createDiv({ cls: `shell-entry ${type}` });
        if (type === 'ai') {
            obsidian_1.MarkdownRenderer.render(this.app, content, entry, '', this);
        }
        else if (type === 'user') {
            entry.setText(content);
        }
        else {
            entry.setText(`[${author}] ${content}`);
        }
        this.scrollToBottom();
        this.updateActivity(); // 更新活动时间
    }
    scrollToBottom() {
        this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
    }
    // ==================== File Opening Methods ====================
    async handleOpenFile(searchTerm) {
        const files = this.app.vault.getFiles();
        const matches = files.filter(f => f.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.basename.toLowerCase().includes(searchTerm.toLowerCase()));
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
    showFileSelection(files, searchTerm) {
        let message = `找到 ${files.length} 个匹配 "${searchTerm}" 的文件：\n\n`;
        files.forEach((f, i) => {
            message += `  ${i + 1}. ${f.path}\n`;
        });
        message += '\n输入数字选择文件';
        this.appendLog('System', message, 'system');
        this.pendingFileSelection = files;
    }
    async openFile(file) {
        try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            this.appendLog('System', `✓ 已打开: ${file.path}`, 'system');
            this.pendingFileSelection = null; // Clear selection state
        }
        catch (e) {
            this.appendLog('System', `✗ 打开失败: ${e.message}`, 'system');
        }
    }
    async onClose() {
        // Cleanup if needed
        this.stopHeartbeat();
    }
    // ==================== Heartbeat Monitoring ====================
    startHeartbeat() {
        this.heartbeatInterval = window.setInterval(() => {
            this.checkHeartbeat();
        }, this.heartbeatIntervalMs);
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    checkHeartbeat() {
        const now = Date.now();
        const timeSinceLastActivity = now - this.lastActivityTime;
        logger_1.logger.debug(`心跳检查: 距离上次活动 ${timeSinceLastActivity}ms`, 'GeminiShellView.heartbeat');
        // 如果超过2分钟没有响应，显示警告
        if (this.isResponding && timeSinceLastActivity > 120000) {
            const warning = '⚠️ 检测到长时间无响应，系统可能出现问题';
            logger_1.logger.warn(warning, 'GeminiShellView.heartbeat');
            this.appendLog('System', warning, 'system');
            this.isResponding = false;
        }
        // 如果超过5分钟没有活动，尝试重置状态
        if (timeSinceLastActivity > 300000) {
            logger_1.logger.info('长时间无活动，重置状态', 'GeminiShellView.heartbeat');
            this.isResponding = false;
        }
    }
    updateActivity() {
        this.lastActivityTime = Date.now();
        this.isResponding = true;
        logger_1.logger.debug(`活动更新: ${new Date().toISOString()}`, 'GeminiShellView.updateActivity');
    }
    // ==================== Enhanced Error Handling ====================
    handleError(error, context) {
        logger_1.logger.error(`${context} 错误`, error, 'GeminiShellView', { context });
        const errorMessage = this.formatErrorMessage(error, context);
        this.appendLog('Error', errorMessage, 'system');
        // 重置响应状态
        this.isResponding = false;
    }
    formatErrorMessage(error, context) {
        if (error.name === 'AbortError') {
            return `${context}: 请求超时，请稍后重试`;
        }
        if (error.message?.includes('503') || error.message?.includes('overloaded')) {
            return `${context}: AI模型当前过载，请稍后再试`;
        }
        if (error.message?.includes('401')) {
            return `${context}: API密钥无效或已过期`;
        }
        if (error.message?.includes('network')) {
            return `${context}: 网络连接问题，请检查网络连接`;
        }
        return `${context}: ${error.message || '未知错误'}`;
    }
}
exports.GeminiShellView = GeminiShellView;
