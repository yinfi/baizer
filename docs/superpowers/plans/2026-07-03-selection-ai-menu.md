# 选中文字 AI 快捷菜单 + 常驻对话框 + 内联应用 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"选中文字 → 迷你聊天窗"重做为"选中即浮出图标快捷动作条 + 常驻对话框 + 改写结果内联 diff 应用",并给对话框的 `@` 补上(复用主输入框那套的)图标化 + Enter 选中补全。

**Architecture:** 新增 `src/ui/selection-ai/` 目录承载动作元数据(纯函数)、快捷动作条(CM tooltip)、改写服务、内联 diff(CM StateField/Widget)。对话框主体由现有 `selection-menu.ts` 的 `createChatPanel` 演进而来,继续复用 `ChatController`。`@` 补全把现有 `CommandDropdown` + `InputController` 抽成一个 `SuggestList` 挂载器,主输入框与选区对话框共用。

**Tech Stack:** TypeScript、Obsidian API(`setIcon`/`MarkdownRenderer`/`Notice`)、CodeMirror 6(`StateField`/`StateEffect`/`Decoration`/`WidgetType`/`showTooltip`)。测试用项目自带的 mini-harness(`test/*.test.ts` 各自可执行,`npx tsx --tsconfig tsconfig.test.json <file>` 运行,新测试需注册进 `test/run-tests.ts`)。

**测试策略(遵循本仓库既有模式):** 本项目对纯函数写 mini-harness 单测(见 `test/selection-menu.test.ts`、`test/change-preview.test.ts`),对 CM/DOM/流式 UI 靠 `npm run build` 编译验证 + 手测脚本。本计划照此:所有可提纯的逻辑(动作元数据、prompt 模板、翻译语言方向、补全抽取回归)走单测;CM/对话框/内联 diff 给编译验证 + 明确手测步骤。

---

## 文件结构

**新建**
- `src/ui/selection-ai/action-registry.ts` — 动作元数据 + prompt 模板渲染 + 翻译语言方向检测(纯函数,可单测)
- `src/ui/selection-ai/inline-diff.ts` — CM StateField/StateEffect/Widget:改写结果内联预览 + ✓/✗/↻ 工具条
- `src/ui/selection-ai/rewrite-runner.ts` — 改写类执行:拼 prompt → `ModelService.generate()` → 文本
- `src/ui/components/suggest-list.ts` — 从 `CommandDropdown` + `InputController` 抽出的补全挂载器(textarea/input 通用)
- `test/action-registry.test.ts` — action-registry 纯函数单测
- `test/suggest-list.test.ts` — SuggestList 挂载器逻辑回归单测

**修改**
- `src/ui/selection-menu.ts` — `createChatPanel` 演进为常驻对话框:重做视觉、挂 `@` 补全、快捷动作条常驻头部、改写气泡的「应用到正文」入口;移除 `DiffModal` 调用
- `src/ui/shell-view.ts:290-296,432-471` — 改用 `SuggestList`(等价替换,行为不变)
- `main.ts:199-204` — 注册 `inlineDiffExtension()`
- `styles.css:785-939` — 重写 `.guardian-selection-*` / `.guardian-chat-*` / `.guardian-message-*`,新增动作条/内联 diff 样式
- `test/run-tests.ts` — 注册两个新测试文件

**删除(实现期确认无其它引用后)**
- `src/ui/diff-modal.ts` — 被内联 diff 取代(先 grep 确认仅 selection-menu 引用)

---

## Task 1: action-registry —— 动作元数据与纯函数

**Files:**
- Create: `src/ui/selection-ai/action-registry.ts`
- Test: `test/action-registry.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/action-registry.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toContain: (sub: string) => {
      if (typeof actual !== 'string' || !actual.includes(sub)) throw new Error(`Expected "${actual}" to contain "${sub}"`);
    },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== Action Registry Tests ===');
  const { SELECTION_ACTIONS, getAction, detectTranslateDirection, buildActionPrompt } =
    await import('../src/ui/selection-ai/action-registry');

  await test('每个动作元数据字段完整', () => {
    for (const a of SELECTION_ACTIONS) {
      if (!a.id || !a.icon || !a.label || !a.promptTemplate || !a.kind) {
        throw new Error(`action ${a.id} 字段缺失`);
      }
      if (a.kind !== 'rewrite' && a.kind !== 'readonly') {
        throw new Error(`action ${a.id} kind 非法: ${a.kind}`);
      }
    }
  });

  await test('包含约定的六个动作', () => {
    const ids = SELECTION_ACTIONS.map(a => a.id).sort();
    expect(ids).toEqual(['expand', 'explain', 'fix', 'improve', 'summarize', 'translate']);
  });

  await test('explain 是只读,其余是改写', () => {
    expect(getAction('explain')!.kind).toBe('readonly');
    expect(getAction('improve')!.kind).toBe('rewrite');
    expect(getAction('translate')!.kind).toBe('rewrite');
  });

  await test('翻译方向:中文译英,其余译中', () => {
    expect(detectTranslateDirection('你好世界')).toBe('to-en');
    expect(detectTranslateDirection('hello world')).toBe('to-zh');
    expect(detectTranslateDirection('包含some英文的中文')).toBe('to-en');
  });

  await test('buildActionPrompt 把选区文本嵌入模板', () => {
    const p = buildActionPrompt('improve', '这是一段草稿');
    expect(p).toContain('这是一段草稿');
  });

  await test('翻译 prompt 按方向给出目标语言', () => {
    expect(buildActionPrompt('translate', '你好')).toContain('English');
    expect(buildActionPrompt('translate', 'hello')).toContain('中文');
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/action-registry.test.ts`
Expected: FAIL(模块不存在 / Cannot find module `../src/ui/selection-ai/action-registry`)

