import { EditorView, Decoration, DecorationSet, WidgetType, keymap } from '@codemirror/view';
import { StateField, StateEffect, Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';

// Ghost Text 建议
export interface GhostTextSuggestion {
    text: string;
    line: number;
    ch: number;
}

// 更新 Ghost Text 的 Effect
export const setGhostText = StateEffect.define<GhostTextSuggestion | null>();

// Ghost Text Widget
class GhostTextWidget extends WidgetType {
    constructor(private text: string) {
        super();
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
const ghostTextField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },

    update(decorations, tr) {
        // 1. Check for explicit effects (highest priority)
        for (let effect of tr.effects) {
            if (effect.is(setGhostText)) {
                if (effect.value) {
                    const { text, line, ch } = effect.value;

                    // Validate line number
                    if (line < 1 || line > tr.state.doc.lines) {
                        continue;
                    }

                    // Calculate position
                    const lineBlock = tr.state.doc.line(line);
                    const pos = Math.min(lineBlock.from + ch, lineBlock.to);

                    const widget = Decoration.widget({
                        widget: new GhostTextWidget(text || ''),
                        side: 1
                    });

                    return Decoration.set([widget.range(pos)]);
                } else {
                    return Decoration.none;
                }
            }
        }

        // 2. If document changed (user typing), clear suggestions
        if (tr.docChanged) {
            return Decoration.none;
        }

        // 3. Otherwise map existing decorations
        return decorations.map(tr.changes);
    },

    provide: f => EditorView.decorations.from(f)
});

// Tab 键接受建议的处理
function acceptGhostText(view: EditorView): boolean {
    const decorations = view.state.field(ghostTextField);

    if (decorations.size === 0) {
        return false;
    }

    // 获取 ghost text 内容和位置
    let ghostText = '';
    let insertPos = 0;

    decorations.between(0, view.state.doc.length, (from, to, value) => {
        if (value.spec.widget instanceof GhostTextWidget) {
            ghostText = (value.spec.widget as any).text;
            insertPos = from;
        }
    });

    if (ghostText) {
        // 插入文本
        view.dispatch({
            changes: { from: insertPos, insert: ghostText },
            selection: EditorSelection.cursor(insertPos + ghostText.length),
            effects: setGhostText.of(null) // 清除 ghost text
        });
        return true;
    }

    return false;
}

// 键盘事件处理 - 使用最高优先级覆盖 Obsidian 默认 Tab 行为
import { Prec } from '@codemirror/state';

const ghostTextKeymap = Prec.highest(keymap.of([
    {
        key: 'Tab',
        run: (view: EditorView) => {
            return acceptGhostText(view);
        }
    },
    {
        key: 'Escape',
        run: (view: EditorView) => {
            const decorations = view.state.field(ghostTextField);
            if (decorations.size > 0) {
                view.dispatch({
                    effects: setGhostText.of(null)
                });
                return true;
            }
            return false;
        }
    }
]));

// Ghost Text Extension
export function ghostTextExtension(): Extension {
    return [
        ghostTextField,
        ghostTextKeymap
    ];
}

// 导出辅助函数：显示 Ghost Text
export function showGhostText(view: EditorView, text: string, line: number, ch: number) {
    view.dispatch({
        effects: setGhostText.of({ text, line, ch })
    });
}

// 导出辅助函数：隐藏 Ghost Text
export function hideGhostText(view: EditorView) {
    view.dispatch({
        effects: setGhostText.of(null)
    });
}
