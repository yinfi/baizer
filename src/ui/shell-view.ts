import { App, Editor, ItemView, TFile, WorkspaceLeaf, Notice, MarkdownView, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ModelService } from '../services/model-service';
import { logger } from '../utils/logger';
import { ChatController, ChatTurnRequest, MessageAddedOptions } from './chat-controller';
import { ContextItem, ContextManager } from '../services/context-manager';
import { DiffModal } from './diff-modal';
import { DEFAULT_SETTINGS, IPlugin, PLUGIN_ID, PLUGIN_NAME, VIEW_TYPE_SHELL } from '../mcp/types';
import { ChatTurnOutcome, StreamEvent } from '../models/interfaces';
import { buildCommandSuggestions, CommandSuggestion } from './command-suggestions';
import { t } from '../i18n/zh';
import { ContextController } from './controllers/context-controller';
import { SuggestionType, SuggestionItem, SuggestionSelection } from './controllers/input-controller';
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
import { GrowthToken, ScrollFollowController } from './scroll/scroll-follow-controller';
import { debounce } from '../utils/throttle';
import { thrownMessage } from '../utils/thrown-message';

/** Obsidian App 上未在公开 d.ts 暴露的内部命令 API。 */
type AppWithCommands = App & {
    commands?: { executeCommandById?(commandId: string): boolean };
};

/** Obsidian App 上未在公开 d.ts 暴露的设置页 API。 */
type AppWithSetting = App & {
    setting: { open(): void; openTabById(id: string): void };
};

/** Obsidian App 上未在公开 d.ts 暴露的插件注册表。 */
type AppWithPluginRegistry = App & {
    plugins: { plugins: Record<string, IPlugin> };
};

