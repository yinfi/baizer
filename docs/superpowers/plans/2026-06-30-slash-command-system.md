# 斜杠命令系统瘦身与渲染修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 瘦身斜杠命令、让命令输出走 markdown 渲染、清理 GBK 乱码、修复 `/clear` 清屏失效。

**Architecture:** 四刀独立改动——(1) 纯删除冗余命令；(2) `ChatMessage.metadata` 加 `richText` 标记，渲染层 system 分支据此走 markdown；(3) 整文修复 `chat-controller.ts` 的 mojibake 字符串；(4) 新增 `onClear` 回调让 ChatController 单向通知 view 层复活 `clearChat()`。

**Tech Stack:** TypeScript, esbuild, 自研轻量测试框架（`test/*.test.ts` + `tsx`）。

---

## 测试与构建命令速查

- 跑单个测试文件：`npx tsx --tsconfig tsconfig.test.json test/<name>.test.ts`
- 跑全部测试：`npm test`
- 生产构建：`npm run build`

测试框架是自研的：每个 `test/*.test.ts` 文件自带 `expect`/`test` 实现并在末尾调用 `runTests()`，失败时 `process.exit(1)`。无 jest/vitest。

---

## 现状校准（spec 与代码的两处偏差，已核实）

1. **`/save` 的 switch case 早已删除**：`test/chat-controller.test.ts:119` 已断言 `/save` 落入 `Unknown command: /save`。残留的是死函数 `handleSave`（`chat-controller.ts:1045`）+ 两处 help 文本提及。本计划只删这些，不碰 switch。
2. **`handleForget` 不可删函数本体**：它被 `/memory forget` 复用（`chat-controller.ts:812` 调用 `this.handleForget(rest.join(' '))`）。`/forget` 只是带 `legacyCommand` 参数的别名入口。本计划只删 switch 的 `/forget` case + 函数内的 `legacyCommand`/`compatibilityNote` 兼容分支，保留核心遗忘逻辑。

---

## 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/ui/types.ts` | ChatMessage 类型 | 加 `metadata.richText?: boolean` |
| `src/ui/chat-controller.ts` | 命令分发 + 输出 | 删冗余命令、给命令输出打 richText、新增 onClear、修乱码 |
| `src/ui/renderers/message-renderer.ts` | 消息渲染 | system 分支加 richText → markdown 判定 |
| `src/ui/shell-view.ts` | view 层 | 删 `/edit` 建议项、接 onClear→clearChat |
| `test/chat-controller.test.ts` | controller 测试 | 加 /edit 移除、onClear、richText 断言 |
| `test/message-renderer.test.ts` | 渲染测试 | 加 richText system 渲染断言 |

---
## Task 1: 瘦身 — 删除 `/edit`、清理 `/save` 与 `/forget` 残留

**Files:**
- Modify: `src/ui/chat-controller.ts`（switch case、死函数、help 文本）
- Modify: `src/ui/shell-view.ts:95-107`（删 `/edit` 建议项）
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: 写失败测试 — `/edit` 被移除后落入 Unknown command**

在 `test/chat-controller.test.ts` 的 `runTests()` 内、紧跟现有 `/save` 移除测试（约第 149 行后）追加：

```typescript
  await test('processCommand does not fall back to a removed local /edit handler', async () => {
    const messages: any[] = [];
    const apiCalls = { chat: [] as any[] };

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => { apiCalls.chat.push(args); return 'fallback'; },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/edit translate to English');

    expect(apiCalls.chat.length).toBe(0);
    expect(messages[messages.length - 1].content).toBe('Unknown command: /edit');

    controller.cleanup();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: FAIL — `/edit` 当前仍被 `handleEdit` 处理，最后一条消息不是 `Unknown command: /edit`。

- [ ] **Step 3: 删除 `/edit` 的 switch case**

在 `src/ui/chat-controller.ts` 的 `handleSlashCommand` switch 中删除这三行（约 333-335 行）：

```typescript
            case '/edit':
                await this.handleEdit(argStr);
                break;
