"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hideGhostText = exports.showGhostText = exports.ghostTextExtension = exports.setGhostText = void 0;
const view_1 = require("@codemirror/view");
const state_1 = require("@codemirror/state");
const state_2 = require("@codemirror/state");
// 更新 Ghost Text 的 Effect
exports.setGhostText = state_1.StateEffect.define();
// Ghost Text Widget
class GhostTextWidget extends view_1.WidgetType {
    constructor(text) {
        super();
        this.text = text;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'guardian-ghost-text';
        span.textContent = this.text;
        span.setAttribute('aria-label', 'Press Tab to accept suggestion');
        return span;
    }
    ignoreEvent() {
        return false;
    }
}
// StateField 管理 Ghost Text
const ghostTextField = state_1.StateField.define({
    create() {
        return view_1.Decoration.none;
    },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (let effect of tr.effects) {
            if (effect.is(exports.setGhostText)) {
                if (effect.value) {
                    const { text, line, ch } = effect.value;
                    // 计算插入位置
                    const lineBlock = tr.state.doc.line(line);
                    const pos = lineBlock.from + ch;
                    const widget = view_1.Decoration.widget({
                        widget: new GhostTextWidget(text),
                        side: 1
                    });
                    decorations = view_1.Decoration.set([widget.range(pos)]);
                }
                else {
                    decorations = view_1.Decoration.none;
                }
            }
        }
        return decorations;
    },
    provide: f => view_1.EditorView.decorations.from(f)
});
// Tab 键接受建议的处理
function acceptGhostText(view) {
    const decorations = view.state.field(ghostTextField);
    if (decorations.size === 0) {
        return false;
    }
    // 获取 ghost text 内容和位置
    let ghostText = '';
    let insertPos = 0;
    decorations.between(0, view.state.doc.length, (from, to, value) => {
        if (value.spec.widget instanceof GhostTextWidget) {
            ghostText = value.spec.widget.text;
            insertPos = from;
        }
    });
    if (ghostText) {
        // 插入文本
        view.dispatch({
            changes: { from: insertPos, insert: ghostText },
            selection: state_2.EditorSelection.cursor(insertPos + ghostText.length),
            effects: exports.setGhostText.of(null) // 清除 ghost text
        });
        return true;
    }
    return false;
}
// 键盘事件处理 - 使用最高优先级覆盖 Obsidian 默认 Tab 行为
const state_3 = require("@codemirror/state");
const ghostTextKeymap = state_3.Prec.highest(view_1.keymap.of([
    {
        key: 'Tab',
        run: (view) => {
            return acceptGhostText(view);
        }
    }
]));
// Ghost Text Extension
function ghostTextExtension() {
    return [
        ghostTextField,
        ghostTextKeymap
    ];
}
exports.ghostTextExtension = ghostTextExtension;
// 导出辅助函数：显示 Ghost Text
function showGhostText(view, text, line, ch) {
    view.dispatch({
        effects: exports.setGhostText.of({ text, line, ch })
    });
}
exports.showGhostText = showGhostText;
// 导出辅助函数：隐藏 Ghost Text
function hideGhostText(view) {
    view.dispatch({
        effects: exports.setGhostText.of(null)
    });
}
exports.hideGhostText = hideGhostText;
