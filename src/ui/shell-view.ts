import { ItemView, WorkspaceLeaf, Notice, MarkdownView, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ModelService } from '../services/model-service';
import { logger } from '../utils/logger';
import { ChatController } from './chat-controller';
import { ContextManager } from '../services/context-manager';
import { DiffModal } from './diff-modal';
import { IPlugin, PLUGIN_ID, PLUGIN_NAME, VIEW_TYPE_SHELL } from '../mcp/types';
import { StreamEvent } from '../models/interfaces';
import { buildCommandSuggestions, CommandSuggestion } from './command-suggestions';
import { ContextController } from './controllers/context-controller';
import { InputController, SuggestionType, SuggestionItem, SuggestionSelection } from './controllers/input-controller';
import { StreamController } from './controllers/stream-controller';
import { SuggestList } from './components/suggest-list';
import { ContextChips } from './components/context-chips';
import { InputToolbar, ThinkingLevel } from './components/input-toolbar';
import { AttachmentModal, AttachmentResult } from './components/attachment-modal';
import { HistoryMenu } from './components/history-menu';
import { KnowledgeStatusPanel } from './components/knowledge-status-panel';
import { ThinkingRenderer } from './renderers/thinking-renderer';
import { ToolRenderer } from './renderers/tool-renderer';
import { MessageRenderer } from './renderers/message-renderer';
import { findBlockBoundary } from './renderers/stream-block-splitter';
import { ConversationSnapshot, ChatMessage } from './types';
import { WorkspaceEditSummary } from '../services/workspace-edit-service';
import { TabBar } from './tabs/tab-bar';
import { TabManager } from './tabs/tab-manager';
import { TabData, TabId } from './tabs/types';
import { ConversationController } from './history/conversation-controller';
import { ConversationStore } from './history/conversation-store';
import { showGhostText } from './ghost-text';
import { debounce } from '../utils/throttle';

export { VIEW_TYPE_SHELL };

interface ShellTabSession {
    chatController: ChatController;
    contextManager: ContextManager;
    contextController: ContextController;
}

