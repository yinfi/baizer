# 选中文字 AI —— 快捷动作 + 常驻对话框 + 内联应用(重做)

- 日期:2026-07-03
- 状态:设计已确认(第二版,含用户反馈修订),待写实现计划
- 影响面:`src/ui/selection-menu.ts`、`styles.css`;新增 `src/ui/selection-ai/*`;复用/小幅重构 `src/ui/components/command-dropdown.ts`、`src/ui/controllers/input-controller.ts`

## 1. 背景与问题

当前"选中文字 → AI"(`src/ui/selection-menu.ts`)本质是"绑在选区上的迷你聊天窗":选中 → 纯文字 `AI` 按钮 → 固定 350×400 聊天面板 → **手打**指令 → 气泡回答 → `Replace` → 全屏 `DiffModal` → `Apply`。

两层根本问题:

1. **功能单一 —— 病根是"每次都要打字"**。没有预置动作,润色/校对/翻译/扩写/摘要每次都要敲完整指令。
2. **显示丑 —— CSS 陈旧**。纯文字 `x` 关闭、`rgba(0,0,0,0.5)` 硬阴影、10–13px 小字、无图标;对话框里的 `@` 是裸文本,无补全、无 Enter 选中(而主输入框的 `@` 早已图标化 + Enter 选中)。

**优化本质**:保留对话框作为常驻主体,在它之上叠一层"预置问题的快捷动作"降低打字摩擦;改写结果能一键内联应用到正文;并把主输入框成熟的 `@` 补全复用进对话框、统一美化。

## 2. 目标 / 非目标

**目标**
- 选中即浮出图标快捷动作条;点动作 = 把预置问题注入对话框并执行。
- **对话框常驻**:动作执行完对话框不关闭,可继续追问、换动作、多轮对话。
- 改写类结果在对话框回答的同时,提供"应用到正文" → 走内联 diff 预览(✓接受 / ✗拒绝 / ↻重试)。
- 只读类(解释/搜索)结果只在对话框展示,可复制 / 插入,不替换原文。
- 对话框内 `@` 复用主输入框补全(图标 + Enter 选中),并美化补全下拉列表。
- 视觉全面重做,统一走 Obsidian CSS 变量,自动适配明暗主题。

**非目标**
- 不改动 `@` 内联插入触发(光标处打 `@` 叫 AI 插入)那条线。
- 不改主输入框(ShellView)的 `@` 交互逻辑(仅把其补全能力抽出共用;若样式统一顺带受益)。
- 不改 Guardian Ghost Text。
- 翻译本期仅中↔英自动互译,不做多语言选择。

## 3. 交互决策(已与用户确认)

| 维度 | 决策 |
|------|------|
| 对话框 | **保留、常驻**;快捷动作是"预置问题",执行完对话框仍在,可继续其他动作 |
| 预置动作 | 润色、校对、翻译、扩写、摘要(改写类)+ 解释/搜索(只读类)+ 自定义 |
| 改写结果 | 对话框内回答 + 提供"应用到正文"走内联 diff(✓/✗/↻) |
| "搜索"含义 | 介绍/解释选中文字,联网 + 本地库结合,只读可插入,不替换 |
| 改写流式 | 非流式 + loading 态 |
| 翻译目标 | 中↔英自动互译(中文译英,其余译中) |
| `@` 美化 | 复用主输入框补全(图标 + Enter 选中);美化补全下拉列表(选中高亮/圆角/软阴影/暗亮适配) |
| `@` 作用处 | 仅选区对话框的 `@`;主输入框逻辑不动 |
| `@` 补全复用 | 抽公共补全组件,选区对话框与主输入框共用一套 |
| `@` 内联触发 | 保留不动 |

## 4. 架构

保留对话框,在其上叠快捷动作层,并挂一条内联应用旁路:

