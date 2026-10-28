/**
 * 选区工具条的状态层。只依赖 @codemirror/*，不依赖 obsidian / app 层，故可在 Node 下直接测试。
 *
 * ## 为什么"可见性判定"必须在状态层，不能放回 tooltip 的 create 回调
 *
 * 工具条是 CM6 视图级 tooltip（`showTooltip.compute([...], provider)`），而 CM6 只在
 * **依赖的真实值发生变化**时才重算 facet：
 *
 * 1. `selectionMenuField.update` 对"非选区事务"返回**同一个状态对象**，于是该 field 判等为
 *    "未变"；焦点变化本身也不产生选区事务，依赖它的 facet 因此不重算。
 * 2. facet 组合值未变时，`TooltipViewManager.update` 走 `input === this.input` 的复用分支，
 *    **根本不会再次调用 `create`**。
 *
 * 所以"在 create 里判断 `view.hasFocus`"（旧实现，即 fb67092 的思路）只在**首次创建**时求值
 * 一次：编辑器后来失焦，工具条不会被收回；又因容器挂在 document.body 上、不受编辑器裁剪，
 * 它会继续留在视口里 —— 这就是"两条工具条"。
 *
 * 修法：把"本视图此刻是否活跃"提升为**状态**（`selectionMenuFocusField`），并让它成为 tooltip
 * provider 的第二个依赖。焦点变化 → 状态真实变更 → facet 重算 → provider 返回新对象或 `null`
 * → `create` 引用变化 → CM6 重建或移除 tooltip 节点。
 *
 * **请勿再把焦点判断挪回 `create`。**
 *
 * 两条边界（改这里时必须同时守住）：
 * - 焦点门**只作用于 `toolbar` 态**。`@` 触发的 button/chat 态正是靠把焦点移进面板来工作的，
 *   一并设门会让用户一进输入框就被收回。
 * - 活跃性判定必须把"焦点落在**本视图自己创建的**工具条节点内"算作活跃。点按钮时 mousedown
 *   会先让编辑器失焦，若此时判定为不活跃，节点会在 click 之前被移除，按钮就点不动了。
 */
import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Tooltip, TooltipView, showTooltip } from '@codemirror/view';

export type AiMenuMode = 'selection' | 'trigger';

/** 状态层只约束到 cleanup()，避免把 ChatController（依赖 obsidian）拖进本文件。 */
export interface SelectionMenuController {
    cleanup(): void;
}

// selection 场景:选中即出横向工具条(toolbar),点动作直接分流(改写→内联 diff / 只读→浮窗)。
// trigger 场景(@ 行内插入):保留旧的 button→chat 迷你对话框。
export type SelectionMenuState =
    | { type: 'hidden' }
    | { type: 'toolbar'; mode: 'selection'; from: number; to: number }
    | { type: 'button'; mode: 'trigger'; from: number; to: number }
    | { type: 'chat'; mode: 'trigger'; from: number; to: number; controller: SelectionMenuController };

export const setSelectionMenuState = StateEffect.define<SelectionMenuState>();

export const selectionMenuField = StateField.define<SelectionMenuState>({
    create() { return { type: 'hidden' }; },
    update(state, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setSelectionMenuState)) {
                cleanupPreviousController(state, effect.value);
                return effect.value;
            }
        }

        if (!tr.selection && !tr.docChanged) return state;

        const selection = tr.newSelection.main;
        if (!selection.empty) {
            // 选区非空 → 横向工具条(选中即出,无中间 AI 按钮态)。
            const next: SelectionMenuState = {
                type: 'toolbar',
                mode: 'selection',
                from: selection.from,
                to: selection.to,
            };
            cleanupPreviousController(state, next);
            return next;
        }

        const trigger = findAtTriggerInState(tr.state, selection.from);
        if (trigger) {
            if (state.type !== 'hidden'
                && state.mode === 'trigger'
                && state.from === trigger.from
                && state.to === trigger.to) {
                return state;
            }
            const next: SelectionMenuState = {
                type: 'button',
                mode: 'trigger',
                from: trigger.from,
                to: trigger.to,
            };
            cleanupPreviousController(state, next);
            return next;
        }

        const next: SelectionMenuState = { type: 'hidden' };
        cleanupPreviousController(state, next);
        return next;
    },
});

export const setSelectionMenuFocus = StateEffect.define<boolean>();

/**
 * 本视图此刻是否"活跃"（见文件头）。默认 false:视图刚建好时焦点尚未落到它身上,
 * 未聚焦的视图不应产生工具条节点。
 */
export const selectionMenuFocusField = StateField.define<boolean>({
    create() { return false; },
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setSelectionMenuFocus)) return effect.value;
        }
        return value;
    },
});

export type SelectionTooltipFactory = (view: EditorView, menu: SelectionMenuState) => TooltipView;

/**
 * 工具条 provider。双依赖是修复的核心:焦点变化必须能改变第二个依赖,
 * facet 才会重算,CM6 才会重建/移除 tooltip 节点。
 */
