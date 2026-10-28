// 静态导入(而非 await import):动态 import 会把 @codemirror/* 解析到 ESM 产物,
// 与被测模块拿到的实例不是同一份,instanceof 判等失败。
import { EditorState, Extension } from '@codemirror/state';
import { showTooltip } from '@codemirror/view';
import {
  createSelectionMenuFocusTracker,
  isViewActive,
  selectionMenuField,
  selectionMenuFocusField,
  selectionMenuTooltipExtension,
  setSelectionMenuFocus,
  stampTooltipOwner,
} from '../src/ui/selection-ai/selection-menu-state';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

// 末行是裸 @,用于 @ 触发分支;前两行是普通多行文本,用于选区分支。
const DOC = 'hello world\nsecond line\n@\n';
const AT_CURSOR = DOC.indexOf('@') + 1;

async function runTests() {
  console.log('=== Selection Menu State Tests ===');

  // 断言的是真实状态机 + 真实 provider 的产出,不构造 EditorView(Node 下没有 DOM)。
  const createState = () => EditorState.create({
    doc: DOC,
    extensions: [
      selectionMenuTooltipExtension(() => ({ dom: {} as any })),
      createSelectionMenuFocusTracker(),
    ] as Extension[],
  });

  // showTooltip 的 combine 是默认的 `(values) => values`,provider 返回的 null 会留在数组里;
  // TooltipViewManager 自己也用 `input.filter(t => t)` 过滤。所以"工具条节点数"= 非 null 条目数。
  const tooltipCount = (st: any) => st.facet(showTooltip).filter((t: any) => t).length;

  const selectRange = (st: any) => st.update({ selection: { anchor: 0, head: 5 } }).state;
  const setFocus = (st: any, focused: boolean) =>
    st.update({ effects: setSelectionMenuFocus.of(focused) }).state;

  await test('an active view with a non-empty selection exposes exactly one tooltip', () => {
    const active = setFocus(selectRange(createState()), true);
    expect(active.field(selectionMenuField).type).toBe('toolbar');
    expect(tooltipCount(active)).toBe(1);
  });

  // 本缺陷的回归门:旧实现把焦点判断放在 tooltip 的 create 回调里,provider 无论活跃与否
  // 都产出一条 tooltip,此断言在旧实现下必然失败。
  await test('an inactive view with a non-empty selection produces no tooltip node', () => {
    const inactive = selectRange(createState());
    expect(inactive.field(selectionMenuField).type).toBe('toolbar');
    expect(inactive.field(selectionMenuFocusField)).toBe(false);
    expect(tooltipCount(inactive)).toBe(0);
  });

  // 根因所在:焦点变化必须让 facet 真的重算,产出才会跟着变。
  await test('focusing an inactive view turns its tooltip from none into one', () => {
    const inactive = selectRange(createState());
    const active = setFocus(inactive, true);
    expect(tooltipCount(inactive)).toBe(0);
    expect(tooltipCount(active)).toBe(1);
  });

  await test('blurring an active view retracts its tooltip', () => {
    const active = setFocus(selectRange(createState()), true);
    const blurred = setFocus(active, false);
    expect(tooltipCount(active)).toBe(1);
    expect(tooltipCount(blurred)).toBe(0);
  });

  // @ 分支靠把焦点移进面板来工作,不受焦点门影响。
  await test('the @ trigger branch keeps its tooltip while the view is inactive', () => {
    const triggered = createState().update({ selection: { anchor: AT_CURSOR } }).state;
    expect(triggered.field(selectionMenuField).type).toBe('button');
    expect(triggered.field(selectionMenuFocusField)).toBe(false);
    expect(tooltipCount(triggered)).toBe(1);
  });

  await test('a hidden menu state produces no tooltip node', () => {
    const hidden = createState();
    expect(hidden.field(selectionMenuField).type).toBe('hidden');
    expect(tooltipCount(hidden)).toBe(0);
  });

  // 点按钮时 mousedown 会先让编辑器失焦;焦点落在自己条内必须仍算活跃,否则按钮点不动。
  await test('isViewActive accepts focus inside this view own toolbar and rejects another view toolbar', () => {
    const ownButton = { id: 'own' };
    const otherButton = { id: 'other' };
    const ownDom: any = { contains: (node: any) => node === ownButton };
    const otherDom: any = { contains: (node: any) => node === otherButton };

    const viewA: any = { hasFocus: false };
    const viewB: any = { hasFocus: false };
    const viewWithoutToolbar: any = { hasFocus: false };

    stampTooltipOwner(ownDom, viewA);
    stampTooltipOwner(otherDom, viewB);

    expect(isViewActive(viewA, ownDom, ownButton)).toBe(true);
    expect(isViewActive(viewA, ownDom, otherButton)).toBe(false);
    expect(isViewActive(viewA, otherDom, otherButton)).toBe(false);
    expect(isViewActive(viewWithoutToolbar, null, ownButton)).toBe(false);

    const focusedView: any = { hasFocus: true };
    expect(isViewActive(focusedView, null, null)).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
