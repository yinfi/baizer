import { App, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';
import { EditorView, showTooltip, tooltips } from '@codemirror/view';
import { StateField, Extension, StateEffect, EditorState } from '@codemirror/state';
import { ModelService } from '../services/model-service';
import { ChatController } from './chat-controller';
import { ChatMessage } from './types';
import { SuggestList } from './components/suggest-list';
import { SuggestionItem, SuggestionType } from './controllers/input-controller';
import { SELECTION_ACTIONS, getAction, buildActionPrompt } from './selection-ai/action-registry';
import { SelectionContextBuilder } from './selection-ai/selection-context-builder';
import { FloatingPanel } from './selection-ai/floating-panel';
import { PluginSettings } from '../mcp/types';
import { t } from '../i18n/zh';

// 浮窗单例:同一时刻只允许一个选区 AI 浮窗,开新窗前销毁旧窗,避免多开堆叠。
let activeExplainPanel: FloatingPanel | null = null;

type AiMenuMode = 'selection' | 'trigger';

// selection 场景:选中即出横向工具条(toolbar),点动作直接分流(改写→内联 diff / 只读→浮窗)。
// trigger 场景(@ 行内插入):保留旧的 button→chat 迷你对话框,不在本次改造范围。
type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'toolbar'; mode: 'selection'; from: number; to: number }
    | { type: 'button'; mode: 'trigger'; from: number; to: number }
    | { type: 'chat'; mode: 'trigger'; from: number; to: number; controller: ChatController };

interface PluginContext {
    app: App;
    modelService: ModelService;
    contextBuilder: SelectionContextBuilder;
    // 稳定引用（插件 onload 后原地 mutate，不整体替换），故此处直接读取即可反映最新设置。
    settings: PluginSettings;
}

const pluginContextMap = new WeakMap<EditorView, PluginContext>();

export const setSelectionMenuState = StateEffect.define<SelectionMenuState>();

export function findAtTrigger(text: string, cursor: number): { from: number; to: number } | null {
    if (cursor <= 0 || cursor > text.length) return null;

    const triggerFrom = cursor - 1;
    if (text[triggerFrom] !== '@') return null;
    if (triggerFrom > 0 && !/\s/.test(text[triggerFrom - 1])) return null;

    return { from: triggerFrom, to: cursor };
}

const selectionMenuField = StateField.define<SelectionMenuState>({
    create() { return { type: 'hidden' }; },
    update(state, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setSelectionMenuState)) {
                cleanupPreviousController(state, effect.value);
                return effect.value;
            }
        }

        if (!tr.selection && !tr.docChanged) return state;

        const selection = tr.newSelection.main;
        if (!selection.empty) {
            // 选区非空 → 横向工具条(选中即出,无中间 AI 按钮态)。
            const next: SelectionMenuState = {
                type: 'toolbar',
                mode: 'selection',
                from: selection.from,
                to: selection.to,
            };
            cleanupPreviousController(state, next);
            return next;
        }

        const trigger = findAtTriggerInState(tr.state, selection.from);
        if (trigger) {
            if (state.type !== 'hidden'
                && state.mode === 'trigger'
                && state.from === trigger.from
                && state.to === trigger.to) {
                return state;
            }
            const next: SelectionMenuState = {
                type: 'button',
                mode: 'trigger',
                from: trigger.from,
                to: trigger.to,
            };
            cleanupPreviousController(state, next);
            return next;
        }

        const next: SelectionMenuState = { type: 'hidden' };
        cleanupPreviousController(state, next);
        return next;
    },
    provide: field => showTooltip.from(field, (state) => {
        if (state.type === 'hidden') return null;

        return {
            pos: state.to,
            above: false,
            strictSide: false,
            create: (view: EditorView) => createSelectionTooltip(view, state),
        };
    }),
});

export function selectionMenuExtension(
    app: App,
    modelService: ModelService,
    knowledgeRuntime: { getGuardianDeepKnowledgeContext(q: string): Promise<string> } | null,
    contextService: { collect(): Promise<any> } | null,
    settings: PluginSettings,
): Extension {
    const contextBuilder = new SelectionContextBuilder({
        knowledgeRuntime,
        modelService,   // recallGuardianMemory 在 ModelService 上
        contextService,
    });
    return [
        selectionMenuField,
        // Tooltip 定位:挂 body 顶层脱离兄弟遮挡 + fixed 视口定位不被 overflow 裁剪。
        // 不再把 tooltipSpace 限死为编辑器矩形——那会让选区靠右时工具条被强制左移/下移避让,
        // 脱离选区(实测漂到编辑器右侧空白)。用整个视口作可用空间,令工具条正常贴 pos(选区末尾)。
        tooltips({
            parent: document.body,
            position: 'fixed',
        }),
        EditorView.updateListener.of((update) => {
            pluginContextMap.set(update.view, { app, modelService, contextBuilder, settings });
        }),
    ];
}

