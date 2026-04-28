import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice } from 'obsidian';
import { ModelService } from '../services/model-service';
import { logger } from '../utils/logger';
import { ChatController, ChatMessage } from './chat-controller';
import { ContextManager } from '../services/context-manager';
import { DiffModal } from './diff-modal';
import { VIEW_TYPE_SHELL } from '../mcp/types';
import { StreamEvent } from '../models/interfaces';
import { renderApprovalCard } from './approval-card';
import { buildCommandSuggestions, CommandSuggestion } from './command-suggestions';
import { ContextController } from './controllers/context-controller';
import { detectSuggestionTrigger, InputController } from './controllers/input-controller';
import { StreamController } from './controllers/stream-controller';
import { ThinkingRenderer } from './renderers/thinking-renderer';
import { ToolRenderer } from './renderers/tool-renderer';

export { VIEW_TYPE_SHELL };

export class ShellView extends ItemView {
    private modelService: ModelService;
    private chatController: ChatController;
    private contextManager: ContextManager;
    private outputContainer: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private suggestionContainer: HTMLElement;
    private currentSelection: string = "";
    private inputController: InputController;
    private contextController: ContextController;
    private streamController: StreamController;
    private thinkingRenderer: ThinkingRenderer | null = null;
    private toolRenderer: ToolRenderer | null = null;

    // Heartbeat monitoring
    private heartbeatInterval: number | null = null;
    private lastActivityTime: number = Date.now();
    private heartbeatIntervalMs: number = 30000; // 30s check
    private isResponding: boolean = false;
    private modelSelectEl: HTMLSelectElement | null = null;
    private providerSelectEl: HTMLSelectElement | null = null;
    private modelLoadRequestId: number = 0;
    private unsubscribeProvider: (() => void) | null = null;

    // Streaming state
    private streamContainer: HTMLElement | null = null;
    private streamTimeline: HTMLElement | null = null;
    private streamContent: HTMLElement | null = null;
    private streamAccumulatedText: string = '';
    private streamRenderTimer: number | null = null;
    private readonly localCommandSuggestions: CommandSuggestion[] = [
        { label: '/clear', desc: 'Clear session history' },
        { label: '/profile', desc: 'View user profile' },
        { label: '/file-back', desc: 'Archive a previous AI answer to the knowledge wiki' },
        { label: '/forget', desc: 'Forget user memory (name/profession/all...)' },
        { label: '/new', desc: 'Create new note' },
        { label: '/edit', desc: 'AI edit selected text' },
        { label: '/open', desc: 'Open file' },
        { label: '/tools', desc: 'List available MCP tools' },
        { label: '/help', desc: 'Show all commands' },
        { label: '/wiki:compile', desc: 'Compile notes to knowledge wiki' },
        { label: '/wiki:index', desc: 'Open knowledge wiki index' },
        { label: '/wiki:lint', desc: 'Run knowledge health check' }
    ];

    // Event Handlers
    private handleInputBound = () => {
        this.adjustHeight();
        this.handleInput();
    };