- [ ] **Step 3: 实现 action-registry**

创建 `src/ui/selection-ai/action-registry.ts`:

```ts
export type ActionKind = 'rewrite' | 'readonly';

export interface SelectionAction {
  id: string;
  icon: string;      // Obsidian setIcon 名
  label: string;     // hover tooltip / 菜单文案
  kind: ActionKind;
  promptTemplate: string; // 含 {{selection}} 占位;translate 额外含 {{target}}
}

export const SELECTION_ACTIONS: SelectionAction[] = [
  {
    id: 'improve', icon: 'wand', label: '润色', kind: 'rewrite',
    promptTemplate: '请润色下面这段文字,使其更流畅自然,保持原意与语言不变。只输出润色后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'fix', icon: 'check', label: '校对', kind: 'rewrite',
    promptTemplate: '请校对下面这段文字的拼写、语法与标点错误,保持原意与语言不变。只输出修正后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'translate', icon: 'languages', label: '翻译', kind: 'rewrite',
    promptTemplate: '请把下面这段文字翻译成{{target}}。只输出译文,不要解释:\n\n{{selection}}',
  },
  {
    id: 'expand', icon: 'expand', label: '扩写', kind: 'rewrite',
    promptTemplate: '请在保持原意与语言不变的前提下扩写下面这段文字,补充细节使其更充实。只输出扩写后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'summarize', icon: 'text', label: '摘要', kind: 'rewrite',
    promptTemplate: '请用与原文相同的语言,把下面这段文字概括成简洁的摘要。只输出摘要,不要解释:\n\n{{selection}}',
  },
  {
    id: 'explain', icon: 'search', label: '解释', kind: 'readonly',
    promptTemplate: '请解释并介绍下面这段文字涉及的概念/背景,可结合联网检索与我的知识库。用中文回答:\n\n{{selection}}',
  },
];

export function getAction(id: string): SelectionAction | undefined {
  return SELECTION_ACTIONS.find(a => a.id === id);
}

/** 检测翻译方向:含中日韩字符 → 译英;否则译中。 */
export function detectTranslateDirection(text: string): 'to-en' | 'to-zh' {
  return /[぀-ヿ㐀-鿿豈-﫿]/.test(text) ? 'to-en' : 'to-zh';
}

/** 把选区文本(及翻译目标语言)填入动作模板。 */
export function buildActionPrompt(actionId: string, selection: string): string {
  const action = getAction(actionId);
  if (!action) throw new Error(`未知动作: ${actionId}`);
  let prompt = action.promptTemplate.replace('{{selection}}', selection);
  if (action.id === 'translate') {
    const target = detectTranslateDirection(selection) === 'to-en' ? 'English' : '中文';
    prompt = prompt.replace('{{target}}', target);
  }
  return prompt;
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/action-registry.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 注册测试并提交**

在 `test/run-tests.ts` 的 `tests` 数组末尾(`'test/throttle.test.ts',` 之后)加入:

```ts
  'test/action-registry.test.ts',
```

```bash
git add src/ui/selection-ai/action-registry.ts test/action-registry.test.ts test/run-tests.ts
git commit -m "feat(selection-ai): 动作元数据与 prompt 模板(纯函数 + 单测)"
```

---

## Task 2: SuggestList —— 抽出可复用的补全挂载器

把 shell-view 里"trigger 检测 → 取 items → 渲染 → 键盘导航 → 回填"这段胶水抽成一个与宿主无关的挂载器,`items` 由调用方回调提供(主输入框注入 command/skill/file 三类;选区对话框只注入 file 类)。`CommandDropdown` 与 `InputController` 已是 UI 无关组件,直接复用,不改动它们。

**Files:**
- Create: `src/ui/components/suggest-list.ts`
- Test: `test/suggest-list.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/suggest-list.test.ts`(复用 command-dropdown.test.ts 的 FakeElement 与 FakeTextarea 思路;这里聚焦挂载器的编排逻辑:trigger→取items→Enter选中→回填):

```ts
function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toEqual: (e: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)} but got ${JSON.stringify(actual)}`);
    },
  };
}
async function test(name: string, fn: () => any) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

class FakeEl {
  children: FakeEl[] = [];
  className = ''; textContent = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  createDiv(a?: any) { return this.createEl('div', a); }
  createSpan(a?: any) { return this.createEl('span', a); }
  createEl(_t: string, a?: any) { const c = new FakeEl(); c.className = a?.cls || ''; c.textContent = a?.text || ''; if (a?.attr) for (const [k,v] of Object.entries(a.attr)) c.attributes[k]=String(v); this.children.push(c); return c; }
  empty() { this.children = []; }
  setAttribute(n: string, v: string) { this.attributes[n] = v; }
  addEventListener(t: string, h: Function) { (this.listeners[t] ||= []).push(h); }
  scrollIntoView() {}
}

async function runTests() {
  console.log('=== Suggest List Tests ===');
  const { SuggestList } = await import('../src/ui/components/suggest-list');

  await test('打 @ 触发 file 类,回调收到 query', () => {
    const container = new FakeEl();
    let askedQuery: string | null = null;
    const list = new SuggestList({
      container: container as any,
      provideItems: (type, query) => { askedQuery = query; return type === 'file' ? [{ label: 'Note', desc: 'Note.md', value: 'Note.md', source: 'file', kind: 'file' }] : []; },
      onApply: () => {},
    });
    list.handleInput('hello @No', 9);
    expect(askedQuery).toBe('No');
    expect(list.isOpen()).toBe(true);
  });

  await test('Enter 选中回填文本并触发 onApply', () => {
    const container = new FakeEl();
    const applied: any[] = [];
    const list = new SuggestList({
      container: container as any,
      provideItems: () => [{ label: 'Note', desc: 'Note.md', value: 'Note.md', source: 'file', kind: 'file' }],
      onApply: (sel) => applied.push(sel),
    });
    list.handleInput('@No', 3);
    const handled = list.handleKeyDown({ key: 'Enter', preventDefault() {} } as any);
    expect(handled).toBe(true);
    expect(applied.length).toBe(1);
    expect(applied[0].text).toBe('Note.md ');
  });

  await test('无 trigger 时关闭', () => {
    const container = new FakeEl();
    const list = new SuggestList({ container: container as any, provideItems: () => [], onApply: () => {} });
    list.handleInput('plain text', 10);
    expect(list.isOpen()).toBe(false);
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/suggest-list.test.ts`
Expected: FAIL(`Cannot find module '../src/ui/components/suggest-list'`)