```

- [ ] **Step 4: 删除死函数 `handleEdit` 和 `handleSave`**

删除 `src/ui/chat-controller.ts` 的整个 `private async handleEdit(instruction: string) { ... }`（约 1014-1043 行）和 `private async handleSave(url: string) { ... }`（约 1045-1060 行）。这两个函数删除后无任何调用方（`/save` switch case 早已移除，`/edit` 刚删）。

- [ ] **Step 5: 删 `showLegacyHelp` 里的 `/edit` 和 `/save` 行**

在 `src/ui/chat-controller.ts:1096` 的 `showLegacyHelp()` 表格中删除这两行：

```
| \`/edit <instruction>\` | AI edit the selected text |
| \`/save <url>\` | Save a webpage or video into the vault |
```

- [ ] **Step 6: 删 `/edit` 下拉建议项**

在 `src/ui/shell-view.ts` 的 `localCommandSuggestions`（约第 100 行）删除这一行：

```typescript
        { label: '/edit', desc: 'AI edit selected text' },
```

（`/save`、`/profile`、`/forget` 本就不在该数组中，无需处理。）

- [ ] **Step 7: 删 `/forget` switch case，并清理 `handleForget` 的兼容分支**

在 `handleSlashCommand` switch 中删除 `/forget` case（约 327-329 行）：

```typescript
            case '/forget':
                await this.handleForget(argStr, '/forget');
                break;
```

然后简化 `handleForget` 签名与兼容逻辑（约 926-934 行），改为：

```typescript
    private async handleForget(field: string) {
        const f = field.trim().toLowerCase();
        if (!f) {
            this.addMessage('system', 'Usage: `/memory forget <field>` or `/memory forget all`\n\nForgettable fields: name, profession, expertise, preferences, workflows, projects, goals, all');
            return;
        }
```

并删除函数体内所有 `compatibilityNote` 变量的引用——把 `` `${compatibilityNote}...` `` 改为不带前缀的版本。具体在 `handleForget` 内搜索 `compatibilityNote` 共 5 处（含定义），定义行删除，其余 4 处去掉 `${compatibilityNote}` 前缀。`handleMemory:812` 的调用 `await this.handleForget(rest.join(' '))` 已是单参数，无需改。

- [ ] **Step 8: 删 `/profile` switch case，并清理 `handleMemory` 的兼容分支**

先删 `test/chat-controller.test.ts` 中针对 `/profile` 的旧测试（约第 151-176 行 `'/profile renders hindsight memory profile text when available'` 整个 `await test(...)` 块）——`/profile` 被移除后该测试不再适用。如需保留覆盖可改用 `/memory overview`，但本计划直接删除该测试。

删除 `handleSlashCommand` switch 的 `/profile` case（约 306-308 行）：

```typescript
            case '/profile':
                await this.handleMemory(argStr || 'overview', '/profile');
                break;
```

简化 `handleMemory` 签名（约第 803 行）去掉 `legacyCommand` 参数：

```typescript
    private async handleMemory(input: string) {
        const trimmed = input.trim();
        const [rawMode = 'overview', ...rest] = trimmed ? trimmed.split(/\s+/) : ['overview'];
        const mode = rawMode.toLowerCase();
        const note = '';
```

删除 `handleMemory` 内的 `/profile` 兼容分支（约 836-839 行）：

```typescript
        if (legacyCommand === '/profile') {
            await this.renderMemoryView({ mode: 'overview', limit: 10 }, note);
            return;
        }
```

注意：`note` 变量原本用于拼接 `/profile`/`/memory` 兼容提示，现恒为 `''`。可保留 `const note = ''` 让 `renderMemoryView(..., note)` 调用点不变（最小改动），或一并清理 `note` 参数。本计划保留 `const note = ''` 以缩小改动面。`/profile` switch case 删除后，`handleMemory` 仅由 `/memory` case（约 303-305 行）单参数调用，类型收窄无副作用。

- [ ] **Step 9: 跑测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: PASS — 包含新增的 `/edit` 移除测试和现有的 `/save` 移除测试全绿，`/profile` 旧测试已删除。