/** Obsidian Editor 上未在公开 d.ts 暴露的 CodeMirror 6 视图。 */
type EditorWithCm = Editor & { cm?: EditorView };

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
    // 头部作用域胶囊:显示当前作用笔记名(绿点=已作用/灰=无作用域)。
    private scopePillEl: HTMLElement | null = null;
    private scopePillNameEl: HTMLElement | null = null;
    private tabSessions = new Map<TabId, ShellTabSession>();
    // 每个 tab 一棵独立消息子树,挂在 outputContainer 下;切换时切 display 而非全量重建。
    private tabContainers = new Map<TabId, HTMLElement>();
    // think-summary 折叠交互的事件委托是否已绑定到 outputContainer(幂等标记,防重复绑定)。
    private timelineDelegationBound = false;
    // 后台(非活动)tab 收到新消息/流事件时标脏,切回时强制重建以补齐 DOM。
    private dirtyTabs = new Set<TabId>();
    // 滚动跟随策略:每会话的跟随/未读/阅读位置,以及延迟滚动回调的会话身份校验。
    private scrollFollow: ScrollFollowController | null = null;
    // 流式渲染代次:切换 tab / 开新回合时自增,异步渲染回调用旧代次 token 一律丢弃,
    // 避免一次迟到的 Markdown 完成回调滚动另一个会话或另一个回合的视口。
    private renderGeneration = 0;
    // 「有新输出 · 回到最新」入口:仅当活动会话暂停跟随后确有新输出时显示。
    private unreadBarEl: HTMLElement | null = null;
    private unreadButtonEl: HTMLButtonElement | null = null;
    // T14 消息 DOM 虚拟化:监听每条消息 entry,滚出视口+缓冲区即脱水为等高占位,滚入再挂回。
    private messageObserver: IntersectionObserver | null = null;
    // 脱水态 entry → 其被摘下的子树(等高占位期间寄存于此,滚入时挂回)。WeakMap 随节点回收自动清理。
    private dehydratedEntries = new WeakMap<HTMLElement, DocumentFragment>();
    private conversationController: ConversationController;
    private historyMenu: HistoryMenu | null = null;
    private historyMenuContainerEl: HTMLElement | null = null;
    /** 触发历史菜单的按钮:菜单关闭(Esc/点外部)后把焦点还给它,不让焦点掉到 body。 */
    private historyMenuTriggerEl: HTMLElement | null = null;
    private knowledgeStatusPanel: KnowledgeStatusPanel | null = null;
    private knowledgeStatusContainerEl: HTMLElement | null = null;
    private excludedCurrentNotePath: string | null = null;

    // Heartbeat monitoring
    private heartbeatInterval: number | null = null;
    private lastActivityTime: number = Date.now();
    private heartbeatIntervalMs: number = 30000; // 30s check
    private isResponding: boolean = false;
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
    /** 已晋升为稳定块的文本前缀长度(streamAccumulatedText 的字符数),尾部从此处开始。 */
    private streamRenderedLen = 0;
    private streamAccumulatedText: string = '';
    /**
     * 本轮流开始时投影里最后一条 ai 消息的 id。
     * finalizeStream 靠它判断「最后一条 ai」是本轮新落的还是上一轮的残留——
     * 本轮没有最终正文时不落消息(纯工具轮次),若不比对就会把操作栏
     * 挂到上一轮的回复上,👍/👎/重试全部作用在错误的消息。
     */
    private streamPriorLastAiId: string | null = null;
    /**
     * 进行中轮次的请求现场(原文 + 附件上下文),按 tab 暂存。
     * 失败/取消时据此恢复输入区与上下文;成功则丢弃。
     */
    private pendingDrafts = new Map<TabId, ChatTurnRequest>();
    /**
     * 失败/取消轮次的原请求现场,按落下的 AI 消息 id 索引。
     * 失败卡片的「恢复草稿」用它;刷新后内存丢失,按钮自然不出现(不提供死入口)。
     */
    private draftRequests = new Map<string, ChatTurnRequest>();
    private streamNodeCount = 0;
    /** 智能体工具循环回合数(step_boundary 计数),用于时间线「Step N」分组标签。 */
    private streamStepCount = 0;
    /** 待插入的回合分隔:置位后由下一个时间线节点触发真正插入,避免空分隔。 */
    private pendingStepDivider = false;
    private readonly debouncedRenderStream = debounce(
        () => this.renderStreamContent(),
        { wait: 100 }
    );
    /** metadataCache changed 高频事件的合并刷新,避免批量文件操作触发连续面板刷新。 */
    private readonly debouncedRefreshKnowledgeStatus = debounce(
        () => { void this.refreshKnowledgeStatusPanel(); },
        { wait: 500 }
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
            // IME 组合输入中(如中文候选词确认)按 Enter 只应确认候选词,不触发提交。
            // 必须在 preventDefault 之前判定并放行,否则会吞掉 IME 的确认键。
            if (e.isComposing) return;
            e.preventDefault(); // Prevent newline

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
    // 停止无条件贴底后,scroll 事件负责「上翻暂停 / 回到底部恢复」。
    private handleOutputScrollBound = () => this.scrollFollow?.handleScroll();
    // 真实输入:恢复位置还没执行时取消它。布局/切 tab 产生的 scroll 不经过这里。
    private handleOutputScrollIntentBound = () => this.scrollFollow?.handleUserScrollIntent();
    // 真实输入结束:普通点击/选文本没有移动视口时,把被取消的恢复重新排上。
    private handleOutputScrollIntentEndBound = () => this.scrollFollow?.handleUserScrollIntentEnd();
    // 滚轮向上是明确的阅读意图:立即暂停,不等 scroll 事件或下一次 token。
    private handleOutputWheelBound = (e: WheelEvent) => {
        if (e.deltaY < 0) this.scrollFollow?.handleUserScrollIntentUp();
        else this.scrollFollow?.handleUserScrollIntent();
    };
    // 键盘滚动键同样是真实输入(ArrowUp/Down、PageUp/Down、Home/End、空格)。
    private handleOutputKeyDownBound = (e: KeyboardEvent) => {
        // 焦点在按钮/链接/输入框上时，空格与方向键是控件操作，不是滚动视口。
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, textarea, select, [role="button"]')) return;
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            this.scrollFollow?.handleUserScrollIntent();
        }
    };

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
                const growth = this.captureScrollGrowth();
                this.ensureStreamContainer();
                this.flushPendingStepDivider();
                this.thinkingRenderer?.appendThinking(content);
                this.streamNodeCount = this.getStreamNodeCount();
                this.afterScrollGrowth(growth, true);
            },
            onToolCall: (name, args) => {
                const growth = this.captureScrollGrowth();
                this.ensureStreamContainer();
                // 工具调用出现 = 此前回复区的正文是「这一步的过程叙述」,
                // 把它毕业进时间线作为思路节点,并清空回复区为下一轮腾空。
                this.graduateNarrationToTimeline();
                this.thinkingRenderer?.finalizeCurrentThinking();
                this.toolRenderer?.addToolCall(name, args);
                this.streamNodeCount = this.getStreamNodeCount();
                this.afterScrollGrowth(growth, true);
            },
            onToolResult: (name, result, error) => {
                const growth = this.captureScrollGrowth();
                this.toolRenderer?.updateToolResult(name, result, error);
                // 工具结果也是新输出；暂停中的读者应看到返回入口。
                this.afterScrollGrowth(growth, true);
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
            onDone: (finalText, outcome) => this.finalizeStream(outcome ?? 'completed', finalText),
            onError: (message) => this.finalizeStream('failed', undefined, message),
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
        // 作用域胶囊:绿点 + 当前作用笔记名,替代原静态 "Ready - current note scoped"。
        const scopePill = headerCopy.createDiv({ cls: 'shell-scope-pill' });
        scopePill.createSpan({ cls: 'shell-scope-dot' });
        this.scopePillNameEl = scopePill.createSpan({ cls: 'shell-scope-name' });
        this.scopePillEl = scopePill;
        this.updateScopePill();
        this.tabBarContainerEl = headerTitle.createDiv({ cls: 'shell-tab-bar-container' });
        this.createHeaderActions(header);

        this.historyMenuContainerEl = header.createDiv({ cls: 'baizer-history-menu baizer-hidden' });
        this.historyMenu = new HistoryMenu(this.historyMenuContainerEl, {
            onOpen: (id) => this.openConversationFromHistory(id),
            onDelete: (id) => this.deleteConversationFromHistory(id),
            onTogglePin: (id) => this.toggleConversationPin(id),
            onClose: () => this.hideHistoryMenu(),
        });
        this.historyMenu.hide();

        // 2. Output Area (Scrollable)
        this.outputContainer = container.createDiv({ cls: 'shell-output-area' });
        // think-summary 折叠交互采用事件委托(避免每轮流式在 summary 上累积监听器)。
        // 抽成幂等方法,onOpen 与流式入口都会确保绑定,不依赖初始化路径是否完整走过。
        this.ensureTimelineDelegation();
        this.bindScrollFollowListeners();
        this.createUnreadBar(container);
        this.createScrollFollowController();

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
        // 首次打开:新会话定位到最新(与「切回已有会话恢复阅读位置」明确区分)。
        if (activeTab) this.scrollFollow?.activateSession(activeTab.id, 'new');

        // 3. Input Area (Fixed at bottom)
        const inputContainer = this.createShellScaffold(container);
        void this.refreshKnowledgeStatusPanel();
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.excludedCurrentNotePath = null;
                const contextContainer = this.getContextChipsContainer();
                if (contextContainer) this.renderContextChips(contextContainer);
                void this.refreshKnowledgeStatusPanel();
                this.updateScopePill();
            })
        );
        this.registerEvent(
            // 批量文件操作会高频触发 changed;debounce 500ms 合并,避免连续刷新知识状态面板。
            this.app.metadataCache.on('changed', this.debouncedRefreshKnowledgeStatus)
        );

        // Suggestion Popup
        this.suggestionContainer = this.createSuggestionContainer(inputContainer);

        // Input wrapper (contains the textarea)
        const inputWrapper = inputContainer.createDiv({ cls: 'shell-input-wrapper' });

        this.inputEl = inputWrapper.createEl('textarea', {
            cls: 'shell-input',
            attr: {
                placeholder: 'Ask AI... (/ commands, @ context)',
                'aria-label': t('Send a message to AI'),
                spellcheck: 'false',
                autocomplete: 'off',
                rows: '1'
            }
        });
        // Set provider-specific placeholder.
        this.updatePlaceholder();

        // 补全挂载器须在 textarea 之后构造:hostInput 指向 textarea,自动维护 combobox 的 ARIA 关联。
        this.suggestList = new SuggestList({
            container: this.suggestionContainer,
            provideItems: (type, query) => this.buildSuggestionItems(type, query),
            onApply: (selection) => this.applySuggestionSelection(selection),
            hostInput: this.inputEl,
        });

        // 4. Input Controls (below the textarea)
        const inputControls = inputContainer.createDiv({ cls: 'shell-input-controls' });
        this.inputToolbar = new InputToolbar(inputControls, {
            onModelSelect: (providerId, modelId) => this.handleModelSelect(providerId, modelId),
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
            void this.refreshInputToolbarModels(true);
            this.updateInputToolbarCapabilities();
            this.updatePlaceholder();
        });

        // Start heartbeat monitoring
        this.startHeartbeat();
    }

    adjustHeight() {
        this.inputEl.setCssStyles({ height: 'auto' });
        this.inputEl.setCssStyles({ height: `${this.inputEl.scrollHeight}px` });
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
            const userCommands = (typeof this.modelService.getUserCommandsSync === 'function'
                ? this.modelService.getUserCommandsSync()
                : []).map((command) => ({
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
                this.updateScopePill();
            }
            this.contextManager.addContext(selection.contextItem);
            this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
            void this.refreshKnowledgeStatusPanel();
        }
        this.inputEl.focus();
    }

    private buildContextScopeSuggestions(query: string) {
        const normalized = query.toLowerCase();
        const suggestions: SuggestionItem[] = [
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
        const session = this.ensureActiveTabSession();
        const tabId = this.tabManager.getActiveTab()?.id;
        let request: ChatTurnRequest | null = null;
        try {
            const { contextItems, selection } = await this.contextController.collectCommandContext({
                includeCurrent: this.shouldIncludeCurrentNoteContext(),
            });
            this.currentSelection = selection;
            // 发送前留一份现场:失败/取消时按它恢复草稿与附件,重试也按它还原原请求。
            request = {
                query,
                context: contextItems.map(item => ({ ...item })),
                selection,
                source: 'shell',
            };
            if (tabId != null) this.pendingDrafts.set(tabId, request);

            this.updateActivity();
            const outcome = await session.chatController.processCommand(query, contextItems, this.currentSelection);

            const stillActive = this.tabManager.getActiveTab()?.id === tabId;
            if (outcome === 'failed' || outcome === 'cancelled') {
                // 失败/取消:上下文保留在 chips 里,输入区按现场恢复;等待期间的新输入不覆盖。
                if (stillActive && request) this.restoreDraft(request);
            } else if (stillActive) {
                // 成功才清空上下文(现有行为)。
                session.contextManager.clearContexts();
                const chipsContainer = this.getContextChipsContainer();
                if (chipsContainer) this.renderContextChips(chipsContainer);
                await this.refreshKnowledgeStatusPanel();
            }
        } catch (error) {
            logger.error('Command processing failed', error, 'ShellView.processCommand');
            if (request) this.restoreDraft(request);
            this.appendMessage({
                id: 'error-' + Date.now(),
                role: 'system',
                content: `Error processing command: ${error.message}`,
                timestamp: Date.now()
            });
        } finally {
            if (tabId != null) this.pendingDrafts.delete(tabId);
        }
    }

    /**
     * 恢复失败/取消轮次的原草稿。
     * 输入区已有新内容时绝不覆盖(只保留现场,由失败卡片的「恢复草稿」显式取回);
     * 上下文附件按 id 合并,避免把等待期间新加的 chip 冲掉。
     */
    private restoreDraft(request: ChatTurnRequest, force = false) {
        if (!this.inputEl) return;
        if (force || !this.inputEl.value.trim()) {
            this.inputEl.value = request.query;
            this.adjustHeight();
        }

        // 只在活动 tab 上恢复;contextManager 就是活动 tab 的实例。
        const existing = new Set(this.contextManager.getContexts().map(item => item.id));
        for (const item of request.context) {
            if (!item?.id || existing.has(item.id)) continue;
            this.contextManager.addContext(item as ContextItem);
            existing.add(item.id);
        }
        const chipsContainer = this.getContextChipsContainer();
        if (chipsContainer) this.renderContextChips(chipsContainer);
        this.updateInputToolbarCapabilities();
    }

    /** 失败卡片「恢复草稿」:显式用户动作,允许覆盖当前输入。 */
    private handleRestoreDraft(message: ChatMessage) {
        const request = this.draftRequests.get(message.id);
        if (!request) return;
        this.restoreDraft(request, true);
        this.inputEl?.focus();
    }

    /** 失败卡片「重试」:按原请求与上下文重跑;处理中拒绝重复触发。 */
    private async handleRetryTurn(message: ChatMessage) {
        if (!this.chatController || this.chatController.isRunActive()) return;
        const request = this.chatController.getRetryRequest(message.id) ?? this.deriveRetryRequest(message);
        if (!request) {
            new Notice(t('Cannot locate the question to retry.'));
            return;
        }
        this.draftRequests.delete(message.id);
        await this.chatController.retryTurn(request);
        await this.persistActiveTab();
    }

    /** 刷新/重开视图后内存现场已丢:从相邻 user 消息还原原文,至少原文可重试。 */
    private deriveRetryRequest(message: ChatMessage): ChatTurnRequest | null {
        const userMessage = this.findPrecedingUserMessage(message);
        if (!userMessage?.content.trim()) return null;
        return {
            query: userMessage.content,
            context: [],
            selection: '',
            source: 'shell',
        };
    }

    /**
     * @param markUnread 该消息是否算「新输出」。全量重建旧消息时传 false,
     *   否则切回暂停中的会话会凭空点亮「有新输出」。
     */
    appendMessage(msg: ChatMessage, markUnread = true) {
        const growth = this.captureScrollGrowth();
        void this.getMessageRenderer()
            .renderMessage(this.getActiveMessageContainer(), msg)
            .then((entry) => {
                this.observeMessageEntry(entry);
                this.afterScrollGrowth(growth, markUnread);
            });
        this.updateActivity();
    }

    /**
     * 当前活动 tab 的消息子树容器(挂在 outputContainer 下,每个 tab 一棵)。
     * 不存在则惰性创建。消息、加载指示、流容器都写入此容器,
     * 使切换 tab 时能通过 display 切换整棵子树、避免全量重建 DOM。
     */
    private getActiveMessageContainer(): HTMLElement {
        const activeId = this.tabManager.getActiveTab()?.id;
        if (activeId == null) return this.outputContainer;
        let el = this.tabContainers.get(activeId);
        if (!el) {
            el = this.outputContainer.createDiv({ cls: 'shell-tab-messages' });
            this.tabContainers.set(activeId, el);
        }
        return el;
    }

    /** 只显示当前活动 tab 的子树,隐藏其余;并清理已关闭 tab 的残留子树。 */
    private showOnlyActiveContainer() {
        const activeId = this.tabManager.getActiveTab()?.id;
        for (const [id, node] of this.tabContainers) {
            if (!this.tabManager.getAllTabs().some(t => t.id === id)) {
                this.unobserveContainerEntries(node);
                node.remove();
                this.tabContainers.delete(id);
                this.dirtyTabs.delete(id);
                continue;
            }
            if (id === activeId) node.removeClass('baizer-hidden');
            else node.addClass('baizer-hidden');
        }
    }

    // ==================== 滚动跟随（issue #64） ====================

    private createScrollFollowController() {
        this.scrollFollow?.dispose();
        this.scrollFollow = new ScrollFollowController({
            getContainer: () => this.outputContainer ?? null,
            getRenderGeneration: () => this.renderGeneration,
            onUnreadChange: (sessionId, unread) => {
                if (this.tabManager.getActiveTab()?.id !== sessionId) return;
                this.updateUnreadBar(unread);
            },
        });
    }

    private bindScrollFollowListeners() {
        this.outputContainer.addEventListener('scroll', this.handleOutputScrollBound, { passive: true });
        this.outputContainer.addEventListener('wheel', this.handleOutputWheelBound, { passive: true });
        // 恢复位置期间只有真实输入能取消它;pointerdown/touchstart 覆盖拖滚动条与触摸滑动。
        this.outputContainer.addEventListener('pointerdown', this.handleOutputScrollIntentBound, { passive: true });
        this.outputContainer.addEventListener('touchstart', this.handleOutputScrollIntentBound, { passive: true });
        this.outputContainer.addEventListener('keydown', this.handleOutputKeyDownBound);
        // 普通点击/选文本结束时若视口没动,恢复原阅读锚点(见 handleUserScrollIntentEnd)。
        this.outputContainer.addEventListener('pointerup', this.handleOutputScrollIntentEndBound, { passive: true });
        this.outputContainer.addEventListener('touchend', this.handleOutputScrollIntentEndBound, { passive: true });
    }

    /**
     * 「有新输出 · 回到最新」入口。放在消息区与输入区之间、不覆盖任何一侧：
     * 隐藏时不占布局，显示时是独立一行，窄侧栏下也不会横向溢出。
     */
    private createUnreadBar(container: HTMLElement) {
        const bar = container.createDiv({ cls: 'shell-unread-bar baizer-hidden' });
        bar.setAttribute('aria-live', 'polite');
        const button = bar.createEl('button', {
            cls: 'shell-unread-button',
            text: t('New output · Back to latest'),
        });
        button.setAttr('type', 'button');
        button.addEventListener('click', () => this.scrollFollow?.scrollToLatest());
        this.unreadBarEl = bar;
        this.unreadButtonEl = button;
    }

    private updateUnreadBar(unread: boolean = this.scrollFollow?.hasUnread() ?? false) {
        if (!this.unreadBarEl) return;
        this.unreadBarEl.toggleClass('baizer-hidden', !unread);
        this.unreadButtonEl?.setAttr('aria-hidden', String(!unread));
    }

    /** 内容增长前捕获会话身份、近底/跟随快照与渲染代次,增长后交给策略决定是否贴底/点亮未读。 */
    private captureScrollGrowth(): GrowthToken | null {
        return this.scrollFollow?.captureGrowth() ?? null;
    }

    private afterScrollGrowth(token: GrowthToken | null, markUnread: boolean) {
        this.scrollFollow?.afterGrowth(token, { markUnread });
    }

    // ==================== T14: 消息 DOM 虚拟化 ====================

    /**
     * 惰性创建 IntersectionObserver。root 为滚动容器 outputContainer,
     * rootMargin 上下各留一屏缓冲(不在视口边缘就脱水,避免快速滚动露白)。
     */
    private ensureMessageObserver(): IntersectionObserver | null {
        // 运行时兜底:某些旧 webview(含 Obsidian 移动端老环境)与测试环境没有 IntersectionObserver。
        // 此时优雅降级为「不虚拟化」——所有消息保持正常渲染,只是不做脱水/复水,不抛错。
        if (typeof IntersectionObserver === 'undefined') return null;
        if (this.messageObserver) return this.messageObserver;
        this.messageObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const el = entry.target as HTMLElement;
                    if (entry.isIntersecting) {
                        this.rehydrateEntry(el);
                    } else {
                        this.dehydrateEntry(el);
                    }
                }
            },
            {
                root: this.outputContainer,
                // 上下各扩一屏:进入缓冲区就提前 rehydrate,滚出一屏才 dehydrate。
                rootMargin: '150% 0px 150% 0px',
                threshold: 0,
            },
        );
        return this.messageObserver;
    }

    /** 登记一条消息 entry 到虚拟化观察。正在写入的活动流容器不纳入(避免脱水未完成的流)。 */
    private observeMessageEntry(entry: HTMLElement) {
        if (!entry || entry === this.streamContainer) return;
        // observer 不可用(旧 webview / 测试环境)时直接跳过观察,消息照常留在 DOM 里正常渲染。
        this.ensureMessageObserver()?.observe(entry);
    }

    /**
     * 脱水:把 entry 的实际内容摘进 fragment 寄存,并锁定其当前高度为 minHeight 占位。
     * 已脱水 / 高度未知(0)则跳过,避免误折叠。
     */
    private dehydrateEntry(el: HTMLElement) {
        if (this.dehydratedEntries.has(el)) return;
        const height = el.offsetHeight;
        if (height <= 0) return; // 不可见(display:none 的后台 tab 或尚未布局)——不处理
        const fragment = createFragment();
        while (el.firstChild) fragment.appendChild(el.firstChild);
        el.setCssStyles({ minHeight: `${height}px` });
        el.classList.add('shell-entry-dehydrated');
        this.dehydratedEntries.set(el, fragment);
    }

    /** 复水:把寄存的子树挂回 entry,撤销占位高度。 */
    private rehydrateEntry(el: HTMLElement) {
        const fragment = this.dehydratedEntries.get(el);
        if (!fragment) return;
        el.appendChild(fragment);
        el.setCssStyles({ minHeight: '' });
        el.classList.remove('shell-entry-dehydrated');
        this.dehydratedEntries.delete(el);
    }

    /** 解除对某容器下所有消息 entry 的观察,并把仍处于脱水态的 entry 先复水(否则内容随 empty 丢失)。 */
    private unobserveContainerEntries(container: HTMLElement) {
        if (!this.messageObserver) return;
        const entries = container.querySelectorAll('.shell-entry');
        entries.forEach((node) => {
            const el = node as HTMLElement;
            this.rehydrateEntry(el); // 若在脱水态,先挂回内容再解除观察
            this.messageObserver?.unobserve(el);
        });
    }

    handleStatusChange(isResponding: boolean) {
        this.isResponding = isResponding;
        this.updateInputToolbarCapabilities();
        if (isResponding) {
            // Show loading indicator (instance-scoped to avoid cross-view collisions)
            const growth = this.captureScrollGrowth();
            if (!this.loadingIndicatorEl) {
                const loadingDiv = this.getActiveMessageContainer().createDiv({ cls: 'shell-entry system' });
                loadingDiv.setAttribute('role', 'status');
                loadingDiv.setAttribute('aria-live', 'polite');
                loadingDiv.createSpan({ cls: 'shell-loading' });
                loadingDiv.createSpan({ text: 'Thinking...' });
                this.loadingIndicatorEl = loadingDiv;
            }
            // 加载指示不是新输出,不点亮未读;跟随中仍贴底。
            this.afterScrollGrowth(growth, false);
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

    // think-summary 折叠交互的事件委托:在 outputContainer 上挂一对监听,通过
    // closest('.shell-think-summary') 匹配。幂等——重复调用只绑定一次。
    private ensureTimelineDelegation() {
        if (this.timelineDelegationBound || !this.outputContainer) return;
        this.timelineDelegationBound = true;
        this.outputContainer.addEventListener('click', (event) => {
            const summary = (event.target as HTMLElement | null)?.closest('.shell-think-summary') as HTMLElement | null;
            if (!summary) return;
            const timeline = summary.closest('.shell-think-timeline') as HTMLElement | null;
            if (timeline) this.toggleStreamTimeline(timeline);
        });
        this.outputContainer.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const summary = (event.target as HTMLElement | null)?.closest('.shell-think-summary') as HTMLElement | null;
            if (!summary) return;
            const timeline = summary.closest('.shell-think-timeline') as HTMLElement | null;
            if (!timeline) return;
            event.preventDefault();
            this.toggleStreamTimeline(timeline);
        });
    }

    private ensureStreamContainer() {
        this.ensureTimelineDelegation();
        if (this.streamContainer) return;

        // 记下开流前的最后一条 ai 消息,供 finalizeStream 区分本轮新落与上一轮残留。
        const priorMessages = this.tabManager.getActiveTab()?.state.getMessages() ?? [];
        this.streamPriorLastAiId = [...priorMessages].reverse().find(m => m.role === 'ai')?.id ?? null;

        this.loadingIndicatorEl?.remove();
        this.loadingIndicatorEl = null;

        // 新回合换了一棵流式 DOM 树:旧回合还在 await 的渲染回调从此过期。
        this.renderGeneration += 1;
        this.streamContainer = this.getActiveMessageContainer().createDiv({ cls: 'shell-entry ai shell-stream-container' });
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
        // \u6298\u53E0\u4EA4\u4E92\u7531 outputContainer \u4E0A\u7684\u4E8B\u4EF6\u59D4\u6258\u7EDF\u4E00\u5904\u7406(\u89C1 onOpen \u4E2D\u7684\u59D4\u6258\u76D1\u542C),
        // \u6B64\u5904\u4E0D\u518D\u6302 per-summary \u76D1\u542C,\u907F\u514D\u957F\u5BF9\u8BDD\u7D2F\u79EF\u76D1\u542C\u5668\u3002

        this.streamContent = this.streamContainer.createDiv({ cls: 'shell-response-content' });
        // 流式途中关闭 live 播报:逐字增量会让读屏疯狂读碎片。改为流结束(finalizeStream)时
        // 临时切到 polite 让读屏把完成的整段回复播报一次。
        this.streamContent.setAttribute('aria-live', 'off');
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
        const divider = this.streamTimeline.createDiv({ cls: 'shell-think-step-divider think-node' });
        divider.createSpan({ cls: 'shell-think-step-label', text: `Step ${this.streamStepCount}` });
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
        // 增长前捕获:是否跟随只由此刻的跟随状态决定,不能用增长后的新高度重新判断。
        const growth = this.captureScrollGrowth();

        // 首帧:建立稳定块容器 + 尾部纯文本 + 光标三段结构。
        if (!this.streamTailEl) {
            this.streamContent.empty();
            this.streamStableEl = this.streamContent.createDiv({ cls: 'shell-stream-stable' });
            this.streamTailEl = this.streamContent.createDiv({ cls: 'shell-stream-plaintext' });
            this.streamContent.createSpan({ cls: 'shell-stream-cursor' });
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
        this.afterScrollGrowth(growth, true);
    }

    /** 把一段已闭合的 Markdown 文本渲染进一个新的稳定块节点并追加,冻结不再重渲。 */
    private async appendStableBlock(markdown: string) {
        if (!this.streamStableEl) return;
        // 入队时捕获 token:await 之后活动会话可能已经切走、渲染代次也可能已前进,
        // 完成回调只能滚动发起时的会话,过期即丢弃。
        const growth = this.captureScrollGrowth();
        const blockEl = this.streamStableEl.createDiv({ cls: 'shell-stream-block' });
        await this.getMessageRenderer().renderAiContent(blockEl, markdown);
        // Markdown 渲染完成可能再改变高度:仍属同一会话/同一代次且增长前跟随并近底时补一次贴底。
        this.afterScrollGrowth(growth, false);
    }


    /**
     * 收尾一轮流。outcome 是本轮唯一终态来源(completed / failed / cancelled):
     * - 成功才自动折叠过程;
     * - 失败/取消保留过程展开,就地渲染「原因 + 已保留内容 + 重试/恢复草稿」;
     * - 无论有没有正文都清掉流式状态,不留永久 Thinking。
     */
    private finalizeStream(
        outcome: ChatTurnOutcome = 'completed',
        finalText?: string,
        error?: string,
    ) {
        const growth = this.captureScrollGrowth();
        this.debouncedRenderStream.flush();

        this.thinkingRenderer?.finalizeCurrentThinking();

        // 首 token 前就失败/取消时还没有流容器;终态卡片仍需要一个落点。
        const createdLate = !this.streamContainer;
        if (createdLate && outcome !== 'completed') {
            this.ensureStreamContainer();
        }

        // runtime 可能在结束前替换正文(如 generation quality failure):done.text 才是
        // 入库/重建所见。有非空 finalText 时用它定型 DOM,使屏幕与保存一致;
        // 否则回退到 UI 逐字累计(onError 无 text、以及 runtime 未替换时二者本就相同)。
        const resolvedText = (typeof finalText === 'string' && finalText.length > 0)
            ? finalText
            : this.streamAccumulatedText;

        // ChatController 在发出终态事件之前就把本轮消息记进了投影(ADR 0002),
        // 这里按同一 id 找回它,操作栏/失败卡片/重试才能作用在真实消息上。
        const activeMessages = this.tabManager.getActiveTab()?.state.getMessages() ?? [];
        const candidate = [...activeMessages].reverse().find(m => m.role === 'ai');
        const terminalMessage = candidate && candidate.metadata?.outcome === outcome
            ? candidate
            : undefined;
        const lastAiMessage = candidate && (createdLate || candidate.id !== this.streamPriorLastAiId)
            ? candidate
            : undefined;

        if (this.streamContent && resolvedText) {
            // 流结束:把回复区切回 polite,让读屏把完成的整段回复播报一次(流式途中是 off)。
            this.streamContent.setAttribute('aria-live', 'polite');
            this.streamContent.empty();
            this.getMessageRenderer().renderAiContent(
                this.streamContent,
                resolvedText,
            ).then(() => {
                // 定型渲染不是「新输出」:暂停时不得点亮未读,也不能把读者拉回底部。
                this.afterScrollGrowth(growth, false);
            });
        }

        if (this.streamTimeline && this.streamNodeCount > 0) {
            const summaryText = this.streamTimeline.querySelector('.think-summary-text') as HTMLElement;
            const summary = this.streamTimeline.querySelector('.shell-think-summary') as HTMLElement;
            if (outcome === 'completed') {
                if (summaryText) summaryText.textContent = `Thought through ${this.streamNodeCount} steps`;
                this.streamTimeline.addClass('is-collapsed');
                summary?.setAttribute('aria-expanded', 'false');
            } else {
                // 失败/取消:保留过程默认展开,用户仍可点击/键盘折叠。
                if (summaryText) {
                    summaryText.textContent = outcome === 'cancelled'
                        ? `Stopped after ${this.streamNodeCount} steps`
                        : `Failed after ${this.streamNodeCount} steps`;
                }
                this.streamTimeline.removeClass('is-collapsed');
                this.streamTimeline.addClass(outcome === 'cancelled' ? 'is-cancelled' : 'is-failed');
                summary?.setAttribute('aria-expanded', 'true');
            }
        } else if (this.streamTimeline && this.streamNodeCount === 0) {
            this.streamTimeline.addClass('baizer-hidden');
        }

        if (this.streamContainer) {
            // 失败/取消卡片:原因 + 已保留内容(正文在卡片之上)+ 重试/恢复草稿。
            // 用同一份渲染逻辑服务实时收尾与回放(renderMessage 也调用它)。
            if (outcome !== 'completed') {
                const outcomeMessage: ChatMessage = terminalMessage ?? {
                    id: `stream-outcome-${Date.now()}`,
                    role: 'ai',
                    content: resolvedText,
                    timestamp: Date.now(),
                    metadata: { outcome, failureReason: error },
                };
                const tabId = this.tabManager.getActiveTab()?.id;
                const draft = (tabId != null ? this.pendingDrafts.get(tabId) : undefined)
                    ?? this.chatController?.getRetryRequest(outcomeMessage.id)
                    ?? undefined;
                if (draft) this.draftRequests.set(outcomeMessage.id, draft);
                this.getMessageRenderer().renderTurnOutcome(this.streamContainer, outcomeMessage);
            }

            // 阶段C:用投影里刚落下的真实 ai 消息(已带 assistantEntryId)渲染操作栏,
            // 而非临时空壳——否则 sessionEntryId 缺失,重试按钮的显示条件永不满足。
            // 但「最后一条 ai」未必属于本轮:纯工具轮次没有最终正文、不落消息,
            // 那时它是上一轮的残留。与开流前记下的 id 比对,不同才是本轮新落的。
            // 失败且无正文时只显示失败卡(不渲染空操作栏/空气泡)。
            const toolbarMessage: ChatMessage | null = resolvedText.trim()
                ? (lastAiMessage
                    ? { ...lastAiMessage, forkSourceText: this.findPrecedingUserMessage(lastAiMessage)?.content }
                    : {
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                        role: 'ai',
                        content: resolvedText,
                        timestamp: Date.now(),
                    })
                : null;
            if (toolbarMessage) {
                this.getMessageRenderer().addActionToolbar(this.streamContainer, toolbarMessage);
            }
        }

        // 流结束:该容器已定型为一条普通 ai 消息,纳入虚拟化观察。
        // 先记引用,待 streamContainer 置空后再 observe(observeMessageEntry 会跳过「当前活动流容器」)。
        const finalizedStreamEl = this.streamContainer;

        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamStableEl = null;
        this.streamTailEl = null;
        this.streamRenderedLen = 0;
        this.streamAccumulatedText = '';
        this.streamPriorLastAiId = null;
        this.streamNodeCount = 0;
        this.streamStepCount = 0;
        this.pendingStepDivider = false;
        this.thinkingRenderer = null;
        this.toolRenderer = null;
        // streamContainer 已置空,此时 observe 该定型消息容器不会被「活动流」守卫拦下。
        if (finalizedStreamEl) this.observeMessageEntry(finalizedStreamEl);
        void this.persistActiveTab();
    }

    private getMessageRenderer(): MessageRenderer {
        if (!this.messageRenderer) {
            this.messageRenderer = new MessageRenderer({
                app: this.app,
                component: this,
                onApprove: async (message) => {
                    await this.chatController.approveApproval(message.id);
                },
                onReject: (message) => {
                    this.chatController.rejectApproval(message.id);
                },
                onApprovalRetry: async (message) => {
                    await this.chatController.retryApproval(message.id);
                },
                onApprovalRecheck: async (message) => {
                    await this.chatController.recheckApproval(message.id);
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
                onRetryTurn: (message) => this.handleRetryTurn(message),
                canRestoreDraft: (message) => this.draftRequests.has(message.id),
                onRestoreDraft: (message) => this.handleRestoreDraft(message),
                onEdit: (message, newText) => this.handleEditMessage(message, newText),
                onFork: (message, newText) => this.handleForkFromAi(message, newText),
                onSwitchBranch: (message, targetLeafId) => this.handleSwitchBranch(message, targetLeafId),
                onReviewCodeBlock: (content) => this.reviewCodeBlock(content),
                onUndoWorkspaceEdit: (editId) => { void this.chatController.undoWorkspaceEdit(editId); },
                onInternalLinkClick: (href) => {
                    void this.app.workspace.openLinkText(href, '', false);
                },
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
        const editor: EditorWithCm | undefined = activeView?.editor;
        const cmView = editor?.cm;
        if (!cmView) {
            new Notice('Open the target note in source mode to show the preview.');
            return;
        }

        const line = Math.max(1, (editor?.getCursor?.()?.line ?? NaN) + 1 || 1);
        const ch = Math.max(0, editor?.getCursor?.()?.ch || 0);
        showGhostText(cmView, this.buildApprovalGhostPreview(previewText), line, ch);
        new Notice('Preview shown in the editor. Use the approval card buttons to approve or reject.');
    }

    private async openApprovalTarget(path: string) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) return;
        if (!(file instanceof TFile)) return;
        const leaf = this.app.workspace.getLeaf(false);
        await leaf?.openFile?.(file);
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
        // 清理 per-tab 消息子树引用(DOM 随 contentEl 一并销毁,此处仅释放 Map 引用)。
        this.tabContainers.clear();
        this.dirtyTabs.clear();
        // 断开消息虚拟化观察,避免视图关闭后 observer 泄漏。
        this.messageObserver?.disconnect();
        this.messageObserver = null;
        // 视图关闭后不能再有任何延迟滚动回调影响会话。
        this.scrollFollow?.dispose();
        this.scrollFollow = null;
        if (this.outputContainer) {
            this.outputContainer.removeEventListener('scroll', this.handleOutputScrollBound);
            this.outputContainer.removeEventListener('wheel', this.handleOutputWheelBound as EventListener);
            this.outputContainer.removeEventListener('pointerdown', this.handleOutputScrollIntentBound);
            this.outputContainer.removeEventListener('touchstart', this.handleOutputScrollIntentBound);
            this.outputContainer.removeEventListener('keydown', this.handleOutputKeyDownBound);
            this.outputContainer.removeEventListener('pointerup', this.handleOutputScrollIntentEndBound);
            this.outputContainer.removeEventListener('touchend', this.handleOutputScrollIntentEndBound);
        }
        this.unreadBarEl = null;
        this.unreadButtonEl = null;
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

    // 语言切换后重建视图，让 t() 文案即时刷新。
    // 走 onClose→onOpen 完整生命周期而非裸调 onOpen：onClose 精确拆除 onOpen 注册的
    // 事件/心跳/订阅，避免重复 registerEvent 与 interval 泄漏；tabManager 在构造函数创建，
    // 跨此周期存活，会话/标签页得以还原。流式进行中则跳过，避免打断输出。
    async rerender(): Promise<void> {
        if (this.isResponding || this.tabManager.getAllTabs().some(tab => tab.isStreaming)) {
            return;
        }
        await this.onClose();
        await this.onOpen();
    }

    // ==================== Heartbeat Monitoring ====================

    private startHeartbeat() {
        this.heartbeatInterval = window.setInterval(() => {
            this.checkHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            window.clearInterval(this.heartbeatInterval);
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
            // 心跳超时判定为卡死后,主动中止底层流,避免僵尸流在后台继续、
            // 与用户随后发起的新提交并存。
            this.chatController?.cancelActiveStream();
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
                (this.app as AppWithCommands).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-lint`);
            },
            onCopyPath: (path) => {
                void window.navigator?.clipboard?.writeText?.(path);
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
        return host.createDiv({ cls: 'shell-suggestions baizer-hidden' });
    }

    private createHeaderActions(container: HTMLElement) {
        const actions = container.createDiv({ cls: 'shell-header-buttons' });
        this.historyMenuTriggerEl = this.createHeaderActionButton(actions, 'Search history', 'search', 'shell-history-btn', (event) => {
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
        if (summaryPath && typeof this.app.workspace?.openLinkText === 'function') {
            await this.app.workspace.openLinkText(summaryPath, '', false);
            return;
        }
        (this.app as AppWithCommands).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-open-index`);
    }

    private excludeCurrentNoteContext(path: string) {
        this.excludedCurrentNotePath = path;
        const contextContainer = this.getContextChipsContainer();
        if (contextContainer) this.renderContextChips(contextContainer);
        if (this.knowledgeStatusContainerEl) this.knowledgeStatusContainerEl.empty();
        this.updateScopePill();
    }

    /**
     * 刷新头部作用域胶囊:当前有活动笔记且未被排除 → 绿点 + 笔记名(去 .md);
     * 否则 → 灰点 + "未作用于笔记"。作用域来源与上下文注入一致(getActiveFile + excludedCurrentNotePath)。
     */
    private updateScopePill() {
        if (!this.scopePillEl || !this.scopePillNameEl) return;
        const activePath = this.app.workspace?.getActiveFile?.()?.path ?? null;
        const scoped = !!activePath && activePath !== this.excludedCurrentNotePath;
        if (scoped) {
            const base = activePath!.split('/').pop() ?? activePath!;
            const name = base.replace(/\.md$/i, '');
            this.scopePillNameEl.setText(name);
            this.scopePillEl.setAttribute('title', `当前作用于:${activePath}`);
        } else {
            this.scopePillNameEl.setText(t('No note in scope'));
            this.scopePillEl.setAttribute('title', t('No note in scope'));
        }
        this.scopePillEl.toggleClass('is-scoped', scoped);
    }

    private openPluginSettings() {
        const app = this.app as AppWithSetting;
        app.setting.open();
        app.setting.openTabById(PLUGIN_ID);
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
        const clipboard = e.clipboardData;
        if (!clipboard) return;

        // 图像粘贴:先扫描 items,命中图像即拦截并转 base64 context。
        const items = clipboard.items;
        if (items) {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.type.indexOf('image') === -1) continue;
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
                return;
            }
        }

        // 文本粘贴:同步读取纯文本。若是合法 URL 则同步 preventDefault + 加 chip,
        // 否则不拦截,交给浏览器默认粘贴(避免 URL 既进 textarea 又进 chip 的重复)。
        const text = clipboard.getData('text/plain').trim();
        if (text && this.isValidUrl(text)) {
            e.preventDefault();
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

    private async refreshInputToolbarModels(forceRefresh: boolean = false) {
        const settings = this.getPluginInstance()?.settings;
        if (!settings?.providers || !this.inputToolbar) return;

        const activeProviderId = settings.activeProvider || DEFAULT_SETTINGS.activeProvider;
        const activeModelId = settings.providers[activeProviderId]?.model || '';

        const requestId = ++this.modelLoadRequestId;
        this.inputToolbar.updateModels({
            loading: true,
            groups: [],
            activeProviderId,
            activeModelId,
        });

        try {
            const groups = await this.modelService.getAllProviderModels(forceRefresh);
            if (requestId !== this.modelLoadRequestId) return;

            this.inputToolbar.updateModels({
                loading: false,
                groups,
                activeProviderId,
                activeModelId,
            });
        } catch (error: unknown) {
            if (requestId !== this.modelLoadRequestId) return;
            logger.warn(
                `Failed to load model list: ${thrownMessage(error) || 'Unknown error'}`,
                'ShellView.refreshInputToolbarModels'
            );
            this.inputToolbar.updateModels({
                loading: false,
                groups: [],
                activeProviderId,
                activeModelId,
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

    /**
     * 合并下拉的唯一切换入口:选中的模型带着它所属 provider。
     * 若切换了 provider 先 switchProvider(会重建 runtime/清缓存),再 switchModel 落地模型;
     * 未换 provider 则只 switchModel。避免了旧「provider 与 model 两个下拉各自 onChange」的时序问题。
     */
    private async handleModelSelect(providerId: string, modelId: string) {
        const plugin = this.getPluginInstance();
        const config = plugin?.settings?.providers?.[providerId];
        if (!config?.apiKey) {
            this.handleUnavailableProvider(providerId);
            return;
        }

        const saveFn = plugin ? () => plugin.saveSettings() : undefined;
        const providerChanged = providerId !== this.getActiveProviderId();
        if (providerChanged) {
            await this.modelService.switchProvider(providerId, saveFn);
        }
        await this.modelService.switchModel(modelId, saveFn);

        const activeTab = this.tabManager.getActiveTab();
        if (activeTab) {
            this.tabManager.updateTab(activeTab.id, {
                providerId,
                modelId,
                currentNote: this.getCurrentNotePath(),
            });
        }
        new Notice(providerChanged ? `Switched to ${config.label} · ${modelId}` : `Switched to ${modelId}`);
    }

    private handleUnavailableProvider(id: string) {
        const plugin = this.getPluginInstance();
        const config = plugin?.settings?.providers?.[id];
        new Notice(`${config?.label || id} API Key is not configured. Please configure it in settings.`);
        const app = this.app as AppWithSetting;
        app.setting.open();
        app.setting.openTabById(PLUGIN_ID);
        void this.refreshInputToolbarModels();
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

    private updatePlaceholder() {
        if (!this.inputEl) return;
        const settings = this.getPluginInstance()?.settings;
        const config = settings?.providers?.[settings?.activeProvider];
        const label = config?.label || 'AI';
        this.inputEl.setAttr('placeholder', `Ask ${label}... (/ commands, @ context)`);
    }

    public async updateModelSelector(forceRefresh: boolean = false) {
        await this.refreshInputToolbarModels(forceRefresh);
    }

    private async createAndShowTab() {
        this.scrollFollow?.prepareForSessionSwitch();
        await this.persistActiveTab();
        const tab = this.tabManager.createTab();
        this.activateTabSession(tab.id);
        this.applyTabMetadata(tab);
        this.resetStreamState();
        this.renderActiveTabMessages();
        // 新会话:定位到最新并开始跟随。
        this.scrollFollow?.activateSession(tab.id, 'new');
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async switchTab(id: TabId) {
        if (this.tabManager.getActiveTab()?.id === id) {
            this.hideHistoryMenu();
            return;
        }

        // 先记下离开会话的阅读位置,再切身份;延迟回调带会话校验,不会滚到目标 tab。
        this.scrollFollow?.prepareForSessionSwitch();
        await this.persistActiveTab();
        if (!this.tabManager.switchTab(id)) return;

        const activeTab = this.tabManager.getActiveTab();
        this.activateTabSession(id);
        if (activeTab) {
            await this.syncProviderStateForTab(activeTab);
        }
        this.resetStreamState();
        // 目标 tab 子树已渲染且未被后台消息标脏 → 只切 display,零重建(核心性能收益)。
        // 否则(首次打开 / 后台有新消息)全量重建该子树。
        const cached = this.tabContainers.get(id);
        if (cached && !this.dirtyTabs.has(id)) {
            this.showOnlyActiveContainer();
        } else {
            this.renderActiveTabMessages();
        }
        // 恢复该会话自己的跟随/未读/阅读位置(新会话已在创建时定位)。
        this.scrollFollow?.activateSession(id, 'restore');
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async closeTab(id: TabId) {
        this.scrollFollow?.prepareForSessionSwitch();
        const tabToClose = this.tabManager.getAllTabs().find(item => item.id === id) ?? null;
        await this.persistTab(tabToClose);
        const wasActive = this.tabManager.getActiveTab()?.id === id;
        if (!this.tabManager.closeTab(id)) return;
        this.scrollFollow?.removeSession(id);

        const session = this.tabSessions.get(id);
        session?.chatController.cleanup();
        this.tabSessions.delete(id);
        // 释放该会话的 pi session 内存态(磁盘文件与持久 ref 保留,再次打开可恢复)。
        this.modelService.releaseSession(id);
        // 移除该 tab 的消息子树,避免关闭后 DOM 残留。
        const closedContainer = this.tabContainers.get(id);
        if (closedContainer) {
            this.unobserveContainerEntries(closedContainer);
            closedContainer.remove();
        }
        this.tabContainers.delete(id);
        this.dirtyTabs.delete(id);
        this.hideHistoryMenu();

        if (wasActive) {
            const activeTab = this.tabManager.getActiveTab();
            if (activeTab) {
                this.activateTabSession(activeTab.id);
                await this.syncProviderStateForTab(activeTab);
                this.resetStreamState();
                this.renderActiveTabMessages();
                this.scrollFollow?.activateSession(activeTab.id, 'restore');
            }
        }
    }

    private getPluginInstance(): IPlugin | undefined {
        return this.plugin ?? (this.app as AppWithPluginRegistry).plugins.plugins[PLUGIN_ID];
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
            onMessageAdded: (msg, options) => this.handleTabMessageAdded(id, msg, options),
            onMessageRemoved: (messageId) => this.handleTabMessageRemoved(id, messageId),
            onMessageUpdated: (msg) => this.handleTabMessageUpdated(id, msg),
            onStatusChanged: (status) => this.handleTabStatusChanged(id, status),
            onStreamEvent: (event) => this.handleTabStreamEvent(id, event),
            onClear: () => this.handleTabClear(id),
            onWorkspaceEdit: (edit) => this.handleTabWorkspaceEdit(id, edit),
            onWorkspaceEditUndone: (edit) => this.handleTabWorkspaceEditUndone(id, edit),
            onWorkspaceEditUndoFailed: (message) => this.handleWorkspaceEditUndoFailed(id, message),
        });

        const session = { chatController, contextManager, contextController };
        // 从历史菜单恢复的 tab 在创建时就带着快照消息(只写进了投影,没经过 onMessageAdded)。
        // 让唯一作者接管它们,否则恢复后的 👍/👎 按 id 回查会落空。
        const tab = this.tabManager.getAllTabs().find(item => item.id === id);
        if (tab) {
            chatController.adoptMessages(tab.state.getMessages());
        }
        this.tabSessions.set(id, session);
        return session;
    }

    /**
     * 收到 ChatController(消息列表的唯一作者)的记录通知。
     * tab.state 是只读投影:永远写,不自己造消息(ADR 0002)。
     * alreadyRendered 的消息已随 stream 事件上屏,只记录、不重画。
     */
    private handleTabMessageAdded(tabId: TabId, msg: ChatMessage, options?: MessageAddedOptions) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        if (tab) {
            tab.state.addMessage(msg);
        }

        if (options?.alreadyRendered) return;

        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.appendMessage(msg);
        } else {
            this.tabManager.markAttention(tabId, true);
            // 后台 tab 有新消息:标脏,切回时强制重建以补齐 DOM。
            this.dirtyTabs.add(tabId);
            // 该会话若已暂停跟随,后台到达的输出点亮它自己的未读;跟随中的会话切回自然贴底。
            this.scrollFollow?.noteOutputInSession(tabId);
        }
    }

    /** 重试替换失败消息:同步删投影并重渲(活动 tab)或标脏(后台 tab)。 */
    private handleTabMessageRemoved(tabId: TabId, messageId: string) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        tab?.state.removeMessage(messageId);
        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.renderActiveTabMessages();
        } else {
            this.dirtyTabs.add(tabId);
        }
    }

    /**
     * 审批状态变化：更新只读投影，并只重画这一张卡片。
     *
     * 不重排整条消息流，既避免长对话在点击后跳到最底部，也保住键盘焦点上下文。
     * 卡片元素按 `data-message-id` 定位；视图重挂载后由 renderActiveTabMessages
     * 从投影里的 approvalState 重建，不依赖旧 DOM 是否存在。
     */
    private handleTabMessageUpdated(tabId: TabId, msg: ChatMessage) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        tab?.state.updateMessage(msg.id, msg);
        // 审批结果要能跨视图关闭/应用重启回看：状态一变就落一次快照。
        if (tab) void this.persistTab(tab);

        if (this.tabManager.getActiveTab()?.id !== tabId) {
            this.dirtyTabs.add(tabId);
            return;
        }

        const container = this.getActiveMessageContainer();
        const entry = container.querySelector(`.shell-entry[data-message-id="${msg.id}"]`) as HTMLElement | null;
        const body = entry?.querySelector('.shell-approval-message-body') as HTMLElement | null;
        if (!body) return;

        // 只有焦点原本就在这张卡片里时才把焦点移到新状态区：
        // 后台 reconcile 完成时用户可能在输入框里打字，不能抢焦点。
        const active = document.activeElement as HTMLElement | null;
        const hadFocus = !!active && !!entry && entry.contains(active);

        // 就地重画会改变卡片高度（按钮区消失/详情行数变化）。与内容增长同样处理：
        // 跟随且近底才贴底，暂停时保持锚点；不是新输出，不点亮未读。
        const growth = this.captureScrollGrowth();
        body.empty();
        this.getMessageRenderer().renderApproval(body, msg);
        if (hadFocus) this.focusApprovalState(entry, msg);
        this.afterScrollGrowth(growth, false);
    }

    /**
     * 状态流转后把焦点留在卡片内：处理中/终态聚焦状态区（读屏会播报），
     * 失败/未知聚焦重试或核实按钮，键盘用户可以继续操作。
     */
    private focusApprovalState(entry: HTMLElement | null, msg: ChatMessage) {
        if (!entry) return;
        const status = msg.approvalState?.status;
        const selector = status === 'failed'
            ? '.shell-approval-retry'
            : status === 'unknown'
                ? '.shell-approval-recheck'
                : '.shell-approval-processing, .shell-approval-outcome';
        const target = entry.querySelector(selector) as HTMLElement | null;
        target?.focus?.();
    }

    /** /clear:清空该 tab 的可见历史(tab.state)并重渲(修 /clear 不清屏)。 */
    private handleTabClear(tabId: TabId) {
        const tab = this.tabManager.getAllTabs().find(item => item.id === tabId);
        tab?.state.clearMessages();
        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.resetStreamState();
            this.renderActiveTabMessages();
            // /clear 是显式重置:回到最新并恢复跟随。
            this.scrollFollow?.activateSession(tabId, 'new');
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
                // 阶段B:把本轮 user entryId 锚定到投影里最近一条尚未锚定的 user 消息
                // (阶段C 分叉/重试的定位依据)。
                // ai 消息不在此创建——它由 ChatController 在发出 done 之前就记进了投影(ADR 0002)。
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
            }
        }

        if (this.tabManager.getActiveTab()?.id === tabId) {
            this.handleStreamEvent(event);
        } else {
            this.tabManager.markAttention(tabId, true);
            // 后台 tab 有流事件:标脏,切回时重建。
            // 这也是流式 ai 回复在后台 tab 的标脏来源——它在 handleTabMessageAdded
            // 里带 alreadyRendered 早退,不走那边的标脏分支。
            this.dirtyTabs.add(tabId);
            this.scrollFollow?.noteOutputInSession(tabId);
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
            // 后台 tab 的工作区编辑消息:标脏,切回时重建。
            this.dirtyTabs.add(tabId);
            this.scrollFollow?.noteOutputInSession(tabId);
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

        if (!this.historyMenuContainerEl.hasClass('baizer-hidden')) {
            this.hideHistoryMenu();
            return;
        }

        await this.refreshHistoryMenu();
    }

    private hideHistoryMenu() {
        // 仅当菜单当前可见时才还原焦点:避免 init/unload 等场景无谓抢焦点。
        const wasOpen = this.historyMenuContainerEl ? !this.historyMenuContainerEl.hasClass('baizer-hidden') : false;
        this.historyMenu?.hide();
        if (wasOpen) this.historyMenuTriggerEl?.focus();
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

        this.scrollFollow?.prepareForSessionSwitch();
        await this.persistActiveTab();
        const restoredTab = this.conversationController.restoreConversation(snapshot, this.tabManager);
        this.activateTabSession(restoredTab.id);
        await this.syncProviderStateForTab(restoredTab);
        this.resetStreamState();
        this.renderActiveTabMessages();
        // 已有会话:恢复其阅读位置;首次恢复（无记录）落在最新输出。
        this.scrollFollow?.activateSession(restoredTab.id, 'restore');
        this.hideHistoryMenu();
        this.inputEl?.focus();
    }

    private async deleteConversationFromHistory(id: string) {
        await this.conversationController.deleteConversation(id);
        // 删历史 = 用户显式删除:同步删磁盘 pi session 文件 + 清 ref,不留孤儿文件
        // (磁盘泄漏 + 隐私:JSONL 存对话原文)。失败静默——快照已删,尽力清盘。
        await this.modelService.purgeSession(id);

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
        return this.getPluginInstance()?.settings?.activeProvider || DEFAULT_SETTINGS.activeProvider;
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
        // 同一批消息换表后也要让 owner 跟上:分支切换/重跑后从投影重建时,
        // 旧 id 已不在屏幕上,owner 若不同步,操作栏上的 👍/👎 会再次查不到。
        this.tabSessions.get(tab.id)?.chatController.adoptMessages(windowed);
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
            new Notice(t('Cannot switch branch.'));
        }
    }

    /** 从某条 ai 回复分叉:用新文本重跑它对应的 user 提问,产生兄弟分支。 */
    private async handleForkFromAi(aiMessage: ChatMessage, newText: string) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid) return;
        const userMessage = this.findPrecedingUserMessage(aiMessage);
        if (!userMessage?.sessionEntryId) {
            new Notice(t('Cannot locate the question to fork.'));
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
            new Notice(t('Cannot locate the question to retry.'));
            return;
        }
        // 重试:同一问题重生成,新答案换掉旧的、不保留旧分支(supersede=true)。
        await this.forkAndRerun(cid, userMessage.sessionEntryId, userMessage.content, true);
    }

    /** 编辑重问某条 user 消息:定位到它之前,用新文本重跑,产生兄弟分支。 */
    private async handleEditMessage(userMessage: ChatMessage, newText: string) {
        const cid = this.tabManager.getActiveTab()?.id;
        if (!cid || !userMessage.sessionEntryId) {
            new Notice(t('Cannot edit this message.'));
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
            new Notice(t('Cannot locate the fork point; rerun cancelled.'));
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

    /**
     * 渲染当前活动 tab 的消息。
     * 每个 tab 一棵独立 DOM 子树:只清空并重建「当前活动 tab」这一棵,其余子树保留、切 display 隐藏。
     * 由此切换 tab 时若目标子树已存在且未标脏,switchTab 走 display 切换、完全不进本方法,避免全量重建。
     */
    private renderActiveTabMessages() {
        if (!this.outputContainer) return;

        const activeTab = this.tabManager.getActiveTab();
        const activeId = activeTab?.id;
        // 只重建当前活动子树:取容器、清空它(而非清空整个 outputContainer)。
        const container = this.getActiveMessageContainer();
        // 清空前解除对旧 entry 的观察,避免 observer 持有已脱离文档的节点。
        this.unobserveContainerEntries(container);
        container.empty();
        if (activeId != null) this.dirtyTabs.delete(activeId);
        this.showOnlyActiveContainer();

        const messages = activeTab?.state.getMessages() ?? [];

        if (messages.length === 0) {
            this.appendMessage({
                id: 'init',
                role: 'system',
                content: 'Kernel initialized.',
                timestamp: Date.now(),
            }, false);
            if (activeId != null) this.scrollFollow?.activateSession(activeId, 'restore');
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
                }, false);
            } else {
                this.appendMessage(message, false);
            }
        }
        // 全量重建会把滚动位置清零。停在原会话的阅读位置(跟随中则回到底部),
        // 避免分支切换、撤销工作区编辑等纯重画把读者弹出阅读锚点。
        if (activeId != null) this.scrollFollow?.activateSession(activeId, 'restore');
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
        // 流式 DOM 被丢弃:此前排队的异步渲染回调(稳定块、定型渲染)一律过期。
        this.renderGeneration += 1;
        // 丢弃流时主动释放思考计时器,避免 interval 泄漏(切换/关闭标签页会走到这里)。
        this.thinkingRenderer?.dispose();
        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamStableEl = null;
        this.streamTailEl = null;
        this.streamRenderedLen = 0;
        this.streamAccumulatedText = '';
        this.streamPriorLastAiId = null;
        this.streamNodeCount = 0;
        this.streamStepCount = 0;
        this.pendingStepDivider = false;
        this.thinkingRenderer = null;
        this.toolRenderer = null;
    }
}