- [ ] **Step 3: 实现 SuggestList**

创建 `src/ui/components/suggest-list.ts`:

```ts
import { CommandDropdown } from './command-dropdown';
import {
  InputController,
  detectSuggestionTrigger,
  SuggestionItem,
  SuggestionType,
  SuggestionSelection,
} from '../controllers/input-controller';

export interface SuggestListOptions {
  container: HTMLElement;
  /** 按 trigger 类型与 query 返回候选(调用方决定支持哪些类型)。 */
  provideItems: (type: SuggestionType, query: string) => SuggestionItem[];
  /** 选中一项后:text 是回填后的完整输入,cursor 是新光标位,contextItem 可选。 */
  onApply: (selection: SuggestionSelection) => void;
}

/**
 * 与宿主无关的补全挂载器:trigger 检测 → 取 items → 渲染下拉 → 键盘导航 → 回填。
 * 复用 CommandDropdown(渲染) + InputController(选中逻辑)。
 * 调用方在输入事件里调 handleInput,在 keydown 里先调 handleKeyDown。
 */
export class SuggestList {
  private readonly controller = new InputController();
  private readonly dropdown: CommandDropdown;
  private currentValue = '';
  private currentCursor = 0;

  constructor(private readonly options: SuggestListOptions) {
    this.dropdown = new CommandDropdown(options.container, {
      onNavigate: (dir) => this.navigate(dir),
      onSelect: (_item, index) => this.selectAt(index),
      onCancel: () => this.hide(),
    });
  }

  handleInput(value: string, cursor: number) {
    this.currentValue = value;
    this.currentCursor = cursor;
    const trigger = detectSuggestionTrigger(value, cursor);
    if (!trigger) { this.hide(); return; }
    const items = this.options.provideItems(trigger.type, trigger.query);
    this.controller.setSuggestions(trigger.type, items);
    if (this.controller.getSuggestions().length === 0) { this.hide(); return; }
    this.render();
  }

  /** 返回 true 表示本次按键已被补全消费,宿主应 return。 */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.controller.getIsSuggesting()) return false;
    return this.dropdown.handleKeyDown(event);
  }

  isOpen(): boolean {
    return this.controller.getIsSuggesting();
  }

  hide() {
    this.controller.hide();
    this.dropdown.hide();
  }

  private navigate(dir: number) {
    this.controller.navigate(dir);
    this.render();
  }

  private selectAt(index: number) {
    // 先把选中项对齐到 index,再复用 controller 的回填逻辑
    while (this.controller.getSelectedIndex() < index) this.controller.navigate(1);
    while (this.controller.getSelectedIndex() > index) this.controller.navigate(-1);
    const selection = this.controller.selectSuggestion(this.currentValue, this.currentCursor);
    this.hide();
    if (selection) this.options.onApply(selection);
  }

  private render() {
    const type = this.controller.getSuggestionType();
    if (!type) return;
    this.dropdown.update({
      type,
      items: this.controller.getSuggestions(),
      selectedIndex: this.controller.getSelectedIndex(),
    });
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/suggest-list.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 注册测试并提交**

在 `test/run-tests.ts` 加入 `'test/suggest-list.test.ts',`。

```bash
git add src/ui/components/suggest-list.ts test/suggest-list.test.ts test/run-tests.ts
git commit -m "feat(suggest-list): 抽出可复用补全挂载器(复用 CommandDropdown + InputController)"
```

---

## Task 3: 主输入框改用 SuggestList(等价替换,行为不变)

把 shell-view 里手写的补全编排替换为 SuggestList,验证主输入框 `@`/`/`/`$` 行为不回归。这是抽取的正确性保证。

**Files:**
- Modify: `src/ui/shell-view.ts:290-296`(构造)、`:366-471`(handleInput/show/render/navigate/select)

- [ ] **Step 1: 构造 SuggestList 替换 CommandDropdown**

`src/ui/shell-view.ts:290-296` 处,把:

```ts
        this.suggestionContainer = this.createSuggestionContainer(inputContainer);
        this.commandDropdown = new CommandDropdown(this.suggestionContainer, {
            onNavigate: (dir) => this.navigateSuggestions(dir),
            onSelect: (_item, index) => this.selectSuggestionAt(index),
            onCancel: () => this.hideSuggestions(),
        });
```

替换为:

```ts
        this.suggestionContainer = this.createSuggestionContainer(inputContainer);
        this.suggestList = new SuggestList({
            container: this.suggestionContainer,
            provideItems: (type, query) => this.buildSuggestionItems(type, query),
            onApply: (selection) => this.applySuggestionSelection(selection),
        });