- [ ] **Step 10: 构建确认无类型错误**

Run: `npm run build`
Expected: 构建成功，无 `handleEdit`/`handleSave` 未使用或 `compatibilityNote`/`legacyCommand` 未定义错误。

- [ ] **Step 11: Commit**

```bash
git add src/ui/chat-controller.ts src/ui/shell-view.ts test/chat-controller.test.ts
git commit -m "refactor: 瘦身斜杠命令，删除 /edit 并清理 /save /forget 残留"
```

---

## Task 2: 数据层 — `ChatMessage.metadata` 增加 `richText` 标记

**Files:**
- Modify: `src/ui/types.ts:13-19`

- [ ] **Step 1: 给 metadata 加 richText 字段**

在 `src/ui/types.ts` 的 `ChatMessage.metadata` 内（第 18 行 `workspaceEdit` 之后）追加：

```typescript
    metadata?: {
        providerId?: string;
        modelId?: string;
        durationMs?: number;
        interrupted?: boolean;
        workspaceEdit?: WorkspaceEditSummary;
        /** 命令输出等需要走 markdown 渲染的 system 消息标记。 */
        richText?: boolean;
    };
```

- [ ] **Step 2: 构建确认类型通过**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 3: Commit**

```bash
git add src/ui/types.ts
git commit -m "feat: ChatMessage.metadata 增加 richText 标记"
```

---
## Task 3: 渲染层 — system 消息支持 richText markdown 渲染

**Files:**
- Modify: `src/ui/renderers/message-renderer.ts:91-100`
- Test: `test/message-renderer.test.ts`

- [ ] **Step 1: 写失败测试 — richText system 消息走 markdown 且无反馈工具栏**

在 `test/message-renderer.test.ts` 的 `runTests()` 内追加（紧跟现有 system 渲染测试附近，约第 245 行后）：

```typescript
  await test('renders richText system messages through markdown without feedback toolbar', async () => {
    const container = new FakeElement();
    const rendered: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app, markdown, el) => {
        rendered.push(markdown);
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackUp: async () => { },
      onFeedbackDown: async () => { },
    } as any);

    await renderer.renderMessage(container as any, {
      id: 'sys-rich',
      role: 'system',
      content: '## Available Tools\n\n- **read_note**: read a note',
      timestamp: 7,
      metadata: { richText: true },
    });

    // 走了 markdown 渲染（拿到原始 markdown），而非纯文本贴 [System]
    expect(rendered).toEqual(['## Available Tools\n\n- **read_note**: read a note']);
    expect(!!container.querySelector('.rendered-markdown')).toBe(true);
    expect(container.children[0].textContent).notToContain('[System]');
    // 命令输出不挂点赞/点踩/复制工具栏（那是 AI 回答专属）
    expect(!!container.querySelector('.shell-message-actions')).toBe(false);
    expect(!!container.querySelector('.shell-thumbs-up')).toBe(false);
  });
```

注意：`message-renderer.test.ts` 现有的 `expect` 没有 `notToContain`。在该文件顶部 `expect` 工厂（第 1-21 行）的 `toContain` 之后补一个：

```typescript
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected "${actual}" not to contain "${expected}"`);
      }
    },
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts`
Expected: FAIL — 当前 system 分支无论如何都走 `setText('[System] ...')`，`rendered` 数组为空、找不到 `.rendered-markdown`。

- [ ] **Step 3: 在 system 分支最前面加 richText 判定**

在 `src/ui/renderers/message-renderer.ts` 的 `renderMessage` 内，把 system 分支（当前第 91-100 行 `} else {` 块）改为：

```typescript
      } else if (message.metadata?.richText) {
        // 命令输出等富文本 system 消息：走 markdown 渲染，但不挂 AI 回答专属的反馈工具栏。
        await this.renderAiContent(entry, message.content);
      } else {
        const status = this.parseSystemStatus(message.content);
        if (status) {
          this.renderSystemStatus(entry, status);
        } else if (this.isCancelledSystemMessage(message.content)) {
          (entry as any).addClass?.('shell-system-cancelled') ?? entry.classList.add('shell-system-cancelled');
          this.setText(entry, `[System] ${message.content}`);
        } else {
          this.setText(entry, `[System] ${message.content}`);
        }
      }
