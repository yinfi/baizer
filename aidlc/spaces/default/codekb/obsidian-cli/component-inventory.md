# 组件清单 — Baizer（obsidian-cli）

本清单是仓库的完整组件目录。**组件名即为标题**，供 CodeKB 重跑守卫逐字比对。

---

## Plugin Bootstrap

**位置**：`main.ts`（`BaizerPlugin extends Plugin`，1130 行）
**职责**：插件生命周期唯一入口。`onload` 装配全部子系统、注册 25 个工具与 7 个内置技能、注册 4 条命令、注册 `ShellView`、注册 CodeMirror 扩展与 vault/editor 事件；`onunload` 拆除。**同时拥有 Guardian 的全部调度逻辑**（去抖、单飞、自动升级、锚点去重、日志）。
**依赖**：几乎所有模块（门面、知识、技能、UI、i18n）
**被依赖**：Obsidian 宿主
**关键点**：
- 启动路径已优化：内置技能物化写盘推到后台（`void materializeBuiltins(...)`），路径同步计算
- 派生技能对账在 `loadSkills` 之后**必须**紧接着跑（`reconcileDerivedSkills()`）
- 快补与深补各有独立 `AbortController`；`guardianRequestSeq` 只由快路径递增（递增即宣告在途快请求作废），深路径不得触碰

---

## ModelService 门面

**位置**：`src/services/model-service.ts`（977 行）
**职责**：全部 LLM 工作的唯一入口。持有并装配 tool/skill 注册表、记忆管理器、会话管理器、运行中控制器、审计日志、工作区编辑服务、用户命令服务；构造 pi `Model` 句柄与无状态生成函数；提供会话/分支/审批/记忆/知识/技能的公开方法。
**依赖**：`runtime-factory`、`src/runtime/pi/*`、`active-run-controller`、`memory-manager`、`workspace-edit-service`、`operation-audit-log`、`model-catalog-service`、`generation-strategy-service`、`src/mcp/types`
**被依赖**：`main.ts`、`ShellView`、`ChatController`、`GuardianCompletionService`、`KnowledgeRuntime`、`PluginSkillGenerator`
**关键点**：设置变更在**下一轮**生效（模型句柄每轮重建）；`generate` 通过注入回调供记忆/知识使用，避免反向依赖

---

## Chat Runtime（准备层与执行层）

**位置**：`src/runtime/runtime-types.ts`、`runtime-factory.ts`、`base-chat-runtime.ts`（413 行）、`src/runtime/pi/harness-chat-runtime.ts`（360 行）
**职责**：
- `BaseChatRuntime` —— **准备层**：提示装配（记忆召回、时间、上下文项、skill 清单、slash 契约、生成计划、文件操作契约）、强制技能解析、短确认/延续检测、工具集收窄、生成质量校验、回合留存
- `HarnessChatRuntime` —— **执行层**：解析模型句柄、取会话、构造 pi `AgentHarness`、桥接事件到 `StreamEvent`、审批终止、运行错误累积、entryId 锚定、触发压缩
**依赖**：`utils/file-operation-contract`、`services/generation-quality`、`services/generation-strategy-service`、`skills/{skill,tool}-registry`、`src/runtime/pi/*`
**被依赖**：`ModelService`
**关键点**：`createChatRuntime()` **恒**返回 `HarnessChatRuntime`（单实现）；`prepareTurn` 的装饰进 `systemPrompt`（不持久化），干净原文进 `prompt`（持久化）

---

## pi 原生适配层

