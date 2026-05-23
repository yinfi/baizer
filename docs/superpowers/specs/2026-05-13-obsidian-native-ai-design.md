# Obsidian 原生 AI 操作层设计方案

**Date:** 2026-05-13
**Project:** `obsidian-cli`
**Status:** Proposed design, pending review

## 目标

将 `obsidian-cli` 从“可在 Obsidian 中使用的 AI Shell”升级为“以笔记、编辑器、知识网络和插件工作流为中心的 Obsidian 原生 AI 操作层”。

这个升级包含两条同等重要的目标：

1. 交互原生化：让用户觉得自己在使用增强过的 Obsidian，而不是嵌入在 Obsidian 里的独立 Agent 终端。
2. 生成质量系统化：让 AI 产出的内容稳定地像当前用户、像当前笔记、像当前 vault，而不是偶尔写出一句好话。

本设计不追求复刻 Claudian 的 Agent 终端体验，而是明确选择一条不同的产品路线：

- 让 AI 行为优先围绕 note、selection、heading、properties、backlinks、tags 和 vault workflow 展开
- 让编辑器和当前笔记成为第一入口，Shell 成为复杂编排入口
- 让高风险操作始终具备明确预览、局部应用、可审计和可撤销能力
- 保留现有 `ToolRegistry + SkillRegistry + KnowledgeRuntime + Guardian` 的产品方向，而不是把产品重心改成 bash / subagent / MCP server 工作台

## 背景与问题

当前项目已经具备一批正确的基础能力：

- Shell 聊天视图
- Skill 与 Tool 分层
- Guardian 行内建议、ghost text、selection menu
- 知识编译、查询、归档
- 插件命令调用与权限控制
- 多 provider、流式输出、多会话 tab

但这些能力在用户感知上仍偏向“功能集合”，而不是“Obsidian 原生体验”。主要问题有六类：

1. 上下文模型仍偏向“附加文件内容”，而不是“理解当前笔记在知识网络中的位置”。
2. 编辑器内交互存在，但没有成为主入口。
3. 知识系统能力强，但状态不可见，入口偏命令化。
4. 审批机制可用，但缺乏面向写作和笔记修改的变更预览语义。
5. 插件协同存在基础能力，但没有形成“AI 理解我的 Obsidian 工作流”的整体体验。
6. 内容生成整体仍偏通用助手风格，缺少稳定的“惊艳感”。

Claudian 的问题正好说明了反例：它更像一个嵌入在 Obsidian 里的 Agent IDE。这个方向适合代码代理，但不适合作为 Obsidian 的主流交互范式。

## 设计原则

### 1. Note-first，而不是 terminal-first

AI 默认理解的是笔记对象，而不是普通文件对象。一个 note 至少应该包含：

- 路径和标题
- frontmatter / properties
- headings 结构
- tags
- outgoing links
- backlinks
- 当前选区和选区所在 heading
- 最近编辑关系

### 2. Editor-first，而不是 chat-first

聊天窗口仍保留，但编辑器内的微交互要成为更高频入口：

- 选中文本直接触发 AI 操作
- 当前段落、当前 heading、当前 note 都可成为操作作用域
- AI 写入优先走预览和局部应用，而不是直接修改文件

### 3. Knowledge-visible，而不是 command-driven

知识系统不能只作为 `/wiki:*` 命令存在。用户应在日常使用中直接看到：

- 当前笔记是否已被知识系统收录
- 是否过期、待编译、失败
- 这次 AI 回答是否值得归档

### 4. Workflow-aware，而不是 generic assistant

AI 不只是“会操作 Obsidian 文件”，而是“理解这个 vault 的工作流”：

- 哪些目录是项目区、日记区、知识区
- 哪些插件是核心工作流插件
- 哪些操作需要 selection、active note、focused editor

### 5. Preview before mutation

所有写入类行为都必须先向用户展示它将改变什么。批准粒度优先是：

- 当前选区替换
- 当前 heading 内替换
- 当前 note 修改
- 新建 note
- 追加到 note
- 执行可能间接改写 vault 的插件命令

### 6. Obsidian language，而不是 CLI language

界面、说明和设置文案应以 Obsidian 用户能理解的语言组织：

- “当前笔记”“反向链接”“属性”“标签”“知识索引”
- 而不是“command execution”“runtime context injection”“workspace mutation”