export class ShellView extends ItemView {
    private modelService: ModelService;
    private chatController: ChatController;
    private contextManager: ContextManager;
    private outputContainer: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private suggestionContainer: HTMLElement;
    private currentSelection: string = "";
    private suggestList!: SuggestList;
    private inputToolbar: InputToolbar | null = null;
    private contextController: ContextController;
    private streamController: StreamController;
    private thinkingRenderer: ThinkingRenderer | null = null;
    private toolRenderer: ToolRenderer | null = null;
    private messageRenderer: MessageRenderer | null = null;
    private tabManager: TabManager;
    private tabBar: TabBar | null = null;
    private tabBarContainerEl: HTMLElement | null = null;
    private tabSessions = new Map<TabId, ShellTabSession>();
    private conversationController: ConversationController;
    private historyMenu: HistoryMenu | null = null;
    private historyMenuContainerEl: HTMLElement | null = null;
    private knowledgeStatusPanel: KnowledgeStatusPanel | null = null;
    private knowledgeStatusContainerEl: HTMLElement | null = null;
    private excludedCurrentNotePath: string | null = null;

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
    private loadingIndicatorEl: HTMLElement | null = null;
    private streamContainer: HTMLElement | null = null;
    private streamTimeline: HTMLElement | null = null;
    private streamContent: HTMLElement | null = null;
    /** 流式增量渲染:已渲染的稳定块容器。每个已闭合的 Markdown 块渲染进独立子节点后冻结,不再重渲。 */
    private streamStableEl: HTMLElement | null = null;
    /** 流式增量渲染:尾部未闭合内容的纯文本节点。块一旦闭合(遇到围栏外空行)即晋升进 streamStableEl。 */
    private streamTailEl: HTMLElement | null = null;
    /** 流式增量渲染:闪烁光标,始终位于尾部之后。 */
    private streamCursorEl: HTMLElement | null = null;
    /** 已晋升为稳定块的文本前缀长度(streamAccumulatedText 的字符数),尾部从此处开始。 */
    private streamRenderedLen = 0;
    private streamAccumulatedText: string = '';
    private streamNodeCount = 0;
    /** 智能体工具循环回合数(step_boundary 计数),用于时间线「Step N」分组标签。 */
    private streamStepCount = 0;
    /** 待插入的回合分隔:置位后由下一个时间线节点触发真正插入,避免空分隔。 */
    private pendingStepDivider = false;
    private readonly debouncedRenderStream = debounce(
        () => this.renderStreamContent(),
        { wait: 100 }
    );
    private readonly localCommandSuggestions: CommandSuggestion[] = [
        { label: '/clear', desc: 'Clear session history' },
        { label: '/memory', desc: 'View, search, and forget Hindsight memory' },
        { label: '/file-back', desc: 'Archive a previous AI answer to the knowledge wiki' },
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
        if (this.suggestList.handleKeyDown(e)) {
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); // Prevent newline
            if (e.isComposing) return;

            const query = this.inputEl.value.trim();
            if (!query) return;

            this.inputEl.value = '';
            this.adjustHeight(); // Reset height
            await this.submitInput(query);
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
            target.closest('.shell-action-buttons') ||
            target.closest('.shell-header-buttons') ||
            target.closest('.baizer-history-menu') ||
            target.closest('.shell-history-btn')
        ) return;
        this.hideHistoryMenu();
        this.inputEl.focus();
    };

    private handlePasteBound = (e: ClipboardEvent) => this.handlePaste(e);
    private handleDropBound = (e: DragEvent) => this.handleDrop(e);

    constructor(leaf: WorkspaceLeaf, modelService: ModelService, private plugin?: IPlugin) {
        super(leaf);
        this.modelService = modelService;
        this.tabManager = new TabManager({
            onChanged: () => this.updateTabBar(),
        });
        const conversationStore = new ConversationStore(this.app);
        this.conversationController = new ConversationController({
            store: conversationStore,
            getProviderId: () => this.getActiveProviderId(),
            getModelId: () => this.getActiveModelId(),
            getCurrentNotePath: () => this.getCurrentNotePath(),
        });
        this.contextManager = new ContextManager();
        this.contextController = new ContextController({
            app: this.app,
            contextManager: this.contextManager,
        });
        this.streamController = new StreamController({
            onThinking: (content) => {
                this.ensureStreamContainer();
                this.flushPendingStepDivider();
                this.thinkingRenderer?.appendThinking(content);
                this.streamNodeCount = this.getStreamNodeCount();
            },
            onToolCall: (name, args) => {
                this.ensureStreamContainer();
                // 工具调用出现 = 此前回复区的正文是「这一步的过程叙述」,
                // 把它毕业进时间线作为思路节点,并清空回复区为下一轮腾空。
                this.graduateNarrationToTimeline();
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
            onStepBoundary: () => {
                this.ensureStreamContainer();
                this.streamStepCount++;
                // 懒标记:真正的分隔推迟到本回合产生时间线内容时再插入,
                // 末轮(只出答案、无工具/思考)不产生时间线内容 → 不会留下空分隔。
                this.pendingStepDivider = true;
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
        return PLUGIN_NAME;
    }

    getIcon() {
        return 'terminal-square';
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Create a wrapper container to ensure proper flexbox layout
        const container = contentEl.createDiv({ cls: 'baizer-shell-view' });

        // 1. Header
        const header = container.createDiv({ cls: 'shell-header' });
        const headerTitle = header.createDiv({ cls: 'shell-header-title' });
        const headerIdentity = headerTitle.createDiv({ cls: 'shell-header-identity' });
        headerIdentity.createDiv({ cls: 'shell-brand-mark', text: 'BZ' });
        const headerCopy = headerIdentity.createDiv({ cls: 'shell-header-copy' });
        headerCopy.createEl('h1', { text: PLUGIN_NAME, cls: 'shell-title' });
        headerCopy.createDiv({ cls: 'shell-header-state', text: 'Ready - current note scoped' });
        this.tabBarContainerEl = headerTitle.createDiv({ cls: 'shell-tab-bar-container' });
        this.createHeaderActions(header);

        this.historyMenuContainerEl = header.createDiv({ cls: 'baizer-history-menu' });
        this.historyMenu = new HistoryMenu(this.historyMenuContainerEl, {
            onOpen: (id) => this.openConversationFromHistory(id),
            onDelete: (id) => this.deleteConversationFromHistory(id),
            onTogglePin: (id) => this.toggleConversationPin(id),
            onClose: () => this.hideHistoryMenu(),
        });
        this.historyMenu.hide();

        // 2. Output Area (Scrollable)
        this.outputContainer = container.createDiv({ cls: 'shell-output-area' });

        this.tabBar = new TabBar(this.tabBarContainerEl, {
            onTabClick: (id) => {
                void this.switchTab(id);
            },
            onTabClose: (id) => {
                void this.closeTab(id);
            },
            onNewTab: () => {
                void this.createAndShowTab();
            },
        });

        if (this.tabManager.getAllTabs().length === 0) {
            this.tabManager.createTab();
        }
        const activeTab = this.tabManager.getActiveTab();
        if (activeTab) {
            this.activateTabSession(activeTab.id);
            this.applyTabMetadata(activeTab);
        }
        this.updateTabBar();
        this.renderActiveTabMessages();

        // 3. Input Area (Fixed at bottom)
        const inputContainer = this.createShellScaffold(container);
        void this.refreshKnowledgeStatusPanel();
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.excludedCurrentNotePath = null;
                const contextContainer = this.getContextChipsContainer();
                if (contextContainer) this.renderContextChips(contextContainer);
                void this.refreshKnowledgeStatusPanel();
            })
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', () => {
                void this.refreshKnowledgeStatusPanel();
            })
        );

        // Suggestion Popup
        this.suggestionContainer = this.createSuggestionContainer(inputContainer);
        this.suggestList = new SuggestList({
            container: this.suggestionContainer,
            provideItems: (type, query) => this.buildSuggestionItems(type, query),
            onApply: (selection) => this.applySuggestionSelection(selection),
        });

        // Input wrapper (contains the textarea)
        const inputWrapper = inputContainer.createDiv({ cls: 'shell-input-wrapper' });

        this.inputEl = inputWrapper.createEl('textarea', {
            cls: 'shell-input',
            attr: {
                placeholder: 'Ask AI... (/ commands, @ context)',
                spellcheck: 'false',
                autocomplete: 'off',
                rows: '1'
            }
        });
        // Set provider-specific placeholder.
        this.updatePlaceholder();

        // 4. Input Controls (below the textarea)
        const inputControls = inputContainer.createDiv({ cls: 'shell-input-controls' });
        this.inputToolbar = new InputToolbar(inputControls, {
            onProviderChange: (id) => this.handleProviderChange(id),
            onUnavailableProvider: (id) => this.handleUnavailableProvider(id),
            onModelChange: (id) => this.handleModelChange(id),
            onThinkingChange: (level) => this.handleThinkingChange(level),
            onAttach: () => this.handleAttachFiles(),
            onSend: async () => {
                const query = this.inputEl.value.trim();
                if (!query) return;
                this.inputEl.value = '';
                this.adjustHeight();
                await this.submitInput(query);
            },
            onStop: () => this.stopActiveResponse(),
        });
        this.providerSelectEl = this.inputToolbar.getProviderSelectEl();
        this.modelSelectEl = this.inputToolbar.getModelSelectEl();
        this.refreshInputToolbarProviders();
        this.refreshInputToolbarThinking();
        void this.refreshInputToolbarModels();
        this.updateInputToolbarCapabilities();
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
            this.refreshInputToolbarProviders();
            void this.refreshInputToolbarModels(true);
            this.updateInputToolbarCapabilities();
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
        this.updateInputToolbarCapabilities();
        this.suggestList.handleInput(this.inputEl.value, this.inputEl.selectionStart);
    }

    private buildSuggestionItems(type: SuggestionType, query: string): SuggestionItem[] {
        if (type === 'command') {
            const skillCommands = this.modelService.getSkillCommands().map(command => ({
                command: command.command,
                description: command.description,
            }));
            // 用户自定义命令(.obsidian/baizer-commands/*.md)并入 skill 通道一起展示。
            const userCommands = (typeof (this.modelService as any).getUserCommandsSync === 'function'
                ? (this.modelService as any).getUserCommandsSync()
                : []).map((command: any) => ({
                    command: command.command,
                    description: command.description,
                }));
            const mergedSkillLike = [...skillCommands, ...userCommands];
            const skillCommandLabels = new Set(mergedSkillLike.map(command => command.command));
            return buildCommandSuggestions(
                this.localCommandSuggestions,
                mergedSkillLike,
                query,
            ).map(item => ({
                ...item,
                source: skillCommandLabels.has(item.label) ? 'skill' as const : 'local' as const,
            }));
        }
        if (type === 'skill') {
            return this.modelService.getSkillCommands()
                .filter(command =>
                    command.skillName.toLowerCase().includes(query.toLowerCase()) ||
                    command.command.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(command => ({
                    label: `$${command.skillName}`,
                    desc: command.description,
                    value: command.command,
                    source: 'skill' as const,
                }));
        }
        const scopeSuggestions = this.buildContextScopeSuggestions(query);
        const fileSuggestions = this.app.vault.getFiles()
            .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10)
            .map(f => ({
                label: f.basename,
                desc: f.path,
                value: f.path,
                source: 'file' as const,
                kind: 'file' as const,
            }));
        return [...scopeSuggestions, ...fileSuggestions];
    }

    private applySuggestionSelection(selection: SuggestionSelection) {
        this.inputEl.value = selection.text;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = selection.cursor;
        if (selection.contextItem) {
            if (selection.contextItem.type === 'scope' && selection.contextItem.scope === 'current') {
                this.excludedCurrentNotePath = null;
            }
            this.contextManager.addContext(selection.contextItem);
            this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
            void this.refreshKnowledgeStatusPanel();
        }
        this.inputEl.focus();
    }

    private buildContextScopeSuggestions(query: string) {
        const normalized = query.toLowerCase();
        const suggestions = [
            {
                label: '@current',
                desc: 'Add the current note',
                value: '@current',
                source: 'scope' as const,
                kind: 'scope' as const,
                scope: 'current' as const,
            },
            {
                label: '@backlinks',
                desc: 'Add notes linking to the current note',
                value: '@backlinks',
                source: 'scope' as const,
                kind: 'scope' as const,
                scope: 'backlinks' as const,
            },
            {
                label: '@recent',
                desc: 'Add recently opened notes',
                value: '@recent',
                source: 'scope' as const,
                kind: 'scope' as const,
                scope: 'recent' as const,
            },
        ];

        if (normalized.startsWith('tag:')) {
            const tag = query.slice(4).trim();
            if (tag) {
                suggestions.unshift({
                    label: `@tag:${tag}`,
                    desc: `Add notes tagged ${tag}`,
                    value: `@tag:${tag}`,
                    source: 'scope' as const,
                    kind: 'scope' as const,
                    scope: 'tag' as const,
                    tag,
                });
            }
        } else if ('tag:'.includes(normalized) || normalized.includes('tag')) {
            suggestions.push({
                label: '@tag:',
                desc: 'Add notes matching a tag',
                value: '@tag:',
                source: 'scope' as const,
                kind: 'scope' as const,
                scope: 'tag' as const,
            });
        }

        return suggestions
            .filter(item => item.label.toLowerCase().includes(`@${normalized}`))
            .slice(0, 10);
    }

    // ==================== Chat Logic ====================

    /**
     * 提交入口：根据当前是否有正在运行的流，决定「补话」还是「发起新一轮」。
     * - 运行中且输入是普通文本：把它作为 steering 补话排队，注入正在跑的 agentLoop 下一轮，
     *   不打断、不重启当前流（避免覆盖 activeStreamController 造成孤儿流）。
     * - 否则（无活动流，或输入是 / 斜杠命令）：走原有 processCommand 发起新一轮。
     *   斜杠命令在 ChatController 内于创建 AbortController 之前分流处理，故运行中执行斜杠命令安全。
     */
    private async submitInput(query: string) {
        const session = this.ensureActiveTabSession();
        const isSlashCommand = query.startsWith('/');
        if (!isSlashCommand && session.chatController.isRunActive()) {
            if (session.chatController.steerActiveRun(query)) {
                this.updateActivity();
                return;
            }
        }
        await this.processCommand(query);
    }

    async processCommand(query: string) {
        try {
            this.ensureActiveTabSession();
            const { contextItems, selection } = await this.contextController.collectCommandContext({
                includeCurrent: this.shouldIncludeCurrentNoteContext(),
            });
            this.currentSelection = selection;

            this.updateActivity();
            await this.chatController.processCommand(query, contextItems, this.currentSelection);

            // Clear context after sending (optional, maybe keep for multi-turn?)
            // Smart Composer clears context after send usually, unless pinned.
            // Let's clear for now.
            this.contextManager.clearContexts();
            this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
            await this.refreshKnowledgeStatusPanel();
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
        void this.getMessageRenderer().renderMessage(this.outputContainer, msg);
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
        this.updateInputToolbarCapabilities();
        if (isResponding) {
            // Show loading indicator (instance-scoped to avoid cross-view collisions)
            if (!this.loadingIndicatorEl) {
                const loadingDiv = this.outputContainer.createDiv({ cls: 'shell-entry system' });
                loadingDiv.setAttribute('role', 'status');
                loadingDiv.setAttribute('aria-live', 'polite');
                loadingDiv.createSpan({ cls: 'shell-loading' });
                loadingDiv.createSpan({ text: 'Thinking...' });
                this.loadingIndicatorEl = loadingDiv;
            }
            this.scrollToEnd();
        } else {
            // Remove loading indicator
            this.loadingIndicatorEl?.remove();
            this.loadingIndicatorEl = null;
        }
    }

    private handleStreamEvent(event: StreamEvent) {
        this.updateActivity();
        this.streamController.handleEvent(event);
    }

    private ensureStreamContainer() {
        if (this.streamContainer) return;

        this.loadingIndicatorEl?.remove();
        this.loadingIndicatorEl = null;

        this.streamContainer = this.outputContainer.createDiv({ cls: 'shell-entry ai shell-stream-container' });
        this.streamTimeline = this.streamContainer.createDiv({ cls: 'shell-think-timeline' });
        const streamTimeline = this.streamTimeline;
        this.thinkingRenderer = new ThinkingRenderer(streamTimeline);
        this.toolRenderer = new ToolRenderer(streamTimeline, {
            onToolUpdate: (run) => {
                this.tabManager.getActiveTab()?.state.upsertTool(run);
            },
        });

        const summary = streamTimeline.createDiv({ cls: 'shell-think-summary' });
        summary.createSpan({ cls: 'think-toggle', text: '\u25BC' });
        summary.createSpan({ cls: 'think-summary-text', text: 'Thinking in progress...' });
        summary.setAttribute('role', 'button');
        summary.setAttribute('tabindex', '0');
        summary.setAttribute('aria-expanded', 'true');
        summary.addEventListener('click', () => {
            this.toggleStreamTimeline(streamTimeline);
        });
        summary.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.toggleStreamTimeline(streamTimeline);
        });

        this.streamContent = this.streamContainer.createDiv({ cls: 'shell-response-content' });
        // 流式回复区声明为礼貌型 live region,读屏会随增量文本播报 AI 回复进展。
        this.streamContent.setAttribute('aria-live', 'polite');
        this.streamContent.setAttribute('aria-atomic', 'false');
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
    }

    private getStreamNodeCount() {
        return (this.thinkingRenderer?.getNodeCount() || 0) + (this.toolRenderer?.getNodeCount() || 0);
    }

    private toggleStreamTimeline(timeline: HTMLElement | null = this.streamTimeline) {
        if (!timeline) return;
        const nextCollapsed = !timeline.hasClass('is-collapsed');
        timeline.toggleClass('is-collapsed', nextCollapsed);
        const summary = timeline.querySelector('.shell-think-summary') as HTMLElement;
        summary?.setAttribute('aria-expanded', String(!nextCollapsed));
    }

    private handleTextDelta(content: string) {
        this.streamAccumulatedText += content;
        this.debouncedRenderStream();
    }

    /**
     * 把回复区累计的正文「毕业」为时间线里的过程思路节点。
     * 在工具调用出现时调用:此前这一轮流出的正文是「我打算做什么、为什么」的叙述,
     * 属于处理过程而非最终答案,沉淀进时间线;回复区随即清空,为下一轮腾空。
     */
    private graduateNarrationToTimeline() {
        this.debouncedRenderStream.flush();
        this.flushPendingStepDivider();
        const narration = this.streamAccumulatedText.trim();
        if (!narration) return;

        this.thinkingRenderer?.appendThinking(narration);
        this.streamNodeCount = this.getStreamNodeCount();
        this.streamAccumulatedText = '';
        // 回复区整体腾空:置空三段结构指针,下一帧 renderStreamContent 会重建,
        // 让下一轮正文从头开始块级渲染,不残留上一轮的稳定块。
        this.streamStableEl = null;
        this.streamTailEl = null;
        this.streamCursorEl = null;
        this.streamRenderedLen = 0;
    }

    /**
     * 若有待插入的回合分隔,在时间线当前末尾插入「Step N」分组标记。
     * 由「即将新增时间线节点」的路径(思考/叙述毕业/工具调用)触发,
     * 保证分隔总在本回合内容之上,且末轮无内容时不产生空分隔。
     */
    private flushPendingStepDivider() {
        if (!this.pendingStepDivider || !this.streamTimeline) return;
        this.pendingStepDivider = false;
        const divider = (this.streamTimeline as any).createDiv({ cls: 'shell-think-step-divider think-node' }) as HTMLElement;
        (divider as any).createSpan({ cls: 'shell-think-step-label', text: `Step ${this.streamStepCount}` });
    }

    /**
     * 流式途中的块级增量 Markdown 渲染(方案2)。
     *
     * 把累计文本按 Markdown「块边界」切成两段:
     *  - 已闭合的块(切分点之前):渲染成 HTML,追加进 streamStableEl 后冻结,后续增量不再触碰。
     *  - 尾部未闭合内容(切分点之后):作为纯文本写进 streamTailEl,块一旦闭合再晋升。
     *
     * 这样每帧只渲染「新闭合的那几个块」而非整段,总开销≈O(n),避免旧方案里
     * 「结束才渲染」的原始 Markdown 观感,也避免「每帧整段重渲」的 O(n²) 卡顿。
     */
    private renderStreamContent() {
        if (!this.streamContent) return;

        // 首帧:建立稳定块容器 + 尾部纯文本 + 光标三段结构。
        if (!this.streamTailEl) {
            this.streamContent.empty();
            this.streamStableEl = this.streamContent.createDiv({ cls: 'shell-stream-stable' });
            this.streamTailEl = this.streamContent.createDiv({ cls: 'shell-stream-plaintext' });
            this.streamCursorEl = document.createElement('span');
            this.streamCursorEl.className = 'shell-stream-cursor';
            this.streamContent.appendChild(this.streamCursorEl);
            this.streamRenderedLen = 0;
        }

        // 在「尚未晋升的尾部」里找一个安全切分点(围栏外的空行边界)。
        const pending = this.streamAccumulatedText.slice(this.streamRenderedLen);
        const splitInPending = findBlockBoundary(pending);
        if (splitInPending > 0) {
            const closedChunk = pending.slice(0, splitInPending);
            // 晋升:把新闭合的块渲染进独立子节点,追加到稳定容器,永不重渲。
            void this.appendStableBlock(closedChunk);
            this.streamRenderedLen += splitInPending;
        }

        // 尾部只做纯文本更新(浏览器只 diff 这一个文本节点),开销与尾部长度线性。
        this.streamTailEl.textContent = this.streamAccumulatedText.slice(this.streamRenderedLen);
        this.scrollToEnd();
    }

    /** 把一段已闭合的 Markdown 文本渲染进一个新的稳定块节点并追加,冻结不再重渲。 */
    private async appendStableBlock(markdown: string) {
        if (!this.streamStableEl) return;
        const blockEl = this.streamStableEl.createDiv({ cls: 'shell-stream-block' });
        await this.getMessageRenderer().renderAiContent(blockEl, markdown);
    }


    private finalizeStream() {
        this.debouncedRenderStream.flush();

        this.thinkingRenderer?.finalizeCurrentThinking();

        if (this.streamContent && this.streamAccumulatedText) {
            this.streamContent.empty();
            this.getMessageRenderer().renderAiContent(
                this.streamContent,
                this.streamAccumulatedText,
            ).then(() => {
                this.scrollToEnd();
            });
        }

        if (this.streamTimeline && this.streamNodeCount > 0) {
            const summaryText = this.streamTimeline.querySelector('.think-summary-text') as HTMLElement;
            if (summaryText) summaryText.textContent = `Thought through ${this.streamNodeCount} steps`;
            this.streamTimeline.addClass('is-collapsed');
            const summary = this.streamTimeline.querySelector('.shell-think-summary') as HTMLElement;
            summary?.setAttribute('aria-expanded', 'false');
        } else if (this.streamTimeline && this.streamNodeCount === 0) {
            this.streamTimeline.style.display = 'none';
        }

        if (this.streamContainer) {
            // 阶段C:用 tab.state 里刚落盘的真实 ai 消息(已带 assistantEntryId)渲染操作栏,
            // 而非临时空壳——否则 sessionEntryId 缺失,重试按钮的显示条件永不满足。
            // handleTabStreamEvent 在 done 时已先把 entryId 写进 tab.state,此处取最后一条 ai 消息即可。
            const activeMessages = this.tabManager.getActiveTab()?.state.getMessages() ?? [];
            const lastAiMessage = [...activeMessages].reverse().find(m => m.role === 'ai');
            // 就近填充分叉源问题文本:该 ai 回复紧邻其前的 user 消息原文,供底部「分叉」输入预填。
            const toolbarMessage: ChatMessage = lastAiMessage
                ? { ...lastAiMessage, forkSourceText: this.findPrecedingUserMessage(lastAiMessage)?.content }
                : {
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                    role: 'ai',
                    content: this.streamAccumulatedText,
                    timestamp: Date.now(),
                };
            this.getMessageRenderer().addActionToolbar(this.streamContainer, toolbarMessage);
        }

        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamStableEl = null;
        this.streamTailEl = null;
        this.streamCursorEl = null;
        this.streamRenderedLen = 0;
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
        this.streamStepCount = 0;
        this.pendingStepDivider = false;
        this.thinkingRenderer = null;
        this.toolRenderer = null;
        void this.persistActiveTab();
    }

    private getMessageRenderer(): MessageRenderer {
        if (!this.messageRenderer) {
            this.messageRenderer = new MessageRenderer({
                app: this.app,
                component: this,
                onApprove: async (message) => {
                    if (message.approval) {
                        await this.chatController.approveApproval(message.approval);
                    }
                },
                onCancel: (message) => {
                    if (message.approval) {
                        this.chatController.cancelApproval(message.approval);
                    }
                },
                onFocusApprovalPreview: async (message) => {
                    if (message.approval) {
                        await this.showApprovalPreviewInEditor(message.approval);
                    }
                },
                onFeedbackUp: async (message) => {
                    await this.chatController.recordPositiveFeedback(message.id);
                    await this.refreshKnowledgeStatusPanel();
                },
                onFeedbackDown: async (message, reason) => {
                    await this.chatController.recordNegativeFeedback(message.id, reason);
                },
                onRetry: (message) => this.handleRetryMessage(message),
                onEdit: (message, newText) => this.handleEditMessage(message, newText),
                onFork: (message, newText) => this.handleForkFromAi(message, newText),
                onSwitchBranch: (message, targetLeafId) => this.handleSwitchBranch(message, targetLeafId),
                onReviewCodeBlock: (content) => this.reviewCodeBlock(content),
                onUndoWorkspaceEdit: (editId) => this.chatController.undoWorkspaceEdit(editId),
                onInternalLinkClick: (href) => {
                    void this.app.workspace.openLinkText(href, '', false);
                },
                onScrollRequest: () => this.scrollToEnd(),
                onRenderError: (error) => {
                    logger.error('Markdown rendering failed', error, 'ShellView');
                },
            });
        }

        return this.messageRenderer;
    }

    private async reviewCodeBlock(newContent: string) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No active file to apply changes to.');
            return;
        }

        const originalContent = await this.app.vault.read(activeFile);
        new DiffModal(this.app, originalContent, newContent, async () => {
            await this.chatController.applyPreviewedChange({
                action: 'review_code_block',
                target: activeFile.path,
                previousContent: originalContent,
                apply: async () => {
                    await this.app.vault.modify(activeFile, newContent);
                    new Notice('Changes applied.');
                },
            });
        }).open();
    }

    private async refreshKnowledgeStatusPanel() {
        if (!this.shouldIncludeCurrentNoteContext()) {
            this.knowledgeStatusContainerEl?.empty();
            return;
        }
        await this.knowledgeStatusPanel?.refresh();
    }

    private shouldIncludeCurrentNoteContext() {
        const activePath = this.app.workspace?.getActiveFile?.()?.path;
        return !!activePath && this.excludedCurrentNotePath !== activePath;
    }

    private async showApprovalPreviewInEditor(approval: import('./approval-card').ApprovalRequest) {
        const previewText = approval.preview?.newContent ?? approval.args?.content;
        if (!previewText || typeof previewText !== 'string') {
            new Notice('No editor preview is available for this approval.');
            return;
        }

        const target = approval.target || approval.args?.path || approval.args?.filename;
        if (target) {
            await this.openApprovalTarget(target);
        }

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = activeView?.editor as any;
        const cmView = editor?.cm as EditorView | undefined;
        if (!cmView) {
            new Notice('Open the target note in source mode to show the preview.');
            return;
        }

        const line = Math.max(1, editor?.getCursor?.()?.line + 1 || 1);
        const ch = Math.max(0, editor?.getCursor?.()?.ch || 0);
        showGhostText(cmView, this.buildApprovalGhostPreview(previewText), line, ch);
        new Notice('Preview shown in the editor. Hover approval icons for actions.');
    }

    private async openApprovalTarget(path: string) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) return;
        const leaf = this.app.workspace.getLeaf(false);
        await leaf?.openFile?.(file as any);
    }

    private buildApprovalGhostPreview(content: string) {
        const lines = content.split(/\r?\n/).slice(0, 12);
        const suffix = content.split(/\r?\n/).length > lines.length ? '\n...' : '';
        return `\n${lines.join('\n')}${suffix}`;
    }

    async onClose() {
        await this.persistAllTabs();
        this.stopHeartbeat();
        // 释放思考计时器,避免视图关闭后 interval 泄漏。
        this.thinkingRenderer?.dispose();
        this.thinkingRenderer = null;
        this.hideHistoryMenu();
        this.tabBar?.destroy();
        this.tabBar = null;
        // Unsubscribe from provider changes
        this.unsubscribeProvider?.();
        this.unsubscribeProvider = null;
        // Prevent interval leaks from ChatController
        for (const session of this.tabSessions.values()) {
            session.chatController.cleanup();
        }
        this.tabSessions.clear();
        if (this.inputEl) {
            this.inputEl.removeEventListener('input', this.handleInputBound);
            this.inputEl.removeEventListener('keydown', this.handleKeyDownBound);
            this.inputEl.removeEventListener('paste', this.handlePasteBound);
            this.inputEl.removeEventListener('drop', this.handleDropBound);
        }
        const container = this.contentEl.querySelector('.baizer-shell-view');
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
            const warning = 'Long-running response detected. The provider may be stalled.';
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

        if (this.shouldIncludeCurrentNoteContext() && this.knowledgeStatusPanel) {
            this.knowledgeStatusContainerEl = container.createDiv({ cls: 'shell-knowledge-status-host' });
            this.knowledgeStatusPanel = new KnowledgeStatusPanel(this.knowledgeStatusContainerEl, {
                app: this.app,
                plugin: this.plugin,
                onAddRelatedContext: () => this.addBacklinksScopeContext(),
                onExcludeCurrentContext: (path) => this.excludeCurrentNoteContext(path),
                onOpenKnowledgeSettings: () => this.openPluginSettings(),
            });
            void this.refreshKnowledgeStatusPanel();
        }

        const explicitContainer = container.createDiv({ cls: 'shell-explicit-context-chips' });
        const activePath = this.app.workspace?.getActiveFile?.()?.path;
        const explicitContexts = this.contextManager.getContexts()
            .filter((ctx) => !(ctx.type === 'scope' && ctx.scope === 'current'))
            .filter((ctx) => !(ctx.type === 'file' && ctx.data === activePath));

        new ContextChips(explicitContainer, {
            onRemove: (id) => {
                this.contextManager.removeContext(id);
                this.renderContextChips(container);
            },
            onOpenFile: (path) => {
                void this.app.workspace.openLinkText(path, '', false);
            },
            onCompileFile: async (path) => {
                const result = await this.plugin?.knowledgeRuntime?.compileByPath?.(path);
                if (result) {
                    new Notice(`Knowledge compile: ${result.success} success, ${result.failed} failed`);
                }
                await this.refreshKnowledgeStatusPanel();
            },
            onAddRelatedContext: () => this.addBacklinksScopeContext(),
            onOpenSummary: (path) => {
                void this.openKnowledgeSummaryForPath(path);
            },
            onRunLint: () => {
                (this.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-lint`);
            },
            onCopyPath: (path) => {
                void globalThis.navigator?.clipboard?.writeText?.(path);
                new Notice('Copied note path.');
            },
            onOpenSettings: () => this.openPluginSettings(),
        }).update(explicitContexts);
    }

    private getContextChipsContainer() {
        return this.outputContainer?.parentElement?.querySelector('.shell-context-chips') as HTMLElement | null;
    }

    private createShellScaffold(container: HTMLElement) {
        const inputShell = container.createDiv({ cls: 'shell-input-shell' });
        const inputContainer = inputShell.createDiv({ cls: 'shell-input-container' });

        const contextBar = inputContainer.createDiv({ cls: 'shell-input-context-bar' });
        const contextContainer = contextBar.createDiv({ cls: 'shell-context-chips' });
        this.knowledgeStatusContainerEl = contextContainer.createDiv({ cls: 'shell-knowledge-status-host' });
        this.knowledgeStatusPanel = new KnowledgeStatusPanel(this.knowledgeStatusContainerEl, {
            app: this.app,
            plugin: this.plugin,
            onAddRelatedContext: () => this.addBacklinksScopeContext(),
            onExcludeCurrentContext: (path) => this.excludeCurrentNoteContext(path),
            onOpenKnowledgeSettings: () => this.openPluginSettings(),
        });
        this.renderContextChips(contextContainer);

        return inputContainer;
    }

    private createSuggestionContainer(inputContainer: HTMLElement) {
        const host = inputContainer.parentElement || inputContainer;
        return host.createDiv({ cls: 'shell-suggestions' });
    }

    private createHeaderActions(container: HTMLElement) {
        const actions = container.createDiv({ cls: 'shell-header-buttons' });
        this.createHeaderActionButton(actions, 'Search history', 'search', 'shell-history-btn', (event) => {
            event.stopPropagation();
            void this.toggleHistoryMenu();
        });
        this.createHeaderActionButton(actions, 'Settings', 'settings', 'shell-settings-btn', () => {
            this.openPluginSettings();
        });
    }

    private createHeaderActionButton(
        container: HTMLElement,
        label: string,
        icon: string,
        cls: string,
        handler: (event: MouseEvent) => void | Promise<void>,
    ) {
        const button = container.createEl('button', {
            cls: `clickable-icon shell-header-action ${cls}`,
            attr: { type: 'button', 'aria-label': label, title: label },
        });
        setIcon(button, icon);
        button.addEventListener('click', (event) => {
            void handler(event);
        });
        return button;
    }

    private showAvailableTools() {
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
            return;
        }
        new Notice('No tools available or tools not loaded yet.');
    }

    private addBacklinksScopeContext() {
        this.contextManager.addContext({
            id: 'scope:backlinks',
            type: 'scope',
            data: '@backlinks',
            summary: 'Add notes linking to the current note',
            scope: 'backlinks',
        });
        const contextContainer = this.getContextChipsContainer();
        if (contextContainer) this.renderContextChips(contextContainer);
        new Notice('Added @backlinks context.');
    }

    private async openKnowledgeSummaryForPath(path: string) {
        const status = await this.plugin?.knowledgeRuntime?.getStatusService?.()?.getNoteStatus?.(path);
        const summaryPath = status?.summaryPath;
        if (summaryPath && typeof (this.app.workspace as any)?.openLinkText === 'function') {
            await (this.app.workspace as any).openLinkText(summaryPath, '', false);
            return;
        }
        (this.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-open-index`);
    }

    private excludeCurrentNoteContext(path: string) {
        this.excludedCurrentNotePath = path;
        const contextContainer = this.getContextChipsContainer();
        if (contextContainer) this.renderContextChips(contextContainer);
        if (this.knowledgeStatusContainerEl) this.knowledgeStatusContainerEl.empty();
    }

    private prepareSelectionEdit() {
        if (!this.inputEl) return;
        if (!this.inputEl.value.trim().startsWith('/edit')) {
            this.inputEl.value = '/edit ';
        }
        this.inputEl.focus();
        this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
        this.adjustHeight();
    }

    private openPluginSettings() {
        // @ts-ignore - app setting tab activation
        this.app.setting.open();
        // @ts-ignore - activate plugin settings tab
        this.app.setting.openTabById(PLUGIN_ID);
    }

    /**
     * 打开文件附件弹窗：选中的本地文本文件读出内容后作为 type:'file' 上下文加入。
     * 走与 @ 文件相同的上下文链路（base-chat-runtime 会把 content 真正拼进 prompt）。
     */
    private handleAttachFiles() {
        new AttachmentModal(this.app, (results: AttachmentResult[]) => {
            if (!results.length) return;
            for (const result of results) {
                this.contextManager.addContext({
                    id: `attachment:${result.name}:${Date.now()}`,
                    type: 'file',
                    data: result.name,
                    content: result.content,
                    summary: result.name,
                });
            }
            const contextContainer = this.getContextChipsContainer();
            if (contextContainer) this.renderContextChips(contextContainer);
            new Notice(`Attached ${results.length} file${results.length > 1 ? 's' : ''}.`);
        }).open();
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

    private refreshInputToolbarProviders() {
        const settings = this.getPluginInstance()?.settings;
        if (!settings?.providers || !this.inputToolbar) return;

        this.inputToolbar.updateProviders(
            Object.entries(settings.providers).map(([id, config]) => ({
                id,
                label: config.label,
                configured: !!config.apiKey,
            })),
            settings.activeProvider || 'gemini',
        );
    }

    private async refreshInputToolbarModels(forceRefresh: boolean = false) {
        const settings = this.getPluginInstance()?.settings;
        if (!settings?.providers || !this.inputToolbar) return;

        const config = settings.providers[settings.activeProvider];
        if (!config) return;

        const requestId = ++this.modelLoadRequestId;
        this.inputToolbar.updateModels({
            loading: true,
            providerLabel: config.label,
            models: [],
            activeModelId: '',
        });

        try {
            const models = await this.modelService.getAvailableModels(forceRefresh);
            if (requestId !== this.modelLoadRequestId) return;

            this.inputToolbar.updateModels({
                loading: false,
                providerLabel: config.label,
                models,
                activeModelId: config.model || '',
            });
        } catch (error: any) {
            if (requestId !== this.modelLoadRequestId) return;
            logger.warn(
                `Failed to load model list: ${error?.message || 'Unknown error'}`,
                'ShellView.refreshInputToolbarModels'
            );
            this.inputToolbar.updateModels({
                loading: false,
                providerLabel: config.label,
                models: [],
                activeModelId: '',
            });
        }
    }

    private updateInputToolbarCapabilities() {
        const isResponding = this.tabManager.getActiveTab()?.isStreaming ?? this.isResponding;
        this.inputToolbar?.updateCapabilities({
            supportsImageInput: this.modelService.getProviderCapabilities().supportsImageInput,
            supportsCancellation: isResponding,
            isResponding,
            canSend: !!this.inputEl?.value.trim(),
        });
    }

    private async handleProviderChange(id: string) {
        const plugin = this.getPluginInstance();
        const config = plugin?.settings?.providers?.[id];
        if (!config?.apiKey) {
            this.handleUnavailableProvider(id);
            return;
        }

        await this.modelService.switchProvider(id, plugin ? () => plugin.saveSettings() : undefined);
        const activeTab = this.tabManager.getActiveTab();
        if (activeTab) {
            this.tabManager.updateTab(activeTab.id, {
                providerId: id,
                modelId: plugin?.settings?.providers?.[id]?.model || '',
                currentNote: this.getCurrentNotePath(),
            });
        }
        new Notice(`Switched to ${config.label}`);
    }

    private handleUnavailableProvider(id: string) {
        const plugin = this.getPluginInstance();
        const config = plugin?.settings?.providers?.[id];
        new Notice(`${config?.label || id} API Key is not configured. Please configure it in settings.`);
        // @ts-ignore - app setting tab activation
        this.app.setting.open();
        // @ts-ignore - activate plugin settings tab
        this.app.setting.openTabById(PLUGIN_ID);
        this.refreshInputToolbarProviders();
    }

    private async handleModelChange(modelId: string) {
        const plugin = this.getPluginInstance();
        await this.modelService.switchModel(modelId, plugin ? () => plugin.saveSettings() : undefined);
        const activeTab = this.tabManager.getActiveTab();
        if (activeTab) {
            this.tabManager.updateTab(activeTab.id, {
                providerId: this.getActiveProviderId(),
                modelId,
                currentNote: this.getCurrentNotePath(),
            });
        }
        new Notice(`Switched to ${modelId}`);
    }

    private async handleThinkingChange(level: ThinkingLevel) {
        const plugin = this.getPluginInstance();
        if (!plugin) return;
        plugin.settings.thinkingLevel = level;
        await plugin.saveSettings();
    }

    private refreshInputToolbarThinking() {
        const settings = this.getPluginInstance()?.settings;
        if (!settings || !this.inputToolbar) return;
        this.inputToolbar.updateThinking((settings.thinkingLevel ?? 'medium') as ThinkingLevel);
    }

    private async populateModelOptions(selectEl: HTMLSelectElement, forceRefresh: boolean = false) {
        const settings = this.getPluginInstance()?.settings;
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

            // 鐢ㄦ埛鍦ㄨ姹傛湡闂村垏鎹簡 provider锛屼涪寮冩棫璇锋眰缁撴灉
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
        const settings = this.getPluginInstance()?.settings;
        if (!settings?.providers) return;

        selectEl.empty();
        const active = settings.activeProvider || 'gemini';

        for (const [id, config] of Object.entries(settings.providers) as [string, any][]) {
            const configured = !!config.apiKey;
            const option = selectEl.createEl('option', {
                value: id,
                text: configured ? config.label : `${config.label} !`
            });
            if (id === active) option.selected = true;
        }
    }

    private updatePlaceholder() {
        if (!this.inputEl) return;
        const settings = this.getPluginInstance()?.settings;
        const config = settings?.providers?.[settings?.activeProvider];
        const label = config?.label || 'AI';
        this.inputEl.setAttr('placeholder', `Ask ${label}... (/ commands, @ context)`);
    }

    public async updateModelSelector(forceRefresh: boolean = false) {
        this.refreshInputToolbarProviders();
        await this.refreshInputToolbarModels(forceRefresh);
    }

    private clearChat() {
        this.outputContainer.empty();
        const activeTab = this.tabManager.getActiveTab();
        activeTab?.state.clearMessages();
        if (activeTab) {
            this.tabManager.updateTab(activeTab.id, {
                title: `Chat ${activeTab.index}`,
                createdAt: undefined,
                updatedAt: undefined,
                pinnedAt: undefined,
                providerId: this.getActiveProviderId(),
                modelId: this.getActiveModelId(),
                currentNote: this.getCurrentNotePath(),
            });
            void this.conversationController.deleteConversation(activeTab.id);
        }
        // Re-add welcome message
        this.appendMessage({
            id: 'init',
            role: 'system',
            content: 'Chat cleared.',
            timestamp: Date.now()
        });
        new Notice('Chat cleared');
    }

    private async createAndShowTab() {
        await this.persistActiveTab();
        const tab = this.tabManager.createTab();
        this.activateTabSession(tab.id);
        this.applyTabMetadata(tab);
        this.resetStreamState();
        this.renderActiveTabMessages();
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async switchTab(id: TabId) {
        if (this.tabManager.getActiveTab()?.id === id) {
            this.hideHistoryMenu();
            return;
        }

        await this.persistActiveTab();
        if (!this.tabManager.switchTab(id)) return;

        const activeTab = this.tabManager.getActiveTab();
        this.activateTabSession(id);
        if (activeTab) {
            await this.syncProviderStateForTab(activeTab);
        }
        this.resetStreamState();
        this.renderActiveTabMessages();
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async closeTab(id: TabId) {
        const tabToClose = this.tabManager.getAllTabs().find(item => item.id === id) ?? null;
        await this.persistTab(tabToClose);
        const wasActive = this.tabManager.getActiveTab()?.id === id;
        if (!this.tabManager.closeTab(id)) return;

        const session = this.tabSessions.get(id);
        session?.chatController.cleanup();
        this.tabSessions.delete(id);
        // 释放该会话的 pi session 内存态(磁盘文件与持久 ref 保留,再次打开可恢复)。
        this.modelService.releaseSession(id);
        this.hideHistoryMenu();

        if (wasActive) {
            const activeTab = this.tabManager.getActiveTab();
            if (activeTab) {
                this.activateTabSession(activeTab.id);
                await this.syncProviderStateForTab(activeTab);
                this.resetStreamState();
                this.renderActiveTabMessages();
            }
        }
    }

    private getPluginInstance(): IPlugin | undefined {
        return this.plugin ?? (this.app as any).plugins.plugins[PLUGIN_ID];
    }

    private ensureActiveTabSession(): ShellTabSession {
        let activeTab = this.tabManager.getActiveTab();
        if (!activeTab) {
            activeTab = this.tabManager.createTab();
            this.applyTabMetadata(activeTab);
        }

        return this.activateTabSession(activeTab.id);
    }

    private activateTabSession(id: TabId): ShellTabSession {
        const session = this.getOrCreateTabSession(id);
        this.chatController = session.chatController;
        this.contextManager = session.contextManager;
        this.contextController = session.contextController;
        return session;
    }

    private getOrCreateTabSession(id: TabId): ShellTabSession {
        const existing = this.tabSessions.get(id);
        if (existing) return existing;

        const contextManager = new ContextManager();
        const contextController = new ContextController({
            app: this.app,
            contextManager,
        });
        const chatController = new ChatController({
            app: this.app,
            api: this.modelService,
            conversationId: id,
            onMessageAdded: (msg) => this.handleTabMessageAdded(id, msg),
            onStatusChanged: (status) => this.handleTabStatusChanged(id, status),
            onStreamEvent: (event) => this.handleTabStreamEvent(id, event),
            onClear: () => this.handleTabClear(id),
            onWorkspaceEdit: (edit) => this.handleTabWorkspaceEdit(id, edit),
            onWorkspaceEditUndone: (edit) => this.handleTabWorkspaceEditUndone(id, edit),
            onWorkspaceEditUndoFailed: (message) => this.handleWorkspaceEditUndoFailed(id, message),
        });

        const session = { chatController, contextManager, contextController };
        this.tabSessions.set(id, session);
        return session;
    }

    private handleTabMessageAdded(tabId: TabId, msg: ChatMessage) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        if (tab) {
            tab.state.addMessage(msg);
        }

        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.appendMessage(msg);
        } else {
            this.tabManager.markAttention(tabId, true);
        }
    }

    /** /clear:清空该 tab 的可见历史(tab.state)并重渲(修 /clear 不清屏)。 */
    private handleTabClear(tabId: TabId) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        tab?.state.clearMessages();
        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.resetStreamState();
            this.renderActiveTabMessages();
        }
    }

    private handleTabStatusChanged(tabId: TabId, isResponding: boolean) {
        this.tabManager.markStreaming(tabId, isResponding);
        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.handleStatusChange(isResponding);
        }
    }

    private handleTabStreamEvent(tabId: TabId, event: StreamEvent) {
        if (event.type === 'done') {
            const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
            if (tab) {
                // 阶段B:把本轮 entryId 锚定到 tab.state 的消息(阶段C 分叉/重试的定位依据)。
                // user entry 打到最近一条尚未锚定的 user 消息;assistant entry 打到本轮新建的 ai 消息。
                const entryIds = event.entryIds;
                if (entryIds?.userEntryId) {
                    const messages = tab.state.getMessages();
                    for (let i = messages.length - 1; i >= 0; i--) {
                        if (messages[i].role === 'user' && !messages[i].sessionEntryId) {
                            tab.state.updateMessage(messages[i].id, { sessionEntryId: entryIds.userEntryId });
                            break;
                        }
                    }
                }
                if (event.text) {
                    tab.state.addMessage({
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                        role: 'ai',
                        content: event.text,
                        timestamp: Date.now(),
                        sessionEntryId: entryIds?.assistantEntryId,
                        metadata: event.interrupted ? { interrupted: true } : undefined,
                    });
                }
            }
        }

        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.handleStreamEvent(event);
        } else {
            this.tabManager.markAttention(tabId, true);
        }
    }

    private handleTabWorkspaceEdit(tabId: TabId, edit: WorkspaceEditSummary) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        if (!tab) return;

        tab.state.upsertWorkspaceEdit(edit);
        const message = this.createWorkspaceEditMessage(edit);
        const alreadyRendered = tab.state.getMessages().some(item => item.id === message.id);
        if (alreadyRendered) {
            tab.state.updateMessage(message.id, message);
        } else {
            tab.state.addMessage(message);
        }

        if (this.tabManager.getActiveTab()?.id === tabId) {
            if (alreadyRendered) {
                this.renderActiveTabMessages();
            } else {
                this.appendMessage(message);
            }
        } else {
            this.tabManager.markAttention(tabId, true);
        }
    }

    private handleTabWorkspaceEditUndone(tabId: TabId, edit: WorkspaceEditSummary) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        tab?.state.upsertWorkspaceEdit(edit);
        tab?.state.updateMessage(this.getWorkspaceEditMessageId(edit.id), {
            metadata: { workspaceEdit: edit },
        });

        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.renderActiveTabMessages();
        }
        new Notice(`Reverted ${this.basename(edit.path)}.`);
    }

    private handleWorkspaceEditUndoFailed(tabId: TabId, message: string) {
        new Notice(message);
    }

    private createWorkspaceEditMessage(edit: WorkspaceEditSummary): ChatMessage {
        return {
            id: this.getWorkspaceEditMessageId(edit.id),
            role: 'system',
            content: '',
            timestamp: edit.appliedAt || Date.now(),
            metadata: { workspaceEdit: edit },
        };
    }

    private getWorkspaceEditMessageId(editId: string): string {
        return `workspace-edit-${editId}`;
    }

    private basename(path: string): string {
        return path.split(/[\\/]/).filter(Boolean).pop() || path;
    }

    private updateTabBar() {
        this.tabBar?.update(this.tabManager.toTabBarItems());
    }

    private async toggleHistoryMenu() {
        if (!this.historyMenu || !this.historyMenuContainerEl) return;

        if (this.historyMenuContainerEl.style.display === 'block') {
            this.hideHistoryMenu();
            return;
        }

        await this.refreshHistoryMenu();
    }

    private hideHistoryMenu() {
        this.historyMenu?.hide();
    }

    private async openConversationFromHistory(id: string) {
        const existing = this.tabManager.getAllTabs().find(tab => tab.id === id);
        if (existing) {
            await this.switchTab(existing.id);
            return;
        }

        const history = await this.conversationController.listHistory();
        const snapshot = history.find(item => item.id === id);
        if (!snapshot) {
            new Notice('Saved conversation not found.');
            this.hideHistoryMenu();
            return;
        }

        await this.persistActiveTab();
        const restoredTab = this.conversationController.restoreConversation(snapshot, this.tabManager);
        this.activateTabSession(restoredTab.id);
        await this.syncProviderStateForTab(restoredTab);
        this.resetStreamState();
        this.renderActiveTabMessages();
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async deleteConversationFromHistory(id: string) {
        await this.conversationController.deleteConversation(id);

        await this.refreshHistoryMenu();
        new Notice('Conversation deleted.');
    }

    private async persistAllTabs() {
        for (const tab of this.tabManager.getAllTabs()) {
            await this.persistTab(tab);
        }
    }

    private async persistActiveTab() {
        await this.persistTab(this.tabManager.getActiveTab());
    }

    private async persistTab(tab: TabData | null) {
        const snapshot = await this.conversationController.saveActiveTab(tab);
        if (!snapshot) return;

        this.tabManager.updateTab(snapshot.id, {
            title: snapshot.title,
            providerId: snapshot.providerId,
            modelId: snapshot.modelId,
            currentNote: snapshot.currentNote,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            pinnedAt: snapshot.pinnedAt,
        });
    }

    private applyTabMetadata(tab: TabData) {
        this.tabManager.updateTab(tab.id, {
            providerId: tab.providerId || this.getActiveProviderId(),
            modelId: tab.modelId || this.getActiveModelId(),
            currentNote: tab.currentNote || this.getCurrentNotePath(),
            createdAt: tab.createdAt,
            updatedAt: tab.updatedAt,
            pinnedAt: tab.pinnedAt,
        });
    }

    private async syncProviderStateForTab(tab: TabData) {
        const plugin = this.getPluginInstance();
        const settings = plugin?.settings;
        const providerId = tab.providerId;
        const modelId = tab.modelId;

        if (providerId && settings?.providers?.[providerId]?.apiKey && providerId !== settings.activeProvider) {
            await this.modelService.switchProvider(providerId, plugin ? () => plugin.saveSettings() : undefined);
        }

        if (modelId && modelId !== this.getActiveModelId()) {
            await this.modelService.switchModel(modelId, plugin ? () => plugin.saveSettings() : undefined);
        }

        this.refreshInputToolbarProviders();
        await this.refreshInputToolbarModels(true);
        this.handleStatusChange(tab.isStreaming);
        this.updatePlaceholder();
    }

    private toHistoryMenuItem(snapshot: ConversationSnapshot) {
        return {
            id: snapshot.id,
            title: snapshot.title,
            updatedAt: snapshot.updatedAt,
            providerId: snapshot.providerId,
            modelId: snapshot.modelId,
            currentNote: snapshot.currentNote,
            pinnedAt: snapshot.pinnedAt,
            isActive: snapshot.id === this.tabManager.getActiveTab()?.id,
        };
    }

    private async refreshHistoryMenu() {
        const history = await this.conversationController.listHistory();
        this.historyMenu?.update(history.map(snapshot => this.toHistoryMenuItem(snapshot)));
    }

    private async toggleConversationPin(id: string) {
        const history = await this.conversationController.listHistory();
        const snapshot = history.find(item => item.id === id);
        if (!snapshot) {
            new Notice('Saved conversation not found.');
            await this.refreshHistoryMenu();
            return;
        }

        const nextPinned = !snapshot.pinnedAt;
        const updated = await this.conversationController.togglePinned(id, nextPinned);
        if (!updated) {
            new Notice('Unable to update conversation pin.');
            await this.refreshHistoryMenu();
            return;
        }

        this.tabManager.updateTab(id, {
            pinnedAt: updated.pinnedAt,
        });
        await this.refreshHistoryMenu();
        new Notice(updated.pinnedAt ? 'Conversation pinned.' : 'Conversation unpinned.');
    }

    private stopActiveResponse() {
        if (!this.chatController?.cancelActiveStream()) {
            return;
        }

        this.updateInputToolbarCapabilities();
    }

    private getActiveProviderId(): string {
        return this.getPluginInstance()?.settings?.activeProvider || 'gemini';
    }

    private getActiveModelId(): string {
        const settings = this.getPluginInstance()?.settings;
        return settings?.providers?.[settings.activeProvider]?.model || '';
    }

    private getCurrentNotePath(): string | undefined {
        return this.app.workspace.getActiveFile()?.path;
    }

    // ---- 阶段C:分支操作(切换 / 重试 / 编辑重问)----

    /**
     * 用会话分支投影重建当前 tab 的 state 并重渲。
     * skipLeading:切掉投影头部的「隐藏祖先」条数——持久 session(按 tab)可能累积了当前
     * 可见窗口之上、用户看不到的更早历史,全量 root→leaf 投影会把它们翻出来。只渲染尾部窗口。
     */
    private rebuildActiveTabFromProjection(messages: ChatMessage[], skipLeading = 0) {
        const tab = this.tabManager.getActiveTab();
        if (!tab) return;
        const windowed = skipLeading > 0 ? messages.slice(skipLeading) : messages;
        tab.state.clearMessages();
        for (const message of windowed) {
            tab.state.addMessage(message);
        }
        this.renderActiveTabMessages();
    }

    /** 切换到某兄弟分支:纯投影切换,不发起生成。保持当前可见窗口(不翻出隐藏祖先)。 */
    private async handleSwitchBranch(_message: ChatMessage, targetLeafId: string) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid) return;
        // 切换前先算「隐藏祖先」条数 = 全量投影长度 − 当前可见条数。该边界在切换前后不变。
        const visibleBefore = this.tabManager.getActiveTab()?.state.getMessages().length ?? 0;
        const before = await this.modelService.getBranchProjection(cid);
        const hiddenCount = before ? Math.max(0, before.length - visibleBefore) : 0;

        const projection = await this.modelService.switchBranch(cid, targetLeafId);
        if (projection) {
            this.rebuildActiveTabFromProjection(projection, hiddenCount);
        } else {
            new Notice('无法切换分支。');
        }
    }

    /** 从某条 ai 回复分叉:用新文本重跑它对应的 user 提问,产生兄弟分支。 */
    private async handleForkFromAi(aiMessage: ChatMessage, newText: string) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid) return;
        const userMessage = this.findPrecedingUserMessage(aiMessage);
        if (!userMessage?.sessionEntryId) {
            new Notice('无法定位要分叉的问题。');
            return;
        }
        await this.forkAndRerun(cid, userMessage.sessionEntryId, newText);
    }

    /** 重试某条 ai 回复:定位到它对应的 user 消息之前,用原文重跑,产生兄弟分支。 */
    private async handleRetryMessage(aiMessage: ChatMessage) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid) return;
        const userMessage = this.findPrecedingUserMessage(aiMessage);
        if (!userMessage?.sessionEntryId) {
            new Notice('无法定位要重试的问题。');
            return;
        }
        // 重试:同一问题重生成,新答案换掉旧的、不保留旧分支(supersede=true)。
        await this.forkAndRerun(cid, userMessage.sessionEntryId, userMessage.content, true);
    }

    /** 编辑重问某条 user 消息:定位到它之前,用新文本重跑,产生兄弟分支。 */
    private async handleEditMessage(userMessage: ChatMessage, newText: string) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid || !userMessage.sessionEntryId) {
            new Notice('无法编辑该消息。');
            return;
        }
        await this.forkAndRerun(cid, userMessage.sessionEntryId, newText);
    }

    /**
     * 分支重跑的公共流程:
     * 1. prepareRetryFromUser 把会话 leaf 移到目标 user 消息之前(定位分叉点);
     * 2. 把 UI 历史截断到该 user 之前(丢弃旧问答的渲染,新一轮从此处长出);
     * 3. 走正常 processCommand(text) 流式重跑,新回复与原问答成为兄弟分支;
     * 4. 完成后用投影校正 tab.state,使兄弟导航条 `< n/m >` 计数正确。
     */
    private async forkAndRerun(conversationId: string, userEntryId: string, text: string, supersede = false) {
        // 先算「隐藏祖先」条数 = 操作前全量投影长度 − 当前可见条数。持久 session(按 tab)可能累积了
        // 当前可见窗口之上、用户看不到的更早历史;最终重投影须切掉这段头部,只渲染可见窗口。
        // 该边界在整个重跑过程中不变(重跑只在窗口内增删),故此处一次算好。
        const visibleBefore = this.tabManager.getActiveTab()?.state.getMessages().length ?? 0;
        const beforeProjection = await this.modelService.getBranchProjection(conversationId);
        const hiddenCount = beforeProjection ? Math.max(0, beforeProjection.length - visibleBefore) : 0;

        const positioned = await this.modelService.prepareRetryFromUser(conversationId, userEntryId, { supersede });
        if (!positioned) {
            new Notice('无法定位分叉点,已取消重跑。');
            return;
        }

        // UI 截断:移除目标 user 消息及其之后的所有消息(它们属于旧分支,重渲时由投影恢复计数)。
        const tab = this.tabManager.getActiveTab();
        if (tab) {
            const messages = tab.state.getMessages();
            const cutIndex = messages.findIndex(m => m.sessionEntryId === userEntryId);
            if (cutIndex >= 0) {
                for (let i = messages.length - 1; i >= cutIndex; i--) {
                    tab.state.removeMessage(messages[i].id);
                }
            }
            this.renderActiveTabMessages();
        }

        // 流式重跑;processCommand 会追加新的 user 消息并流式渲染 ai 回复。
        await this.processCommand(text);

        // 校正:重跑后用投影重建,确保分叉点 user 消息带上正确的兄弟计数与切换目标;
        // 切掉隐藏祖先头部,避免把可见窗口之上的旧历史翻出来渲染到界面。
        const projection = await this.modelService.getBranchProjection(conversationId);
        if (projection) {
            this.rebuildActiveTabFromProjection(projection, hiddenCount);
        }
    }

    /** 找到某条 ai 消息在当前 tab 历史中紧邻其前的 user 消息(重试时用它的原始提问)。 */
    private findPrecedingUserMessage(aiMessage: ChatMessage): ChatMessage | null {
        const messages = this.tabManager.getActiveTab()?.state.getMessages() ?? [];
        const aiIndex = messages.findIndex(m => m.id === aiMessage.id);
        if (aiIndex < 0) return null;
        for (let i = aiIndex - 1; i >= 0; i--) {
            if (messages[i].role === 'user') return messages[i];
        }
        return null;
    }

    private renderActiveTabMessages() {
        if (!this.outputContainer) return;

        this.outputContainer.empty();
        const activeTab = this.tabManager.getActiveTab();
        const messages = activeTab?.state.getMessages() ?? [];

        if (messages.length === 0) {
            this.appendMessage({
                id: 'init',
                role: 'system',
                content: 'Kernel initialized.',
                timestamp: Date.now(),
            });
            return;
        }

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            // ai 消息就近继承其前一条 user 的分支信息与原文,供底部「分叉 / < n/m >」渲染。
            // (projector 把 branch 挂在 user 消息上;分叉入口在 ai 操作栏,故此处桥接。)
            if (message.role === 'ai') {
                const prevUser = this.findPrecedingUserInList(messages, i);
                this.appendMessage({
                    ...message,
                    branch: message.branch ?? prevUser?.branch,
                    forkSourceText: message.forkSourceText ?? prevUser?.content,
                });
            } else {
                this.appendMessage(message);
            }
        }
    }

    /** 在给定消息数组中,找到 index 之前紧邻的一条 user 消息。 */
    private findPrecedingUserInList(messages: ChatMessage[], index: number): ChatMessage | null {
        for (let i = index - 1; i >= 0; i--) {
            if (messages[i].role === 'user') return messages[i];
        }
        return null;
    }

    private resetStreamState() {
        this.debouncedRenderStream.cancel();
        // 丢弃流时主动释放思考计时器,避免 interval 泄漏(切换/关闭标签页会走到这里)。
        this.thinkingRenderer?.dispose();
        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamStableEl = null;
        this.streamTailEl = null;
        this.streamCursorEl = null;
        this.streamRenderedLen = 0;
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
        this.streamStepCount = 0;
        this.pendingStepDivider = false;
        this.thinkingRenderer = null;
        this.toolRenderer = null;
    }
}