```

顶部 import 处新增 `import { SuggestList } from './components/suggest-list';`,并把类字段 `private commandDropdown?: CommandDropdown;` 改为 `private suggestList!: SuggestList;`。`SuggestionSelection` 从 `./controllers/input-controller` 引入。

- [ ] **Step 2: 用 provideItems 承接原三类数据源**

新增方法(把原 `showSuggestions` 里 command/skill/file 三分支的"造 items"部分平移进来,去掉渲染副作用):

```ts
    private buildSuggestionItems(type: SuggestionType, query: string): SuggestionItem[] {
        if (type === 'command') {
            const skillCommands = this.modelService.getSkillCommands().map(c => ({ command: c.command, description: c.description }));
            const skillLabels = new Set(skillCommands.map(c => c.command));
            return buildCommandSuggestions(this.localCommandSuggestions, skillCommands, query)
                .map(item => ({ ...item, source: skillLabels.has(item.label) ? 'skill' as const : 'local' as const }));
        }
        if (type === 'skill') {
            return this.modelService.getSkillCommands()
                .filter(c => c.skillName.toLowerCase().includes(query.toLowerCase()) || c.command.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(c => ({ label: `$${c.skillName}`, desc: c.description, value: c.command, source: 'skill' as const }));
        }
        const scope = this.buildContextScopeSuggestions(query);
        const files = this.app.vault.getFiles()
            .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10)
            .map(f => ({ label: f.basename, desc: f.path, value: f.path, source: 'file' as const, kind: 'file' as const }));
        return [...scope, ...files];
    }
```

- [ ] **Step 3: 用 applySuggestionSelection 承接原回填副作用**

把原 `selectSuggestion()` 里"回填 textarea + 加 contextItem + 刷 chips"的副作用平移:

```ts
    private applySuggestionSelection(selection: SuggestionSelection) {
        this.inputEl.value = selection.text;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = selection.cursor;
        if (selection.contextItem) {
            if (selection.contextItem.type === 'scope' && selection.contextItem.scope === 'current') {
                this.excludedCurrentNotePath = null;
            }
            this.contextManager.addContext(selection.contextItem);
            this.renderContextChips(this.outputContainer.parentElement?.querySelector('.shell-context-chips') as HTMLElement);
            void this.refreshKnowledgeStatusPanel();
        }
        this.inputEl.focus();
    }
```

- [ ] **Step 4: 改 handleInput 与 keydown 转发**

`handleInput()`(:366)改为:

```ts
    handleInput() {
        this.updateInputToolbarCapabilities();
        this.suggestList.handleInput(this.inputEl.value, this.inputEl.selectionStart);
    }
```

keydown 分发处(:116 附近,原 `if (this.inputController.getIsSuggesting() && this.commandDropdown?.handleKeyDown(e))`)改为:

```ts
        if (this.suggestList.handleKeyDown(e)) return;