```

注意：`renderAiContent` 不调用 `addActionToolbar`（对比 `message.role === 'ai'` 分支第 86-88 行有 `addActionToolbar`，这里故意不加），因此不会出现复制/点赞/点踩按钮。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts`
Expected: PASS — 新增 richText 测试 + 现有 4 个 system/ai 渲染测试全绿。

- [ ] **Step 5: Commit**

```bash
git add src/ui/renderers/message-renderer.ts test/message-renderer.test.ts
git commit -m "feat: system 消息支持 richText markdown 渲染"
```

---

## Task 4: 命令输出打 richText 标记

**Files:**
- Modify: `src/ui/chat-controller.ts`（`addMessage` 签名 + 命令输出调用点）
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: 写失败测试 — `/tools` 输出带 richText 标记**

在 `test/chat-controller.test.ts` 的 `runTests()` 内追加：

```typescript
  await test('/tools output is flagged richText for markdown rendering', async () => {
    const messages: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => null,
        updateProfile: async () => undefined,
        clearSession: async () => undefined,
        getAvailableTools: () => [
          { name: 'read_note', description: 'Read a note' },
        ],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/tools');

    const last = messages[messages.length - 1];
    expect(last.content).toContain('read_note');
    expect(last.metadata?.richText).toBe(true);

    controller.cleanup();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: FAIL — `last.metadata?.richText` 当前为 `undefined`，不等于 `true`。

- [ ] **Step 3: 扩展 `addMessage` 接受 metadata**

把 `src/ui/chat-controller.ts:665` 的 `addMessage` 改为：

```typescript
    private addMessage(
        role: 'user' | 'ai' | 'system',
        content: string,
        approval?: ApprovalRequest,
        metadata?: ChatMessage['metadata'],
    ) {
        const msg: ChatMessage = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            role,
            content,
            timestamp: Date.now(),
            approval,
            metadata,
        };
        this.messages.push(msg);
        if (this.onMessageAdded) {
            this.onMessageAdded(msg);
        }
    }
```

- [ ] **Step 4: 给命令输出调用点传 richText**

给以下 system 输出调用点追加 `, undefined, { richText: true }` 参数（这些是命令的正常 markdown 输出，非错误/状态消息）：

1. `/tools` 输出（约第 312 行）：
```typescript
                this.addMessage('system', `## Available Tools\n\n${toolsList}`, undefined, { richText: true });
```

2. `showHelp()` 末尾（约第 1093 行 `this.addMessage('system', help);`）：
```typescript
        this.addMessage('system', help, undefined, { richText: true });
```

3. `renderMemoryView` 的两处正常输出（约第 853、857 行）：
```typescript
        this.addMessage('system', `${prefix}No memory data available.`, undefined, { richText: true });
```
```typescript
        this.addMessage('system', `${prefix}${this.formatMemoryView(view, request)}`, undefined, { richText: true });
```

4. `formatLegacyProfile` 输出（约第 847 行）：
```typescript
            this.addMessage('system', this.formatLegacyProfile(prefix), undefined, { richText: true });