### 7. Quality-by-design，而不是 prompt-by-luck

内容质量不能依赖单个 prompt 的运气。系统必须显式建模：

- 当前写作任务是什么
- 当前 note 属于什么文类和工作流
- 用户自己的写作偏好是什么
- 什么样的输出才算这个场景下的“成品”

生成质量应来自统一策略层，而不是零散地在 `Guardian`、`/edit`、Shell 问答里各写一段 prompt。

## “惊艳” 的正式定义

本设计对“让用户觉得惊艳”的定义如下：

- 高相关：明显读懂当前 note、当前段落和相关旧笔记
- 高品味：结构、措辞和节奏优于泛用助手
- 高完成度：输出是可直接落进 Obsidian 的成品，而不是半成品
- 低废话：不过度解释，不堆安全套话
- 可立即落地：能被应用、归档、链接或继续编辑

这五项构成生成质量公式：

`Quality = Context Fitness + Taste + Completeness + Specificity + Actionability`

## 设计方案比较

### 方案 A：继续强化 Shell 工作台

做法：

- 继续围绕 `ShellView` 增加更多面板、命令、上下文 chips 和工作台能力
- 让更多操作从聊天输入框发起
- 编辑器与知识系统只是 shell 的辅助入口

优点：

- 对现有代码侵入最小
- 复用当前多 tab、流式、tool timeline 基础最好

问题：

- 用户依然会感知为“AI 终端”
- 编辑器内能力永远是附属
- 难以形成 Obsidian 原生工作流

结论：

不采用。这个方案延续当前产品优点，但无法解决产品方向问题。

### 方案 B：双入口架构，Editor 为主，Shell 为编排中心

做法：

- 保留 `ShellView` 作为长对话、复杂编排、工具回放中心
- 将编辑器内操作、知识状态、变更预览、归档入口前移
- 让上下文系统统一为“笔记语义上下文”，Shell 和编辑器共用
- 增加统一的生成策略层，为不同入口提供一致的质量标准

优点：

- 与现有架构兼容
- 可以逐步演进
- 最符合 Obsidian 用户的真实使用路径
- 既保留复杂能力，又能降低“外来工具感”
- 能从系统层解决内容质量问题，而不是继续堆 prompt

问题：

- 需要补一层统一上下文和变更预览模型
- 需要新增生成策略层
- 需要谨慎控制 `ShellView` 继续膨胀

结论：

推荐采用。这是本设计的正式方案。

### 方案 C：全面转向编辑器内 AI，不再突出 Shell

做法：

- 弱化甚至隐藏 Shell
- 让所有能力走 selection menu、command palette、note panel 和 gutter

优点：

- 最原生
- 最贴近写作型使用场景

问题：

- 会损失复杂工具编排、多轮问答和知识回放能力
- 与当前项目已有 shell 能力冲突过大

结论：

不采用。它适合作为长期演化方向之一，但不适合作为当前仓库的主线改造方案。

## 正式设计

### 产品定位

`obsidian-cli` 是 Obsidian 内的 AI 操作层。它帮助用户在笔记、知识网络和插件工作流中完成阅读、思考、编辑、整理、归档和执行，而不是把外部 Agent 终端照搬到 Obsidian 中。

### 用户入口模型

设计采用四个入口，按频率从高到低排列：

1. 编辑器原位入口
2. 当前笔记状态入口
3. Shell 编排入口
4. Command Palette / slash command 入口

这四个入口不是四套系统，而是四个视图层，底层共享统一的上下文、生成策略、变更预览、权限与知识状态模型。

## 用户体验设计

### 1. 编辑器原位入口

编辑器内保留并增强现有三类能力：

- `Guardian`：持续性、轻量、上下文感知
- `Selection Menu`：局部操作、即时反馈
- 手动命令：命令面板或 hotkey 触发的作用域编辑

目标交互：

- 选中文本后出现操作菜单：润色、改写、总结、提炼要点、生成标题、提取任务、归档知识
- 对当前段落或当前 heading 运行 AI 操作时，不直接改文，而是出现局部 diff 预览
- `Guardian` 不只提供续写，也提供结构提醒、重复提醒、语义补全和知识引用建议

第一阶段不做：

- 复杂的多人协同批注
- Word 风格长文审校面板

### 2. 当前笔记状态入口