```

删除现已无用的方法/字段:`showSuggestions`、`renderSuggestions`、`navigateSuggestions`、`selectSuggestion`、`selectSuggestionAt`、`hideSuggestions`(若仅内部使用)、`inputController`、`commandDropdown` 字段。用编译器找残余引用(下一步)。

- [ ] **Step 5: 编译验证 + 手测**

Run: `npm run build`
Expected: 编译通过,无 TS 报错(报错即说明有残余引用,逐个清理)。

手测(在 Obsidian 里加载插件):
1. 主输入框打 `@` → 弹文件补全,↑↓ 导航,Enter 选中回填 + 出现 context chip。
2. 打 `/` → 命令补全,Enter 选中。
3. 打 `$` → skill 补全。
4. Esc 关闭补全。
预期:与改动前完全一致。

- [ ] **Step 6: 提交**

```bash
git add src/ui/shell-view.ts
git commit -m "refactor(shell-view): 主输入框补全改用 SuggestList,行为不变"
```

---

## Task 4: inline-diff —— 内联预览 + ✓/✗/↻ 工具条(CM 扩展)

改写结果不再用全屏 DiffModal,而是在正文里内联展示:原选区加红色删除线底,其后插入绿色新文本 widget,widget 尾部带 ✓接受 / ✗拒绝 / ↻重试 三个按钮。参照 `ghost-text.ts` 的 StateField + StateEffect + WidgetType + Decoration 写法。

**Files:**
- Create: `src/ui/selection-ai/inline-diff.ts`

说明:CM 扩展依赖真实 EditorView,本仓库无 CM 测试夹具(见 `test/ghost-text.test.ts` 亦只测数据结构),故此任务以 `npm run build` 编译 + 手测验证,不写单测。回调注入使 accept/reject/retry 的业务逻辑留在对话框侧(Task 6),本文件只管渲染与派发。

- [ ] **Step 1: 实现 inline-diff 扩展**

创建 `src/ui/selection-ai/inline-diff.ts`:

```ts
import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, Extension, Range } from '@codemirror/state';
import { setIcon } from 'obsidian';

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
      wrap.createSpan({ cls: 'baizer-inline-diff-spinner' });
      wrap.createSpan({ cls: 'baizer-inline-diff-hint', text: '正在改写…' });
      return wrap;
    }

    if (this.state.status === 'error') {
      wrap.classList.add('is-error');
      wrap.createSpan({ cls: 'baizer-inline-diff-hint', text: this.state.message || '改写失败' });
      this.addButton(wrap, 'rotate-ccw', '重试', () => callbacks?.onRetry(this.state));
      return wrap;
    }

    const text = wrap.createSpan({ cls: 'baizer-inline-diff-new' });
    text.textContent = this.state.newText;
    const bar = wrap.createSpan({ cls: 'baizer-inline-diff-actions' });
    this.addButton(bar, 'check', '接受', () => callbacks?.onAccept(this.state));
    this.addButton(bar, 'x', '拒绝', () => callbacks?.onReject(this.state));
    this.addButton(bar, 'rotate-ccw', '重试', () => callbacks?.onRetry(this.state));
    return wrap;
  }

  private addButton(parent: HTMLElement, icon: string, title: string, onClick: () => void) {
    const btn = parent.createEl('button', { cls: 'baizer-inline-diff-btn', attr: { type: 'button', title } });
    setIcon(btn, icon);
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
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
```

- [ ] **Step 2: 编译验证**

Run: `npm run build`
Expected: 编译通过。若 `createSpan`/`createEl` 在 `HTMLElement` 上报类型错误,确认顶部无需额外 import(Obsidian 全局扩展了 HTMLElement 原型;项目其它文件如 diff-modal.ts 已直接用 `contentEl.createDiv`,同样可用)。

- [ ] **Step 3: 提交**

```bash
git add src/ui/selection-ai/inline-diff.ts
git commit -m "feat(selection-ai): 内联 diff 预览扩展(红底原文 + 绿底新文 + 工具条)"
```

---

## Task 5: rewrite-runner —— 改写类执行

把"动作 → prompt → generate() → 文本"这段抽成一个薄函数,便于对话框侧调用与(将来)测试。

**Files:**
- Create: `src/ui/selection-ai/rewrite-runner.ts`

说明:依赖 `ModelService.generate`(签名见 `src/services/model-service.ts:414` — `generate(prompt, systemPrompt?, source?, obsidianContext?, userProfile?, options?)`,返回 `Promise<string>`)。此函数逻辑极薄且依赖注入,验证走编译 + Task 6 集成手测。

- [ ] **Step 1: 实现 rewrite-runner**

创建 `src/ui/selection-ai/rewrite-runner.ts`:

```ts
import { ModelService } from '../../services/model-service';
import { buildActionPrompt } from './action-registry';

export interface RewriteResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * 执行一次改写类动作:拼 prompt → generate() → 纯文本。
 * @param actionId action-registry 里的改写类动作 id(improve/fix/translate/expand/summarize)
 * @param selection 选中的原文
 * @param signal 允许选区变化/关闭时中断
 */
export async function runRewrite(
  api: ModelService,
  actionId: string,
  selection: string,
  signal?: AbortSignal,
): Promise<RewriteResult> {
  const prompt = buildActionPrompt(actionId, selection);
  try {
    const text = await api.generate(prompt, undefined, 'selection-menu', undefined, undefined, { signal });
    const trimmed = (text || '').trim();
    if (!trimmed) return { ok: false, text: '', error: '模型没有返回内容' };
    return { ok: true, text: trimmed };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, text: '', error: 'aborted' };
    return { ok: false, text: '', error: e?.message || '改写失败' };
  }
}
```

- [ ] **Step 2: 编译验证**

Run: `npm run build`
Expected: 编译通过。(`'selection-menu'` 已是 `GenerationSource` 合法值,见 `src/services/generation-strategy-service.ts:4`;`GenerationOptions.signal` 存在,见 `src/models/interfaces.ts:62`。)

- [ ] **Step 3: 提交**

```bash
git add src/ui/selection-ai/rewrite-runner.ts
git commit -m "feat(selection-ai): 改写执行器(prompt 模板 + generate)"
```

---

## Task 6: 对话框演进 —— 动作条常驻头部 + @ 补全 + 改写内联应用

改造 `src/ui/selection-menu.ts` 的 `createChatPanel`:
1. 头部下方常驻一排图标快捷动作条(来自 action-registry)。
2. textarea 挂 `SuggestList`(打 `@` 出文件补全,Enter 选中)。
3. 点改写类动作 = 注入预置问题并执行 `runRewrite`,结果进 AI 气泡;气泡下出现「应用到正文」→ 触发内联 diff。
4. 点只读类动作(explain) = 走对话框既有 `processCommand`(带工具流式)。
5. 移除 `applySelectionReplacement` 里的 `DiffModal`,改为内联 diff。
6. **对话框不因执行动作而关闭。**

**Files:**
- Modify: `src/ui/selection-menu.ts`(`createChatPanel`、`createSelectionTooltip` 的 button 分支文案、`applySelectionReplacement`→内联;移除 `DiffModal` import)

- [ ] **Step 1: 顶部 import 调整**

`src/ui/selection-menu.ts` 顶部:
- 删除 `import { DiffModal } from './diff-modal';`
- 新增:

```ts
import { SuggestList } from './components/suggest-list';
import { SuggestionItem, SuggestionType } from './controllers/input-controller';
import { SELECTION_ACTIONS, getAction } from './selection-ai/action-registry';
import { runRewrite } from './selection-ai/rewrite-runner';
import { showInlineDiff, clearInlineDiff, InlineDiffState } from './selection-ai/inline-diff';
```

- [ ] **Step 2: 在对话框头部下方渲染动作条**

在 `createChatPanel` 内、`header` 创建之后、`messageList` 之前,插入动作条渲染:

```ts
    const actionBar = container.createDiv({ cls: 'baizer-action-bar' });
    for (const action of SELECTION_ACTIONS) {
        const btn = actionBar.createEl('button', {
            cls: 'baizer-action-btn',
            attr: { type: 'button', title: action.label, 'aria-label': action.label },
        });
        setIcon(btn, action.icon);
        btn.createSpan({ cls: 'baizer-action-label', text: action.label });
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void runSelectionAction(view, state, context, action.id);
        };
    }