function findAtTriggerInState(state: EditorState, cursor: number): { from: number; to: number } | null {
    if (cursor <= 0) return null;

    const at = state.doc.sliceString(cursor - 1, cursor);
    if (at !== '@') return null;

    const before = cursor > 1 ? state.doc.sliceString(cursor - 2, cursor - 1) : '';
    if (cursor > 1 && !/\s/.test(before)) return null;

    return { from: cursor - 1, to: cursor };
}

function createSelectionTooltip(view: EditorView, state: SelectionMenuState) {
    const context = pluginContextMap.get(view);
    const dom = document.createElement('div');
    dom.className = `guardian-selection-tooltip is-${state.type}`;
    if (state.type === 'hidden' || !context) return { dom };

    // 防重:同一文档在运行时可能同时存在多个 CM 实例(链接面板 / 同笔记多标签 / 隐藏后台编辑器)。
    // 它们都注册了本扩展,选区被 Obsidian 同步后各自的 field 都看到非空选区、各弹一个工具条;
    // 又因 tooltip 被 parent 到 document.body + position:fixed,非当前实例也会显示在视口,
    // 造成"两个工具条"。选区在语义上只属于用户此刻聚焦的那个编辑器 —— DOM 焦点唯一,
    // 只让 hasFocus 的实例渲染,其余返回空节点。(隐藏后台实例天然无焦点,一并被挡掉。)
    if (!view.hasFocus) return { dom };

    // selection 场景:横向工具条,点动作直接分流。
    if (state.type === 'toolbar') {
        // 用户可在设置里关闭"选中即弹工具条"。关则返回空节点,选区不再触发悬浮条。
        // (trigger 的 @ 行内插入是独立功能,不受此开关控制。)
        if (!context.settings.enableSelectionMenu) return { dom };
        const bar = dom.createDiv({ cls: 'baizer-selection-toolbar' });
        for (const action of SELECTION_ACTIONS) {
            const btn = bar.createEl('button', {
                cls: 'baizer-selection-tool',
                attr: { type: 'button', title: t(action.label), 'aria-label': t(action.label) },
            });
            setIcon(btn, action.icon);
            btn.createSpan({ cls: 'baizer-selection-tool-label', text: t(action.label) });
            btn.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                void onToolClick(view, context, state, action.id);
            };
        }
        return { dom };
    }

    // trigger 场景(@ 行内插入):保留旧的迷你对话框。
    if (state.type === 'button') {
        const btn = document.createElement('button');
        btn.className = 'guardian-selection-btn';
        btn.type = 'button';
        setIcon(btn, 'sparkles');
        btn.createSpan({ cls: 'guardian-selection-btn-label', text: 'AI' });
        btn.setAttribute('aria-label', 'Ask AI to insert here');
        btn.title = 'Ask AI to insert here';
        btn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const controller = new ChatController({
                app: context.app,
                api: context.modelService,
            });
            view.dispatch({
                effects: setSelectionMenuState.of({
                    type: 'chat',
                    mode: state.mode,
                    from: state.from,
                    to: state.to,
                    controller,
                }),
            });
        };
        dom.appendChild(btn);
        return { dom };
    }

    const markdownComponent = new Component();
    dom.appendChild(createChatPanel(view, state, context, markdownComponent));
    return { dom, destroy: () => markdownComponent.unload() };
}

/**
 * 工具条点击分流:改写类走内联 diff(prompt 带上下文),只读类弹浮窗对话。
 */
async function onToolClick(
    view: EditorView,
    context: PluginContext,
    state: Extract<SelectionMenuState, { type: 'toolbar' }>,
    actionId: string,
) {
    const action = getAction(actionId);
    if (!action) return;
    const selection = view.state.doc.sliceString(state.from, state.to);
    if (!selection.trim()) { new Notice(t('Please select some text first.')); return; }

    // 所有动作(改写/解释)统一走浮窗流式,不再区分 inline diff。
    openPanel(view, context, state, action, selection);

    // 动作已发起,隐藏工具条(后续 UI 由浮窗承载)。
    view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
}

/** 把选区文本截断成一行意图文案(超长省略),用于浮窗顶部展示。 */
function truncateForIntent(text: string, max = 40): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * 弹可拖拽缩放浮窗,用 ChatController 驱动流式(thinking→结果)。
 * 显示层:顶部意图=「动作名:选中文字」;真实 prompt(动作模板+装配上下文)只发给模型、不显示。
 */
