# 选中文字 AI —— 动作优先的快捷菜单 + 内联预览(重做)

- 日期:2026-07-03
- 状态:设计已确认,待写实现计划
- 影响面:`src/ui/selection-menu.ts`、`src/ui/diff-modal.ts`、`styles.css`;新增 `src/ui/selection-ai/*`

## 1. 背景与问题

当前"选中文字 → AI"的实现(`src/ui/selection-menu.ts`)本质上不是一个润色功能,而是"一个绑在选区上的迷你聊天窗":选中 → 冒出纯文字 `AI` 按钮 → 点开一个固定 350×400 的聊天面板 → **手打**指令 → 流式回答进消息气泡 → 点 `Replace` → 打开全屏 `DiffModal`(行级 diff + 双栏)→ `Apply`。

两层根本问题:

1. **功能单一 —— 病根是"每次都要打字"**。没有任何预置动作,最高频操作(润色/校对/翻译/扩写/摘要)每次都要敲完整指令;一次性改写却用"聊天 + 气泡 + 状态栏"的重交互;应用要 4 步点击。
2. **显示丑 —— 形态错了,不只是 CSS**。350×400 固定浮层遮挡正文、可能溢出屏幕;纯文字 `x` 关闭按钮、`rgba(0,0,0,0.5)` 硬阴影、10–13px 小字、无图标;结果不在正文内联预览,靠脑补对比。

**优化本质**:从"必须打字的迷你聊天"变成"动作优先的快捷 AI 菜单 + 内联预览一键应用",聊天仅作为"自定义指令"的兜底。

## 2. 目标 / 非目标

**目标**
- 选中即浮出图标动作条,点一下即执行高频动作,零打字。
- 改写结果在正文内联 diff 预览,悬浮小工具条一键接受/拒绝/重试。
- 解释/搜索类结果在轻量只读浮层展示,可复制/插入,不替换原文。
- 视觉全面重做,统一走 Obsidian CSS 变量,自动适配明暗主题。

**非目标**
- 不改动 `@` 内联插入触发(光标处打 `@` 叫 AI 插入)这条线,保留现状。
- 不改 Guardian Ghost Text、ShellView 主聊天。
- 不做多语言翻译子菜单(本期仅中↔英自动互译)。

## 3. 交互决策(已与用户确认)

| 维度 | 决策 |
|------|------|
| 核心目标 | 动作化 + 视觉,一次彻底重做 |
| 预置动作 | 润色、校对、翻译、扩写、摘要(改写类)+ 解释/搜索(只读类) |
| "搜索"含义 | 介绍/解释选中文字,联网 + 本地库结合,只读展示可插入,不替换 |
| 预览与应用 | 内联 diff 高亮 + 悬浮小工具条(✓接受 / ✗拒绝 / ↻重试) |
| 菜单形态 | 选中即浮出图标动作条,二级子菜单按需 |
| 改写流式 | 非流式 + loading 态 |
| 翻译目标 | 中↔英自动互译(检测选区语言:中文译英,其余译中) |
| `@` 内联触发 | 保留不动 |

## 4. 架构

废弃"选区绑迷你聊天窗"模型,替换为解耦的三段式:

```
选中文字
  → SelectionActionBar(浮出图标动作条)      ← 替换 guardian-selection-btn / createChatPanel
      → 改写类动作 → RewriteService.run() → generate() 一次性改写 → InlineDiff(内联预览 + 工具条)
      → 只读类动作 → ExplainService.run() → chatStream()(web_search + query_knowledge) → InfoPopover
      → 自定义指令 → 按性质走上面对应通道(默认 rewrite)
```

`selection-menu.ts` 中的 `ChatController` 聊天路径、`createChatPanel`、350×400 面板、`DiffModal` 调用全部退役。`DiffModal` 文件本身若无其它引用则一并删除(实现期用引用检索确认)。

### LLM 通道选择(已核对 `ModelService` 接口)
- 改写类:无状态一次性改写 → `modelService.generate(prompt, systemPrompt, source, ...)`,纯文本进出,不需要聊天历史/气泡。
- 只读类:需要调工具 → `modelService.chatStream(...)`,允许 `web_search` + `query_knowledge`。

## 5. 组件划分(各司一职,可独立测试)

新增目录 `src/ui/selection-ai/`:

