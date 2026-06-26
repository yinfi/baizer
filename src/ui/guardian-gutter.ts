import { EditorView, gutter, GutterMarker } from '@codemirror/view';
import { StateField, StateEffect, RangeSet, EditorState } from '@codemirror/state';

// Guardian状态
export enum GuardianState {
    Idle = 'idle',
    Thinking = 'thinking',
    HasSuggestion = 'has-suggestion',
    Error = 'error',
    Paused = 'paused'
}

// Global Guardian Mode (Active vs Paused)
export const setGuardianMode = StateEffect.define<boolean>();

// Effect to update the specific line state (Thinking/Suggestion)
export const setGuardianLineState = StateEffect.define<{ line: number; state: GuardianState } | null>();

// Global State for Guardian Mode
let globalGuardianEnabled = true;

// StateField for Global Mode
export const guardianModeField = StateField.define<boolean>({
    create() {
        return globalGuardianEnabled; // Initialize from global state
    },
    update(value, tr) {
        for (let effect of tr.effects) {
            if (effect.is(setGuardianMode)) {
                globalGuardianEnabled = effect.value; // Update global state
                return effect.value;
            }
        }
        return value;
    }
});

// StateField for Local Line State (Thinking/Suggestion)
const guardianLineStateField = StateField.define<{ line: number; state: GuardianState } | null>({
    create() { return null; },
    update(value, tr) {
        for (let effect of tr.effects) {
            if (effect.is(setGuardianLineState)) {
                return effect.value;
            }
        }
        // Reset local state if document changes significantly or user moves cursor? 
        // For now, let's keep it simple. If user types, we might want to clear 'Thinking' but 'HasSuggestion' is handled by ghost text.
        // Actually, let's clear it on doc change to be safe, similar to ghost text.
        if (tr.docChanged) {
            return null;
        }
        return value;
    }
});

// Guardian Gutter Marker
class GuardianDotMarker extends GutterMarker {
    constructor(private state: GuardianState, private view: EditorView) {
        super();
    }

    toDOM() {
        const dot = document.createElement('div');
        dot.className = `guardian-gutter-marker guardian-${this.state}`;

        // Click handler to toggle mode
        dot.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const currentMode = this.view.state.field(guardianModeField);
            this.view.dispatch({
                effects: setGuardianMode.of(!currentMode)
            });
        };

        // Tooltip
        switch (this.state) {
            case GuardianState.Thinking:
                dot.title = 'Guardian is analyzing...';
                break;
            case GuardianState.HasSuggestion:
                dot.title = 'Guardian has a suggestion (Tab to accept)';
                break;
            case GuardianState.Paused:
                dot.title = 'Guardian is Paused (Click to Resume)';
                break;
            case GuardianState.Idle:
                dot.title = 'Guardian is Active (Click to Pause)';
                break;
        }

        return dot;
    }
}

// StateField to manage Gutter Markers (Follows Cursor)
const guardianMarkerField = StateField.define<RangeSet<GutterMarker>>({
    create() {
        return RangeSet.empty;
    },

    update(markers, tr) {
        // Always recalculate based on current state and cursor position
        const isEnabled = tr.state.field(guardianModeField);
        const localState = tr.state.field(guardianLineStateField);

        // Determine effective state
        let effectiveState = GuardianState.Idle;

        if (!isEnabled) {
            effectiveState = GuardianState.Paused;
        } else if (localState && localState.state) {
            effectiveState = localState.state;
        }

        // Get cursor line
        const selection = tr.state.selection.main;
        const lineBlock = tr.state.doc.lineAt(selection.head);

        // Create marker
        // Note: We need access to the view to dispatch events from the marker. 
        // Since StateField update doesn't have view, we'll pass a proxy or handle it differently.
        // Actually, GutterMarker.toDOM doesn't strictly need the view if we use a global command or similar.
        // But to keep it self-contained, we can attach the view later or use a closure if we were in the extension factory.
        // A common pattern is to pass the view to the marker constructor if possible, but here we are in StateField.
        // Workaround: We can't easily pass 'view' here. 
        // Alternative: The click handler can be attached in the gutter configuration or we use a custom DOM event.
        // Let's use a custom DOM event for simplicity in the marker, and handle it in the view plugin or just rely on the fact that 
        // we can't easily get 'view' here.

        // WAIT: Gutter markers are created in state field. 
        // Let's use a slightly different approach for the click handler.
        // We can't pass 'view' to the marker from the StateField.
        // However, we can use a class that doesn't depend on view for creation, but the DOM element does.
        // Actually, we can just dispatch a custom event from the DOM element, and have a ViewPlugin listen for it.

        // SIMPLER: Just use a global window event or similar? No, that's messy.
        // Better: The `gutter` extension allows `domEventHandlers`. We can handle clicks there!

        const marker = new GuardianDotMarker(effectiveState, null as any); // View will be handled in domEventHandlers
        return RangeSet.of([marker.range(lineBlock.from)]);
    }
});

// Gutter Extension
export function guardianGutterExtension() {
    return [
        guardianModeField,
        guardianLineStateField,
        guardianMarkerField,
        gutter({
            class: 'guardian-gutter',
            markers: (view) => view.state.field(guardianMarkerField),
            domEventHandlers: {
                mousedown(view, line, event) {
                    const target = event.target as HTMLElement;
                    if (target.classList.contains('guardian-gutter-marker')) {
                        event.preventDefault();
                        const currentMode = view.state.field(guardianModeField);
                        view.dispatch({
                            effects: setGuardianMode.of(!currentMode)
                        });
                        return true;
                    }
                    return false;
                }
            }
        })
    ];
}

// Helper: Update Local State
export function updateGuardianState(view: EditorView, line: number, state: GuardianState) {
    view.dispatch({
        effects: setGuardianLineState.of({ line, state })
    });
}