为当前 note 增加一个轻量状态层，统一展示三类信息：

- AI 上下文状态
- 知识状态
- 可执行动作

状态信息包括：

- 当前 note 是否已加入聊天上下文
- 当前选区是否被锁定为操作目标
- 是否已编译入知识系统
- 是否 stale / pending / failed
- 当前 note 有多少 backlinks / tags / 关联笔记可作为上下文

动作包括：

- 加入上下文
- 查看关联笔记
- 编译当前笔记
- 打开知识索引
- 将上一次 AI 回答归档到知识系统

### 3. Shell 编排入口

Shell 保留，但职责重新定义为：

- 多轮复杂问题
- 工具与 skill 编排
- 查询知识
- 跨笔记整理
- 回看 tool timeline 和审批历史

Shell 不再承担“所有 AI 交互的统一入口”。

Shell 中需要强化的能力：

- `@` 提及不仅支持文件，还支持 `@current`、`@backlinks`、`@recent`、`@tag:xxx`
- 当前 note 默认作为弱上下文，而不是每次强制注入全文
- 输出尽量使用 Obsidian 可直接消费的 Markdown 结构，例如 `[[note]]`、tasks、callout、heading

### 4. Slash / Command Palette 入口

slash command 保留给高频显式操作：

- `/clear`
- `/profile`
- `/tools`
- `/wiki:*`
- `/open`
- `/edit`

但不应继续扩张为主要入口。新增能力优先考虑：

- 编辑器菜单
- 当前笔记状态面板
- 消息动作按钮

## 内容生成设计

### 北极星

对本产品而言，用户觉得 AI 内容“惊艳”，通常不是因为它写得更长，而是因为它同时满足四件事：

1. 它明显理解这篇笔记此刻在做什么。
2. 它给出的不是普通文字，而是可以直接放进 Obsidian 的结构化成品。
3. 它提供了一个用户自己未必会想到、但读完会认同的连接、判断或重组方式。
4. 它在保留用户声音的前提下让内容变得更清晰、更完整、更有组织。

### 生成模式设计

系统不再把“生成内容”视为单一能力，而是拆分为若干明确模式。每种模式有不同的输出契约和评价标准。

正式模式包括：

- `co-write`：续写或补全当前段落，重点是延续语气与思路
- `rewrite`：改写已有内容，重点是清晰度、压缩度或语气调整
- `structure`：重组内容结构，重点是标题、层次、列表和 callout
- `summarize`：提炼重点，重点是密度和可回顾性
- `knowledge-link`：补充相关笔记、概念连接和归档建议
- `archive`：把现有回答或笔记转成知识条目，重点是可沉淀性
- `naming`：为标题、section、note 命名，重点是区分度和可检索性

同一段文本在不同模式下应产生不同输出。系统不能再用一段通用 prompt 同时处理所有任务。

### 成品导向设计

系统默认追求“成品输出”，而不是“普通 prose 输出”。

在 Obsidian 中，成品优先表现为：

- 合理的 `##` 和 `###` 结构
- 可直接应用的任务列表 `- [ ]`
- 可直接渲染的 callout
- 正确的 `[[note]]` 或 `[[note#heading]]` 链接
- 适合当前 note 的 properties / frontmatter 建议
- 可归档为独立 note 的候选段落或标题

如果任务是改写，输出至少应是“可替换原文”的完整片段；如果任务是总结，输出至少应是“可直接插入当前笔记”的 summary block。

### 惊艳点约束

系统级别增加一个显式质量要求：

- 每次高价值生成，至少要包含一个“非显而易见但合理”的点

这个点可以是：

- 一个来自当前 vault 的相关笔记连接
- 一个更适合当前内容的结构变化建议
- 一个缺失的判断标准或对比维度
- 一个适合沉淀为独立知识条目的概念切分

这个约束的作用不是强迫模型“耍聪明”，而是避免输出退化成安全但平庸的改写。

### 用户声音保真

惊艳不等于文学化。对 Obsidian 用户，内容质量更依赖“保留用户原有声音并让它更好”。

因此系统需要维护两个层次的风格：

- `User Writing Profile`：用户层面的长期偏好，如句长、语气、是否偏列表、是否常下结论
- `Vault Voice Profile`：当前 vault 的整体文风和常见笔记组织方式

生成时优先级应为：