| 组件 | 职责 | 依赖 |
|------|------|------|
| `action-registry.ts` | 动作元数据:id / 图标名 / label / prompt 模板 / 类型(`rewrite`\|`readonly`) / 是否有二级选项。纯数据 + 纯函数。 | 无 |
| `selection-action-bar.ts` | CM tooltip 扩展:选中即浮出图标条 + 二级子菜单;派发动作。替换现有 `selectionMenuField`。 | action-registry |
| `rewrite-service.ts` | 改写类:用动作模板 + 选区文本拼 prompt → `generate()` → 返回新文本。 | ModelService |
| `explain-service.ts` | 只读类:拼"介绍/解释这段"prompt → `chatStream()`,聚合流式文本。 | ModelService |
| `inline-diff.ts` | CM StateField/StateEffect:选区红底删除线 + 下方 widget 绿底新文本 + 悬浮工具条(✓/✗/↻);状态迁移。 | — |
| `info-popover.ts` | 只读结果浮层:Markdown 渲染 + 复制 / 插入到光标后。宽度自适应、限高滚动。 | MarkdownRenderer |

复用现有:`relocateRange`(锚点重定位防审阅期错位)、`applyPreviewedChange`(undo 记录),从 `selection-menu.ts` 抽出或保留调用。

## 6. 数据流

**改写类**(润色/校对/翻译/扩写/摘要)
1. 点图标 → `rewrite-service` 用动作 prompt 模板 + 选区文本拼 prompt(翻译先检测语言决定方向)。
2. 选区进入 loading 态(工具条位置转圈)。
3. `generate()` 一次性返回新文本。
4. `inline-diff` 展示:原选区标红加删除线,紧邻下方 widget 绿底显示新文本,右侧浮 ✓接受 / ✗拒绝 / ↻重试。
5. ✓ → `relocateRange` 重定位选区 → `view.dispatch` 替换 + 记 undo;✗ → 清 decoration;↻ → 回到第 2 步。

**只读类**(解释/搜索)
1. 点图标 → `explain-service` 拼"介绍/解释这段"prompt,`chatStream()` 允许 `web_search` + `query_knowledge`。
2. 结果流式聚合进 `info-popover`(轻量浮层,非固定 350×400)。
3. 底部按钮:复制 / 插入到光标后。不替换原文。

## 7. 动作清单(action-registry)

改写类:
- 润色 `improve`(图标 `wand`)
- 校对 `fix`(图标 `check`)
- 翻译 `translate`(图标 `languages`,中↔英自动互译)
- 扩写 `expand`(图标 `expand`)
- 摘要 `summarize`(图标 `text`)

只读类:
- 解释/搜索 `explain`(图标 `search`,联网 + 本地库结合)

末位:
- `✎ 自定义…`(图标 `pencil`)→ 展开单行输入,回车执行;默认走 rewrite 通道。

## 8. 视觉重做(解决"丑")

- 图标动作条:圆角胶囊容器,`var(--radius-m)` + `var(--shadow-s)` 软阴影;图标用 Obsidian 内置 `setIcon()`;hover 显 tooltip label。
- 内联新文本 widget:绿底、`var(--text-accent)` 边框强调;删除态选区红底 + 删除线。
- 移除纯文字 `x` 关闭、硬 `rgba(0,0,0,0.5)` 阴影、10px 小字。
- 全部用 `var(--)` Obsidian 变量,自动适配明暗主题。
- `info-popover` 宽度自适应(max-width 约束)、限高滚动,不再固定 350×400。

## 9. 错误处理

- `generate()` 失败/超时 → 工具条位置显示错误文案 + ↻重试,不污染文档。
- 空选区 / 纯空白 → 动作条不浮出。
- 应用前 `relocateRange` 失败(审阅期文档被改动)→ 复用现有中止逻辑,Notice 提示重选,绝不盲写。
- API Key 未配置 → 浮层/工具条内提示去设置,不静默失败。
- `chatStream` 被后续选区变化打断 → AbortController 取消,浮层关闭。

## 10. 测试

- `action-registry`:动作元数据完整性、prompt 模板渲染、翻译语言方向检测(纯函数,单测)。
- `inline-diff`:StateField 在 loading / 预览 / 接受 / 拒绝 / 重试下的状态迁移。
- `rewrite-service`:mock ModelService,验证 prompt 拼装与结果透传。
- `relocateRange`:已有测试,补"审阅期文档变动"case。
- 手测:明暗主题下动作条与浮层视觉;长选区内联 diff 布局;溢出屏幕边界。

## 11. 迁移与清理

- 删除 `selection-menu.ts` 中的聊天面板路径(`createChatPanel`、`createSelectionTooltip` 的 chat 分支、`ChatController` 引用)。
- 检索 `DiffModal` 全项目引用;若仅被选区菜单使用,删除 `diff-modal.ts`;否则保留。
- `styles.css` 中 `.guardian-chat-*` / `.guardian-selection-*` / `.guardian-message-*` 相关规则清理或替换。
- `main.ts` 中 `selectionMenuExtension` 注册点替换为新的 `selectionActionBarExtension`。
```
