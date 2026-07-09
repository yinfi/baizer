# 选中弹框功能优化 · 设计文档

日期:2026-07-09
分支目标:优化编辑器"选中文字 → AI"功能的回答质量与 UI 交互

## 背景与问题

选中文字后弹出的 AI 菜单当前有三个问题:

1. **回答质量差**:扩写/翻译/解释/润色/摘要等功能点击后,回答没有结合当前笔记上下文和知识库,效果差。
2. **排版/尺寸问题**:显示空间太小、查询信息费劲;面板不能缩放,大量输出看起来费劲。
3. **UI 与交互粗糙**。

## 根因分析(第一性)

不是"注入没生效",而是**选中菜单这条链路从一开始就没接上 `ModelService` 的上下文管线**。

现状两条路径都在"裸奔":

| 动作 | 走的路径 | 上下文情况 |
|------|---------|-----------|
| 润色/校对/翻译/扩写/摘要(rewrite) | `runRewrite` → `generate(prompt, undefined, 'selection-menu', undefined, undefined, {skipGenerationPlan:true})` | 完全裸:无 obsidianContext / userProfile / 记忆 / 工具,跳过生成计划 |
| 解释(readonly) | `processCommand` → `chatStream(..., 'selection-menu', undefined, ...)` | 有工具(web_search / query_knowledge),但 `obsidianContext=undefined`,只塞一个包着选区文本的 contextItem |

三个现成的上下文源,选中菜单一个都没接:
- `KnowledgeRuntime.getGuardianKnowledgeContext(query)`(快·读元数据)/ `getGuardianDeepKnowledgeContext(query)`(深·读正文)
- `ModelService.recallGuardianMemory(query)`(个人记忆召回)
- `ObsidianContextService.collect()`(活动笔记当前小节 / frontmatter / tags / 出链 / backlinks)

问题二/三的根因是**载体选型**:面板是 CodeMirror `showTooltip` + `document.body` fixed 定位,天生尺寸靠内容撑、不可拖拽/缩放、被编辑器矩形挤压。CSS 调不出来。

Guardian 深补已有一整套"上下文预取 → 注入 prompt"的成熟范式(`Promise.race` 超时兜底),本次复用它。

## 设计决策(已与用户确认)

- **UI 载体**:B 方案 —— 独立可拖拽 + 可缩放浮窗(FloatingPanel)。
- **触发交互**:选中文字**立刻**浮出横向工具条(删除现有"✨AI"中间按钮态);点动作**直接**进浮窗,浮窗顶部**不再**重复放动作条。
- **改写 vs 只读分流**:改写类(润色/校对/翻译/扩写/摘要)走**正文原地内联 diff**;只读类(解释)走**浮窗**对话。
- **去掉**:复制按钮(工具条上)、朗读 TTS。
- **上下文注入粒度**:按动作分级(声明式),不一刀切。
- **AI 搜索 vs 解释**:合并为「解释」(用笔记 + 联网解释选中概念)。
- **知识库检索深浅**:统一用**深检索**(读正文),选中菜单是显式操作,值得等 1-2s。

## 动作上下文分级表

| 动作 | activeNote | knowledge | memory | 理由 |
|------|:---:|:---:|:---:|------|
| 翻译 translate | — | ✓(术语) | — | 就文本论文本,只有专名译法有用 |
| 校对 fix | — | — | — | 纯语法拼写,注上下文纯干扰 |
| 润色 improve | ✓ | — | ✓ | 贴合全文文风,不需要事实 |
| 扩写 expand | ✓ | ✓ | ✓ | 最吃上下文——往哪写取决于笔记主题+周边 |
| 摘要 summarize | — | — | — | 就选中文本概括,外部无益 |
| 解释 explain | ✓ | ✓ | ✓ | 用自己的笔记+联网解释 |

预期效果:修好后**校对/摘要基本不变**(本就不需要上下文),真正脱胎换骨的是**扩写/解释/润色**。

## 架构设计

### 1. 声明式上下文需求(action-registry.ts)

```typescript
interface SelectionAction {
  id: string; icon: string; label: string;
  kind: 'rewrite' | 'readonly';
  promptTemplate: string;
  context: {
    activeNote?: boolean;   // 活动笔记当前小节
    knowledge?: boolean;    // 知识库深检索节选
    memory?: boolean;       // Hindsight 记忆召回
  };
}
```

各动作按上表填 `context`。合并 AI搜索→解释。

### 2. 统一上下文装配器(新增 selection-context-builder.ts)

唯一的上下文装配点:

1. 读动作的 `context` 声明,只预取声明了的源(`Promise.all` 并发)。
2. 复用现成接口:`getGuardianDeepKnowledgeContext(query)`、`recallGuardianMemory(query)`、`ObsidianContextService.collect()`。
3. query 用选中文本(必要时叠加动作意图)。
4. 每个源带超时兜底(知识库 2.5s / 记忆 1.5s),超时返回空串不阻塞(照搬 Guardian `Promise.race` 范式)。
5. 把非空片段拼成 `[Context]/[Knowledge]/[Relevant Memory]` 前缀,拼在动作 prompt 前。

### 3. 两条执行路径都接上

