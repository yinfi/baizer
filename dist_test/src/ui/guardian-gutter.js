"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearGuardianState = exports.updateGuardianState = exports.guardianGutterExtension = exports.setGuardianMarker = exports.GuardianState = void 0;
const view_1 = require("@codemirror/view");
const state_1 = require("@codemirror/state");
// Guardian状态
var GuardianState;
(function (GuardianState) {
    GuardianState["Idle"] = "idle";
    GuardianState["Thinking"] = "thinking";
    GuardianState["HasSuggestion"] = "has-suggestion";
})(GuardianState = exports.GuardianState || (exports.GuardianState = {}));
// Guardian Gutter Marker
class GuardianDotMarker extends view_1.GutterMarker {
    constructor(state) {
        super();
        this.state = state;
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
exports.setGuardianMarker = state_1.StateEffect.define();
// StateField 管理 Gutter Markers
const guardianMarkerField = state_1.StateField.define({
    create() {
        return state_1.RangeSet.empty;
    },
    update(markers, tr) {
        markers = markers.map(tr.changes);
        for (let effect of tr.effects) {
            if (effect.is(exports.setGuardianMarker)) {
                if (effect.value) {
                    const { line, state } = effect.value;
                    const lineBlock = tr.state.doc.line(line);
                    const marker = new GuardianDotMarker(state);
                    markers = state_1.RangeSet.of([marker.range(lineBlock.from)]);
                }
                else {
                    markers = state_1.RangeSet.empty;
                }
            }
        }
        return markers;
    }
});
// Gutter Extension
function guardianGutterExtension() {
    return [
        guardianMarkerField,
        (0, view_1.gutter)({
            class: 'guardian-gutter',
            markers: (view) => view.state.field(guardianMarkerField)
        })
    ];
}
exports.guardianGutterExtension = guardianGutterExtension;
// 导出辅助函数：更新 Guardian 状态
function updateGuardianState(view, line, state) {
    view.dispatch({
        effects: exports.setGuardianMarker.of({ line, state })
    });
}
exports.updateGuardianState = updateGuardianState;
// 导出辅助函数：清除 Guardian 状态
function clearGuardianState(view) {
    view.dispatch({
        effects: exports.setGuardianMarker.of(null)
    });
}
exports.clearGuardianState = clearGuardianState;