```
选中文字
  → SelectionActionBar(浮出图标快捷动作条)         ← 替换裸文字 AI 按钮
      → 点动作 = 预置问题注入 SelectionChatPanel 并执行(对话框常驻)
  → SelectionChatPanel(常驻对话框,重做视觉 + @ 补全)
      ├ 改写类动作/指令 → RewriteService → generate() → 气泡回答
      │     └ 气泡下「应用到正文」→ InlineDiff(内联预览 + ✓/✗/↻)
      ├ 只读类动作/指令 → ExplainService → chatStream()(web_search+query_knowledge) → 气泡回答(复制/插入)
      └ 自定义输入 + @ 补全(复用主输入框那套)
```

对话框主体保留(`createChatPanel` 演进为 `SelectionChatPanel`),不再废弃;`DiffModal` 全屏弹窗被内联 diff 取代,退役。

### LLM 通道(已核对 `ModelService`)
- 改写类:`modelService.generate(prompt, systemPrompt, source, ...)`,纯文本一次性改写。
- 只读类:`modelService.chatStream(...)`,允许 `web_search` + `query_knowledge`。
- 对话框的多轮追问沿用现有 `ChatController.processCommand`(已支持流式与 priorMessages)。

## 5. 组件划分(各司一职,可独立测试)

新增目录 `src/ui/selection-ai/`:

| 组件 | 职责 | 依赖 |
|------|------|------|
| `action-registry.ts` | 动作元数据:id / 图标名 / label / prompt 模板 / 类型(`rewrite`\|`readonly`) / 是否有二级选项。纯数据 + 纯函数。 | 无 |
| `selection-action-bar.ts` | CM tooltip:选中即浮出图标条;派发动作 → 打开/复用对话框并注入预置问题。 | action-registry |
| `selection-chat-panel.ts` | 常驻对话框(由 `createChatPanel` 演进):消息列表、输入区、动作条常驻头部、`@` 补全挂载、改写气泡的「应用到正文」入口。 | ChatController、SuggestList、action-registry |
| `rewrite-service.ts` | 改写类:动作模板 + 选区文本拼 prompt → `generate()` → 新文本(翻译先检测语言方向)。 | ModelService |
| `inline-diff.ts` | CM StateField/StateEffect:选区红底删除线 + 下方绿底新文本 widget + 悬浮工具条(✓/✗/↻);状态迁移。 | relocateRange |

复用/重构现有:
- `command-dropdown.ts`(`CommandDropdown`)+ `input-controller.ts`(`InputController`、`detectSuggestionTrigger`、`selectSuggestion`)已是 UI 无关的补全三件套;抽成可复用的 `SuggestList` 挂载器,选区对话框 new 一份、喂同样的文件建议数据。主输入框改为也用这个挂载器(等价替换,行为不变)。
- `relocateRange`(锚点重定位防审阅期错位)、`applyPreviewedChange`(undo 记录):从 `selection-menu.ts` 抽出到共用位置。
- 只读类不新建 service:直接走 `ChatController.processCommand`(与追问同通道),仅由 action-registry 提供预置 prompt。

## 6. 数据流

**快捷动作(改写类:润色/校对/翻译/扩写/摘要)**
1. 点图标 → action-registry 取该动作 prompt 模板 + 选区文本(翻译先检测中↔英方向)。
2. 若对话框未开则打开;把预置问题作为一条 user 消息注入对话框,进入 loading。
3. 走 `RewriteService.generate()`,回答进 AI 气泡。
4. 该气泡下出现「应用到正文」按钮 → 点击进入 `InlineDiff`:原选区标红删除线,下方绿底 widget 显示新文本,悬浮 ✓/✗/↻。
5. ✓ → `relocateRange` 重定位 → `dispatch` 替换 + 记 undo;✗ → 清 decoration;↻ → 重跑第 3 步(结果更新到同一气泡)。
6. **对话框保持打开**,用户可继续追问或点别的动作。