```

`setIcon` 从 `obsidian` 引入(在文件顶部 import 里补上 `setIcon`;`MarkdownRenderer, Component, Notice` 已在)。

- [ ] **Step 3: 实现 runSelectionAction(注入预置问题 + 分流)**

在 `selection-menu.ts` 里新增(模块级函数):

```ts
async function runSelectionAction(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App; modelService: ModelService },
    actionId: string,
) {
    const action = getAction(actionId);
    if (!action) return;
    const targetText = getTargetText(view, state);
    if (!targetText.trim()) { new Notice('请先选中文字。'); return; }

    if (action.kind === 'readonly') {
        // 只读类:走对话框既有流式通道(带 web_search + query_knowledge 工具)
        await state.controller.processCommand(
            action.promptTemplate.replace('{{selection}}', targetText),
            [buildContextItem(state.mode, targetText)],
            targetText,
            'selection-menu',
        );
        return;
    }

    // 改写类:generate() 一次性改写 → 内联 diff(不经对话框流式)
    await runRewriteAction(view, state, context, actionId, targetText);
}
```

- [ ] **Step 4: 实现 runRewriteAction(执行改写 + 内联 diff + 接受/拒绝/重试)**

```ts
async function runRewriteAction(
    view: EditorView,
    state: Extract<SelectionMenuState, { type: 'chat' }>,
    context: { app: App; modelService: ModelService },
    actionId: string,
    selectionText: string,
) {
    const from = state.from;
    const to = state.to;
    // loading 态
    showInlineDiff(view, { from, to, oldText: selectionText, newText: '', status: 'loading' });

    const result = await runRewrite(context.modelService, actionId, selectionText);
    if (result.error === 'aborted') { clearInlineDiff(view); return; }
    if (!result.ok) {
        showInlineDiff(view, { from, to, oldText: selectionText, newText: '', status: 'error', message: result.error });
        return;
    }
    // preview 态(inline-diff 的回调在 Task 7 注入,会调用下面的 accept/reject/retry)
    showInlineDiff(view, { from, to, oldText: selectionText, newText: result.text, status: 'preview' });
    // 记住当前 pending,供扩展回调消费(见 Task 7 的模块级 pending 状态)
    setPendingRewrite({
        view, actionId, context,
        apply: async (s: InlineDiffState) => {
            const target = relocateRange(view.state, s.from, s.to, s.oldText);
            if (!target) {
                clearInlineDiff(view);
                new Notice('选区在改写期间发生了变化,已取消替换,请重新选择。');
                return;
            }
            const activeFile = context.app.workspace.getActiveFile();
            await state.controller.applyPreviewedChange({
                action: 'selection_rewrite',
                target: activeFile?.path || 'current-selection',
                previousContent: view.state.doc.toString(),
                apply: () => {
                    view.dispatch({ changes: { from: target.from, to: target.to, insert: s.newText } });
                    clearInlineDiff(view);
                },
            });
        },
        retry: () => { void runRewriteAction(view, state, context, actionId, selectionText); },
    });
}
```

- [ ] **Step 5: 模块级 pending 桥接(inline-diff 回调 ↔ 当前改写)**

inline-diff 的扩展回调是全局单例,需要一个模块级 pending 把"当前这次改写的 accept/reject/retry"接过去。在 `selection-menu.ts` 顶部加:

```ts
interface PendingRewrite {
    view: EditorView;
    actionId: string;
    context: { app: App; modelService: ModelService };
    apply: (s: InlineDiffState) => void | Promise<void>;
    retry: () => void;
}
let pendingRewrite: PendingRewrite | null = null;
function setPendingRewrite(p: PendingRewrite) { pendingRewrite = p; }

/** 供 main.ts 注册 inlineDiffExtension 时作为回调转发。 */
export function handleInlineDiffAccept(s: InlineDiffState) { void pendingRewrite?.apply(s); pendingRewrite = null; }
export function handleInlineDiffReject(_s: InlineDiffState) {
    if (pendingRewrite) { clearInlineDiff(pendingRewrite.view); pendingRewrite = null; }
}
export function handleInlineDiffRetry(_s: InlineDiffState) { pendingRewrite?.retry(); }
```

- [ ] **Step 6: textarea 挂 SuggestList**

在 `createChatPanel` 里创建 `textarea` 之后,挂补全。先在 `inputWrapper` 下建一个补全容器,再 new SuggestList:

```ts
    const suggestContainer = inputWrapper.createDiv({ cls: 'baizer-suggest-container' });
    suggestContainer.style.display = 'none';
    const suggestList = new SuggestList({
        container: suggestContainer,
        provideItems: (type: SuggestionType, query: string): SuggestionItem[] => {
            if (type !== 'file') return [];
            return context.app.vault.getFiles()
                .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map(f => ({ label: f.basename, desc: f.path, value: f.path, source: 'file' as const, kind: 'file' as const }));
        },
        onApply: (selection) => {
            textarea.value = selection.text;
            textarea.selectionStart = textarea.selectionEnd = selection.cursor;
            textarea.focus();
        },
    });
```

在 `textarea.onkeydown` 最前面加转发(Enter 选中要先于发送逻辑):

```ts
    textarea.onkeydown = async (event) => {
        event.stopPropagation();
        if (suggestList.handleKeyDown(event)) return; // 补全消费了本次按键
        // ...(原有 Escape / Enter 发送逻辑保持)
    };
    textarea.oninput = () => suggestList.handleInput(textarea.value, textarea.selectionStart);
