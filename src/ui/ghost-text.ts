import { EditorView, Decoration, DecorationSet, WidgetType, keymap } from '@codemirror/view';
import { StateField, StateEffect, Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { t } from '../i18n/zh';

// Ghost Text 建议
export interface GhostTextSuggestion {
    text: string;
    line: number;
    ch: number;
    replaceRange?: { from: number; to: number }; // Optional replacement range
    visible?: boolean;
    acceptable?: boolean;
    // 视觉变体:'thinking' 用于深补进行中的波动动效 ghost(专属 class,与普通 ghost 区分)。
    variant?: 'thinking';
}

// 更新 Ghost Text 的 Effect
export const setGhostText = StateEffect.define<GhostTextSuggestion | null>();

// ghost 是 pointer-events:none 的装饰,读屏不会自动读到。用一个视觉隐藏的 aria-live 区
// 在 ghost 出现/消失时播报,让盲用户也知道「有可接受的补全 / 深补进行中」。
let ghostLiveRegion: HTMLElement | null = null;

function getGhostLiveRegion(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (ghostLiveRegion && document.body.contains(ghostLiveRegion)) return ghostLiveRegion;
    const region = document.createElement('div');
    region.className = 'baizer-visually-hidden';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('role', 'status');
    document.body.appendChild(region);
    ghostLiveRegion = region;
    return region;
}

function announceGhost(suggestion: GhostTextSuggestion | null): void {
    const region = getGhostLiveRegion();
    if (!region) return;
    if (!suggestion || suggestion.visible === false) {
        region.textContent = '';
        return;
    }
    if (suggestion.variant === 'thinking') {
        region.textContent = t('Deep completion in progress');
    } else if (suggestion.acceptable === false) {
        region.textContent = '';
    } else {
        region.textContent = `${t('AI suggestion available, press Tab to accept:')} ${suggestion.text}`;
    }
}

// Ghost Text Widget
class GhostTextWidget extends WidgetType {
    constructor(private text: string, private variant?: 'thinking') {
        super();
    }

    toDOM() {
        const span = document.createElement('span');
        span.className = this.variant === 'thinking'
            ? 'guardian-ghost-text guardian-ghost-thinking'
            : 'guardian-ghost-text';
        if (this.variant === 'thinking') {
            // 逐字包裹,让每个字符能带相位差地波动(shimmer),而非整体闪烁。
            for (const ch of this.text) {
                const charSpan = document.createElement('span');
                charSpan.className = 'guardian-ghost-thinking-char';
                // 空格用 &nbsp 语义:保留宽度但不参与发光。
                charSpan.textContent = ch;
                span.appendChild(charSpan);
            }
        } else {
            span.textContent = this.text;
        }
        span.setAttribute('aria-label', this.variant === 'thinking' ? t('Deep completion in progress') : t('Press Tab to accept suggestion'));
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
                    const { text, line, ch, visible = true, variant } = effect.value;
                    if (!visible) {
                        return Decoration.none;
                    }

                    // Validate line number
                    if (line < 1 || line > tr.state.doc.lines) {
                        continue;
                    }

                    // Calculate position
                    const lineBlock = tr.state.doc.line(line);
                    const pos = Math.min(lineBlock.from + ch, lineBlock.to);

                    const widget = Decoration.widget({
                        widget: new GhostTextWidget(text || '', variant),
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

        // 3. 光标移动(箭头键/点击)离开装饰所在行时清除 ghost text。
        //    仅在本 transaction 显式设置了新选区(tr.selection)时判定,避免误清。
        if (tr.selection) {
            const suggestion = tr.startState.field(ghostTextStateField, false);
            if (suggestion && suggestion.visible !== false) {
                const cursorLine = tr.state.doc.lineAt(tr.newSelection.main.head).number;
                if (cursorLine !== suggestion.line) {
                    return Decoration.none;
                }
            }
        }

        // 4. Otherwise map existing decorations
        return decorations.map(tr.changes);
    },

    provide: f => EditorView.decorations.from(f)
});

// New StateField to store the full suggestion data (not just decoration)
const ghostTextStateField = StateField.define<GhostTextSuggestion | null>({
    create() { return null; },
    update(value, tr) {
        for (let effect of tr.effects) {
            if (effect.is(setGhostText)) {
                announceGhost(effect.value);
                return effect.value;
            }
        }
        if (tr.docChanged) {
            if (value) announceGhost(null);
            return null;
        }
        // 光标移动离开装饰所在行时,清空 suggestion 数据(与 ghostTextField 装饰同步清除)。
        if (tr.selection && value && value.visible !== false) {
            const cursorLine = tr.state.doc.lineAt(tr.newSelection.main.head).number;
            if (cursorLine !== value.line) {
                announceGhost(null);
                return null;
            }
        }
        return value;
    }
});

// Redefined acceptGhostText using the new data field
function acceptGhostTextReal(view: EditorView): boolean {
    const suggestion = view.state.field(ghostTextStateField);
    if (!suggestion) return false;

    const { text, replaceRange, line, ch } = suggestion;
    if (suggestion.acceptable === false) {
        // thinking/diagnostic 类 ghost 不可接受:清除装饰后返回 false,
        // 把 Tab 放行给原生缩进处理,避免 Tab 在这类 ghost 可见时被吞掉。
        view.dispatch({
            effects: setGhostText.of(null)
        });
        return false;
    }

    // Calculate insert position if not replacing
    let from = replaceRange ? replaceRange.from : 0;
    let to = replaceRange ? replaceRange.to : 0;

    if (!replaceRange) {
        const lineBlock = view.state.doc.line(line);
        from = Math.min(lineBlock.from + ch, lineBlock.to);
        to = from;
    }

    view.dispatch({
        changes: { from, to, insert: text },
        selection: EditorSelection.cursor(from + text.length),
        effects: setGhostText.of(null)
    });

    return true;
}

// 键盘事件处理 - 使用最高优先级覆盖 Obsidian 默认 Tab 行为
import { Prec } from '@codemirror/state';

const ghostTextKeymap = Prec.highest(keymap.of([
    {
        key: 'Tab',
        run: (view: EditorView) => {
            return acceptGhostTextReal(view);
        }
    },
    {
        key: 'Escape',
        run: (view: EditorView) => {
            const suggestion = view.state.field(ghostTextStateField);
            if (suggestion) {
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
        ghostTextStateField,
        ghostTextKeymap
    ];
}

// 导出辅助函数：显示 Ghost Text
export function showGhostText(view: EditorView, text: string, line: number, ch: number, replaceRange?: { from: number; to: number }) {
    view.dispatch({
        effects: setGhostText.of({ text, line, ch, replaceRange, visible: true, acceptable: true })
    });
}

export function storeGhostText(view: EditorView, text: string, line: number, ch: number, replaceRange?: { from: number; to: number }) {
    view.dispatch({
        effects: setGhostText.of({ text, line, ch, replaceRange, visible: false, acceptable: true })
    });
}

export function showDiagnosticGhostText(view: EditorView, text: string, line: number, ch: number) {
    view.dispatch({
        effects: setGhostText.of({ text, line, ch, visible: true, acceptable: false })
    });
}

// 深补进行中的波动 ghost:逐字 shimmer 动效,不可接受(acceptable:false),打字即由 docChanged 清除。
export function showThinkingGhostText(view: EditorView, text: string, line: number, ch: number) {
    view.dispatch({
        effects: setGhostText.of({ text, line, ch, visible: true, acceptable: false, variant: 'thinking' })
    });
}

// 主动清除当前 ghost(用于「光标移动等非输入场景」——输入已由 docChanged 自动清除)。
export function hideGhostText(view: EditorView) {
    view.dispatch({
        effects: setGhostText.of(null)
    });
}