`当前 note 的局部风格 > 用户长期风格 > vault 整体风格 > 默认系统风格`

### 最小质量检查

系统在展示给用户前，应做最小质量检查，而不是盲目接受首个结果。

检查项包括：

- 是否过度重复原文
- 是否符合目标输出形态
- 是否包含至少一个具体连接或结构判断
- 是否使用了可直接落地的 Obsidian 格式
- 是否出现通用废话或空泛套话

第一阶段不要求复杂的多轮自我反思，但要求最小质量门槛过滤。

## 信息架构设计

### 核心对象

本设计正式引入六个核心对象：

1. `ObsidianContext`
2. `GenerationMode`
3. `WritingProfile`
4. `ChangePreview`
5. `KnowledgeStatus`
6. `OperationRecord`

### 1. ObsidianContext

`ObsidianContext` 是对当前工作面而不是单文件内容的抽象。它由以下信息组成：

- `activeNote`
- `selection`
- `activeHeading`
- `frontmatter`
- `tags`
- `outgoingLinks`
- `backlinks`
- `recentNotes`
- `explicitMentions`
- `knowledgeHints`

它的职责不是替代 `ContextItem[]`，而是为 `ContextItem[]` 提供更高层语义来源。

### 2. GenerationMode

`GenerationMode` 表示一次生成任务真正要解决的问题，而不是 UI 入口本身。

它至少包含：

- mode name
- task goal
- expected output shape
- preferred formatting
- quality checklist
- whether mutation preview is required

例如：

- `rewrite` 期待输出“完整替换片段”
- `structure` 期待输出“重组后的层级结构”
- `knowledge-link` 期待输出“内容 + 相关 note 链接 + 沉淀建议”

### 3. WritingProfile

`WritingProfile` 负责把“像这个用户写的”变成系统里的显式对象。

它由两部分构成：

- `userProfile`：长期偏好
- `vaultProfile`：当前知识库中的通用文风

字段包括：

- sentence length tendency
- tone
- heading style
- list preference
- conclusion preference
- common note shapes
- banned phrases or disliked filler

### 4. ChangePreview

`ChangePreview` 表示任何可能变更用户数据的 AI 操作。

类型包括：

- `editor-selection-replace`
- `note-replace`
- `note-append`
- `note-create`
- `note-rename`
- `note-delete`
- `plugin-command`

它应包含：

- 目标对象
- 变更范围
- 摘要
- old/new 内容或差异片段
- 风险级别
- 是否支持局部应用
- 是否支持撤销

### 5. KnowledgeStatus

`KnowledgeStatus` 负责连接当前 note 和知识系统。

状态包括：

- `unregistered`
- `pending`
- `processing`
- `done`
- `failed`
- `stale`

它还应提供：

- summary path
- 最近编译时间
- 最近错误
- 相关知识条目数量

### 6. OperationRecord

`OperationRecord` 用于审计 AI 执行过的真实操作。

字段包括：

- action
- target
- provider
- model
- timestamp
- approval source
- previous content hash
- previous content snapshot
- undo availability

## 系统架构设计

### 分层结构

正式架构分为六层：

1. Entry Layer
2. Context Layer
3. Generation Strategy Layer
4. Interaction Layer
5. Execution Layer
6. Persistence Layer

### 1. Entry Layer

对应用户可见入口：

- `Selection Menu`
- `Guardian`
- `Knowledge Status Panel`
- `ShellView`
- `Command Palette`

这些入口只负责触发意图、展示结果，不负责拼装底层逻辑。

### 2. Context Layer

新增一个 `ObsidianContextService` 作为上下文统一入口。

职责：

- 从当前编辑器和 vault 中采集语义上下文
- 把 note、selection、heading、links、tags 转换为 `ContextItem[]`
- 做优先级与预算控制

这一层会让当前 `ContextController` 从“读取 active file + selection”的薄封装，升级为产品级上下文编排器。

### 3. Generation Strategy Layer

新增一层生成策略层，用于把上下文解释成真正可用的生成任务。

职责：

- 判定当前属于哪种 `GenerationMode`
- 推断当前 note 的文类和当前段落的作用
- 合并 `ObsidianContext + WritingProfile + task intent`
- 为运行时生成明确的输出契约和质量检查项

这一层不直接调用模型，而是为 `ChatRuntime` 和 Guardian 提供一致的“生成说明书”。