```

- [ ] **Step 7: 移除 applySelectionReplacement 的 DiffModal,改内联**

`applySelectionReplacement`(原 :299)整体删除(其职责已并入 Task 4 步骤的 apply 回调路径)。原 `applyBtn`(Replace/Insert 按钮)的 `onclick` 里,selection 分支改为触发一次"自定义改写"——但既然已有动作条,`applyBtn` 的语义调整为:selection 模式下无预置动作时,用输入框最后一条 AI 回答做替换。保留 trigger 模式的 `applyTriggerInsertion` 不变。

具体:把 `applyBtn.onclick` 的 selection 分支从 `applySelectionReplacement(...)` 改为:

```ts
        if (state.mode === 'selection') {
            const selectionText = view.state.doc.sliceString(state.from, state.to);
            const lastAi = [...state.controller.getMessages()].reverse().find(m => m.role === 'ai');
            if (!lastAi?.content) { new Notice('还没有可应用的 AI 回答。'); return; }
            showInlineDiff(view, { from: state.from, to: state.to, oldText: selectionText, newText: lastAi.content.trim(), status: 'preview' });
            setPendingRewrite({
                view, actionId: 'custom', context,
                apply: async (s: InlineDiffState) => {
                    const target = relocateRange(view.state, s.from, s.to, s.oldText);
                    if (!target) { clearInlineDiff(view); new Notice('选区已变化,已取消替换。'); return; }
                    const activeFile = context.app.workspace.getActiveFile();
                    await state.controller.applyPreviewedChange({
                        action: 'selection_rewrite',
                        target: activeFile?.path || 'current-selection',
                        previousContent: view.state.doc.toString(),
                        apply: () => { view.dispatch({ changes: { from: target.from, to: target.to, insert: s.newText } }); clearInlineDiff(view); },
                    });
                },
                retry: () => {},
            });
        } else {
            void applyTriggerInsertion(view, state, context);
        }
```

- [ ] **Step 8: 编译验证 + 手测**

Run: `npm run build`
Expected: 编译通过。逐个消除报错(常见:`buildSelectionRewritePreview` 若不再被引用可留着或删;`DiffModal` 残余 import;`relocateRange` 仍需保留)。

手测(Task 7 完成注册后整体测):见 Task 7。

- [ ] **Step 9: 提交**

```bash
git add src/ui/selection-menu.ts
git commit -m "feat(selection-ai): 对话框常驻动作条 + @补全 + 改写内联应用,移除 DiffModal 弹窗"
```

---

## Task 7: main.ts 注册 inlineDiffExtension

把内联 diff 扩展注册进编辑器扩展,并把回调接到 selection-menu 的桥接函数。

**Files:**
- Modify: `main.ts:1-20`(import)、`:199-204`(注册)

- [ ] **Step 1: import**

`main.ts` 顶部,`selection-menu` 的 import 旁补充:

```ts
import { inlineDiffExtension } from './src/ui/selection-ai/inline-diff';
import { handleInlineDiffAccept, handleInlineDiffReject, handleInlineDiffRetry } from './src/ui/selection-menu';
```

- [ ] **Step 2: 注册扩展**

`main.ts:199-204` 的 `registerEditorExtension` 数组里加入 `inlineDiffExtension`:

```ts
            this.registerEditorExtension([
                guardianGutterExtension(),
                ghostTextExtension(),
                selectionMenuExtension(this.app, this.modelService),
                inlineDiffExtension({
                    onAccept: handleInlineDiffAccept,
                    onReject: handleInlineDiffReject,
                    onRetry: handleInlineDiffRetry,
                }),
            ]);
```

- [ ] **Step 3: 编译验证**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 4: 整体手测**

在 Obsidian 里加载插件:
1. 选中一段中文 → 点 `AI` 按钮打开对话框 → 头部下方出现图标动作条。
2. 点「润色」→ 选区进入 loading → 出现绿底新文本 + ✓/✗/↻。点 ✓ → 选区被替换;点 ✗ → 预览消失原文不变;点 ↻ → 重新改写。
3. 点「翻译」→ 中文被译为英文(选英文段则译中)。
4. 点「解释」→ 对话框气泡里流式出现解释(可能带联网/知识库调用)。
5. 在输入框打 `@` → 文件补全弹出,Enter 选中回填。
6. 执行任一动作后对话框仍在,可继续点别的动作。
7. 切换明/暗主题,动作条、补全、内联 diff 视觉正常。

- [ ] **Step 5: 提交**

```bash
git add main.ts
git commit -m "feat(selection-ai): 注册内联 diff 扩展并接入对话框回调"
```

---

## Task 8: 样式重做

重写选区相关旧样式,新增动作条、补全下拉、内联 diff 的样式,全部用 Obsidian CSS 变量,自动适配明暗主题。

**Files:**
- Modify: `styles.css`(替换 `:785-939` 区块的过时视觉;追加新样式)

- [ ] **Step 1: 更新对话框与按钮的陈旧视觉**

`styles.css:790-805` 的 `.guardian-selection-btn` 阴影从 `rgba(0,0,0,0.3)` 改为变量;`:808-818` 的 `.guardian-chat-view` 阴影从 `rgba(0,0,0,0.5)` 改为 `var(--shadow-s)`,固定 `width:350px;height:400px` 改为自适应:

```css
.guardian-selection-btn {
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    border: none;
    padding: 6px 12px;
    border-radius: var(--radius-s);
    font-size: var(--font-ui-small);
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--shadow-s);
    transition: background-color 0.15s ease;
}

