# 选中弹框功能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让编辑器"选中文字 → AI"功能结合笔记上下文/知识库/记忆回答,并把小气泡 tooltip 换成可拖拽缩放浮窗 + 选中即出横向工具条。

**Architecture:** 新增声明式上下文装配器(SelectionContextBuilder),每个动作声明所需上下文源(活动笔记/知识库/记忆),按需并发预取并拼进 prompt;改写类走内联 diff、只读类走可拖拽缩放浮窗(FloatingPanel)。复用 Guardian 深补现成的知识库/记忆预取接口,不新造检索逻辑。

**Tech Stack:** TypeScript、CodeMirror 6(StateField/showTooltip/Decoration)、Obsidian API、自定义 mini-harness 测试(`npx tsx --tsconfig tsconfig.test.json`)。

**设计文档:** `docs/superpowers/specs/2026-07-09-selection-menu-optimization-design.md`

---

## 测试约束(务必先读)

- 测试用**自定义 mini-harness**,非 jest。每个测试文件自带 `expect`(仅 `toBe`/`toEqual`/`toContain`)与 `async test()`,末尾 `runTests().catch(...)`。参照 `test/action-registry.test.ts`。
- 运行单个测试:`npx tsx --tsconfig tsconfig.test.json test/xxx.test.ts`
- 新测试文件**必须注册进** `test/run-tests.ts` 的 `tests` 数组。
- CM/DOM/流式代码(FloatingPanel、selection-menu 的 CM 部分)**只做编译验证 + 手测**,不写 DOM 单测。可测的是抽出的纯函数与 SelectionContextBuilder(用 mock 依赖)。
- 编译验证:`npx tsc --noEmit -p tsconfig.json`(或 `npm run build`)。
- 提交时**只 add 相关文件**,禁止 `git add -A`(工作区有无关的 `.claude/settings.local.json`、`CLAUDE.md`、`FORYF.md` 改动)。

---

## 文件结构

| 文件 | 职责 | 新建/修改 |
|------|------|:---:|
| `src/ui/selection-ai/action-registry.ts` | 动作定义 + `context` 声明字段 | 修改 |
| `src/ui/selection-ai/selection-context-builder.ts` | 上下文装配器(并发预取+超时+拼接) | 新建 |
| `src/ui/selection-ai/rewrite-runner.ts` | 改写执行,接入 builder | 修改 |
| `src/ui/selection-ai/floating-panel.ts` | 可拖拽缩放浮窗 + 位置尺寸持久化 | 新建 |
| `src/ui/selection-menu.ts` | 删 button 中间态、选中直出工具条、解释走浮窗、注入 deps | 修改 |
| `main.ts` | `selectionMenuExtension` 组装处补传 knowledgeRuntime + contextService | 修改 |
| `styles.css` | `.baizer-floating-panel` 等类(主题变量) | 修改 |
| `test/selection-context-builder.test.ts` | Builder 分级预取/超时/拼接单测 | 新建 |
| `test/action-registry.test.ts` | 补 context 声明断言 | 修改 |
| `test/floating-panel.test.ts` | 浮窗位置/尺寸持久化纯函数单测 | 新建 |

---

## Task 1: 给动作加声明式上下文需求字段

