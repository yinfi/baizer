import { App, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';
import { EditorView, showTooltip, tooltips } from '@codemirror/view';
import { StateField, Extension, StateEffect, EditorState } from '@codemirror/state';
import { ModelService } from '../services/model-service';
import { ChatController } from './chat-controller';
import { ChatMessage } from './types';
import { SuggestList } from './components/suggest-list';
import { SuggestionItem, SuggestionType } from './controllers/input-controller';
import { SELECTION_ACTIONS, getAction, buildActionPrompt } from './selection-ai/action-registry';
import { runRewrite, RewriteRequest } from './selection-ai/rewrite-runner';
import { t } from '../i18n/zh';
import { showInlineDiff, clearInlineDiff, InlineDiffState } from './selection-ai/inline-diff';

// 模块级改写状态:inlineDiffExtension 的回调是全局单例、拿不到具体 view,
// 故在此维护当前 view / modelService / request / controller,供导出的三个回调桥接函数使用。
let rewriteView: EditorView | null = null;
let activeModelService: ModelService | null = null;
let currentRewriteRequest: RewriteRequest | null = null;
let currentRewriteController: AbortController | null = null;

type AiMenuMode = 'selection' | 'trigger';

type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'button'; mode: AiMenuMode; from: number; to: number }
    | { type: 'chat'; mode: AiMenuMode; from: number; to: number; controller: ChatController };

const pluginContextMap = new WeakMap<EditorView, { app: App; modelService: ModelService }>();

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
            const next: SelectionMenuState = {
                type: state.type === 'chat'
                    && state.mode === 'selection'
                    && state.from === selection.from
                    && state.to === selection.to
                    ? 'chat'
                    : 'button',
                mode: 'selection',
                from: selection.from,
                to: selection.to,
                ...(state.type === 'chat'
                    && state.mode === 'selection'
                    && state.from === selection.from
                    && state.to === selection.to
                    ? { controller: state.controller }
                    : {}),
            } as SelectionMenuState;
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

export function selectionMenuExtension(app: App, modelService: ModelService): Extension {
    return [
        selectionMenuField,
        // Tooltip 定位:默认挂在编辑器 DOM 内、以整窗判定可用空间 —— 编辑器被 Workbench 侧栏挤窄时,
        // 面板会向右溢出编辑器并被靠后的侧栏兄弟节点盖住(跨 DOM 子树,z-index 压不住)。
        // 三个开关对症:提到 body 顶层脱离兄弟遮挡 + fixed 视口定位不被 overflow 裁剪 +
        // tooltipSpace 限定为编辑器自身矩形,令 CM 按编辑器宽度自动左移避让,不再伸进侧栏区域。
        tooltips({
            parent: document.body,
            position: 'fixed',
            tooltipSpace: (view) => view.dom.getBoundingClientRect(),
        }),
        EditorView.updateListener.of((update) => {
            pluginContextMap.set(update.view, { app, modelService });
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

    if (state.type === 'button') {
        const btn = document.createElement('button');
        btn.className = 'guardian-selection-btn';
        btn.type = 'button';
        // ✨ sparkle 图标 = AI 操作的业界通用符号(Notion/Cursor/Gemini),
        // 取代旧的纯文字「AI」/「@ AI」(@ 与「文件提及」语义冲突,且灰块难辨识)。
        setIcon(btn, 'sparkles');
        btn.createSpan({ cls: 'guardian-selection-btn-label', text: 'AI' });
        btn.setAttribute('aria-label', state.mode === 'selection' ? 'Ask AI about selection' : 'Ask AI to insert here');
        btn.title = state.mode === 'selection' ? 'Ask AI about selection' : 'Ask AI to insert here';
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

    dom.appendChild(createChatPanel(view, state, context));
    return { dom };
}

function createChatPanel(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App; modelService: ModelService },
) {
    const container = document.createElement('div');
    container.className = `guardian-chat-view is-${state.mode}`;

    const header = container.createDiv({ cls: 'guardian-chat-header' });
    header.createSpan({ text: state.mode === 'selection' ? t('Selection AI') : t('Inline AI') });
    const closeBtn = header.createEl('button', {
        text: 'x',
        cls: 'guardian-close-btn',
        attr: { type: 'button', title: t('Close'), 'aria-label': t('Close') },
    });
    closeBtn.onclick = () => {
        cleanupPendingRewrite(view);
        state.controller.cleanup();
        view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
    };

    const actionBar = container.createDiv({ cls: 'baizer-action-bar' });
    for (const action of SELECTION_ACTIONS) {
        const btn = actionBar.createEl('button', {
            cls: 'baizer-action-btn',
            attr: { type: 'button', title: action.label, 'aria-label': action.label },
        });
        setIcon(btn, action.icon);
        btn.createSpan({ cls: 'baizer-action-label', text: action.label });
        btn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            void runSelectionAction(view, state, context, action.id);
        };
    }

    const messageList = container.createDiv({ cls: 'guardian-message-list' });
    const renderMessages = () => {
        messageList.empty();
        const messages = state.controller.getMessages();
        if (messages.length === 0) {
            messageList.createDiv({
                cls: 'guardian-message system',
                text: state.mode === 'selection'
                    ? 'Ask about the selected text.'
                    : 'Ask AI what to insert here.',
            });
        } else {
            for (const msg of messages) {
                renderSelectionMessage(context.app, messageList, msg);
            }
        }
        setTimeout(() => {
            messageList.scrollTop = messageList.scrollHeight;
        }, 0);
    };

    renderMessages();
    (state.controller as any).onMessageAdded = () => renderMessages();

    const statusContainer = container.createDiv({ cls: 'guardian-status-bar' });
    statusContainer.style.display = 'none';
    statusContainer.setText(t('Thinking...'));
    (state.controller as any).onStatusChanged = (isResponding: boolean) => {
        statusContainer.style.display = isResponding ? 'block' : 'none';
    };

    const inputWrapper = container.createDiv({ cls: 'guardian-input-wrapper' });
    const textarea = inputWrapper.createEl('textarea', {
        cls: 'guardian-chat-input',
        attr: {
            placeholder: state.mode === 'selection' ? t('Ask about this selection...') : t('Ask what to insert...'),
            'aria-label': state.mode === 'selection' ? t('Ask about this selection...') : t('Ask what to insert...'),
            rows: '2',
        },
    });

    const suggestContainer = inputWrapper.createDiv({ cls: 'baizer-suggest-container' });
    suggestContainer.style.display = 'none';
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
            cleanupPendingRewrite(view);
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
        text: state.mode === 'selection' ? t('Copy') : t('Copy line'),
        attr: { type: 'button' },
    });
    copyBtn.onclick = () => {
        void navigator.clipboard.writeText(getTargetText(view, state));
        new Notice(t('Copied.'));
    };

    const applyBtn = actions.createEl('button', {
        text: state.mode === 'selection' ? t('Replace') : t('Insert'),
        attr: { type: 'button' },
    });
    applyBtn.onclick = () => {
        if (state.mode === 'selection') {
            const selectionText = view.state.doc.sliceString(state.from, state.to);
            const lastAi = [...state.controller.getMessages()].reverse().find(m => m.role === 'ai');
            if (!lastAi?.content) { new Notice('还没有可应用的 AI 回答。'); return; }
            // 记录模块级改写上下文,供内联 diff 的 accept/reject 回调桥接使用。
            // request 置空:这是「应用最后一条 AI 回答」,无对应改写动作可 retry(retry 将是 no-op)。
            rewriteView = view;
            activeModelService = context.modelService;
            currentRewriteController?.abort();
            currentRewriteController = null;
            currentRewriteRequest = null;
            showInlineDiff(view, {
                from: state.from,
                to: state.to,
                oldText: selectionText,
                newText: lastAi.content.trim(),
                status: 'preview',
            });
        } else {
            void applyTriggerInsertion(view, state, context);
        }
    };

    setTimeout(() => textarea.focus(), 50);
    return container;
}

