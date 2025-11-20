import { EditorView, gutter, GutterMarker } from '@codemirror/view';
import { StateField, StateEffect, RangeSet } from '@codemirror/state';

// Guardian状态
export enum GuardianState {
    Idle = 'idle',
    Thinking = 'thinking',
    HasSuggestion = 'has-suggestion'
}

// Guardian Gutter Marker
class GuardianDotMarker extends GutterMarker {
    constructor(private state: GuardianState) {
        super();
    }

    toDOM() {
        const dot = document.createElement('div');
        dot.className = `guardian-gutter-marker guardian-${this.state}`;

        // 根据状态设置样式
        switch (this.state) {
            case GuardianState.Thinking:
                dot.title = 'Guardian is analyzing...';
                break;
            case GuardianState.HasSuggestion:
                dot.title = 'Guardian has a suggestion (Tab to accept)';
                break;
            default:
                dot.style.display = 'none';
        }

        return dot;
    }
}

// 更新 Guardian 状态的 Effect
export const setGuardianMarker = StateEffect.define<{ line: number; state: GuardianState } | null>();

// StateField 管理 Gutter Markers
const guardianMarkerField = StateField.define<RangeSet<GutterMarker>>({
    create() {
        return RangeSet.empty;
    },

    update(markers, tr) {
        markers = markers.map(tr.changes);

        for (let effect of tr.effects) {
            if (effect.is(setGuardianMarker)) {
                if (effect.value) {
                    const { line, state } = effect.value;
                    const lineBlock = tr.state.doc.line(line);
                    const marker = new GuardianDotMarker(state);
                    markers = RangeSet.of([marker.range(lineBlock.from)]);
                } else {
                    markers = RangeSet.empty;
                }
            }
        }

        return markers;
    }
});

// Gutter Extension
export function guardianGutterExtension() {
    return [
        guardianMarkerField,
        gutter({
            class: 'guardian-gutter',
            markers: (view) => view.state.field(guardianMarkerField)
        })
    ];
}

// 导出辅助函数：更新 Guardian 状态
export function updateGuardianState(view: EditorView, line: number, state: GuardianState) {
    view.dispatch({
        effects: setGuardianMarker.of({ line, state })
    });
}

// 导出辅助函数：清除 Guardian 状态
export function clearGuardianState(view: EditorView) {
    view.dispatch({
        effects: setGuardianMarker.of(null)
    });
}
