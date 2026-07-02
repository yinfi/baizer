import { App, MarkdownRenderer, Component, Notice } from 'obsidian';
import { EditorView, showTooltip } from '@codemirror/view';
import { StateField, Extension, StateEffect, EditorState } from '@codemirror/state';
import { ModelService } from '../services/model-service';
import { ChatController } from './chat-controller';
import { DiffModal } from './diff-modal';
import { ChatMessage } from './types';

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
        btn.textContent = state.mode === 'selection' ? 'AI' : '@ AI';
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
    header.createSpan({ text: state.mode === 'selection' ? 'Selection AI' : 'Inline AI' });
    const closeBtn = header.createEl('button', {
        text: 'x',
        cls: 'guardian-close-btn',
        attr: { type: 'button', title: 'Close' },
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
    statusContainer.setText('Thinking...');
    (state.controller as any).onStatusChanged = (isResponding: boolean) => {
        statusContainer.style.display = isResponding ? 'block' : 'none';
    };

    const inputWrapper = container.createDiv({ cls: 'guardian-input-wrapper' });
    const textarea = inputWrapper.createEl('textarea', {
        cls: 'guardian-chat-input',
        attr: {
            placeholder: state.mode === 'selection' ? 'Ask about this selection...' : 'Ask what to insert...',
            rows: '2',
        },
    });

    textarea.onkeydown = async (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            state.controller.cleanup();
            view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey) return;
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
        text: state.mode === 'selection' ? 'Copy' : 'Copy line',
        attr: { type: 'button' },
    });
    copyBtn.onclick = () => {
        void navigator.clipboard.writeText(getTargetText(view, state));
        new Notice('Copied.');
    };

    const applyBtn = actions.createEl('button', {
        text: state.mode === 'selection' ? 'Replace' : 'Insert',
        attr: { type: 'button' },
    });
    applyBtn.onclick = () => {
        if (state.mode === 'selection') {
            applySelectionReplacement(view, state, context);
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

function applySelectionReplacement(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App },
) {
    const selectionText = view.state.doc.sliceString(state.from, state.to);
    const preview = state.controller.buildSelectionRewritePreview(selectionText);
    if (!preview) {
        new Notice('No AI response to replace with.');
        return;
    }
    if (!preview.newContent || preview.newContent.length === 0) {
        new Notice('No proposed replacement is available yet.');
        return;
    }

    new DiffModal(context.app, preview.oldContent || '', preview.newContent || '', async () => {
        const activeFile = context.app.workspace.getActiveFile();
        // 锚点重定位：审阅期间文档可能被改动（后台写入/多窗口编辑），
        // 冻结的 state.from/to 可能失效。apply 前用选区文本重新定位。
        const target = relocateRange(view.state, state.from, state.to, selectionText);
        if (!target) {
            new Notice('选区在审阅期间发生了变化，无法定位原文本，已取消替换，请重新选择。');
            view.dispatch({ effects: setSelectionMenuState.of({ type: 'hidden' }) });
            return;
        }
        await state.controller.applyPreviewedChange({
            action: 'selection_rewrite',
            target: activeFile?.path || 'current-selection',
            previousContent: view.state.doc.toString(),
            apply: () => {
                view.dispatch({
                    changes: {
                        from: target.from,
                        to: target.to,
                        insert: preview.newContent || '',
                    },
                    effects: setSelectionMenuState.of({ type: 'hidden' }),
                });
            },
        });
    }).open();
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
        new Notice('No AI response to insert.');
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
