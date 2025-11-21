import { App, MarkdownRenderer, Component } from 'obsidian';
import { EditorView, showTooltip } from '@codemirror/view';
import { StateField, Extension, StateEffect } from '@codemirror/state';

// Define the states for our UI
type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'button', from: number, to: number }
    | { type: 'input', from: number, to: number }
    | { type: 'processing', from: number, to: number }
    | { type: 'result', from: number, to: number, content: string };

// Callback type for when user submits an instruction
export type SelectionActionCallback = (view: EditorView, selection: { from: number, to: number }, instruction: string) => void;

let globalActionCallback: SelectionActionCallback | null = null;

export function setSelectionActionCallback(callback: SelectionActionCallback) {
    globalActionCallback = callback;
}

let pluginApp: App | null = null;

// We need a way to manually update the state (e.g. button click -> input)
// We can use StateEffects for this.
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

            // If we are in input/processing mode, do we cancel on selection change?
            // Usually yes, unless it's a minor adjustment? Let's be strict: selection change resets UI.
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
                        view.dispatch({
                            effects: setSelectionMenuState.of({ type: 'input', from: state.from, to: state.to })
                        });
                    };
                    dom.appendChild(btn);
                } else if (state.type === 'input') {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'guardian-input-wrapper';

                    const textarea = document.createElement('textarea');
                    textarea.placeholder = 'Ask AI to edit...';
                    textarea.className = 'guardian-selection-input';

                    // Prevent Enter from propagating to editor
                    textarea.onkeydown = (e) => {
                        e.stopPropagation(); // Stop CM from handling it
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            // Submit
                            const text = textarea.value.trim();
                            if (text && globalActionCallback) {
                                view.dispatch({
                                    effects: setSelectionMenuState.of({ type: 'processing', from: state.from, to: state.to })
                                });
                                globalActionCallback(view, { from: state.from, to: state.to }, text);
                            }
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            view.dispatch({
                                effects: setSelectionMenuState.of({ type: 'button', from: state.from, to: state.to })
                            });
                        }
                    };

                    const btnGroup = document.createElement('div');
                    btnGroup.className = 'guardian-btn-group';

                    const submitBtn = document.createElement('button');
                    submitBtn.textContent = 'Submit';
                    submitBtn.className = 'guardian-submit-btn';
                    submitBtn.onclick = () => {
                        const text = textarea.value.trim();
                        if (text && globalActionCallback) {
                            view.dispatch({
                                effects: setSelectionMenuState.of({ type: 'processing', from: state.from, to: state.to })
                            });
                            globalActionCallback(view, { from: state.from, to: state.to }, text);
                        }
                    };

                    btnGroup.appendChild(submitBtn);
                    wrapper.appendChild(textarea);
                    wrapper.appendChild(btnGroup);
                    dom.appendChild(wrapper);

                    // Focus
                    setTimeout(() => textarea.focus(), 20);
                } else if (state.type === 'processing') {
                    dom.textContent = 'Thinking...';
                    dom.className += ' guardian-processing';
                } else if (state.type === 'result') {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'guardian-result-view';

                    const content = document.createElement('div');
                    content.className = 'guardian-result-content';

                    if (pluginApp) {
                        MarkdownRenderer.render(pluginApp, state.content, content, '', new Component());
                    } else {
                        content.textContent = state.content;
                    }

                    wrapper.appendChild(content);

                    // Ensure we start at the top
                    setTimeout(() => {
                        content.scrollTop = 0;
                    }, 0);

                    const actions = document.createElement('div');
                    actions.className = 'guardian-result-actions';

                    const copyBtn = document.createElement('button');
                    copyBtn.textContent = 'Copy';
                    copyBtn.onclick = () => {
                        navigator.clipboard.writeText(state.content);
                        copyBtn.textContent = 'Copied!';
                        setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                    };

                    const closeBtn = document.createElement('button');
                    closeBtn.textContent = 'Close';
                    closeBtn.onclick = () => {
                        view.dispatch({
                            effects: setSelectionMenuState.of({ type: 'hidden' })
                        });
                    };

                    actions.appendChild(copyBtn);
                    actions.appendChild(closeBtn);
                    wrapper.appendChild(actions);
                    dom.appendChild(wrapper);
                }

                return { dom };
            }
        };
    })
});

export function selectionMenuExtension(app: App): Extension {
    pluginApp = app;
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