### 4. Interaction Layer

这一层负责“如何让用户确认和消费 AI 输出”，包括：

- `ChangePreview`
- `ChangePreviewCard`
- 编辑器局部应用
- 消息归档按钮
- 知识状态面板

这是 Obsidian 原生感的关键层。

### 5. Execution Layer

继续使用现有：

- `ModelService`
- `ChatRuntime`
- `ToolRegistry`
- `SkillRegistry`
- `KnowledgeRuntime`

但职责进一步清晰：

- `ModelService` 作为 UI facade
- `ChatRuntime` 负责 prompt、tool loop、stream orchestration
- `ToolRegistry` 负责原子操作
- `SkillRegistry` 负责工作流级编排
- `KnowledgeRuntime` 负责知识生命周期

### 6. Persistence Layer

已有持久化与新增持久化分工：

- 会话与 profile：现有 memory manager / conversation store
- 知识状态：frontmatter + knowledge wiki
- 审计记录：新增操作审计存储
- 风格画像：以轻量 profile 形式存储，不做复杂训练数据系统
- UI 状态：尽量轻，不持久化过多临时面板状态

## 关键模块设计

### 模块 A：ObsidianContextService

输入：

- active file
- active editor
- explicit context chips
- mention scopes

输出：

- `ContextItem[]`
- `selection`
- `activeHeading`
- `contextSummary`

设计要求：

- 默认只注入有限且高相关的内容
- 长文按 heading 和 selection 就近裁切
- backlinks / related notes 只注入摘要，不注入全文
- 能为 Shell 和编辑器操作复用

### 模块 B：GenerationStrategyService

输入：

- `ObsidianContext`
- 用户动作来源：Guardian / selection menu / shell / command
- 原始用户请求
- `WritingProfile`

输出：

- `GenerationMode`
- 输出契约
- 风格约束
- 质量检查项

设计要求：

- 不与具体 provider 耦合
- 生成模式推断应可测试
- 同样的任务在不同入口下应得到同一套生成规则
- 明确区分“续写”“改写”“重组”“总结”“知识连接”几类任务

### 模块 C：ChangePreview Pipeline

流程：

1. 用户发起写入类动作
2. 模型返回建议内容或工具调用意图
3. 系统构造 `ChangePreview`
4. UI 呈现预览
5. 用户批准后才执行真实写入
6. 写入结果记录到 `OperationRecord`

设计要求：

- UI 层不直接依赖具体 tool 返回 shape
- preview 层是统一抽象
- 对选区替换和文件写入使用相同的审批心智模型

### 模块 D：KnowledgeStatusService

职责：

- 查询当前 note 的知识状态
- 查询全局 pending / failed / stale 统计
- 暴露 compile / lint / open index 动作

设计要求：

- UI 不直接访问 compiler 和 watcher 内部细节
- 状态更新应事件化或最小轮询化

### 模块 E：OperationAuditLog

职责：

- 记录 AI 真实执行过的用户可见变更
- 提供最近操作查看
- 为低风险文件写入提供有限 undo

不做的事：

- 不实现全量版本控制系统
- 不在第一阶段做复杂冲突恢复

## 生成链路设计

### 四步生成链路

所有高质量内容生成都应走统一四步链路：

1. `Interpret`
2. `Plan`
3. `Generate`
4. `Check`

### 1. Interpret

系统先解释当前任务，而不是立刻把文本扔给模型。

解释结果至少包含：

- 当前 note 类型
- 当前段落作用
- 当前任务模式
- 当前上下文候选
- 是否需要旧笔记连接

### 2. Plan

系统在运行时为本次生成确定：

- 目标输出形态
- 应保留的用户语气
- 应避免的泛化风格
- 是否要求至少一个“惊艳点”
- 是否要求产出 Obsidian 原生成品

### 3. Generate

模型根据策略层给出的约束生成内容。

不同入口共用同一个策略层，但输出渠道不同：

- Guardian：短、轻、连续
- Selection rewrite：局部、可替换
- Shell answer：完整、可引用、可归档
- Knowledge archive：结构化、可沉淀

### 4. Check

系统在展示给用户前做最小质量检查，而不是盲目接受首个结果。

检查项包括：

- 是否过度重复原文
- 是否符合目标输出形态
- 是否包含至少一个具体连接或结构判断
- 是否使用了可直接落地的 Obsidian 格式
- 是否出现通用废话或空泛套话