**位置**：`src/runtime/pi/pi-native-model.ts`、`pi-tool-adapter.ts`、`pi-event-adapter.ts`、`pi-approval-policy.ts`
**职责**：
- `pi-native-model` —— `ProviderConfig` → pi-ai `Model`；注入 apiKey 的无状态 `completeSimple` 工厂；OpenCode Go 会话头
- `pi-tool-adapter` —— `ToolDefinition` → pi `AgentTool`（超时、执行模式推断、白名单硬门、审批 `terminate`）
- `pi-event-adapter` —— pi 事件 → `StreamEvent`；工具结果解包
- `pi-approval-policy` —— 审批响应识别与文案、文件写入状态机、最终文本解析
**依赖**：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`（类型）、`skills/*`、`services/workspace-edit-service`、`utils/file-operation-contract`
**被依赖**：`HarnessChatRuntime`、`ModelService`、`runtime-types`
**关键点**：这是**唯一**接触 pi 类型与 API 形状的层；pi 值导入必须走动态 `import()`

---

## Harness 会话与执行环境

**位置**：`src/runtime/pi/harness-session-manager.ts`（453 行）、`vault-session-fs.ts`（287 行）、`harness-env.ts`（142 行）、`session-branch-projector.ts`（142 行）
**职责**：
- `HarnessSessionManager` —— per-conversation 长生命持久会话（open-or-create、并发去重、release、purge）、`hasHistory`、审批结果回灌（`appendApprovalOutcome`）、分支原语（`getBranchEntries` / `moveToBranch` / `prepareForkAtUser` / `supersedeUserEntry`）、自动压缩判定（`maybeCompact`）
- `VaultSessionFileSystem` —— pi `JsonlSessionRepo` 的 FileSystem 契约，落在 Obsidian vault adapter 上（移动端安全，不碰 node fs）
- `HarnessExecutionEnv` —— pi `ExecutionEnv`（FileSystem + 无 shell），临时目录在 `.obsidian/baizer-tmp`
- `projectBranchToMessages` —— pi 会话树 → `ChatMessage[]` 投影（过滤作废分支）
**依赖**：`@earendil-works/pi-agent-core`（动态 import + 类型）、`utils/logger`
**被依赖**：`ModelService`、`HarnessChatRuntime`
**关键点**：手写 `PiSession` / `PiSessionRepo` / `CompactionSettings` 结构镜像以规避 ESM-only value import——上游变更不被编译器捕获

---

## 运行中控制

**位置**：`src/runtime/active-run-controller.ts`（84 行）、`src/runtime/pi/prompt-template-service.ts`（127 行）、`src/runtime/provider-capabilities.ts`
**职责**：
- `ActiveRunController` —— 持有当前活跃 harness 引用，把"补话"与"动态工具集"转发给 pi 原生 `steer()` / `setActiveTools()`（自动补回 `read_skill`）；`steer()` 的返回值是**语义必需**（false = 模型不会看到）
- `PromptTemplateService` —— 加载 `.obsidian/baizer-commands/*.md`，列出/解析/展开用户命令（懒加载 + 同步快照）
- `ProviderCapabilities` —— 声明式 provider 能力描述
**依赖**：`@earendil-works/pi-agent-core`（动态 import，prompt 模板）、`utils/logger`
**被依赖**：`ModelService`、`HarnessChatRuntime`、`ShellView`
**关键点**：取代了旧的自造 `SteeringController`（FIFO 队列 + `prepareNextTurn` 钩子）——那是重造 harness 已有能力

---

## 工具注册表

**位置**：`src/skills/tool-registry.ts`（95 行）
**职责**：原子工具的注册、查找、`ToolDefinition` 转换、执行（含 `signal` 透传与错误包装）、`getSettings()`。
**依赖**：`obsidian`、`src/mcp/types`、`src/models/interfaces`、`src/skills/types`
**被依赖**：`BaseChatRuntime`、`pi-tool-adapter`、`SkillRegistry`、`main.ts`、`ModelService`
**关键点**：每次执行用**浅拷贝 ctx**（而非 mutate 共享 ctx），避免并发工具间 signal 串台；未知工具返回 `{ error }` 而非抛错

---

## 技能注册表

**位置**：`src/skills/skill-registry.ts`（401 行）、`skill-files.ts`（376 行）、`pi-skill-source.ts`（95 行）
**职责**：
- `SkillRegistry` —— 内置/用户/插件技能的注册、物化路径解析、物化写盘、发现（pi `formatSkillsForSystemPrompt`）、激活（pi `formatSkillInvocation`）、路由（斜杠命令 / 关键词意图，加权打分阈值 2 分）、注销与命令索引维护
- `skill-files` —— 技能目录与文件名常量、确定性路径计算、物化写盘、目录列举（跳过内置自身物化目录）
- `pi-skill-source` —— SKILL.md 解析（pi Skill 模型 + YAML frontmatter + Baizer sidecar：`tools` / `triggers`）
**依赖**：`@earendil-works/pi-agent-core`（类型 + 动态 import 格式化器）、`ToolRegistry`、`obsidian`
**被依赖**：`BaseChatRuntime`、`main.ts`、`PluginWatcher`、`ModelService`、`read_skill` 工具
**关键点**：**空 `tools` 声明 = 不限制**；可用性唯一来源是 `settings.disabledSkills`

---

## 内置技能与工具

**位置**：`src/skills/builtin/`（7 个技能目录 + `read-skill.ts`）
**职责**：内置 SKILL.md 与工具实现：

| 技能 | 命令 | 关键词触发 | 工具子集 |
|---|---|---|---|
| `web-search` | — | 搜索/搜一下/search/google/最新/新闻 | `web_search` |
| `web-clipper` | `/save` | 剪藏/clip/网页/webpage/youtube/bilibili/微信公众号 | `save_webpage` |
| `knowledge` | `/wiki:query` | 知识库/knowledge/wiki | `query_knowledge`、`file_back_knowledge`、`search_vault` |
| `plugin-ctrl` | — | 插件/plugin/plugins | `list_plugins`、`get_plugin_commands`、`get_plugin_settings`、`execute_plugin_command` |
| `json-canvas` | — | canvas/mind map/flowchart/diagram/.canvas | `read_file`、`create_file`、`update_file`、`search_vault`、`open_file`、`validate_json_canvas` |
| `obsidian-bases` | — | bases/.base/table view/card view/filter/formula/database | `read_file`、`create_file`、`update_file`、`search_vault`、`open_file`、`validate_base_yaml` |
| `obsidian-markdown` | — | wikilink/callout/frontmatter/embed/markdown/tags | `read_note`、`create_note`、`update_note`、`append_to_note`、`search_vault`、`list_notes`、`open_file` |

以及 `vault-ops.ts`（12 个 vault 工具，独立注册，不属于任何技能子集收窄对象）。
**依赖**：`permissions/permission-service`、`ToolRegistry`、`ModelService`（web-clipper 摘要）
**被依赖**：`main.ts`（注册）
**关键点**：SKILL.md 经 esbuild text loader 内联进 bundle；技能**自身不执行任何东西**，只改变模型读什么

---

## 插件控制与派生技能

**位置**：`src/skills/builtin/plugin-ctrl/plugin-watcher.ts`（767 行）、`skill-generator.ts`（666 行）、`executor.ts`（216 行）
**职责**：
- `PluginWatcher` —— 监听其它 Obsidian 插件的启停/安装，为它们生成 `plugin-<id>` 派生技能；**每次启动对账**，来源消失/禁用/被排除/无权限时撤下技能（策略集中在 watcher）
- `PluginSkillGenerator` —— 读插件 manifest 与命令清单，用无状态 LLM 生成 SKILL.md；记录 `generationFailures`
- `executor` —— 4 个 plugin-control 工具的实装（含配置值脱敏）
**依赖**：`SkillRegistry`、`ModelService`、`ToolRegistry`、`obsidian`、`permissions`
**被依赖**：`main.ts`、设置页
**关键点**：派生技能是**唯一**违反"可用性与权限正交"的例外——`plugin-*` 仅在插件控制权限授予时生成与提供；任何注册路径都要过 `withdrawalReason`，任何生成路径都要写 `generationFailures`

---

## 权限服务

**位置**：`src/permissions/permission-service.ts`（112 行）
**职责**：把"要不要拦 / 要不要批"收敛为纯函数：`checkWriteScope`、`checkFileCapability`、`checkPluginControl`、`needsApproval`、`canWriteToVaultTarget`。
**依赖**：`src/mcp/types`、`src/skills/types`（仅类型）
**被依赖**：全部 vault 写工具、plugin-ctrl 工具、`pi-tool-adapter` 间接
**关键点**：**不含任何硬编码策略常量**——只读设置执行；`activeNote` 由调用方从 `ctx.app` 取出后传入以保持可单测；审批**载荷**（rich ChangePreview）不进本层，仍由各工具自造

---

## 知识子系统

**位置**：`src/knowledge/`（13 个文件，共约 3200 行）
**职责**：知识 Wiki 的完整生命周期。
- `runtime.ts`（658 行）—— 生命周期门面：注册 `/wiki:compile|index|lint` 命令、vault 事件、去抖 5 秒的自动编译（含打满批次后的补跑）、本体加载与发现、Guardian 上下文（浅/深两档）、设置热更新
- `compiler.ts`（752 行）—— Map-Reduce 编译、分块、归并、提示构造、响应解析、摘要 Markdown 生成、内容哈希
- `indexer.ts` / `metadata-index.ts` —— 索引重建与 `.base` 文件生成
- `frontmatter.ts` —— 编译状态读写、`sourceId` 生成、按状态筛选、未注册文件发现
- `ontology.ts` / `ontology-service.ts` —— 本体模式解析、校验、哈希、发现提示与响应解析、状态与就绪度
- `query.ts` / `file-back.ts` —— 检索执行器与归档执行器（暴露为工具）
- `linter.ts` —— 缺摘要 / 低置信抽取 / 孤儿概念检查与健康报告
- `watcher.ts` —— 源文件夹监听与入队判定
- `status-service.ts` —— 面板状态与全局计数
**依赖**：`ModelService.generate`（注入回调）、`obsidian`、`utils/throttle`、`utils/logger`
**被依赖**：`main.ts`、`ModelService`、`GuardianCompletionService`
**关键点**：编译产出在 `<knowledgeWikiFolder>/Articles/`；每篇源笔记的编译状态在自身 frontmatter 中

---

## 记忆子系统

**位置**：`src/memory/`（7 个文件，共约 2100 行）
**职责**：本地 Hindsight 语义记忆。
- `memory-manager.ts`（785 行）—— 门面：召回（BM25 + 可选查询扩展 + 一跳实体图 + 矛盾更新）、沉淀（fire-and-forget，`flush()` 排空）、整合触发、`/memory` 视图与变更、`retainLesson`、`getMentalModelBlock`
- `hindsight-store.ts` / `hindsight-retriever.ts` / `hindsight-consolidator.ts` —— 存储、检索、周期性整合
- `hindsight-types.ts` —— 记录类型、tokenizer、去重、超时包装、id 生成
- `hindsight-migration.ts` —— 旧记忆文件导入与迁移（隐私模式跳过）
- `types.ts` —— `MemoryView` / `MemoryMutationResult` / `UserProfile`
**依赖**：`obsidian`、`utils/logger`、注入的 `generate` 回调
**被依赖**：`ModelService`、`BaseChatRuntime`（`recallForPrompt`）、`GuardianCompletionService`
**关键点**：数据在 `.obsidian/baizer-memory/`；与知识 Wiki **完全独立**，互不流动

---

## UI 层：Workbench

**位置**：`src/ui/shell-view.ts`（2203 行）、`chat-controller.ts`（1210 行）、`renderers/`、`tabs/`、`history/`、`state/`、`components/`、`controllers/`、`approval-card.ts`、`diff-modal.ts`、`diff/`
**职责**：
- `ShellView` —— 主工作台视图（`ItemView`）：视图生命周期、命令解析、`@` 文件补全与 `/` 命令补全、建议弹窗、流式内容渲染与时间线折叠、上下文芯片、附件与拖放、心跳/活动指示、Tab 管理、审批 ghost 预览
- `ChatController` —— 一轮对话的编排（ADR-0002：记录与绘制分离，它是消息列表的**唯一作者**）：消费 `StreamEvent`、文件写入文本缓冲、审批卡片、工作区编辑撤销、👍/👎 反馈、`/clear`
- 渲染器 —— `MessageRenderer`、`ThinkingRenderer`、`ToolRenderer`、`CodeBlockRenderer`、`stream-block-splitter`
- Tab 与历史 —— `TabManager` / `TabBar`、`ConversationStore` / `ConversationController` / `HistoryMenu`
- 组件 —— `CommandDropdown`、`SuggestList`、`ContextChips`、`InputToolbar`、`KnowledgeStatusPanel`、`AttachmentModal`、`ChangePreviewCard`
- 控制器 —— `InputController`、`ContextController`、`StreamController`
**依赖**：`ModelService`、`src/models/interfaces`、`src/i18n`、`obsidian`、`@codemirror/*`
**被依赖**：`main.ts`
**关键点**：`ShellView` 与 `ChatController` 均超 1000 行，是仓库最大的两个 UI 单元

---

## UI 层：Guardian 与选区

**位置**：`src/ui/guardian-completion.ts`（1039 行）、`ghost-text.ts`（283 行）、`guardian-gutter.ts`（204 行）、`selection-menu.ts`（522 行）、`guardian-modal.ts`、`guardian-request.ts`、`guardian-styles.css`、`selection-ai/`
**职责**：
- `GuardianCompletionService` —— 快/深两条补全路径的决策与执行：触发判定（禁用/自动关闭/忽略文件夹/空/过短）、上下文组装、知识库注入、个人记忆召回、无状态生成、响应解析、质量门控、缓存、诊断事件
- `ghost-text` —— CM6 装饰字段与键映射（Tab 接受、Esc 丢弃）、aria-live 播报
- `guardian-gutter` —— 行内状态点 gutter（thinking / suggestion / paused）
- `selection-menu` —— 选区悬浮工具条（改写/解释等）、`@` 触发、内嵌聊天面板、可拖拽浮窗
- `selection-ai/` —— 动作注册表、浮窗、选区上下文构造器
**依赖**：`ModelService`、`KnowledgeRuntime`（上下文）、`@codemirror/state`、`@codemirror/view`、`obsidian`
**被依赖**：`main.ts`
**关键点**：快/深各有独立 `AbortController`；每锚点最多升级到深路径一次；质量门控的 `weak` 软信号也纳入升级触发

---

## 服务层（横切）

**位置**：`src/services/`（13 个文件，不含 `model-service.ts`）
**职责**：

| 模块 | 职责 |
|---|---|
| `generation-strategy-service.ts` | 依来源/上下文/画像解析生成计划与写作画像；格式化计划块 |
| `generation-quality.ts` | 生成质量评估（相对原文与计划） |
| `workspace-edit-service.ts` | 工作区编辑的应用、撤销、列表；`isDirectApplyWorkspaceTool` |
| `operation-audit-log.ts` | 操作审计日志（`.obsidian/baizer/operations.json`） |
| `obsidian-context-service.ts` | 采集当前笔记快照（标题、frontmatter、标签、出入链、反链、近期笔记） |
| `context-manager.ts` / `context-budget.ts` | 上下文项管理与预算裁剪 |
| `model-catalog-service.ts` | 列模型、探活、provider 能力 |
| `clip-input.ts` / `clip-protocol.ts` | URL 提取、剪藏保存、`obsidian://baizer-clip` 协议 |
| `inbox-autosave.ts` | 监听收件箱笔记中的裸 URL 并自动剪藏 |
| `video-transcription.ts` | 音频转录（非 pi 路径的旁路） |
**依赖**：`obsidian`、`ModelService`（部分）、`utils/*`
**被依赖**：`ModelService`、`main.ts`、`BaseChatRuntime`、UI

---

## 国际化

**位置**：`src/i18n/zh.ts`、`zh-messages.ts`（504 行）
**职责**：`Locale = 'auto' | 'en' | 'zh'`；`setLocale` / `getLocale` / `t(key)`；系统语言自动探测（`navigator.language`）；`setLocaleForTesting`。仅影响面向用户的 UI 文案，**不影响 LLM prompt**。
**依赖**：无（叶子模块）
**被依赖**：`main.ts`、UI 层、设置页

---

## 工具与契约库

**位置**：`src/utils/`（4 个文件）
**职责**：

| 模块 | 职责 |
|---|---|
| `logger.ts` | 单例日志（分级、元数据格式化） |
| `throttle.ts` | `throttle` / `debounce` / `ThrottleMap` |
| `file-operation-contract.ts` | 文件写入契约文本、写入工具名集合、请求识别、结果判定、失败文案、结果路径提取 |
| `video_utils.ts` | 视频转录提取（YouTube / Bilibili） |
**依赖**：无（叶子模块）
**被依赖**：广泛

---

## 共享类型与设置模式

**位置**：`src/models/interfaces.ts`、`src/mcp/types.ts`（323 行）、`src/skills/types.ts`（140 行）
**职责**：
- `models/interfaces.ts` —— `StreamEvent`、`ToolDefinition`、`ChatMessage`、`ChatContextItem`、`GenerationOptions`、`ModelOption`、`ToolCall`、`ToolResult`
- `mcp/types.ts` —— 品牌常量（`PLUGIN_ID`/`PLUGIN_NAME`/`VIEW_TYPE_SHELL`/`MEMORY_DIR`/`PLUGIN_DATA_DIR`）、`ProviderConfig`、`DEFAULT_PROVIDERS`、`PluginSettings`、`DEFAULT_SETTINGS`、`mergeProviderDefaults`、`IPlugin`、Obsidian `App` 模块增强
- `skills/types.ts` —— `Tool`、`ToolContext`、`ToolParameters`、`Skill`、`SkillTriggers`、`ActivatedSkill`、`ResolvedSkill`、`SkillSummary`
**依赖**：无（或仅 `obsidian` 类型）
**被依赖**：几乎所有模块
**关键点**：这是**底层叶子层**——`mcp/types.ts` 用最小结构类型声明 `pluginWatcher?`，明确不反向依赖 skills 层

---

## 构建与测试工程

**位置**：`esbuild.config.mjs`、`tsconfig.json`、`tsconfig.test.json`、`eslint.config.mjs`、`package.json`、`manifest.json`、`versions.json`、`test/`（95 个测试 + runner + 替身）、`scripts/`（3 个脚本）、`.github/workflows/ci.yml`
**职责**：单文件 CJS bundle 构建（含 pi provider 存根与静态资源拷贝）、双 tsconfig（源码 ESNext / 测试 commonjs）、ESLint 9 flat config、自建测试 runner（`execSync` 逐文件跑 `tsx`）、CI 四步（build → test → lint 阻断 → tsc 非阻断）、许可证生成与启动性能探针。
**依赖**：esbuild、typescript、eslint、tsx、obsidian（类型）
**被依赖**：无（工程边界）
**关键点**：`stub-unused-pi-providers` 用正则匹配 pi-ai `providers/` 下的相对文件名——上游改名即静默失效