    private handleKeyDownBound = async (e: KeyboardEvent) => {
        if (this.inputController.getIsSuggesting()) {
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
    };

    private handleContainerClickBound = (e: MouseEvent) => {
        if (window.getSelection()?.toString()) return;
        // Don't focus if clicking on suggestions or context chips
        const target = e.target as HTMLElement;
        if (
            target.closest('.shell-suggestions') ||
            target.closest('.shell-context-chips') ||
            target.closest('.shell-model-select-container') ||
            target.closest('.shell-action-buttons')
        ) return;
        this.inputEl.focus();
    };

    private handlePasteBound = (e: ClipboardEvent) => this.handlePaste(e);
    private handleDropBound = (e: DragEvent) => this.handleDrop(e);

    constructor(leaf: WorkspaceLeaf, modelService: ModelService) {
        super(leaf);
        this.modelService = modelService;
        this.contextManager = new ContextManager();
        this.inputController = new InputController();
        this.contextController = new ContextController({
            app: this.app,
            contextManager: this.contextManager,
        });
        this.streamController = new StreamController({
            onThinking: (content) => {
                this.ensureStreamContainer();
                this.thinkingRenderer?.appendThinking(content);
                this.streamNodeCount = this.getStreamNodeCount();
            },
            onToolCall: (name, args) => {
                this.ensureStreamContainer();
                this.thinkingRenderer?.finalizeCurrentThinking();
                this.toolRenderer?.addToolCall(name, args);
                this.streamNodeCount = this.getStreamNodeCount();
            },
            onToolResult: (name, result, error) => {
                this.toolRenderer?.updateToolResult(name, result, error);
            },
            onTextDelta: (content) => {
                this.ensureStreamContainer();
                this.handleTextDelta(content);
            },
            onDone: () => this.finalizeStream(),
            onError: () => this.finalizeStream(),
            onScrollRequest: () => this.scrollToEnd(),
        });
    }

    getViewType() {
        return VIEW_TYPE_SHELL;
    }

    getDisplayText() {
        return 'Obsidian Shell';
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
            api: this.modelService,
            onMessageAdded: (msg) => this.appendMessage(msg),
            onStatusChanged: (status) => this.handleStatusChange(status),
            onStreamEvent: (event) => this.handleStreamEvent(event)
        });

        // Create a wrapper container to ensure proper flexbox layout
        const container = contentEl.createDiv({ cls: 'ocli-shell-view' });

        // 1. Header
        const header = container.createDiv({ cls: 'shell-header' });
        const headerTitle = header.createDiv({ cls: 'shell-header-title' });
        headerTitle.createEl('h1', { text: 'Obsidian Shell', cls: 'shell-title' });

        const headerButtons = header.createDiv({ cls: 'shell-header-buttons' });