第一阶段不要求复杂的多轮自我反思，但要求最小质量门槛过滤。

## 交互流程设计

### 流程 1：选区改写

1. 用户选中文本
2. `Selection Menu` 选择“润色”或“改写”
3. 系统收集 `selection + active heading + note metadata`
4. 策略层判定当前任务是 `rewrite` 或 `structure`
5. AI 返回替换文本
6. 系统生成 `ChangePreview(editor-selection-replace)`
7. 用户点击“应用”
8. 文本替换，记录审计日志

### 流程 2：Shell 中引用当前笔记上下文

1. 用户在 Shell 中提问
2. 系统自动附带当前 note 的轻量上下文
3. 用户额外通过 `@backlinks` 和 `@tag:project-x` 补充上下文
4. `ObsidianContextService` 统一预算并转换为 `ContextItem[]`
5. 策略层判定当前任务是否需要 `knowledge-link`
6. 模型返回带 `[[note]]` 样式引用的答案

### 流程 3：归档 AI 回答到知识系统

1. AI 回答生成
2. 消息卡片上显示“归档到知识库”
3. 用户点击归档
4. 系统调用现有 `file_back_knowledge`
5. 成功后显示目标知识条目或路径

### 流程 4：执行插件命令

1. AI 判断需要插件能力
2. plugin skill 先确认是否需要 active file / selection
3. 若会触发写入或高风险变更，构造 `ChangePreview(plugin-command)`
4. 用户批准
5. 执行命令并记录审计日志

### 流程 5：生成一段让用户觉得“值”的内容

1. 用户在当前 note 中选中一段设计说明并要求改写
2. 系统识别当前任务是 `rewrite + structure`
3. 系统识别当前 note 属于方案文档，当前段落作用是“问题定义”
4. 系统补充当前 note 的 headings、相关链接和用户写作偏好
5. 策略层要求输出：
   - 保留原语气
   - 减少空话
   - 给出一个更清晰的判断框架
   - 输出可直接替换的 Markdown 片段
6. 模型生成内容
7. 质量检查确认结果不是简单同义改写，而是补出更强结构
8. UI 显示局部 diff 预览

## 权限与安全设计

### 权限模型

保留现有权限开关，但升级解释和约束方式：

- `allowFileCreation`
- `allowFileModification`
- `allowPluginControl`
- `confirmExecutions`

新增一个高层写入范围概念：

- `read-only`
- `current-note`
- `configured-folders`
- `all-vault`

现有布尔开关仍保留以兼容旧配置，但 UI 和运行时判断应优先解释为更接近用户心智的“写入范围”。

### 安全规则

- 一切 mutation 默认先走 preview
- 对当前编辑器替换允许局部应用
- 对文件级写入必须展示路径和变更摘要
- 对插件命令至少展示目标 command id、前置条件和预期影响
- 对 `.obsidian` 配置路径继续默认禁止写入

## UI 设计约束

### 应保留的现有优点

- 多 tab shell
- tool timeline
- context chips
- provider / model selector
- Guardian 轻量性

### 必须避免的方向

- 不做像 IDE 的左中右超重型工作台
- 不把 Plan Mode、subagent、MCP server manager 暴露为主视觉结构
- 不新增一套与编辑器割裂的复杂控制中心

### 视觉风格建议

- 更接近 Obsidian 原生面板、状态条、右键动作和 callout
- 少用“大卡片式 AI 仪表盘”
- 交互强调“轻插入、少打断、可确认”

## 与现有代码的映射

### 应复用

- `src/ui/selection-menu.ts`
- `src/ui/ghost-text.ts`
- `src/ui/guardian-gutter.ts`
- `src/ui/chat-controller.ts`
- `src/ui/shell-view.ts`
- `src/knowledge/runtime.ts`
- `src/services/context-manager.ts`
- `src/skills/builtin/vault-ops.ts`
- `src/skills/builtin/plugin-ctrl/*`

### 应新增

- `src/services/obsidian-context-service.ts`
- `src/services/generation-strategy-service.ts`
- `src/ui/diff/change-preview.ts`
- `src/ui/components/change-preview-card.ts`
- `src/knowledge/status-service.ts`
- `src/ui/components/knowledge-status-panel.ts`
- `src/services/operation-audit-log.ts`