**快捷动作(只读类:解释/搜索)**
1. 点图标 → 注入"介绍/解释这段"预置问题 → `chatStream()`(允许 web_search + query_knowledge)。
2. 流式回答进 AI 气泡;气泡下提供 复制 / 插入到光标后。不替换原文。

**自定义输入 + `@`**
1. 用户在对话框输入区打字;打 `@` → `detectSuggestionTrigger` 命中 file → 弹补全下拉(图标 + Enter 选中)。
2. Enter/点击选中 → `selectSuggestion` 回填文本 + 生成 contextItem;回车发送走对应通道。

## 7. 动作清单(action-registry)

改写类(结果可「应用到正文」):
- 润色 `improve`(图标 `wand`)
- 校对 `fix`(图标 `check`)
- 翻译 `translate`(图标 `languages`,中↔英自动互译)
- 扩写 `expand`(图标 `expand`)
- 摘要 `summarize`(图标 `text`)

只读类(展示,可复制/插入):
- 解释/搜索 `explain`(图标 `search`,联网 + 本地库结合)

自定义:
- `✎ 自定义…`(图标 `pencil`)→ 聚焦对话框输入区自由提问;默认按 rewrite 处理,可应用到正文。

## 8. 视觉重做(解决"丑")

- 快捷动作条:圆角胶囊容器,`var(--radius-m)` + `var(--shadow-s)`;图标用 `setIcon()`;hover 显 tooltip label。
- 对话框:去掉纯文字 `x`(换 `setIcon('x')`)、硬 `rgba(0,0,0,0.5)` 阴影、10px 小字;尺寸从固定 350×400 改为 min/max 约束 + 自适应;全部用 `var(--)` 变量。
- `@` 补全下拉:图标 + 选中高亮 `is-selected` + 圆角 + 软阴影 + 暗亮适配(与主输入框统一样式)。
- 改写气泡的「应用到正文」按钮 + 内联 diff:绿底新文本 widget、红底删除线选区、`var(--text-accent)` 强调。

## 9. 错误处理

- `generate()`/`chatStream()` 失败/超时 → 气泡内显示错误 + 重试入口,不污染文档。
- 空选区 / 纯空白 → 动作条不浮出。
- 应用前 `relocateRange` 失败(审阅期文档被改)→ 复用现有中止逻辑,Notice 提示重选,绝不盲写。
- API Key 未配置 → 对话框内提示去设置,不静默失败。
- 选区变化/关闭对话框 → AbortController 取消进行中的请求。

## 10. 测试

- `action-registry`:动作元数据完整性、prompt 模板渲染、翻译语言方向检测(纯函数,单测)。
- `SuggestList` 抽取:`detectSuggestionTrigger`/`selectSuggestion` 行为在抽取前后一致(回归);Enter 选中路径。
- `inline-diff`:StateField 在 loading / 预览 / 接受 / 拒绝 / 重试下的状态迁移。
- `rewrite-service`:mock ModelService,验证 prompt 拼装与结果透传。
- `relocateRange`:已有测试,补"审阅期文档变动"case。
- 手测:明暗主题下动作条/对话框/补全下拉视觉;`@` Enter 选中;长选区内联 diff 布局与屏幕边界。

## 11. 迁移与清理

- `createChatPanel` 演进为 `SelectionChatPanel`(保留对话框,重做视觉 + 挂 `@` 补全 + 快捷动作条 + 改写应用入口)。
- 抽 `SuggestList` 挂载器,主输入框与选区对话框共用;确认主输入框行为不回归。
- 检索 `DiffModal` 全项目引用;仅被选区菜单使用则删除 `diff-modal.ts`,否则保留。
- `styles.css`:重写 `.guardian-chat-*` / `.guardian-selection-*` / `.guardian-message-*`;新增动作条、补全下拉、内联 diff 样式。
- `main.ts`:`selectionMenuExtension` 注册点适配新的动作条 + 内联 diff 扩展。
