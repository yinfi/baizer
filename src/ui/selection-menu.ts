import { EditorView, ViewPlugin, ViewUpdate, Tooltip, showTooltip } from '@codemirror/view';

import { StateField, Extension, StateEffect } from '@codemirror/state';
import { setGhostText } from './ghost-text'; // Import to check if ghost text is active

// Define the states for our UI
type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'button', from: number, to: number }
    | { type: 'input', from: number, to: number }
    | { type: 'processing', from: number, to: number };

// Callback type for when user submits an instruction
export type SelectionActionCallback = (view: EditorView, selection: { from: number, to: number }, instruction: string) => void;

let globalActionCallback: SelectionActionCallback | null = null;

export function setSelectionActionCallback(callback: SelectionActionCallback) {
    globalActionCallback = callback;
}

// ViewPlugin to track selection and manage UI state
export const selectionMenuPlugin = ViewPlugin.fromClass(class {
    state: SelectionMenuState = { type: 'hidden' };
    tooltip: Tooltip | null = null;

    constructor(public view: EditorView) {
        this.updateState(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
            this.updateState(update.view);
        }
    }

    updateState(view: EditorView) {
        const selection = view.state.selection.main;

        // If selection is empty, hide
        if (selection.empty) {
            this.setState(view, { type: 'hidden' });
            return;
        }

        // If we are already in input or processing state, don't reset to button unless selection changed significantly?
        // Actually, if selection changes, we should probably reset to button or hidden to avoid confusion.
        // For now, simple logic: Selection exists -> Show Button (unless we are interacting)

        // However, we need to persist 'input' state if the user is just typing in the input box (which is outside the editor).
        // But wait, the input box is in the tooltip.
        // If the user changes the EDITOR selection, we should probably reset.

        if (this.state.type === 'hidden') {
            this.setState(view, { type: 'button', from: selection.from, to: selection.to });
        } else if (this.state.type === 'button') {
            // Update coordinates if selection changed
            this.setState(view, { type: 'button', from: selection.from, to: selection.to });
        }
        // If input/processing, we stay there until explicitly closed or selection cleared
    }

    setState(view: EditorView, newState: SelectionMenuState) {
        this.state = newState;

        if (newState.type === 'hidden') {
            this.tooltip = null;
        } else {
            this.tooltip = {
                pos: newState.from,
                above: true,
                strictSide: true,
                create: () => {
                    const dom = document.createElement('div');
                    dom.className = 'guardian-selection-tooltip';

                    if (newState.type === 'button') {
                        this.renderButton(dom, view, newState);
                    } else if (newState.type === 'input') {
                        this.renderInput(dom, view, newState);
                    } else if (newState.type === 'processing') {
                        this.renderProcessing(dom);
                    }

                    return { dom };
                }
            };
        }

        // Dispatch effect to update tooltip
        // Note: ViewPlugin cannot dispatch state effects directly to update the extension configuration easily
        // in the way showTooltip expects if we used the StateField approach.
        // But here we are using a ViewPlugin that provides the tooltip via the 'provide' facet?
        // Actually, the standard way is to use a StateField<Tooltip[]> and provide showTooltip.
    }

    renderButton(container: HTMLElement, view: EditorView, state: { from: number, to: number }) {
        const btn = document.createElement('button');
        btn.className = 'guardian-selection-btn';
        btn.textContent = 'Comment / AI';
        btn.onclick = () => {
            this.setState(view, { type: 'input', from: state.from, to: state.to });
            // Force update to render new tooltip
            view.dispatch({ effects: [] });
        };
        container.appendChild(btn);
    }

    renderInput(container: HTMLElement, view: EditorView, state: { from: number, to: number }) {
        const wrapper = document.createElement('div');
        wrapper.className = 'guardian-input-wrapper';

        const textarea = document.createElement('textarea');
        textarea.placeholder = 'Ask AI to edit or answer...';
        textarea.className = 'guardian-selection-input';

        // Auto-focus
        setTimeout(() => textarea.focus(), 50);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'guardian-btn-group';

        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Submit';
        submitBtn.className = 'guardian-submit-btn';
        submitBtn.onclick = () => {
            const text = textarea.value.trim();
            if (text && globalActionCallback) {
                this.setState(view, { type: 'processing', from: state.from, to: state.to });
                view.dispatch({ effects: [] }); // Force update
                globalActionCallback(view, { from: state.from, to: state.to }, text);
            }
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'guardian-cancel-btn';
        cancelBtn.onclick = () => {
            this.setState(view, { type: 'button', from: state.from, to: state.to });
            view.dispatch({ effects: [] }); // Force update
        };

        // Enter to submit
        textarea.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitBtn.click();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                cancelBtn.click();
            }
        };

        btnGroup.appendChild(cancelBtn);
        btnGroup.appendChild(submitBtn);

        wrapper.appendChild(textarea);
        wrapper.appendChild(btnGroup);
        container.appendChild(wrapper);
    }

    renderProcessing(container: HTMLElement) {
        const spinner = document.createElement('div');
        spinner.className = 'guardian-spinner';
        spinner.textContent = 'Thinking...';
        container.appendChild(spinner);
    }
});

// We need a StateField to actually provide the tooltip to CodeMirror
export const selectionTooltipField = StateField.define<Tooltip | null>({
    create: () => null,
    update(tooltip, tr) {
        // This is a bit tricky. The ViewPlugin manages the logic, but StateField provides the tooltip.
        // Let's try a simpler approach: A pure ViewPlugin that provides the tooltip extension.
        return tooltip;
    },
    provide: f => showTooltip.from(f)
});

// RE-WRITE: The above hybrid approach is messy. Let's use a pure StateField approach for the Tooltip.

const selectionStateField = StateField.define<SelectionMenuState>({
    create() { return { type: 'hidden' }; },
    update(state, tr) {
        if (tr.selection) {
            const selection = tr.newSelection.main;
            if (selection.empty) {
                return { type: 'hidden' };
            }
            // If we were hidden, show button
            if (state.type === 'hidden') {
                return { type: 'button', from: selection.from, to: selection.to };
            }
            // If selection changed significantly, reset to button? 
            // For now, just update coords if in button mode
            if (state.type === 'button') {
                return { type: 'button', from: selection.from, to: selection.to };
            }
        }
        return state;
    }
});

// We need a way to manually update the state (e.g. button click -> input)
// We can use StateEffects for this.
import { StateEffectType } from '@codemirror/state';

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
                }

                return { dom };
            }
        };
    })
});

export function selectionMenuExtension(): Extension {
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