export function selectionMenuTooltipExtension(createTooltip: SelectionTooltipFactory): Extension {
    return [
        selectionMenuField,
        selectionMenuFocusField,
        showTooltip.compute([selectionMenuField, selectionMenuFocusField], (state): Tooltip | null => {
            const menu = state.field(selectionMenuField);
            if (menu.type === 'hidden') return null;

            // 焦点门只作用于选区工具条。@ 触发的 button/chat 态靠把焦点移进面板来工作,
            // 一并设门会让用户一进输入框面板就被收回。
            if (menu.type === 'toolbar' && !state.field(selectionMenuFocusField)) return null;

            return {
                pos: menu.to,
                above: false,
                strictSide: false,
                create: (view: EditorView) => createTooltip(view, menu),
            };
        }),
    ];
}

interface ViewFocusIdentity {
    tooltipDom: HTMLElement | null;
}

const viewFocusIdentity = new WeakMap<EditorView, ViewFocusIdentity>();
const tooltipDomOwners = new WeakMap<HTMLElement, EditorView>();

function identityOf(view: EditorView): ViewFocusIdentity {
    let identity = viewFocusIdentity.get(view);
    if (!identity) {
        identity = { tooltipDom: null };
        viewFocusIdentity.set(view, identity);
    }
    return identity;
}

/** 给本视图创建的工具条容器打归属标记,供 isViewActive 判定"焦点是否落在自己的条上"。 */
export function stampTooltipOwner(dom: HTMLElement, view: EditorView): void {
    identityOf(view).tooltipDom = dom;
    tooltipDomOwners.set(dom, view);
}

/**
 * 本视图此刻是否活跃:持有焦点,或焦点落在**本视图自己创建的**工具条节点内
 * (点按钮时 mousedown 会先让编辑器失焦,这条存活窗口保住"按钮可点击")。
 */
export function isViewActive(
    view: EditorView,
    ownTooltipDom?: HTMLElement | null,
    activeElement?: Element | null,
): boolean {
    if (view.hasFocus) return true;

    const dom = ownTooltipDom ?? identityOf(view).tooltipDom;
    if (!dom || tooltipDomOwners.get(dom) !== view) return false;

    const focused = activeElement === undefined ? currentActiveElement() : activeElement;
    return !!focused && dom.contains(focused);
}

function currentActiveElement(): Element | null {
    // Node(测试)下没有 document;真实运行环境(Obsidian 渲染进程)一定有。
    return typeof document === 'undefined' ? null : document.activeElement;
}

// 回退到微任务而非同步执行:requestSelectionMenuFocusSync 会被 updateListener 调用,
// 同步 dispatch 会撞上 CM6 的"update 进行中不得再 dispatch"。(回退分支只在 Node 下走到。)
const scheduleFrame: (run: () => void) => void =
    typeof requestAnimationFrame === 'function'
        ? (run) => { requestAnimationFrame(() => run()); }
        : (run) => { queueMicrotask(run); };

const pendingFocusSync = new WeakSet<EditorView>();

/**
 * 把焦点变化同步进状态。**延迟一帧**再读 document.activeElement:
 * `mousedown → 编辑器 blur → 按钮 focus` 是同一事件序列,同步读到的还是中间态。
 * 用 WeakSet 合并同一帧内的多次请求,不引入定时器或轮询。
 */
export function requestSelectionMenuFocusSync(view: EditorView): void {
    if (pendingFocusSync.has(view)) return;
    pendingFocusSync.add(view);
    scheduleFrame(() => {
        pendingFocusSync.delete(view);
        syncFocus(view);
    });
}

function syncFocus(view: EditorView): void {
    const next = isViewActive(view);
    // 仅在值确实变化时 dispatch,避免无效事务与重入。
    if (view.state.field(selectionMenuFocusField, false) === next) return;
    view.dispatch({ effects: setSelectionMenuFocus.of(next) });
}

/** 焦点同步扩展:编辑器自身获得/失去焦点时重算一次活跃性。 */
export function createSelectionMenuFocusTracker(): Extension {
    return EditorView.updateListener.of((update) => {
        if (!update.focusChanged) return;
        requestSelectionMenuFocusSync(update.view);
    });
}

function findAtTriggerInState(state: EditorState, cursor: number): { from: number; to: number } | null {
    if (cursor <= 0) return null;

    const at = state.doc.sliceString(cursor - 1, cursor);
    if (at !== '@') return null;

    const before = cursor > 1 ? state.doc.sliceString(cursor - 2, cursor - 1) : '';
    if (cursor > 1 && !/\s/.test(before)) return null;

    return { from: cursor - 1, to: cursor };
}

function cleanupPreviousController(previous: SelectionMenuState, next: SelectionMenuState) {
    if (previous.type !== 'chat') return;
    if (next.type === 'chat' && next.controller === previous.controller) return;
    previous.controller.cleanup();
}
