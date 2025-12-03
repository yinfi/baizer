import { App, MarkdownRenderer, Component, Notice } from 'obsidian';
import { EditorView, showTooltip } from '@codemirror/view';
import { StateField, Extension, StateEffect } from '@codemirror/state';
import { GeminiAPI } from '../gemini-api';
import { ChatController, ChatMessage } from './chat-controller';

// Define the states for our UI
type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'button', from: number, to: number }
    | { type: 'chat', from: number, to: number, controller: ChatController };

let pluginApp: App | null = null;
let pluginApi: GeminiAPI | null = null;

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
    provide: f => showTooltip.from(f, state => {
        if (state.type === 'hidden') return null;

        return {
            pos: state.from,
            above: true,
            strictSide: true,
            create: (view) => {
                const dom = document.createElement('div');
                dom.className = 'guardian-selection-tooltip';

                if (state.type === 'button') {
                    const btn = document.createElement('button');
                    btn.className = 'guardian-selection-btn';
                    btn.textContent = 'Comment / AI';
                    btn.onclick = () => {
                        if (!pluginApp || !pluginApi) {
                            new Notice('Gemini API not initialized');
                            return;
                        }

                        // Initialize ChatController
                        const controller = new ChatController({
                            app: pluginApp,
                            api: pluginApi,
                            onMessageAdded: (msg) => {
                                // We need to re-render or update the UI when message is added
                                // Since we are inside create(), we can manipulate the DOM directly if we had reference
                                // But here we are creating the DOM.
                                // The ChatController will be passed to the 'chat' state.
                                // The 'chat' state render logic will handle the UI.
                                // However, for *updates* (streaming), we need a way to trigger UI update.
                                // A simple way is to dispatch a state update with the SAME controller,
                                // forcing a re-render? No, that's heavy.
                                // Better: The UI component subscribes to the controller.
                            },
                            onStatusChanged: (isResponding) => {
                                // Same here, update UI loading state
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
                                    MarkdownRenderer.render(pluginApp!, msg.content, msgEl, '', new Component());
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
                    // Note: This is a bit hacky as we are modifying the controller's callbacks *after* creation
                    // Ideally ChatController supports multiple listeners or we pass a delegate.
                    // For now, let's just override/wrap.
                    // Actually, we can just re-assign them since we have the instance.
                    // BUT, the controller was created in the previous step.
                    // We need to ensure we don't overwrite if we re-render?
                    // The state persists, so the controller persists.

                    // Let's just assign the callbacks here.
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

export function selectionMenuExtension(app: App, api: GeminiAPI): Extension {
    pluginApp = app;
    pluginApi = api;
    return [
        selectionMenuField
    ];
}

// Helper to reset state (e.g. after success)
export function resetSelectionMenu(view: EditorView) {
    view.dispatch({
        effects: setSelectionMenuState.of({ type: 'hidden' })
    });
}