.guardian-chat-view {
    background-color: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-s);
    display: flex;
    flex-direction: column;
    width: min(420px, 90vw);
    max-height: min(480px, 70vh);
    overflow: hidden;
}
```

`.guardian-close-btn`(:832)去掉纯文字 `x` 依赖(Task 6 已改用 setIcon,若未改则此处保持),字号统一 `var(--font-ui-small)`。

- [ ] **Step 2: 追加动作条样式**

在 `styles.css` 末尾(或选区样式区块后)追加:

```css
/* ==================== Selection AI 动作条 ==================== */
.baizer-action-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-secondary-alt);
}
.baizer-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
}
.baizer-action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
}
.baizer-action-btn .svg-icon { width: 15px; height: 15px; }
.baizer-action-label { line-height: 1; }
```

- [ ] **Step 3: 追加补全下拉样式(选区对话框内)**

补全下拉复用 `.suggestion-item` 等现有类(主输入框已有样式),此处只需保证选区内的容器定位正确:

```css
/* ==================== Selection AI 补全下拉 ==================== */
.baizer-suggest-container {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 180px;
    overflow-y: auto;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-s);
    z-index: 210;
}
.guardian-input-wrapper { position: relative; }
```

- [ ] **Step 4: 追加内联 diff 样式**

```css
/* ==================== Selection AI 内联 diff ==================== */
.baizer-inline-diff-old {
    background: var(--background-modifier-error);
    text-decoration: line-through;
    opacity: 0.7;
}
.baizer-inline-diff {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 4px;
    padding: 1px 6px;
    border-radius: var(--radius-s);
    background: var(--background-modifier-success);
    vertical-align: baseline;
}
.baizer-inline-diff.is-error { background: var(--background-modifier-error); }
.baizer-inline-diff-new { color: var(--text-normal); white-space: pre-wrap; }
.baizer-inline-diff-hint { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.baizer-inline-diff-actions { display: inline-flex; gap: 2px; }
.baizer-inline-diff-btn {
    display: inline-flex;
    padding: 2px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-s);
}
.baizer-inline-diff-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.baizer-inline-diff-spinner {
    width: 12px; height: 12px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: baizer-spin 0.7s linear infinite;
}
@keyframes baizer-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 5: 编译验证 + 手测视觉**

Run: `npm run build`
Expected: 编译通过(CSS 不参与 TS 编译,但确保 bundle 无破坏)。

手测:在明/暗两种主题下打开对话框,确认动作条图标清晰、hover 有反馈、内联 diff 红绿对比明显、补全下拉浮在输入框上方且不溢出。

- [ ] **Step 6: 提交**

```bash
git add styles.css
git commit -m "style(selection-ai): 动作条/补全/内联diff 视觉,统一 Obsidian 变量"
```

---

## Task 9: 清理 DiffModal(若无其它引用)

**Files:**
- 可能删除:`src/ui/diff-modal.ts`
- Modify: `test/run-tests.ts`(若有 diff-modal 相关测试引用)

- [ ] **Step 1: 检索 DiffModal 全项目引用**

Run: `grep -rn "DiffModal\|diff-modal" src/ main.ts test/`
Expected: 仅剩(或应仅剩)历史引用。若除已改的 `selection-menu.ts` 外无其它 `import`,则可删除。

- [ ] **Step 2: 处理 buildLineDiff 的去留**

`diff-modal.ts` 导出的 `buildLineDiff` 可能被 `change-preview` 或测试使用。先确认:

Run: `grep -rn "buildLineDiff" src/ test/`
若 `buildLineDiff` 被其它模块使用 → **不要删文件**,只删 `DiffModal` 类;把 `buildLineDiff` 及其辅助函数保留(或移到独立 `src/ui/diff/line-diff.ts` 并更新引用)。若无其它使用 → 整文件删除。

- [ ] **Step 3: 执行删除或裁剪**

根据 Step 1/2 结果二选一:
- 无引用:`git rm src/ui/diff-modal.ts`
- 有 `buildLineDiff` 引用:保留文件但删除 `DiffModal` 类与 `DiffRow`/`renderPane` 等仅服务弹窗的部分,或按需迁移。

- [ ] **Step 4: 编译 + 全测**

Run: `npm run build && npm test`
Expected: 编译通过;所有测试(含新增两个)PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(selection-ai): 清理被内联 diff 取代的 DiffModal"
```

---

## 自检记录(写计划后已核对)

- **Spec 覆盖**:动作条(Task 6)、常驻对话框(Task 6)、改写内联应用(Task 4+6)、只读类流式(Task 6)、@ 补全复用+美化(Task 2/3/6/8)、中↔英翻译(Task 1)、视觉重做(Task 8)、DiffModal 退役(Task 9)—— spec 各节均有对应任务。
- **接口已核实**:`ModelService.generate` 签名与 `GenerationSource='selection-menu'`、`GenerationOptions.signal`(interfaces.ts:62)、`ChatController.processCommand`/`applyPreviewedChange`/`getMessages`、`relocateRange`、CM6 `Decoration`/`WidgetType`/`StateField` 写法(对照 ghost-text.ts)、`CommandDropdown`/`InputController` API、主输入框挂载点(shell-view.ts:290,366-471)、编辑器扩展注册点(main.ts:199)。
- **类型一致**:`InlineDiffState`、`SelectionAction`、`SuggestListOptions`、`RewriteResult` 在定义与调用处字段一致;inline-diff 回调名 `handleInlineDiffAccept/Reject/Retry` 在 selection-menu 导出与 main.ts 注册处一致。
- **测试策略**:纯函数(action-registry、suggest-list 编排)走 mini-harness 单测并注册进 run-tests.ts;CM/DOM/流式走编译 + 手测,符合本仓库既有模式(ghost-text/selection-menu 测试均只测纯函数)。

---

## 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-07-03-selection-ai-menu.md`. 两种执行方式:

1. **Subagent-Driven(推荐)** — 每个 task 派一个全新 subagent,任务间我来 review,迭代快。
2. **Inline Execution** — 在当前会话里按 executing-plans 分批执行,带检查点 review。

选哪种?
