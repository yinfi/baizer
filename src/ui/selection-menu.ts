import { App, MarkdownRenderer, Component, Notice } from 'obsidian';
import { EditorView, showTooltip } from '@codemirror/view';
import { StateField, Extension, StateEffect } from '@codemirror/state';
import { ModelService } from '../services/model-service';
import { ChatController, ChatMessage } from './chat-controller';

// Define the states for our UI
type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'button', from: number, to: number }
    | { type: 'chat', from: number, to: number, controller: ChatController };

// 使用 WeakMap 存储插件上下文，避免内存泄漏
const pluginContextMap = new WeakMap<EditorView, { app: App; modelService: ModelService }>();

// We need a way to manually update the state (e.g. button click -> input)
export const setSelectionMenuState = StateEffect.define<SelectionMenuState>();

const selectionMenuField = StateField.define<SelectionMenuState>({
    create() { return { type: 'hidden' }; },
    update(state, tr) {
        // 1. Handle explicit state changes (User interaction)
        for (let effect of tr.effects) {
            if (effect.is(setSelectionMenuState)) {
                return effect.value;
            }
        }

        // 2. Handle selection changes
        if (tr.selection) {
            const selection = tr.newSelection.main;
            if (selection.empty) {
                return { type: 'hidden' };
            }

            // If we are in chat mode, do we cancel on selection change?
            // Yes, strict behavior: selection change resets UI.
            if (state.type !== 'hidden' && (selection.from !== state.from || selection.to !== state.to)) {
                return { type: 'button', from: selection.from, to: selection.to };
            }

            if (state.type === 'hidden') {
                return { type: 'button', from: selection.from, to: selection.to };
            }
        }

        return state;
    },
    provide: f => showTooltip.from(f, (state, view) => {
        if (state.type === 'hidden') return null;

        const context = view ? pluginContextMap.get(view) : undefined;
        if (!context) return null;

        return {
            pos: state.from,
            above: true,
            strictSide: true,
            create: () => {
                const dom = document.createElement('div');
                dom.className = 'guardian-selection-tooltip';

                if (state.type === 'button') {
                    const btn = document.createElement('button');
                    btn.className = 'guardian-selection-btn';
                    btn.textContent = 'Comment / AI';
                    btn.onclick = () => {
                        // Initialize ChatController
                        const controller = new ChatController({
                            app: context.app,
                            api: context.modelService,
                            onMessageAdded: (msg) => {
                                // 重新渲染逻辑...
                            },
                            onStatusChanged: (isResponding) => {
                                // 状态更新逻辑...
                            }
                        });

                        view.dispatch({
                            effects: setSelectionMenuState.of({
                                type: 'chat',
                                from: state.from,
                                to: state.to,
                                controller: controller
                            })
                        });
                    };
                    dom.appendChild(btn);
                } else if (state.type === 'chat') {
                    const container = document.createElement('div');
                    container.className = 'guardian-chat-view';

                    // 1. Header
                    const header = container.createDiv({ cls: 'guardian-chat-header' });
                    header.createSpan({ text: 'Gemini Context' });
                    const closeBtn = header.createEl('button', { text: '×', cls: 'guardian-close-btn' });
                    closeBtn.onclick = () => {
                        view.dispatch({
                            effects: setSelectionMenuState.of({ type: 'hidden' })
                        });
                    };

                    // 2. Message List
                    const messageList = container.createDiv({ cls: 'guardian-message-list' });

                    const renderMessages = () => {
                        messageList.empty();
                        const messages = state.controller.getMessages();
                        if (messages.length === 0) {
                            const welcome = messageList.createDiv({ cls: 'guardian-message system' });
                            welcome.setText('Ask about the selected text...');
                        } else {
                            messages.forEach(msg => {
                                const msgEl = messageList.createDiv({ cls: `guardian-message ${msg.role}` });
                                if (msg.role === 'ai') {
                                    MarkdownRenderer.render(context.app, msg.content, msgEl, '', new Component());
                                } else {
                                    msgEl.setText(msg.content);
                                }
                            });
                        }
                        // Scroll to bottom
                        setTimeout(() => messageList.scrollTop = messageList.scrollHeight, 0);
                    };

                    renderMessages();

                    // Hook up callbacks to update UI
                    state.controller['onMessageAdded'] = (msg: ChatMessage) => {
                        renderMessages();
                    };

                    // Loading indicator
                    const statusContainer = container.createDiv({ cls: 'guardian-status-bar' });
                    statusContainer.style.display = 'none';
                    statusContainer.setText('Thinking...');

                    state.controller['onStatusChanged'] = (isResponding: boolean) => {
                        statusContainer.style.display = isResponding ? 'block' : 'none';
                    };


                    // 3. Input Area
                    const inputWrapper = container.createDiv({ cls: 'guardian-input-wrapper' });
                    const textarea = inputWrapper.createEl('textarea', {
                        cls: 'guardian-chat-input',
                        attr: { placeholder: 'Type a message...' }
                    });

                    textarea.onkeydown = async (e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            const text = textarea.value.trim();
                            if (!text) return;

                            textarea.value = '';

                            // Context: The selected text
                            const selectionText = view.state.doc.sliceString(state.from, state.to);
                            const contextStr = `Selected Text:\n${selectionText}`;

                            await state.controller.processCommand(text, contextStr, selectionText);
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            view.dispatch({
                                effects: setSelectionMenuState.of({ type: 'button', from: state.from, to: state.to })
                            });
                        }
                    };

                    // 4. Actions
                    const actions = container.createDiv({ cls: 'guardian-chat-actions' });

                    const copyBtn = actions.createEl('button', { text: 'Copy Selection' });
                    copyBtn.onclick = () => {
                        const selectionText = view.state.doc.sliceString(state.from, state.to);
                        navigator.clipboard.writeText(selectionText);
                        new Notice('Selection copied');
                    };

                    const replaceBtn = actions.createEl('button', { text: 'Replace with Last Response' });
                    replaceBtn.onclick = () => {
                        const msgs = state.controller.getMessages();
                        const lastAiMsg = [...msgs].reverse().find(m => m.role === 'ai');
                        if (lastAiMsg) {
                            view.dispatch({
                                changes: { from: state.from, to: state.to, insert: lastAiMsg.content },
                                effects: setSelectionMenuState.of({ type: 'hidden' })
                            });
                        } else {
                            new Notice('No AI response to replace with.');
                        }
                    };

                    dom.appendChild(container);

                    // Focus input
                    setTimeout(() => textarea.focus(), 50);
                }

                return { dom };
            }
        };
    })
});

export function selectionMenuExtension(app: App, modelService: ModelService): Extension {
    // 使用 WeakMap 存储 context，避免静态变量持有强引用
    return [
        selectionMenuField,
        // 使用 EditorView.updateListener 来存储 context
        EditorView.updateListener.of((update) => {
            if (update.view) {
                pluginContextMap.set(update.view, { app, modelService });
            }
        })
    ];
}

// Helper to reset state (e.g. after success)
export function resetSelectionMenu(view: EditorView) {
    view.dispatch({
        effects: setSelectionMenuState.of({ type: 'hidden' })
    });
}