function openPanel(
    view: EditorView,
    context: PluginContext,
    state: Extract<SelectionMenuState, { type: 'toolbar' }>,
    action: { id: string; label: string; context: any },
    selection: string,
) {
    // 单例:开新浮窗前销毁上一个,避免多开堆叠。
    activeExplainPanel?.destroy();

    const controller = new ChatController({ app: context.app, api: context.modelService });
    const coords = view.coordsAtPos(state.to);
    const intent = `${t(action.label)}:${truncateForIntent(selection)}`;
    const panel = new FloatingPanel({
        app: context.app,
        intent,
        anchor: { x: coords?.left ?? 200, y: coords?.bottom ?? 200 },
        onClose: () => { controller.cleanup(); if (activeExplainPanel === panel) activeExplainPanel = null; },
        // 追问:清屏后把用户输入当普通对话发(带选区作上下文)。
        onSubmit: (text) => { panel.beginTurn(); void controller.processCommand(text, [], selection, 'selection-menu'); },
        onReplace: (resultText) => {
            // 流式期间用户可能已编辑文档,原偏移会错位。用选区快照重定位,
            // 找不到则中止替换(绝不盲写),提示手动复制。
            const target = relocateRange(view.state, state.from, state.to, selection);
            if (!target) { new Notice(t('Selection changed; cannot replace. Please copy manually.')); return; }
            view.dispatch({ changes: { from: target.from, to: target.to, insert: resultText } });
            panel.destroy();
        },
    });
    // ChatController 的流事件转发进浮窗渲染(thinking 折叠 + 流式正文)。
    (controller as any).onStreamEvent = (event: any) => panel.handleStreamEvent(event);
    activeExplainPanel = panel;

    // 首轮:动作模板 + 装配上下文 = 真实 prompt(发模型);displayText=intent(不进消息流,仅占位)。
    const basePrompt = buildActionPrompt(action.id, selection);
    void (async () => {
        const prompt = await context.contextBuilder.build(action.context, selection, basePrompt);
        void controller.processCommand(prompt, [], selection, 'selection-menu', intent);
    })();
}

function createChatPanel(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App; modelService: ModelService },
    markdownComponent: Component,
) {
    const container = document.createElement('div');
    container.className = `guardian-chat-view is-${state.mode}`;

    const header = container.createDiv({ cls: 'guardian-chat-header' });
    header.createSpan({ text: t('Inline AI') });
    const closeBtn = header.createEl('button', {
        text: 'x',
        cls: 'guardian-close-btn',
        attr: { type: 'button', title: t('Close'), 'aria-label': t('Close') },
    });
    closeBtn.onclick = () => {
        state.controller.cleanup();
        view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
    };

    const messageList = container.createDiv({ cls: 'guardian-message-list' });
    const renderMessages = () => {
        messageList.empty();
        const messages = state.controller.getMessages();
        if (messages.length === 0) {
            messageList.createDiv({
                cls: 'guardian-message system',
                text: 'Ask AI what to insert here.',
            });
        } else {
            for (const msg of messages) {
                renderSelectionMessage(context.app, messageList, msg, markdownComponent);
            }
        }
        window.setTimeout(() => {
            messageList.scrollTop = messageList.scrollHeight;
        }, 0);
    };

    renderMessages();
    (state.controller as any).onMessageAdded = () => renderMessages();

    const statusContainer = container.createDiv({ cls: 'guardian-status-bar baizer-hidden' });
    statusContainer.setText(t('Thinking...'));
    (state.controller as any).onStatusChanged = (isResponding: boolean) => {
        if (isResponding) statusContainer.removeClass('baizer-hidden');
        else statusContainer.addClass('baizer-hidden');
    };

    const inputWrapper = container.createDiv({ cls: 'guardian-input-wrapper' });
    const textarea = inputWrapper.createEl('textarea', {
        cls: 'guardian-chat-input',
        attr: {
            placeholder: t('Ask what to insert...'),
            'aria-label': t('Ask what to insert...'),
            rows: '2',
        },
    });

    const suggestContainer = inputWrapper.createDiv({ cls: 'baizer-suggest-container baizer-hidden' });
    const suggestList = new SuggestList({
        container: suggestContainer,
        hostInput: textarea,
        provideItems: (type: SuggestionType, query: string): SuggestionItem[] => {
            if (type !== 'file') return [];
            return context.app.vault.getFiles()
                .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(f => ({ label: f.basename, desc: f.path, value: f.path, source: 'file' as const, kind: 'file' as const }));
        },
        onApply: (selection) => {
            const fileItem = selection.contextItem;
            if (fileItem && fileItem.type === 'file') {
                // file 补全:selection.text 为空(内容在 contextItem),
                // 选区对话框没有 context chip,改为在光标处把最近的 @token 替换为 [[path]] wikilink 文字
                const cursor = textarea.selectionStart;
                const before = textarea.value.slice(0, cursor).replace(/@\S*$/, `[[${fileItem.data}]] `);
                const after = textarea.value.slice(cursor);
                textarea.value = before + after;
                textarea.selectionStart = textarea.selectionEnd = before.length;
            } else {
                textarea.value = selection.text;
                textarea.selectionStart = textarea.selectionEnd = selection.cursor;
            }
            textarea.focus();
        },
    });
    textarea.oninput = () => suggestList.handleInput(textarea.value, textarea.selectionStart);

    textarea.onkeydown = async (event) => {
        event.stopPropagation();
        if (suggestList.handleKeyDown(event)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            state.controller.cleanup();
            view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey) return;
        // IME 组合输入中按 Enter 只确认候选词,不提交(与主输入框一致)。
        if (event.isComposing) return;
        event.preventDefault();

        const text = textarea.value.trim();
        if (!text) return;
        textarea.value = '';

        const targetText = getTargetText(view, state);
        await state.controller.processCommand(
            text,
            [buildContextItem(state.mode, targetText)],
            targetText,
            'selection-menu',
        );
    };

    const actions = container.createDiv({ cls: 'guardian-chat-actions' });
    const copyBtn = actions.createEl('button', {
        text: t('Copy line'),
        attr: { type: 'button' },
    });
    copyBtn.onclick = () => {
        void navigator.clipboard.writeText(getTargetText(view, state));
        new Notice(t('Copied.'));
    };

    const applyBtn = actions.createEl('button', {
        text: t('Insert'),
        attr: { type: 'button' },
    });
    applyBtn.onclick = () => {
        void applyTriggerInsertion(view, state, context);
    };

    window.setTimeout(() => textarea.focus(), 50);
    return container;
}