        // Clear button
        const clearBtn = headerButtons.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Clear Chat' }
        });
        clearBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
        clearBtn.addEventListener('click', () => {
            this.clearChat();
        });

        // Tools button
        const toolsBtn = headerButtons.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Tools' }
        });
        toolsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>';
        toolsBtn.addEventListener('click', async () => {
            const tools = this.modelService.getAvailableTools();
            if (tools && tools.length > 0) {
                let toolsList = 'Available Tools:\n';
                tools.forEach(tool => {
                    toolsList += `\n${tool.name}: ${tool.description}\n`;
                    if (tool.input_schema && tool.input_schema.properties) {
                        toolsList += `  Parameters: ${Object.keys(tool.input_schema.properties).join(', ')}\n`;
                    }
                });
                new Notice(toolsList, 8000);
            } else {
                new Notice('No tools available or tools not loaded yet.');
            }
        });

        // Settings button
        const settingsBtn = headerButtons.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Settings' }
        });
        settingsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 .6 1v.51a2 2 0 0 1-.6 1l-.15.15a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-.6-1v-.5a2 2 0 0 1 .6-1l.15-.15a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        settingsBtn.addEventListener('click', () => {
            // @ts-ignore - app setting tab activation
            this.app.setting.open();
            // @ts-ignore - activate plugin settings tab
            this.app.setting.openTabById('obsidian-cli');
        });

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

        // Context Chips Container
        const contextContainer = inputContainer.createDiv({ cls: 'shell-context-chips' });
        this.renderContextChips(contextContainer);

        // Suggestion Popup
        this.suggestionContainer = inputContainer.createDiv({ cls: 'shell-suggestions' });

        // Input wrapper (contains the textarea)
        const inputWrapper = inputContainer.createDiv({ cls: 'shell-input-wrapper' });

        this.inputEl = inputWrapper.createEl('textarea', {
            cls: 'shell-input',
            attr: {
                placeholder: 'Ask AI... (/ for commands, @ for files)',
                spellcheck: 'false',
                autocomplete: 'off',
                rows: '1'
            }
        });
        // Set provider-specific placeholder.
        this.updatePlaceholder();

        // 4. Input Controls (below the textarea)
        const inputControls = inputContainer.createDiv({ cls: 'shell-input-controls' });

        // Left side: Provider selector + Model selector
        const modelSelectContainer = inputControls.createDiv({ cls: 'shell-model-select-container' });

        // Provider selector
        this.providerSelectEl = modelSelectContainer.createEl('select', {
            cls: 'shell-model-select shell-provider-select',
            attr: { title: 'Select AI Provider' }
        });
        this.populateProviderOptions(this.providerSelectEl);
        this.providerSelectEl.addEventListener('change', async (e) => {
            const target = e.target as HTMLSelectElement;
            const id = target.value;
            const plugin = (this.app as any).plugins.plugins['obsidian-cli'];
            const config = plugin?.settings?.providers?.[id];
            if (!config?.apiKey) {
                new Notice(`${config?.label || id} 未配置 API Key，请先在设置中配置`);
                // @ts-ignore
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById('obsidian-cli');
                // 恢复选择
                if (this.providerSelectEl) this.populateProviderOptions(this.providerSelectEl);
                return;
            }
            await this.modelService.switchProvider(id, () => plugin.saveSettings());
            new Notice(`已切换到 ${config.label}`);
        });

        // Model selector
        this.modelSelectEl = modelSelectContainer.createEl('select', {
            cls: 'shell-model-select shell-main-model-select',
            attr: { title: 'Select AI Model' }
        });

        // Populate model options based on current provider
        void this.populateModelOptions(this.modelSelectEl);

        // Update model when selection changes
        this.modelSelectEl.addEventListener('change', async (e) => {
            const target = e.target as HTMLSelectElement;
            if (!target.value) return;
            const plugin = (this.app as any).plugins.plugins['obsidian-cli'];
            await this.modelService.switchModel(target.value, () => plugin.saveSettings());
            new Notice(`Switched to ${target.options[target.selectedIndex].text}`);
        });

        // Right side: Action buttons
        inputControls.createDiv({ cls: 'shell-action-buttons' });

        // TODO: Add image upload button
        // TODO: Add submit button
        // TODO: Add vault search button

        // Event Listeners
        this.inputEl.addEventListener('input', this.handleInputBound);
        this.inputEl.addEventListener('keydown', this.handleKeyDownBound);

        // Focus input on click
        container.addEventListener('click', this.handleContainerClickBound);

        // Paste & Drop Handlers
        this.inputEl.addEventListener('paste', this.handlePasteBound);
        this.inputEl.addEventListener('drop', this.handleDropBound);

        // Register provider change listener for cross-UI sync
        this.unsubscribeProvider = this.modelService.onProviderChanged(() => {
            if (this.providerSelectEl) this.populateProviderOptions(this.providerSelectEl);
            if (this.modelSelectEl) void this.populateModelOptions(this.modelSelectEl, true);
            this.updatePlaceholder();
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
        const trigger = detectSuggestionTrigger(this.inputEl.value, this.inputEl.selectionStart);
        if (trigger) {
            this.showSuggestions(trigger.type, trigger.query);
        } else {
            this.hideSuggestions();
        }
    }

    showSuggestions(type: 'command' | 'file', query: string) {
        this.suggestionContainer.empty();
        this.suggestionContainer.style.display = 'block';
        let suggestions;
        if (type === 'command') {
            suggestions = buildCommandSuggestions(
                this.localCommandSuggestions,
                this.modelService.getSkillCommands().map(command => ({
                    command: command.command,
                    description: command.description,
                })),
                query,
            );
        } else {
            const files = this.app.vault.getFiles();
            suggestions = files
                .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(f => ({ label: f.basename, desc: f.path, value: `[[${f.path}]]` }));
        }

        this.inputController.setSuggestions(type, suggestions);

        if (this.inputController.getSuggestions().length === 0) {
            this.hideSuggestions();
            return;
        }

        this.renderSuggestions();
    }

    renderSuggestions() {
        this.suggestionContainer.empty();
        this.inputController.getSuggestions().forEach((item, index) => {
            const el = this.suggestionContainer.createDiv({
                cls: `suggestion-item ${index === this.inputController.getSelectedIndex() ? 'is-selected' : ''}`
            });
            el.createSpan({ cls: 'suggestion-icon', text: this.inputController.getSuggestionType() === 'command' ? '/' : '@' });
            el.createSpan({ cls: 'suggestion-text', text: item.label });
            if (item.desc) {
                el.createSpan({ cls: 'suggestion-desc', text: item.desc });
            }

            el.addEventListener('click', () => {
                while (this.inputController.getSelectedIndex() !== index) {
                    this.inputController.navigate(1);
                }
                this.selectSuggestion();
            });
        });
    }

    navigateSuggestions(dir: number) {
        this.inputController.navigate(dir);
        this.renderSuggestions();

        // Scroll into view
        const selectedEl = this.suggestionContainer.children[this.inputController.getSelectedIndex()] as HTMLElement;
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }

    selectSuggestion() {
        const selection = this.inputController.selectSuggestion(this.inputEl.value, this.inputEl.selectionStart);
        if (!selection) return;

        this.inputEl.value = selection.text;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = selection.cursor;

        this.hideSuggestions();
        this.inputEl.focus();
    }

    hideSuggestions() {
        this.inputController.hide();
        this.suggestionContainer.style.display = 'none';
        this.suggestionContainer.empty();
    }

    // ==================== Chat Logic ====================

    async processCommand(query: string) {
        try {
            const { contextItems, selection } = await this.contextController.collectCommandContext();
            this.currentSelection = selection;

            this.updateActivity();
            await this.chatController.processCommand(query, contextItems, this.currentSelection);

            // Clear context after sending (optional, maybe keep for multi-turn?)
            // Smart Composer clears context after send usually, unless pinned.
            // Let's clear for now.
            this.contextManager.clearContexts();
            this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
        } catch (error) {
            logger.error('Command processing failed', error, 'ShellView.processCommand');
            this.appendMessage({
                id: 'error-' + Date.now(),
                role: 'system',
                content: `Error processing command: ${error.message}`,
                timestamp: Date.now()
            });
        }
    }

    appendMessage(msg: ChatMessage) {
        const entry = this.outputContainer.createDiv({ cls: `shell-entry ${msg.role}` });

        if (msg.approval) {
            renderApprovalCard(entry, msg.approval, {
                onApprove: async () => {
                    await this.chatController.approveApproval(msg.approval!);
                },
                onCancel: () => {
                    this.chatController.cancelApproval(msg.approval!);
                },
            });
            this.scrollToEnd();
        } else if (msg.role === 'ai') {
            MarkdownRenderer.render(this.app, msg.content, entry, '', this as any).then(() => {
                this.postProcessAiContent(entry);

                requestAnimationFrame(() => {
                    this.scrollToEnd();
                });

                this.addFeedbackBar(entry, msg.content);
            }).catch(error => {
                logger.error('Markdown rendering failed', error, 'ShellView');
                entry.setText('Error rendering message');
            });
        } else if (msg.role === 'user') {
            entry.setText(msg.content);
            this.scrollToEnd();
        } else {
            entry.setText(`[System] ${msg.content}`);
            this.scrollToEnd();
        }

        this.updateActivity();
    }

    private scrollToEnd() {
        // Use setTimeout to ensure DOM is ready
        setTimeout(() => {
            this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
        }, 50);
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
            this.scrollToEnd();
        } else {
            // Remove loading indicator
            const loadingDiv = document.getElementById('loading-indicator');
            if (loadingDiv) loadingDiv.remove();
        }
    }

    private handleStreamEvent(event: StreamEvent) {
        this.updateActivity();
        this.streamController.handleEvent(event);
    }

    private ensureStreamContainer() {
        if (this.streamContainer) return;

        const loadingDiv = document.getElementById('loading-indicator');
        if (loadingDiv) loadingDiv.remove();

        this.streamContainer = this.outputContainer.createDiv({ cls: 'shell-entry ai shell-stream-container' });
        this.streamTimeline = this.streamContainer.createDiv({ cls: 'shell-think-timeline' });
        this.thinkingRenderer = new ThinkingRenderer(this.streamTimeline);
        this.toolRenderer = new ToolRenderer(this.streamTimeline);

        const summary = this.streamTimeline.createDiv({ cls: 'shell-think-summary' });
        summary.createSpan({ cls: 'think-toggle', text: '\u25BC' });
        summary.createSpan({ cls: 'think-summary-text', text: '思考中...' });
        summary.addEventListener('click', () => {
            this.streamTimeline?.toggleClass('is-collapsed', !this.streamTimeline.hasClass('is-collapsed'));
        });

        this.streamContent = this.streamContainer.createDiv({ cls: 'shell-response-content' });
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
    }

    private getStreamNodeCount() {
        return (this.thinkingRenderer?.getNodeCount() || 0) + (this.toolRenderer?.getNodeCount() || 0);
    }

    private handleTextDelta(content: string) {
        this.streamAccumulatedText += content;

        if (this.streamRenderTimer !== null) {
            window.clearTimeout(this.streamRenderTimer);
        }
        this.streamRenderTimer = window.setTimeout(() => {
            this.renderStreamContent();
        }, 100);
    }

    private renderStreamContent() {
        if (!this.streamContent) return;

        this.streamContent.empty();
        MarkdownRenderer.render(
            this.app,
            this.streamAccumulatedText,
            this.streamContent,
            '',
            this as any
        ).then(() => {
            const cursor = document.createElement('span');
            cursor.className = 'shell-stream-cursor';
            this.streamContent?.appendChild(cursor);
            this.scrollToEnd();
        });
    }

    private finalizeStream() {
        if (this.streamRenderTimer !== null) {
            window.clearTimeout(this.streamRenderTimer);
            this.streamRenderTimer = null;
        }

        this.thinkingRenderer?.finalizeCurrentThinking();

        if (this.streamContent && this.streamAccumulatedText) {
            this.streamContent.empty();
            MarkdownRenderer.render(
                this.app,
                this.streamAccumulatedText,
                this.streamContent,
                '',
                this as any
            ).then(() => {
                if (this.streamContent) {
                    this.postProcessAiContent(this.streamContent);
                }
                this.scrollToEnd();
            });
        }

        if (this.streamTimeline && this.streamNodeCount > 0) {
            const summaryText = this.streamTimeline.querySelector('.think-summary-text') as HTMLElement;
            if (summaryText) summaryText.textContent = `思考了 ${this.streamNodeCount} 步`;
            this.streamTimeline.addClass('is-collapsed');
        } else if (this.streamTimeline && this.streamNodeCount === 0) {
            this.streamTimeline.style.display = 'none';
        }

        if (this.streamContainer) {
            this.addFeedbackBar(this.streamContainer, this.streamAccumulatedText);
        }

        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
        this.thinkingRenderer = null;
        this.toolRenderer = null;
    }

    private postProcessAiContent(container: HTMLElement) {
        const codeBlocks = container.querySelectorAll('pre > code');
        codeBlocks.forEach((codeBlock) => {
            const pre = codeBlock.parentElement;
            if (pre) {
                const header = pre.createDiv({ cls: 'shell-code-block-header' });
                const langClass = Array.from(codeBlock.classList).find(cls => cls.startsWith('language-'));
                const lang = langClass ? langClass.replace('language-', '') : 'text';
                header.createDiv({ cls: 'shell-code-block-filename', text: `untitled.${lang === 'text' ? 'txt' : lang}` });
                const buttons = header.createDiv({ cls: 'shell-code-block-buttons' });
                const btn = buttons.createEl('button', { cls: 'shell-apply-btn clickable-icon', title: 'Review Changes' });
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="16" x2="12" y2="12"></line><line x1="10" y1="14" x2="10" y2="10"></line></svg>';
                btn.addEventListener('click', async () => {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (!activeFile) { new Notice('No active file to apply changes to.'); return; }
                    const originalContent = await this.app.vault.read(activeFile);
                    const newContent = codeBlock.textContent || '';
                    new DiffModal(this.app, originalContent, newContent, async () => {
                        await this.app.vault.modify(activeFile, newContent);
                        new Notice('Changes applied.');
                    }).open();
                });
                pre.insertBefore(header, codeBlock);
            }
        });

        container.querySelectorAll('a.internal-link').forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
                if (href) this.app.workspace.openLinkText(href, '', false);
            });
        });
    }

    private addFeedbackBar(container: HTMLElement, content: string) {
        const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const feedbackBar = container.createDiv({ cls: 'shell-feedback-bar' });
        const thumbsUpBtn = feedbackBar.createEl('button', { cls: 'shell-feedback-btn shell-thumbs-up', title: 'Useful - save to knowledge wiki' });
        thumbsUpBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>';
        const thumbsDownBtn = feedbackBar.createEl('button', { cls: 'shell-feedback-btn shell-thumbs-down', title: 'Not useful' });
        thumbsDownBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>';
        thumbsUpBtn.addEventListener('click', () => {
            thumbsUpBtn.addClass('active');
            thumbsDownBtn.removeClass('active');
            this.chatController.processCommand(`/file-back ${msgId}`, [], '');
        });
        thumbsDownBtn.addEventListener('click', () => {
            thumbsDownBtn.addClass('active');
            thumbsUpBtn.removeClass('active');
        });
    }

    async onClose() {
        this.stopHeartbeat();
        // Unsubscribe from provider changes
        this.unsubscribeProvider?.();
        this.unsubscribeProvider = null;
        // Prevent interval leaks from ChatController
        if (this.chatController) {
            this.chatController.cleanup();
        }
        if (this.inputEl) {
            this.inputEl.removeEventListener('input', this.handleInputBound);
            this.inputEl.removeEventListener('keydown', this.handleKeyDownBound);
            this.inputEl.removeEventListener('paste', this.handlePasteBound);
            this.inputEl.removeEventListener('drop', this.handleDropBound);
        }
        const container = this.contentEl.querySelector('.ocli-shell-view');
        if (container) {
            container.removeEventListener('click', this.handleContainerClickBound as EventListener);
        }
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
            logger.warn(warning, 'ObsidianShellView.heartbeat');
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

    // ==================== Context Handling ====================

    private renderContextChips(container: HTMLElement) {
        if (!container) return;
        container.empty();

        const contexts = this.contextManager.getContexts();
        contexts.forEach(ctx => {
            const chip = container.createDiv({ cls: 'context-chip' });
            chip.createSpan({ cls: 'chip-icon', text: this.getIconForType(ctx.type) });
            chip.createSpan({ cls: 'chip-label', text: ctx.summary || ctx.data });
            const removeBtn = chip.createSpan({ cls: 'chip-remove', text: '×' });

            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.contextManager.removeContext(ctx.id);
                this.renderContextChips(container);
            });
        });
    }

    private getIconForType(type: string): string {
        switch (type) {
            case 'image': return '🖼️';
            case 'url': return '🌐';
            case 'youtube': return '▶️';
            case 'file': return '📄';
            default: return '📎';
        }
    }

    private async handlePaste(e: ClipboardEvent) {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.indexOf('image') !== -1) {
                if (!this.modelService.getProviderCapabilities().supportsImageInput) {
                    new Notice('The active provider does not support image context.');
                    return;
                }
                e.preventDefault();
                const blob = item.getAsFile();
                if (blob) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const base64 = event.target?.result as string;
                        this.contextManager.addContext({
                            id: Date.now().toString(),
                            type: 'image',
                            data: base64,
                            summary: 'Pasted Image'
                        });
                        this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
                    };
                    reader.readAsDataURL(blob);
                }
            } else if (item.type === 'text/plain') {
                // Check if it's a URL
                item.getAsString((text) => {
                    if (this.isValidUrl(text)) {
                        const type = (text.includes('youtube.com') || text.includes('youtu.be'))
                            ? 'youtube'
                            : 'url';
                        this.contextManager.addContext({
                            id: Date.now().toString(),
                            type,
                            data: text,
                            summary: text
                        });
                        this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
                    }
                });
            }
        }
    }

    private handleDrop(e: DragEvent) {
        e.preventDefault();
        if (!this.modelService.getProviderCapabilities().supportsImageInput) {
            new Notice('The active provider does not support image context.');
            return;
        }
        // Handle files dropped
        if (e.dataTransfer?.files) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                if (file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const base64 = event.target?.result as string;
                        this.contextManager.addContext({
                            id: Date.now().toString(),
                            type: 'image',
                            data: base64,
                            summary: file.name
                        });
                        this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
                    };
                    reader.readAsDataURL(file);
                }
            }
        }
    }

    private isValidUrl(str: string) {
        try {
            new URL(str);
            return true;
        } catch (_) {
            return false;
        }
    }

    private async populateModelOptions(selectEl: HTMLSelectElement, forceRefresh: boolean = false) {
        const settings = (this.app as any).plugins.plugins['obsidian-cli']?.settings;
        if (!settings?.providers) return;

        const requestId = ++this.modelLoadRequestId;
        const config = settings.providers[settings.activeProvider];
        if (!config) return;

        selectEl.empty();
        selectEl.disabled = true;
        const loadingOption = selectEl.createEl('option', {
            value: '',
            text: `Loading ${config.label} models...`
        });
        loadingOption.selected = true;

        try {
            const models = await this.modelService.getAvailableModels(forceRefresh);

            // 用户在请求期间切换了 provider，丢弃旧请求结果
            if (requestId !== this.modelLoadRequestId) return;

            selectEl.empty();

            if (!models.length) {
                const emptyOption = selectEl.createEl('option', {
                    value: '',
                    text: 'No models available'
                });
                emptyOption.selected = true;
                emptyOption.disabled = true;
                selectEl.disabled = true;
                return;
            }

            const currentModel = config.model || '';

            models.forEach(model => {
                const option = selectEl.createEl('option', {
                    value: model.value,
                    text: model.label
                });
                if (model.value === currentModel) {
                    option.selected = true;
                }
            });

            if (currentModel && !models.some(m => m.value === currentModel)) {
                const current = selectEl.createEl('option', {
                    value: currentModel,
                    text: `${currentModel} (Current)`
                });
                current.selected = true;
            }

            selectEl.disabled = false;
        } catch (error: any) {
            if (requestId !== this.modelLoadRequestId) return;
            logger.warn(
                `Failed to load model list: ${error?.message || 'Unknown error'}`,
                'ShellView.populateModelOptions'
            );
            selectEl.empty();
            const failedOption = selectEl.createEl('option', {
                value: '',
                text: 'Model list unavailable'
            });
            failedOption.selected = true;
            failedOption.disabled = true;
            selectEl.disabled = true;
        }
    }

    private populateProviderOptions(selectEl: HTMLSelectElement) {
        const settings = (this.app as any).plugins.plugins['obsidian-cli']?.settings;
        if (!settings?.providers) return;

        selectEl.empty();
        const active = settings.activeProvider || 'gemini';

        for (const [id, config] of Object.entries(settings.providers) as [string, any][]) {
            const configured = !!config.apiKey;
            const option = selectEl.createEl('option', {
                value: id,
                text: configured ? config.label : `${config.label} ⚠️`
            });
            if (id === active) option.selected = true;
        }
    }

    private updatePlaceholder() {
        if (!this.inputEl) return;
        const settings = (this.app as any).plugins.plugins['obsidian-cli']?.settings;
        const config = settings?.providers?.[settings?.activeProvider];
        const label = config?.label || 'AI';
        this.inputEl.setAttr('placeholder', `Ask ${label}... (/ for commands, @ for files)`);
    }

    public async updateModelSelector(forceRefresh: boolean = false) {
        if (this.providerSelectEl) {
            this.populateProviderOptions(this.providerSelectEl);
        }
        if (this.modelSelectEl) {
            await this.populateModelOptions(this.modelSelectEl, forceRefresh);
        }
    }

    private clearChat() {
        this.outputContainer.empty();
        // Re-add welcome message
        this.appendMessage({
            id: 'init',
            role: 'system',
            content: 'Chat cleared.',
            timestamp: Date.now()
        });
        new Notice('Chat cleared');
    }
}