function renderSelectionMessage(app: App, messageList: HTMLElement, msg: ChatMessage) {
    const msgEl = messageList.createDiv({ cls: `guardian-message ${msg.role}` });
    if (msg.role === 'ai') {
        void MarkdownRenderer.render(app, msg.content, msgEl, '', new Component());
    } else {
        msgEl.setText(msg.content);
    }
}

function getTargetText(view: EditorView, state: Extract<SelectionMenuState, { type: 'chat' }>) {
    if (state.mode === 'selection') {
        return view.state.doc.sliceString(state.from, state.to);
    }

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
 * 动作条按钮分流:改写类走内联 diff,只读类走对话框流式。
 * 对话框不因执行动作而关闭。
 */
async function runSelectionAction(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App; modelService: ModelService },
    actionId: string,
) {
    const action = getAction(actionId);
    if (!action) return;
    const targetText = getTargetText(view, state);
    if (!targetText.trim()) { new Notice('请先选中文字。'); return; }

    if (action.kind === 'readonly') {
        // 只读类:走对话框既有流式通道(带 web_search + query_knowledge 工具)
        await state.controller.processCommand(
            buildActionPrompt(actionId, targetText),
            [buildContextItem(state.mode, targetText)],
            targetText,
            'selection-menu',
        );
        return;
    }

    // 改写类:generate() 一次性改写 → 内联 diff(不经对话框流式)
    runRewriteAction(view, context, actionId, state.from, state.to, targetText);
}

/**
 * 发起一次改写:记录模块级改写上下文,调 runRewrite(它自己推 loading/preview/error 三态),
 * 存住返回的 controller 供 retry 使用。
 */
function runRewriteAction(
    view: EditorView,
    context: { app: App; modelService: ModelService },
    actionId: string,
    from: number,
    to: number,
    selectionText: string,
) {
    rewriteView = view;
    activeModelService = context.modelService;
    currentRewriteController?.abort(); // 中止上一次未决改写
    currentRewriteRequest = { actionId, selection: selectionText, from, to };
    currentRewriteController = runRewrite(view, context.modelService, currentRewriteRequest);
}

/**
 * inline-diff 回调桥接(Task 7 在 main.ts 注册 inlineDiffExtension 时接上)。
 * 因为 inlineDiffExtension 的回调是全局单例、拿不到具体 view,这里用模块级 rewriteView 转发。
 */
export function handleInlineDiffAccept(s: InlineDiffState) {
    if (!rewriteView) return;
    rewriteView.dispatch({ changes: { from: s.from, to: s.to, insert: s.newText } });
    clearInlineDiff(rewriteView);
    currentRewriteController = null;
    currentRewriteRequest = null;
}

/** 关闭对话框时清理未决的改写:中止请求 + 清掉内联 diff 装饰 + 复位模块级状态。 */
function cleanupPendingRewrite(view: EditorView) {
    currentRewriteController?.abort();
    currentRewriteController = null;
    currentRewriteRequest = null;
    clearInlineDiff(view);
}

export function handleInlineDiffReject(_s: InlineDiffState) {
    if (!rewriteView) return;
    clearInlineDiff(rewriteView);
    currentRewriteController = null;
    currentRewriteRequest = null;
}

export function handleInlineDiffRetry(_s: InlineDiffState) {
    if (!rewriteView || !activeModelService || !currentRewriteRequest) return;
    currentRewriteController?.abort();
    currentRewriteController = runRewrite(rewriteView, activeModelService, currentRewriteRequest);
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