function renderSelectionMessage(app: App, messageList: HTMLElement, msg: ChatMessage, markdownComponent: Component) {
    const msgEl = messageList.createDiv({ cls: `guardian-message ${msg.role}` });
    if (msg.role === 'ai') {
        void MarkdownRenderer.render(app, msg.content, msgEl, '', markdownComponent);
    } else {
        msgEl.setText(msg.content);
    }
}

function getTargetText(view: EditorView, state: Extract<SelectionMenuState, { type: 'chat' }>) {
    const line = view.state.doc.lineAt(state.from);
    const beforeTrigger = line.text.slice(0, Math.max(0, state.from - line.from)).trim();
    return beforeTrigger || line.text.replace('@', '').trim();
}

function buildContextItem(mode: AiMenuMode, targetText: string) {
    return {
        id: mode === 'selection' ? 'selection-menu-context' : 'inline-at-context',
        type: 'selection',
        data: mode === 'selection' ? 'Editor selection' : 'Inline @ trigger',
        summary: mode === 'selection' ? 'Editor selection' : 'Inline @ trigger',
        content: mode === 'selection'
            ? `Selected Text:\n${targetText}`
            : `Line Context:\n${targetText}`,
    };
}

/**
 * 在当前文档中重新定位待替换的选区。
 * - 原偏移处文本仍与快照一致 → 直接用原偏移（最常见、零歧义）。
 * - 否则在全文搜索快照文本，取起点离原 from 最近的一处匹配。
 * - 找不到则返回 null（调用方应中止替换，绝不盲写）。
 */
function relocateRange(
    state: EditorState,
    from: number,
    to: number,
    snapshot: string,
): { from: number; to: number } | null {
    if (!snapshot) return null;
    const docLength = state.doc.length;
    if (from >= 0 && to <= docLength && state.doc.sliceString(from, to) === snapshot) {
        return { from, to };
    }

    const fullText = state.doc.toString();
    let best: number | null = null;
    let index = fullText.indexOf(snapshot);
    while (index !== -1) {
        if (best === null || Math.abs(index - from) < Math.abs(best - from)) {
            best = index;
        }
        index = fullText.indexOf(snapshot, index + 1);
    }
    if (best === null) return null;
    return { from: best, to: best + snapshot.length };
}

async function applyTriggerInsertion(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App },
) {
    const response = getLastAiResponse(state.controller);
    if (!response) {
        new Notice(t('No AI response to insert.'));
        return;
    }

    const activeFile = context.app.workspace.getActiveFile();
    await state.controller.applyPreviewedChange({
        action: 'inline_ai_insert',
        target: activeFile?.path || 'current-editor',
        previousContent: view.state.doc.toString(),
        apply: () => {
            view.dispatch({
                changes: { from: state.from, to: state.to, insert: response },
                effects: setSelectionMenuState.of({ type: 'hidden' }),
            });
        },
    });
}

function getLastAiResponse(controller: ChatController): string {
    const message = [...controller.getMessages()].reverse().find(item => item.role === 'ai');
    return message?.content || '';
}

function cleanupPreviousController(previous: SelectionMenuState, next: SelectionMenuState) {
    if (previous.type !== 'chat') return;
    if (next.type === 'chat' && next.controller === previous.controller) return;
    previous.controller.cleanup();
}