- **改写类**:`runRewrite` 里先 `await builder.build(action, selection)`,拼进 prompt 再 `generate`。仍 `skipGenerationPlan:true`(改写不需生成计划包装),但 prompt 已含真实上下文。
- **只读类(解释)**:走 `processCommand` → `chatStream`,预取上下文作为 contextItem 传入(不再只塞裸选区),同时保留 `web_search`/`query_knowledge` 工具让模型能补充检索。

**取舍**:改写类不走 `chatStream` 带工具,因为改写要"一次性出结果+内联 diff",工具循环会拖慢且破坏 diff 时序。预取注入更适合改写——确定性、单次、快。

## UI 载体与交互

### 态① 横向工具条(Toolbar)

- 选区非空 → 立刻在选区上方浮出横向工具条(删掉现有 button 中间态)。
- 仍用 CM `showTooltip`(擅长贴选区定位,工具条小、不需缩放)。
- 按钮:🔍解释 · 🌐翻译 · 📝润色 · ✓校对 · ➕扩写 · 📄摘要。
- 点改写类 → 走内联 diff(不弹浮窗);点解释 → 弹浮窗②。

### 态② 可拖拽缩放浮窗(FloatingPanel,新增)

- 只有"解释"这类只读对话动作才弹。
- 结构:标题栏(可拖动 + 关闭)/ 消息区(流式渲染,复用 MarkdownRenderer)/ 底部输入区(继续追问)+ 替换/复制按钮。
- 顶部**不放动作条**。
- 可拖标题栏移动、拉右下角 resize handle 缩放。
- **记住尺寸/位置**:存 `localStorage`(UI 偏好,非配置)。首次默认贴选区右下、420×360。

### 改写类内联 diff

沿用现有 `inline-diff.ts` 红/绿预览 + ✓接受/✕拒绝/↻重试,只是喂给它的 prompt 现在带上下文。

**载体分工理由**:工具条要贴选区、小、频繁出现,tooltip 定位能力正合适;浮窗要大、要拖拽缩放、承载长输出,tooltip 做不到,必须独立。不强行统一,因为两者本质需求相反。

### 样式

新增 `.baizer-floating-panel` 等类,走 Obsidian CSS 变量(`--background-primary` 等)自动适配明暗主题,不写死颜色。

## 数据流

```
选中文字
  → CM selectionField 检测非空选区
  → showTooltip 浮出横向工具条
  → 点动作 A
     ├─ [改写类] SelectionContextBuilder.build(A, selection)   // 并发预取,带超时
     │    → 拼上下文前缀 + promptTemplate
     │    → runRewrite → generate(prompt, {skipGenerationPlan})
     │    → inline-diff 红绿预览 → ✓接受写回 / ✕拒绝 / ↻重试
     │
     └─ [只读·解释] SelectionContextBuilder.build(A, selection)
          → 预取上下文作为 contextItem[]
          → 弹 FloatingPanel
          → chatStream(prompt, contextItems, ..., 'selection-menu')  // 带 web_search/query_knowledge 工具
          → 流式渲染进浮窗 → 可继续追问 / 替换 / 复制
```

## 边界与失败处理

- **上下文源全部超时/为空** → 降级为裸 prompt,不阻断动作(与现行为一致,只是不再是常态)。
- **无活动笔记** → `ObsidianContextService.collect()` 返回空快照,`activeNote` 声明自动落空,不报错。
- **无知识库/无记忆管理器** → 对应接口返回空串,Builder 跳过该源。
- **选区在预取期间被改动** → 沿用现有 `relocateRange` 快照重定位;找不到则中止写回,绝不盲写。
- **改写请求竞态** → 沿用现有 `AbortController` 单飞,新动作 abort 旧的。
- **浮窗关闭时有未决流** → abort chatStream + cleanup controller(现有 `cleanupPendingRewrite` 模式扩展到浮窗)。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/ui/selection-ai/action-registry.ts` | `SelectionAction` 加 `context` 声明;各动作按分级表填;合并 AI搜索→解释 |
| `src/ui/selection-ai/selection-context-builder.ts` | **新增** 上下文装配器(并发预取+超时+拼接) |
| `src/ui/selection-ai/floating-panel.ts` | **新增** 可拖拽缩放浮窗组件(位置/尺寸持久化) |
| `src/ui/selection-ai/rewrite-runner.ts` | `runRewrite` 接入 Builder,prompt 带上下文 |
| `src/ui/selection-menu.ts` | 删 button 中间态;选中直出工具条;解释走 FloatingPanel;改写走 inline-diff;`pluginContextMap` 补充 knowledgeRuntime + ObsidianContextService |
| `main.ts` | `selectionMenuExtension` 组装处补传 knowledgeRuntime、ObsidianContextService(实例已存在) |
| `styles.css` | 新增 `.baizer-floating-panel` 等类,走主题变量 |
| `test/` | Builder 分级预取单测(mock 三源)、action-registry context 声明测试 |

## 不做什么(YAGNI)

- 不做朗读 TTS。
- 不做工具条动作自定义/排序。
- 不改 Guardian、知识库、记忆本身(只复用其只读接口)。
- 浮窗不做多实例(同时只一个,与现有单例约束一致)。

## 测试约束

自定义 mini-harness(非 jest),`npx tsx --tsconfig tsconfig.test.json test/x.test.ts`,新测试注册进 `test/run-tests.ts`;CM/DOM/流式只做编译 + 手测。