```

不改的：Error/Usage 提示、`Cancelled:`、`Updated:`、`Session cleared.` 等状态/错误消息保持纯文本（不传 richText）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: PASS。

- [ ] **Step 6: 构建确认**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7: Commit**

```bash
git add src/ui/chat-controller.ts test/chat-controller.test.ts
git commit -m "feat: 命令输出打 richText 标记走 markdown 渲染"
```

---
## Task 5: 修 `/clear` 清屏 — 新增 onClear 回调，复活 clearChat

**Files:**
- Modify: `src/ui/chat-controller.ts`（`ChatControllerOptions`、字段、构造函数、`clearHistory`）
- Modify: `src/ui/shell-view.ts:1469-1493`（`clearChat` 改 public）、`:1579-1588`（接 onClear）
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: 写失败测试 — `/clear` 触发 onClear 且不追加 "Session cleared." 消息**

在 `test/chat-controller.test.ts` 的 `runTests()` 内追加：

```typescript
  await test('/clear clears LLM session, empties messages, and fires onClear without appending a system notice', async () => {
    const messages: any[] = [];
    let cleared = 0;
    let onClearCalls = 0;

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => null,
        updateProfile: async () => undefined,
        getAvailableTools: () => [],
        clearSession: async () => { cleared += 1; },
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onClear: () => { onClearCalls += 1; },
    });

    await controller.processCommand('/clear');

    expect(cleared).toBe(1);
    expect(onClearCalls).toBe(1);
    expect(controller.getMessages().length).toBe(0);
    // 不再追加 "Session cleared." —— 提示由 view 层 clearChat 的欢迎语负责
    const hasNotice = messages.some((m) => m.content === 'Session cleared.');
    expect(hasNotice).toBe(false);

    controller.cleanup();
  });
```

注意：`processCommand('/clear')` 会先 `addMessage('user', '/clear')`（switch 前的 `this.addMessage('user', query)` 在 `handleSlashCommand:282`），所以 `messages` 里会有 user 消息；但 `controller.getMessages()` 在 `clearHistory` 执行 `this.messages = []` 后为空。`onMessageAdded` 的 `messages` 数组记录的是历史推送，断言用 `some` 检查 "Session cleared." 不存在即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: FAIL — `onClear` 选项尚不存在（`onClearCalls` 为 0），且当前 `clearHistory` 会追加 "Session cleared."（`hasNotice` 为 true）。

- [ ] **Step 3: `ChatControllerOptions` 增加 onClear**

在 `src/ui/chat-controller.ts:19-28` 的 `ChatControllerOptions` 内追加：

```typescript
    onWorkspaceEditUndoFailed?: (message: string) => void;
    /** /clear 时通知 view 层清屏（清 DOM + tab.state + 持久会话 + 重加欢迎语）。 */
    onClear?: () => void;
```

- [ ] **Step 4: 增加字段并在构造函数赋值**

在字段声明区（约第 40 行 `onWorkspaceEditUndoFailed` 之后）加：

```typescript
    private onWorkspaceEditUndoFailed?: (message: string) => void;
    private onClear?: () => void;
```

在构造函数（约第 56 行 `this.onWorkspaceEditUndoFailed = ...` 之后）加：

```typescript
        this.onWorkspaceEditUndoFailed = options.onWorkspaceEditUndoFailed;
        this.onClear = options.onClear;
```

- [ ] **Step 5: 改写 `clearHistory`**

把 `src/ui/chat-controller.ts:100-104` 的 `clearHistory` 改为：

```typescript
    public clearHistory() {
        this.messages = [];
        this.api.clearSession();
        // 清屏交给 view 层（清 DOM + tab.state + 持久会话 + 重加欢迎语）。
        // 若宿主未接 onClear，回退到追加一条提示，避免完全无反馈。
        if (this.onClear) {
            this.onClear();
        } else {
            this.addMessage('system', 'Session cleared.');
        }
    }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: PASS。

- [ ] **Step 7: 把 `clearChat` 改为 public 并接 onClear**

在 `src/ui/shell-view.ts:1469` 把 `private clearChat()` 改为 `public clearChat()`。

然后在创建 ChatController 处（`src/ui/shell-view.ts:1579-1588`），给 options 追加 onClear。注意该处在 `createTabSession(id: ...)` 类方法内，`this` 指向 view，`clearChat` 操作的是当前 active tab，所以仅当该 tab 为 active 时清屏才正确——直接调用 `this.clearChat()`（它内部已用 `getActiveTab()`）：

```typescript
            onWorkspaceEditUndoFailed: (message) => this.handleWorkspaceEditUndoFailed(id, message),
            onClear: () => this.clearChat(),
```

- [ ] **Step 8: 构建确认**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 9: 手动验证 `/clear`（开发模式）**