### 应避免

- 继续把产品逻辑堆进 `ShellView`
- 直接在 tool 返回里混入大量 UI 细节
- 让每个入口单独实现一套上下文拼装规则
- 在没有统一策略层之前继续向各处追加 prompt 特例

## 分阶段交付设计

### 第一阶段：统一上下文、生成策略与预览模型

目标：

- 把“Obsidian 原生感”和“内容质量”最核心的上下文层、策略层、预览层打稳

范围：

- `ObsidianContextService`
- `GenerationStrategyService`
- scoped mentions
- `ChangePreview`
- 文件 / 选区修改审批预览

### 第二阶段：知识状态前台化

目标：

- 让知识系统从后台能力变成前台产品能力

范围：

- `KnowledgeStatusService`
- 当前笔记知识状态面板
- 回答归档入口

### 第三阶段：插件工作流与审计

目标：

- 把插件调用从“可执行”升级为“可理解、可确认、可追踪”

范围：

- plugin skill 增强
- `OperationAuditLog`
- 撤销与最近操作浏览

## 验收标准

### 产品验收

- 用户可以在不打开 Shell 的情况下完成至少三类高频 AI 编辑动作
- 用户可以清楚知道当前 note 是否已进入知识系统以及是否需要重编译
- 用户在高风险写入前总能看到明确预览
- 用户在 Shell 中提问时，答案明显更贴近当前 note 和链接网络，而不是泛化回复
- 用户能明显感知到内容输出不再像通用助手，而是像当前 vault 中自然长出来的内容
- 至少三类高频场景中的输出可直接插入当前 note，而不需要用户再手工重写结构

### 技术验收

- 上下文拼装规则对 Shell 和编辑器操作统一
- 预览模型不耦合某个具体 tool 返回格式
- 知识状态 UI 不直接依赖 compiler 内部实现
- 新增服务和 UI 组件有独立测试覆盖
- 生成模式、风格画像和质量检查可在运行时独立测试
- `Guardian`、selection rewrite、Shell 问答共用统一的生成策略层

## 非目标

以下内容明确不在本轮设计范围内：

- 完整的 Plan Mode
- bash / terminal execution 能力扩展
- 子 Agent 编排
- 外部 MCP server 管理界面
- 复杂的知识图谱可视化
- 全量文档版本控制和跨会话撤销系统
- 用统一“高级文风”覆盖用户原有写作声音
- 为了追求惊艳感而引入不可解释的高随机性输出

## 风险与应对

### 风险 1：`ShellView` 继续膨胀

应对：

- 新功能默认新增 service / component，不直接塞入 `ShellView`

### 风险 2：上下文过多导致 token 浪费

应对：

- 强制上下文预算
- backlinks 和 related notes 默认只注入摘要

### 风险 3：预览层与 tool 层耦合

应对：

- 统一中间抽象 `ChangePreview`
- UI 只消费 preview，不消费原始 tool result

### 风险 4：知识状态更新不及时

应对：

- 通过 `KnowledgeRuntime` 暴露状态服务和刷新点
- 不让 UI 直接猜测 runtime 状态

### 风险 5：内容过度风格化，失去用户声音

应对：

- 明确 `WritingProfile` 优先级
- 默认保留当前 note 局部风格
- 把“像用户写的”优先于“像 AI 写得漂亮”

### 风险 6：策略层过重，导致延迟增加

应对：

- 第一阶段只做轻量解释和最小质量检查
- 不引入复杂多轮自我反思
- 将策略推断设计成可缓存、可裁剪的纯函数

## 结论

本设计不把 `obsidian-cli` 推向 Claudian 那种 Agent 工作台，而是把它收敛成一个真正围绕 Obsidian 工作方式构建的 AI 操作层。

关键判断有四个：

1. 主入口应该是编辑器和当前笔记，而不是聊天终端。
2. AI 的真正上下文是知识网络，而不是单个文件全文。
3. 所有写入都必须建立在预览、批准、审计这条可信链路上。
4. 惊艳感必须来自系统化的生成策略，而不是依赖偶然写出的好句子。

如果这个设计成立，后续实现计划应围绕“上下文统一层 -> 生成策略层 -> 变更预览层 -> 知识状态前台化 -> 插件工作流与审计”这条顺序展开，而不是继续横向堆功能。