**Files:**
- Modify: `src/ui/selection-ai/action-registry.ts`
- Test: `test/action-registry.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `test/action-registry.test.ts` 的 `runTests()` 内、`runTests().catch` 之前追加:

```typescript
  await test('每个动作声明 context 需求(三个布尔源)', () => {
    for (const a of SELECTION_ACTIONS) {
      if (!a.context || typeof a.context !== 'object') {
        throw new Error(`action ${a.id} 缺 context 声明`);
      }
    }
  });

  await test('分级表符合设计:校对/摘要不注入任何源', () => {
    const fix = getAction('fix')!.context;
    expect(!!fix.activeNote || !!fix.knowledge || !!fix.memory).toBe(false);
    const sum = getAction('summarize')!.context;
    expect(!!sum.activeNote || !!sum.knowledge || !!sum.memory).toBe(false);
  });

  await test('分级表符合设计:扩写/解释全量注入', () => {
    for (const id of ['expand', 'explain']) {
      const c = getAction(id)!.context;
      expect(c.activeNote).toBe(true);
      expect(c.knowledge).toBe(true);
      expect(c.memory).toBe(true);
    }
  });

  await test('分级表符合设计:翻译仅知识库(术语)、润色笔记+记忆', () => {
    const tr = getAction('translate')!.context;
    expect(tr.knowledge).toBe(true);
    expect(!!tr.activeNote).toBe(false);
    expect(!!tr.memory).toBe(false);
    const im = getAction('improve')!.context;
    expect(im.activeNote).toBe(true);
    expect(im.memory).toBe(true);
    expect(!!im.knowledge).toBe(false);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/action-registry.test.ts`
Expected: FAIL —— `action improve 缺 context 声明`(context 字段尚不存在)

- [ ] **Step 3: 实现** — 修改 `src/ui/selection-ai/action-registry.ts`。

在 `SelectionAction` 接口加字段:

```typescript
export interface SelectionActionContext {
  activeNote?: boolean;  // 活动笔记当前小节
  knowledge?: boolean;   // 知识库深检索节选
  memory?: boolean;      // Hindsight 记忆召回
}

export interface SelectionAction {
  id: string;
  icon: string;
  label: string;
  kind: ActionKind;
  promptTemplate: string;
  context: SelectionActionContext;  // 声明该动作所需上下文源
}
```

给 `SELECTION_ACTIONS` 每项按分级表补 `context`(其余字段保持不动):

```typescript
// improve
context: { activeNote: true, memory: true },
// fix
context: {},
// translate
context: { knowledge: true },
// expand
context: { activeNote: true, knowledge: true, memory: true },
// summarize
context: {},
// explain
context: { activeNote: true, knowledge: true, memory: true },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/action-registry.test.ts`
Expected: PASS(所有旧断言 + 4 条新断言)

- [ ] **Step 5: 提交**

```bash
git add src/ui/selection-ai/action-registry.ts test/action-registry.test.ts
git commit -m "feat(selection-menu): 动作声明式上下文需求字段"
```

---

## Task 2: 新建上下文装配器 SelectionContextBuilder

**Files:**
- Create: `src/ui/selection-ai/selection-context-builder.ts`
- Test: `test/selection-context-builder.test.ts`

**背景接口(已存在,勿改):**
- `knowledgeRuntime.getGuardianDeepKnowledgeContext(query: string): Promise<string>` — 返回带 `[知识库相关笔记节选]` 头的文本,无命中返回 `''`。
- `modelService.recallGuardianMemory(query: string, maxChars?: number): Promise<string>` — 返回带 `[Relevant Memory]` 头的文本,无命中返回 `''`。
- `obsidianContextService.collect(): Promise<ObsidianContextSnapshot>` — 快照含 `activeNote`、`contextItems`(其中 id 以 `active-note:` 开头的项的 `content` 是当前小节正文)。

装配器只依赖这三者的**最小接口**(便于 mock 测试),不 import 具体类。

- [ ] **Step 1: 写失败测试** — 新建 `test/selection-context-builder.test.ts`:

```typescript
function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toContain: (s: string) => { if (typeof actual !== 'string' || !actual.includes(s)) throw new Error(`Expected "${actual}" to contain "${s}"`); },
    notToContain: (s: string) => { if (typeof actual === 'string' && actual.includes(s)) throw new Error(`Expected "${actual}" NOT to contain "${s}"`); },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== SelectionContextBuilder Tests ===');
  const { SelectionContextBuilder } = await import('../src/ui/selection-ai/selection-context-builder');

  const makeDeps = (over: any = {}) => ({
    knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => '[知识库相关笔记节选]\nKB内容' },
    modelService: { recallGuardianMemory: async () => '[Relevant Memory]\n记忆内容' },
    contextService: { collect: async () => ({ activeNote: { path: 'a.md', title: 'A' }, contextItems: [{ id: 'active-note:a.md', content: '当前小节正文' }] }) },
    ...over,
  });

  await test('校对(context 全空)只返回原 prompt,不预取', () => {
    let called = false;
    const deps = makeDeps({ knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => { called = true; return 'x'; } } });
    const b = new SelectionContextBuilder(deps as any);
    return b.build({ activeNote: false, knowledge: false, memory: false }, '选区文字', 'PROMPT').then((out: string) => {
      expect(out).toBe('PROMPT');
      expect(called).toBe(false);
    });
  });

  await test('扩写(全量)把三源拼进 prompt 前缀', async () => {
    const b = new SelectionContextBuilder(makeDeps() as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toContain('当前小节正文');
    expect(out).toContain('KB内容');
    expect(out).toContain('记忆内容');
    expect(out).toContain('PROMPT');
  });

  await test('翻译(仅知识库)不含笔记/记忆', async () => {
    const b = new SelectionContextBuilder(makeDeps() as any);
    const out = await b.build({ knowledge: true }, '选区文字', 'PROMPT');
    expect(out).toContain('KB内容');
    expect(out).notToContain('记忆内容');
    expect(out).notToContain('当前小节正文');
  });

  await test('某源超时/抛错降级为跳过该源,不阻断', async () => {
    const deps = makeDeps({ knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => { throw new Error('boom'); } } });
    const b = new SelectionContextBuilder(deps as any);
    const out = await b.build({ knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toContain('记忆内容');
    expect(out).notToContain('KB内容');
    expect(out).toContain('PROMPT');
  });

  await test('全源为空时返回裸 prompt', async () => {
    const deps = makeDeps({
      knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => '' },
      modelService: { recallGuardianMemory: async () => '' },
      contextService: { collect: async () => ({ activeNote: null, contextItems: [] }) },
    });
    const b = new SelectionContextBuilder(deps as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toBe('PROMPT');
  });

  await test('缺失依赖(null runtime)时安全跳过', async () => {
    const b = new SelectionContextBuilder({ knowledgeRuntime: null, modelService: null, contextService: null } as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toBe('PROMPT');
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 注册测试并运行确认失败**

先把 `'test/selection-context-builder.test.ts'` 加入 `test/run-tests.ts` 的 `tests` 数组(放在 `'test/action-registry.test.ts'` 附近)。

Run: `npx tsx --tsconfig tsconfig.test.json test/selection-context-builder.test.ts`
Expected: FAIL —— `Cannot find module '../src/ui/selection-ai/selection-context-builder'`

- [ ] **Step 3: 实现** — 新建 `src/ui/selection-ai/selection-context-builder.ts`:

```typescript
import { SelectionActionContext } from './action-registry';

/** 最小依赖接口(便于 mock,不耦合具体类)。任一为 null 表示该源不可用。 */
export interface SelectionContextDeps {
  knowledgeRuntime: { getGuardianDeepKnowledgeContext(query: string): Promise<string> } | null;
  modelService: { recallGuardianMemory(query: string, maxChars?: number): Promise<string> } | null;
  contextService: { collect(): Promise<{ contextItems?: Array<{ id?: string; content?: string }> }> } | null;
}

const KNOWLEDGE_TIMEOUT_MS = 2500;
const MEMORY_TIMEOUT_MS = 1500;
const ACTIVE_NOTE_TIMEOUT_MS = 800;

/** 给一个 promise 套超时;超时或抛错都 resolve 空串,绝不 reject。 */
function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(''); } }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v || ''); } })
     .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(''); } });
  });
}

/**
 * 上下文装配器:按动作的 context 声明,并发预取声明了的源,
 * 把非空片段拼成前缀 + 原 prompt。全空则返回裸 prompt。
 */
export class SelectionContextBuilder {
  constructor(private deps: SelectionContextDeps) {}

  async build(need: SelectionActionContext, selection: string, basePrompt: string): Promise<string> {
    const query = selection.trim();
    if (!query) return basePrompt;

    const [note, knowledge, memory] = await Promise.all([
      need.activeNote ? this.fetchActiveNote() : Promise.resolve(''),
      need.knowledge && this.deps.knowledgeRuntime
        ? withTimeout(this.deps.knowledgeRuntime.getGuardianDeepKnowledgeContext(query), KNOWLEDGE_TIMEOUT_MS)
        : Promise.resolve(''),
      need.memory && this.deps.modelService
        ? withTimeout(this.deps.modelService.recallGuardianMemory(query, 500), MEMORY_TIMEOUT_MS)
        : Promise.resolve(''),
    ]);

    const blocks = [note, knowledge, memory].map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) return basePrompt;
    return `${blocks.join('\n\n')}\n\n---\n\n${basePrompt}`;
  }

  /** 取活动笔记当前小节正文(来自 contextService 快照的 active-note contextItem)。 */
  private async fetchActiveNote(): Promise<string> {
    if (!this.deps.contextService) return '';
    const task = (async () => {
      const snap = await this.deps.contextService!.collect();
      const item = (snap.contextItems || []).find((i) => i.id?.startsWith('active-note:'));
      const body = (item?.content || '').trim();
      return body ? `[当前笔记片段]\n${body}` : '';
    })();
    return withTimeout(task, ACTIVE_NOTE_TIMEOUT_MS);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/selection-context-builder.test.ts`
Expected: PASS(6 条断言全过)

- [ ] **Step 5: 提交**

```bash
git add src/ui/selection-ai/selection-context-builder.ts test/selection-context-builder.test.ts test/run-tests.ts
git commit -m "feat(selection-menu): 声明式上下文装配器(并发预取+超时+降级)"
```

---

## Task 3: 改写路径接入 Builder(prompt 带上下文)

**Files:**
- Modify: `src/ui/selection-ai/rewrite-runner.ts`
- Modify: `src/ui/selection-menu.ts`(改写发起处传 builder)

**说明:** `runRewrite` 现在直接 `buildActionPrompt` 后 `generate`。改为可选接收一个已装配好的 `contextBuilder` + `actionContext`,在 `buildActionPrompt` 之后、`generate` 之前先 `await builder.build(...)`。DOM/流式部分不写单测,靠编译 + 手测;这一步的可测点是"prompt 装配顺序"通过 Task 2 已覆盖,故本 Task 只做编译验证。

- [ ] **Step 1: 修改 `RewriteRequest` 与 `runRewrite`** — `src/ui/selection-ai/rewrite-runner.ts`:

在文件顶部 import 补上类型:

```typescript
import { buildActionPrompt, SelectionActionContext } from './action-registry';
import { SelectionContextBuilder } from './selection-context-builder';
```

`RewriteRequest` 增加两个可选字段:

```typescript
export interface RewriteRequest {
  actionId: string;
  selection: string;
  from: number;
  to: number;
  contextBuilder?: SelectionContextBuilder;   // 有则先装配上下文
  actionContext?: SelectionActionContext;      // 该动作声明的上下文需求
}
```

把 `runRewrite` 里同步构造 prompt 的那段:

```typescript
  const prompt = buildActionPrompt(req.actionId, req.selection);

  modelService
    .generate(
      prompt,
```

改为先异步装配(用一个 async IIFE 包住原有的 generate 链,loading 态在其之前已推,保持不变):

```typescript
  const basePrompt = buildActionPrompt(req.actionId, req.selection);

  void (async () => {
    const prompt = req.contextBuilder && req.actionContext
      ? await req.contextBuilder.build(req.actionContext, req.selection, basePrompt)
      : basePrompt;
    if (ac.signal.aborted) return;

    modelService
      .generate(
        prompt,
        undefined,
        'selection-menu',
        undefined,
        undefined,
        { signal: ac.signal, skipGenerationPlan: true },
      )
      .then((newText) => {
        if (ac.signal.aborted) return;
        showInlineDiff(view, { from: req.from, to: req.to, oldText: req.selection, newText: newText.trim(), status: 'preview' });
      })
      .catch((err: Error) => {
        if (ac.signal.aborted) return;
        showInlineDiff(view, { from: req.from, to: req.to, oldText: req.selection, newText: '', status: 'error', message: err.message || '改写失败' });
      });
  })();

  return ac;
```

(注:`ac`、`showInlineDiff(loading)` 保持原样在函数开头;`makeRewriteCallbacks` 不动。)

- [ ] **Step 2: 在 selection-menu.ts 发起改写处传入 builder** — 见 Task 6(selection-menu 改造)统一接线。本 Task 仅改 rewrite-runner 并保证其独立编译通过(未传 builder 时行为与旧版一致)。

- [ ] **Step 3: 编译验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无 rewrite-runner.ts 相关错误(selection-menu.ts 的接线错误留待 Task 6,如本步报 selection-menu 未传新字段的错,属预期,Task 6 修复)

- [ ] **Step 4: 跑 action-registry 与 builder 测试确保未回归**

Run: `npx tsx --tsconfig tsconfig.test.json test/selection-context-builder.test.ts && npx tsx --tsconfig tsconfig.test.json test/action-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/selection-ai/rewrite-runner.ts
git commit -m "feat(selection-menu): 改写路径支持上下文装配(可选注入)"
```

---

## Task 4: 浮窗位置/尺寸持久化(纯函数,先 TDD)

**Files:**
- Create: `src/ui/selection-ai/floating-panel.ts`(本 Task 只写纯函数部分)
- Test: `test/floating-panel.test.ts`

**说明:** 浮窗的拖拽/缩放/DOM 是 CM/DOM 代码,不写单测。但"读写 localStorage 的位置尺寸 + 约束到视口内"是纯函数,先 TDD 出来,DOM 部分在 Task 5 再拼。

- [ ] **Step 1: 写失败测试** — 新建 `test/floating-panel.test.ts`:

```typescript
function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toEqual: (e: any) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)} but got ${JSON.stringify(actual)}`); },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== FloatingPanel geometry Tests ===');
  const { clampRect, DEFAULT_PANEL_RECT } = await import('../src/ui/selection-ai/floating-panel');

  await test('默认矩形有合理尺寸', () => {
    expect(DEFAULT_PANEL_RECT.width).toBe(420);
    expect(DEFAULT_PANEL_RECT.height).toBe(360);
  });

  await test('clampRect 把越界矩形拉回视口内', () => {
    const r = clampRect({ left: 5000, top: -100, width: 420, height: 360 }, { width: 1000, height: 800 });
    // 右边界不超出:left <= 1000-420
    expect(r.left <= 580).toBe(true);
    // 顶部不小于 0
    expect(r.top >= 0).toBe(true);
  });

  await test('clampRect 尺寸超视口时收缩到视口', () => {
    const r = clampRect({ left: 0, top: 0, width: 9999, height: 9999 }, { width: 1000, height: 800 });
    expect(r.width <= 1000).toBe(true);
    expect(r.height <= 800).toBe(true);
  });

  await test('clampRect 保底最小尺寸', () => {
    const r = clampRect({ left: 0, top: 0, width: 10, height: 10 }, { width: 1000, height: 800 });
    expect(r.width >= 280).toBe(true);
    expect(r.height >= 200).toBe(true);
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 注册测试并运行确认失败**

把 `'test/floating-panel.test.ts'` 加入 `test/run-tests.ts`。

Run: `npx tsx --tsconfig tsconfig.test.json test/floating-panel.test.ts`
Expected: FAIL —— `Cannot find module '../src/ui/selection-ai/floating-panel'`

- [ ] **Step 3: 实现纯函数部分** — 新建 `src/ui/selection-ai/floating-panel.ts`(先只放几何/持久化纯函数,DOM 类在 Task 5 追加到同文件):

```typescript
export interface PanelRect { left: number; top: number; width: number; height: number; }

export const DEFAULT_PANEL_RECT: PanelRect = { left: 0, top: 0, width: 420, height: 360 };
const MIN_W = 280, MIN_H = 200;
const STORAGE_KEY = 'baizer.selection.floating-panel.rect';

/** 把矩形约束进视口:先夹尺寸(min..viewport),再夹位置(0..viewport-size)。 */
export function clampRect(rect: PanelRect, viewport: { width: number; height: number }): PanelRect {
  const width = Math.max(MIN_W, Math.min(rect.width, viewport.width));
  const height = Math.max(MIN_H, Math.min(rect.height, viewport.height));
  const left = Math.max(0, Math.min(rect.left, viewport.width - width));
  const top = Math.max(0, Math.min(rect.top, viewport.height - height));
  return { left, top, width, height };
}

/** 从 localStorage 读上次矩形;无/损坏返回 null。 */
export function loadPanelRect(storage: Pick<Storage, 'getItem'> = localStorage): PanelRect | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === 'number' && typeof p?.top === 'number' && typeof p?.width === 'number' && typeof p?.height === 'number') return p;
    return null;
  } catch { return null; }
}

/** 写入 localStorage(失败静默)。 */
export function savePanelRect(rect: PanelRect, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(rect)); } catch { /* ignore */ }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/floating-panel.test.ts`
Expected: PASS(4 条断言)

- [ ] **Step 5: 提交**

```bash
git add src/ui/selection-ai/floating-panel.ts test/floating-panel.test.ts test/run-tests.ts
git commit -m "feat(selection-menu): 浮窗几何约束与位置持久化纯函数"
```

---

## Task 5: FloatingPanel DOM 组件(拖拽 + 缩放 + 流式渲染)

**Files:**
- Modify: `src/ui/selection-ai/floating-panel.ts`(追加 DOM 类,复用 Task 4 的纯函数)

**说明:** 纯 DOM/事件代码,不写单测,只做编译验证 + 手测。承载"解释"这类只读对话:标题栏(拖动+关闭)/ 消息区(MarkdownRenderer 流式)/ 底部输入(追问)+ 替换/复制。

- [ ] **Step 1: 追加 FloatingPanel 类** — 在 `src/ui/selection-ai/floating-panel.ts` 追加:

```typescript
import { App, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';

export interface FloatingPanelOptions {
  app: App;
  title: string;
  anchor: { x: number; y: number };   // 选区屏幕坐标,用于首次定位
  onClose: () => void;
  onSubmit: (text: string) => void;   // 追问
  onReplace: () => void;              // 用最后一条 AI 回答替换选区
}

export class FloatingPanel {
  private root: HTMLElement;
  private messageList: HTMLElement;
  private component = new Component();

  constructor(private opts: FloatingPanelOptions) {
    this.root = document.body.createDiv({ cls: 'baizer-floating-panel' });
    this.applyRect(this.resolveInitialRect());
    this.buildHeader();
    this.messageList = this.root.createDiv({ cls: 'baizer-fp-messages' });
    this.buildFooter();
    this.buildResizeHandle();
  }

  private resolveInitialRect(): PanelRect {
    const vw = window.innerWidth, vh = window.innerHeight;
    const saved = loadPanelRect();
    if (saved) return clampRect(saved, { width: vw, height: vh });
    const r = { ...DEFAULT_PANEL_RECT, left: this.opts.anchor.x, top: this.opts.anchor.y + 8 };
    return clampRect(r, { width: vw, height: vh });
  }

  private applyRect(r: PanelRect) {
    Object.assign(this.root.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  private currentRect(): PanelRect {
    const b = this.root.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }

  private buildHeader() {
    const header = this.root.createDiv({ cls: 'baizer-fp-header' });
    header.createSpan({ text: this.opts.title, cls: 'baizer-fp-title' });
    const close = header.createEl('button', { cls: 'baizer-fp-close', attr: { type: 'button', 'aria-label': 'Close' } });
    setIcon(close, 'x');
    close.onclick = () => this.destroy();

    // 拖动:按下标题栏,mousemove 改 left/top,松开存盘
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.onmousedown = (e) => {
      if ((e.target as HTMLElement).closest('.baizer-fp-close')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = this.currentRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    };
    window.addEventListener('mousemove', this.onDragMove = (e: MouseEvent) => {
      if (!dragging) return;
      const r = clampRect({ left: ox + (e.clientX - sx), top: oy + (e.clientY - sy), width: this.currentRect().width, height: this.currentRect().height }, { width: window.innerWidth, height: window.innerHeight });
      this.applyRect(r);
    });
    window.addEventListener('mouseup', this.onDragUp = () => {
      if (dragging) { dragging = false; savePanelRect(this.currentRect()); }
    });
  }

  private onDragMove?: (e: MouseEvent) => void;
  private onDragUp?: () => void;
  private onResizeMove?: (e: MouseEvent) => void;
  private onResizeUp?: () => void;

  private buildResizeHandle() {
    const handle = this.root.createDiv({ cls: 'baizer-fp-resize' });
    let resizing = false, sx = 0, sy = 0, ow = 0, oh = 0;
    handle.onmousedown = (e) => {
      resizing = true; sx = e.clientX; sy = e.clientY;
      const r = this.currentRect(); ow = r.width; oh = r.height;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('mousemove', this.onResizeMove = (e: MouseEvent) => {
      if (!resizing) return;
      const cur = this.currentRect();
      const r = clampRect({ left: cur.left, top: cur.top, width: ow + (e.clientX - sx), height: oh + (e.clientY - sy) }, { width: window.innerWidth, height: window.innerHeight });
      this.applyRect(r);
    });
    window.addEventListener('mouseup', this.onResizeUp = () => {
      if (resizing) { resizing = false; savePanelRect(this.currentRect()); }
    });
  }

  private buildFooter() {
    const footer = this.root.createDiv({ cls: 'baizer-fp-footer' });
    const input = footer.createEl('textarea', { cls: 'baizer-fp-input', attr: { rows: '1', placeholder: '继续追问...' } });
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const t = input.value.trim();
        if (t) { input.value = ''; this.opts.onSubmit(t); }
      }
    };
    const replace = footer.createEl('button', { text: '替换', attr: { type: 'button' } });
    replace.onclick = () => this.opts.onReplace();
    const copy = footer.createEl('button', { text: '复制', attr: { type: 'button' } });
    copy.onclick = () => {
      const last = this.messageList.querySelector('.baizer-fp-msg.ai:last-child');
      void navigator.clipboard.writeText(last?.textContent || '');
      new Notice('已复制');
    };
  }

  /** 渲染一批消息(role: 'user' | 'ai')。调用方每次流式更新后重渲。 */
  renderMessages(messages: Array<{ role: string; content: string }>) {
    this.messageList.empty();
    for (const m of messages) {
      const el = this.messageList.createDiv({ cls: `baizer-fp-msg ${m.role}` });
      if (m.role === 'ai') void MarkdownRenderer.render(this.opts.app, m.content, el, '', this.component);
      else el.setText(m.content);
    }
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  destroy() {
    if (this.onDragMove) window.removeEventListener('mousemove', this.onDragMove);
    if (this.onDragUp) window.removeEventListener('mouseup', this.onDragUp);
    if (this.onResizeMove) window.removeEventListener('mousemove', this.onResizeMove);
    if (this.onResizeUp) window.removeEventListener('mouseup', this.onResizeUp);
    this.component.unload();
    this.root.remove();
    this.opts.onClose();
  }
}
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无 floating-panel.ts 相关错误

- [ ] **Step 3: 跑 floating-panel 几何测试确保未回归**

Run: `npx tsx --tsconfig tsconfig.test.json test/floating-panel.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/ui/selection-ai/floating-panel.ts
git commit -m "feat(selection-menu): 可拖拽缩放浮窗 DOM 组件"
```

---

## Task 6: 改造 selection-menu(选中直出工具条 + 分流 + 依赖注入)

**Files:**
- Modify: `src/ui/selection-menu.ts`

**说明:** 核心接线 Task。改动点:
1. `selectionMenuExtension` 与 `pluginContextMap` 增加 `knowledgeRuntime`、`contextService` 两个依赖,构造 `SelectionContextBuilder`。
2. 删除 `button` 中间态:选区非空时 tooltip 直接渲染横向工具条(不再先渲一个 ✨AI 按钮)。
3. 工具条点击:改写类 → `runRewriteAction` 传入 builder + actionContext;只读类(解释)→ 弹 `FloatingPanel` 并走 `chatStream`(经 ChatController)。
4. 删除旧的 `chat` 面板态(createChatPanel 及其动作条)——浮窗取代它。

纯 DOM/CM 代码,编译 + 手测。

- [ ] **Step 1: 扩展依赖注入** — 修改 `pluginContextMap` 类型与 `selectionMenuExtension` 签名:

```typescript
import { SelectionContextBuilder } from './selection-ai/selection-context-builder';
import { getAction, SELECTION_ACTIONS, buildActionPrompt } from './selection-ai/action-registry';

const pluginContextMap = new WeakMap<EditorView, {
  app: App;
  modelService: ModelService;
  contextBuilder: SelectionContextBuilder;
}>();

export function selectionMenuExtension(
  app: App,
  modelService: ModelService,
  knowledgeRuntime: { getGuardianDeepKnowledgeContext(q: string): Promise<string> } | null,
  contextService: { collect(): Promise<any> } | null,
): Extension {
  const contextBuilder = new SelectionContextBuilder({
    knowledgeRuntime,
    modelService: modelService as any,   // recallGuardianMemory 在 ModelService 上
    contextService,
  });
  return [
    selectionMenuField,
    tooltips({ parent: document.body, position: 'fixed', tooltipSpace: (view) => view.dom.getBoundingClientRect() }),
    EditorView.updateListener.of((update) => {
      pluginContextMap.set(update.view, { app, modelService, contextBuilder });
    }),
  ];
}
```

- [ ] **Step 2: 工具条替代 button 态** — 把 `createSelectionTooltip` 里 `state.type === 'button'` 分支的"渲染单个 ✨AI 按钮"改为"渲染横向工具条"。工具条对每个 `SELECTION_ACTIONS` 渲染一个图标按钮,点击时分流:

```typescript
function createSelectionTooltip(view: EditorView, state: SelectionMenuState) {
  const context = pluginContextMap.get(view);
  const dom = document.createElement('div');
  dom.className = `guardian-selection-tooltip is-toolbar`;
  if (state.type === 'hidden' || !context) return { dom };

  const bar = dom.createDiv({ cls: 'baizer-selection-toolbar' });
  for (const action of SELECTION_ACTIONS) {
    const btn = bar.createEl('button', { cls: 'baizer-selection-tool', attr: { type: 'button', title: action.label, 'aria-label': action.label } });
    setIcon(btn, action.icon);
    btn.createSpan({ cls: 'baizer-selection-tool-label', text: action.label });
    btn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      void onToolClick(view, context, state, action.id);
    };
  }
  return { dom };
}
```

(注:`SelectionMenuState` 简化——不再需要 `chat` 态与 `controller` 字段;`button`/`trigger` 的 mode 概念保留给 trigger 插入场景,但选区场景只用工具条。若 trigger 场景暂不改,可让工具条只在 `mode==='selection'` 出现,`trigger` 维持原插入逻辑;为控制范围,本 Task 只改 selection 场景,trigger 保持现状。)

- [ ] **Step 3: 实现分流 onToolClick**:

```typescript
async function onToolClick(
  view: EditorView,
  context: { app: App; modelService: ModelService; contextBuilder: SelectionContextBuilder },
  state: Extract<SelectionMenuState, { mode: 'selection' }>,
  actionId: string,
) {
  const action = getAction(actionId);
  if (!action) return;
  const selection = view.state.doc.sliceString(state.from, state.to);
  if (!selection.trim()) { new Notice('请先选中文字。'); return; }

  if (action.kind === 'rewrite') {
    // 改写:内联 diff,prompt 带上下文
    rewriteView = view;
    activeModelService = context.modelService;
    currentRewriteController?.abort();
    currentRewriteRequest = { actionId, selection, from: state.from, to: state.to, contextBuilder: context.contextBuilder, actionContext: action.context };
    currentRewriteController = runRewrite(view, context.modelService, currentRewriteRequest);
  } else {
    // 只读(解释):弹浮窗 + chatStream
    openExplainPanel(view, context, state, action, selection);
  }
}
```

- [ ] **Step 4: 实现 openExplainPanel** — 弹 FloatingPanel,用 ChatController 驱动流式,预取上下文作为 prompt:

```typescript
import { FloatingPanel } from './selection-ai/floating-panel';
import { ChatController } from './chat-controller';

async function openExplainPanel(
  view: EditorView,
  context: { app: App; modelService: ModelService; contextBuilder: SelectionContextBuilder },
  state: Extract<SelectionMenuState, { mode: 'selection' }>,
  action: { id: string; label: string; context: any },
  selection: string,
) {
  const controller = new ChatController({ app: context.app, api: context.modelService });
  const coords = view.coordsAtPos(state.to);
  const panel = new FloatingPanel({
    app: context.app,
    title: action.label,
    anchor: { x: coords?.left ?? 200, y: coords?.bottom ?? 200 },
    onClose: () => controller.cleanup(),
    onSubmit: (text) => { void controller.processCommand(text, [], selection, 'selection-menu'); },
    onReplace: () => {
      const lastAi = [...controller.getMessages()].reverse().find(m => m.role === 'ai');
      if (!lastAi?.content) { new Notice('还没有可应用的 AI 回答。'); return; }
      view.dispatch({ changes: { from: state.from, to: state.to, insert: lastAi.content.trim() } });
      panel.destroy();
    },
  });
  (controller as any).onMessageAdded = () => panel.renderMessages(controller.getMessages());

  const basePrompt = buildActionPrompt(action.id, selection);
  const prompt = await context.contextBuilder.build(action.context, selection, basePrompt);
  void controller.processCommand(prompt, [], selection, 'selection-menu');
}
```

- [ ] **Step 5: 清理旧 chat 态** — 删除 `createChatPanel`、`renderSelectionMessage`、`runSelectionAction`(其逻辑已被 onToolClick 取代)、`buildContextItem`、`applyTriggerInsertion` 中仅服务旧 chat 面板的部分。`SelectionMenuState` 的 `chat` 分支与 `controller` 字段删除。保留:`findAtTrigger`、`relocateRange`、inline-diff 桥接函数(`handleInlineDiffAccept/Reject/Retry`)、`cleanupPendingRewrite`。

> 注意:trigger(`@` 行内插入)场景若仍需保留,单独保留其 button→插入逻辑;若本次不动 trigger,`selectionMenuField` 里 trigger 分支维持原样,仅 selection 分支切到工具条。以最小改动为准,不破坏 trigger。

- [ ] **Step 6: 编译验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: selection-menu.ts 无错误(此时 main.ts 调用 `selectionMenuExtension` 仍是旧签名,会报参数不足——Task 7 修复)

- [ ] **Step 7: 提交**

```bash
git add src/ui/selection-menu.ts
git commit -m "feat(selection-menu): 选中直出工具条 + 改写/只读分流 + 浮窗承载解释"
```

---

## Task 7: main.ts 接线 + 样式 + 全量回归

**Files:**
- Modify: `main.ts:204`
- Modify: `styles.css`

- [ ] **Step 1: main.ts 补传依赖** — 把 `main.ts:204` 的:

```typescript
selectionMenuExtension(this.app, this.modelService),
```

改为(`knowledgeRuntime` 在 106 行已初始化、`guardianContextService` 在 76 行已构造,均早于此处):

```typescript
selectionMenuExtension(
    this.app,
    this.modelService,
    this.knowledgeRuntime,
    this.guardianContextService,
),
```

- [ ] **Step 2: 样式** — 在 `styles.css` 末尾追加(走 Obsidian 主题变量,自动明暗适配):

```css
/* 选中横向工具条 */
.baizer-selection-toolbar { display: flex; gap: 2px; align-items: center; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 10px; padding: 4px 6px; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
.baizer-selection-tool { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: var(--text-normal); border-radius: 6px; padding: 5px 8px; cursor: pointer; font-size: 13px; }
.baizer-selection-tool:hover { background: var(--background-modifier-hover); }
.baizer-selection-tool-label { white-space: nowrap; }

/* 可拖拽缩放浮窗 */
.baizer-floating-panel { display: flex; flex-direction: column; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.22); z-index: var(--layer-popover, 30); overflow: hidden; }
.baizer-fp-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); cursor: move; user-select: none; }
.baizer-fp-title { font-size: 13px; font-weight: 600; color: var(--text-normal); }
.baizer-fp-close { border: none; background: transparent; color: var(--text-muted); cursor: pointer; display: inline-flex; }
.baizer-fp-messages { flex: 1; overflow-y: auto; padding: 12px; font-size: 14px; line-height: 1.6; }
.baizer-fp-msg.user { color: var(--text-muted); margin-bottom: 8px; }
.baizer-fp-msg.ai { color: var(--text-normal); margin-bottom: 12px; }
.baizer-fp-footer { display: flex; gap: 6px; align-items: flex-end; padding: 8px 12px; border-top: 1px solid var(--background-modifier-border); }
.baizer-fp-input { flex: 1; resize: none; border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 6px 10px; background: var(--background-primary); color: var(--text-normal); font-size: 13px; }
.baizer-fp-footer button { border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.baizer-fp-resize { position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px; cursor: nwse-resize; opacity: .5; background: linear-gradient(135deg, transparent 50%, var(--text-muted) 50%); }
```

- [ ] **Step 3: 编译验证(全项目)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 错误

- [ ] **Step 4: 生产构建**

Run: `npm run build`
Expected: 构建成功,生成 `main.js`

- [ ] **Step 5: 全量测试回归**

Run: `npx tsx --tsconfig tsconfig.test.json test/run-tests.ts`
Expected: 全部 test 文件 PASS(含新增 3 个)

- [ ] **Step 6: 提交**

```bash
git add main.ts styles.css
git commit -m "feat(selection-menu): 接线依赖注入 + 浮窗/工具条样式"
```

- [ ] **Step 7: 手测清单(在 Obsidian 中)** — 逐项验证,不通过则回对应 Task 修复:
  - 选中文字 → 立刻浮出横向工具条(无需再点 AI),明暗主题下都清晰
  - 点"校对"/"摘要" → 内联 diff 出现,✓接受/✕拒绝/↻重试正常
  - 点"扩写"/"润色" → 内联 diff 结果明显结合了当前笔记(对比改前更贴合上下文)
  - 点"解释" → 弹浮窗,流式输出,能引用知识库/笔记内容
  - 浮窗:拖标题栏移动、拉右下角缩放、关闭后重开记住上次大小
  - 浮窗内"继续追问"、"替换"、"复制"均可用
  - 无活动笔记 / 无知识库时不报错,降级为普通回答

---

## Self-Review 结论

**Spec 覆盖:** 上下文注入(Task 1-3)、浮窗载体(Task 4-5)、工具条+分流(Task 6)、接线+样式(Task 7)、边界降级(Task 2 测试覆盖 + Task 7 手测)。AI搜索合并解释(Task 6 用 SELECTION_ACTIONS 现状,已在 action-registry 合并)、统一深检索(Task 2 用 getGuardianDeepKnowledgeContext)、去掉复制/朗读(工具条只渲染 SELECTION_ACTIONS 六项,浮窗内的复制是回答后操作,与 spec 一致)。

**类型一致性:** `SelectionContextBuilder.build(need, selection, basePrompt)` 签名在 Task 2/3/6 一致;`PanelRect`/`clampRect`/`loadPanelRect`/`savePanelRect`/`DEFAULT_PANEL_RECT` 在 Task 4/5 一致;`SelectionActionContext` 在 Task 1/2/3 一致。

**无占位符:** 每个 code step 均含完整代码。

**已知取舍:** trigger(`@` 行内插入)场景本次不重构,仅 selection 场景切工具条,避免扩大范围。