Run: `npm run dev`（后台），在 Obsidian 中重载插件，打开 Baizer，发几条消息后输入 `/clear`。
Expected: 屏幕旧对话清空，仅剩 "Chat cleared." 欢迎语；再问 AI 确认它不记得之前的对话（上下文已清）。

- [ ] **Step 10: Commit**

```bash
git add src/ui/chat-controller.ts src/ui/shell-view.ts test/chat-controller.test.ts
git commit -m "fix: /clear 清屏失效，新增 onClear 回调复活 clearChat"
```

---

## Task 6: 修复 chat-controller.ts 的 GBK 乱码

**Files:**
- Modify: `src/ui/chat-controller.ts`（全文 mojibake 字符串字面量）

- [ ] **Step 1: 定位所有 mojibake**

Run: `npx tsx --tsconfig tsconfig.test.json -e "const s=require('fs').readFileSync('src/ui/chat-controller.ts','utf8');s.split('\n').forEach((l,i)=>{if(/[鐢鍒鏂娓闃鈥彁淇瀹缂愮]/.test(l))console.log((i+1)+': '+l.trim())})"`

或用编辑器搜索常见 mojibake 起始字符（`鐢` `鍒` `鏂` `娓` `闃` `鈥` `彁` `淇` `瀹` `缂` `愮`）。已知至少包括：

| 行（约） | 乱码 | 正确中文 |
|------|------|---------|
| 315 | `鍚庡彴鎵ц锛屼笉闃诲涓绘祦绋?` | `后台执行，不阻塞主流程` |
| 991 | `鐢ㄦ硶: ... 鎴?...` | `用法: \`/new <title>\` 或 \`/new <title> <content>\`` |
| 1002 | `鏂囦欢宸插瓨鍦? ${path}` | `文件已存在: ${path}` |
| 1008 | `宸插垱寤哄苟鎵撳紑: [[${path}]]` | `已创建并打开: [[${path}]]` |
| 1010 | `鍒涘缓澶辫触: ${e.message}` | `创建失败: ${e.message}` |
| 1132 | `鏃犲弬鏁帮細缂栬瘧褰撳墠绗旇 + 鎵€鏈?pending` | `无参数：编译当前笔记 + 所有 pending` |
| 1135 | `缂栬瘧: ${activeFile.path}...` | `编译: ${activeFile.path}...` |
| 1137 | `瀹屾垚: 娉ㄥ唽 ...锛屾垚鍔?...锛屽け璐?...` | `完成: 注册 ${r.registered}，成功 ${r.success}，失败 ${r.failed}` |

行号会因前序 Task 的删改而偏移；以字符特征搜索为准，不要硬套行号。

- [ ] **Step 2: 逐处替换为正确中文**

用 Edit 工具逐条把 mojibake 字符串替换为上表对应中文（含 Step 1 命令额外扫出的任何遗漏）。注意保留字符串内的 `${...}` 模板变量和 markdown 标记不变，只改可读文字。`handleEdit`/`handleSave` 已在 Task 1 删除，其内部乱码无需处理。

- [ ] **Step 3: 复扫确认无残留**

Run: `npx tsx --tsconfig tsconfig.test.json -e "const s=require('fs').readFileSync('src/ui/chat-controller.ts','utf8');const m=s.match(/[鐢鍒鏂娓闃鈥彁淇瀹缂愮閿熷彨鎴]/g);console.log(m?('残留:'+m.length):'clean')"`
Expected: 输出 `clean`。

- [ ] **Step 4: 构建确认**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat-controller.ts
git commit -m "fix: 修复 chat-controller.ts 的 GBK 乱码字符串"
```

---

## Task 7: 全量回归

- [ ] **Step 1: 跑全部测试**

Run: `npm test`
Expected: 所有测试文件 PASS，末尾打印 `Executed N test files successfully.`

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: 构建成功，生成 `main.js`。

- [ ] **Step 3: 最终 commit（若有未提交的回归修复）**

```bash
git add -A
git commit -m "test: 斜杠命令系统瘦身与渲染修复全量回归"
```



