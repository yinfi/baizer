import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, Extension, Range } from '@codemirror/state';
import { setIcon } from 'obsidian';
import { t } from '../../i18n/zh';

export interface InlineDiffState {
  from: number;
  to: number;
  oldText: string;
  newText: string;
  status: 'loading' | 'preview' | 'error';
  message?: string; // error 文案
}

export interface InlineDiffCallbacks {
  onAccept: (state: InlineDiffState) => void;
  onReject: (state: InlineDiffState) => void;
  onRetry: (state: InlineDiffState) => void;
}

// 回调通过模块级引用注入(CM 扩展实例化时绑定);单例足够,选区改写同一时刻只有一处。
let callbacks: InlineDiffCallbacks | null = null;

export const setInlineDiff = StateEffect.define<InlineDiffState | null>();

class NewTextWidget extends WidgetType {
  constructor(private readonly state: InlineDiffState) { super(); }

  eq(other: NewTextWidget) {
    return other.state.newText === this.state.newText
      && other.state.status === this.state.status
      && other.state.message === this.state.message;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'baizer-inline-diff';

    if (this.state.status === 'loading') {
      wrap.classList.add('is-loading');
      const spinner = document.createElement('span');
      spinner.className = 'baizer-inline-diff-spinner';
      wrap.appendChild(spinner);
      const hint = document.createElement('span');
      hint.className = 'baizer-inline-diff-hint';
      hint.textContent = t('Rewriting…');
      wrap.appendChild(hint);
      return wrap;
    }

    if (this.state.status === 'error') {
      wrap.classList.add('is-error');
      const hint = document.createElement('span');
      hint.className = 'baizer-inline-diff-hint';
      hint.textContent = this.state.message || t('Rewrite failed');
      wrap.appendChild(hint);
      this.addButton(wrap, 'rotate-ccw', t('Retry'), () => callbacks?.onRetry(this.state));
      return wrap;
    }

    const text = document.createElement('span');
    text.className = 'baizer-inline-diff-new';
    text.textContent = this.state.newText;
    wrap.appendChild(text);
    const bar = document.createElement('span');
    bar.className = 'baizer-inline-diff-actions';
    wrap.appendChild(bar);
    this.addButton(bar, 'check', t('Accept'), () => callbacks?.onAccept(this.state));
    this.addButton(bar, 'x', t('Reject'), () => callbacks?.onReject(this.state));
    this.addButton(bar, 'rotate-ccw', t('Retry'), () => callbacks?.onRetry(this.state));
    return wrap;
  }

  private addButton(parent: HTMLElement, icon: string, title: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.className = 'baizer-inline-diff-btn';
    btn.type = 'button';
    btn.title = title;
    setIcon(btn, icon);
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
    parent.appendChild(btn);
  }

  ignoreEvent() { return false; }
}

const inlineDiffField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setInlineDiff)) {
        const s = effect.value;
        if (!s) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        // 原选区标红删除线(仅在有实际选区时)
        if (s.to > s.from) {
          ranges.push(Decoration.mark({ class: 'baizer-inline-diff-old' }).range(s.from, s.to));
        }
        // 新文本 widget 挂在选区末尾
        ranges.push(Decoration.widget({ widget: new NewTextWidget(s), side: 1 }).range(s.to));
        return Decoration.set(ranges, true);
      }
    }
    // 用户直接改文档 → 撤掉预览(避免错位;接受/拒绝走显式 effect)
    if (tr.docChanged) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

export function inlineDiffExtension(cb: InlineDiffCallbacks): Extension {
  callbacks = cb;
  return [inlineDiffField];
}

/** 展示/更新内联 diff。 */
export function showInlineDiff(view: EditorView, state: InlineDiffState) {
  view.dispatch({ effects: setInlineDiff.of(state) });
}

/** 清除内联 diff。 */
export function clearInlineDiff(view: EditorView) {
  view.dispatch({ effects: setInlineDiff.of(null) });
}
