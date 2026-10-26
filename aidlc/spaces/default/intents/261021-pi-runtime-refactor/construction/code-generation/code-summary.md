# Code Summary —— pi 运行时底座重构

本文件记录本次 Code Generation 的已创建/修改文件、关键实现决策、符号迁移映射、测试覆盖摘要与偏差。

## 符号迁移映射（Step 2.2）

来源：`aidlc/spaces/default/codekb/obsidian-cli/technology-stack.md` §8 的**逐项清单**（值导入 13 个 = pi-agent-core 12 个 + pi-ai 1 个；类型导入 10 个 = pi-agent-core 8 个 + pi-ai 2 个）。逐项核对了 `node_modules/@earendil-works/pi-agent-core@1.3.0/dist/*.d.ts` 与 `@earendil-works/pi-ai@1.3.0/dist/*.d.ts` 的实际导出。

### pi-agent-core 值导入（12 项）

| 符号 | 0.75.5 用途 | 1.3.0 去向 | 处置 |
|---|---|---|---|
| `AgentHarness` | 驱动工具循环、会话、事件的顶层类 | **直接替换为 `Agent` 类**（`agent.d.ts` 导出 `class Agent`，`AgentOptions`/`AgentInitialState` 同文件） | 直接替换为 `Agent` |
| `JsonlSessionRepo` | vault 内 JSONL 会话持久化 | 1.3.0 整体移除（连同 `SessionRepo`/`Session`/`FileSystem` 抽象） | 由 Step 3 自建持久化层承接 |
| `InMemorySessionRepo` | 内存临时会话（`conversationId` 缺省时） | 1.3.0 移除 | 由 Step 3 自建持久化层承接（内存会话改为「不注入 session」） |
| `DEFAULT_COMPACTION_SETTINGS` | 压缩阈值默认值（`reserveTokens`/`keepRecentTokens`/`enabled`） | 1.3.0 移除 | 由 Step 3.7 `maybeCompact` 自建常量承接 |
| `buildSessionContext` | 把 session entries 转成模型上下文消息 | 1.3.0 移除 | 由自建投影算法承接（`session-branch-projector` 的继任者） |
| `estimateContextTokens` | 估算上下文 token（优先真实 provider usage） | 1.3.0 移除 | 由 Step 3.7 自建估算承接（读 assistant message 的真实 usage） |
| `shouldCompact` | 压缩阈值判定 `tokens > (window - reserve)` | 1.3.0 移除 | 由 Step 3.7 自建阈值判定承接 |
| `formatSkillsForSystemPrompt` | 生成系统提示里的 skill 清单 | 1.3.0 移除 | 不再需要（`skill-registry` 自建清单文本，见 Step 4.5） |
| `formatSkillInvocation` | 斜杠/强制激活时包装 skill 完整正文 | 1.3.0 移除 | 不再需要（同上） |
| `loadPromptTemplates` | 从 `env` + 目录加载 prompt 模板 | 1.3.0 移除 | 不再需要（`prompt-template-service` 改为自建加载，见 Step 4.5） |
| `parseCommandArgs` | shell 风格切分命令参数 | 1.3.0 移除 | 不再需要（自建切分） |
| `substituteArgs` | 替换 `$ARGUMENTS`/`$1`/`${@:N}` 占位符 | 1.3.0 移除 | 不再需要（自建替换） |

### pi-ai 值导入（1 项）

| 符号 | 1.3.0 去向 | 处置 |
|---|---|---|
| `completeSimple` | 主入口 `@earendil-works/pi-ai` 的 `index.d.ts` **不再导出** free function（改为 `createModels()` 返回的 `Models` 实例方法）；但 **`@earendil-works/pi-ai/compat` 子路径仍导出** `completeSimple`/`streamSimple`/`registerApiProvider`/`getApiProvider` 等旧全局 API（文件头注明 "Temporary compatibility entrypoint"，随 coding-agent ModelManager 迁移删除） | 经 `/compat` 继续可用（本计划采用；`createModels()` 迁移属后续独立任务） |

### pi-agent-core 类型导入（8 项）

| 符号 | 1.3.0 去向 | 处置 |
|---|---|---|
| `AgentTool` | 仍在（`types.d.ts`，字段扩展为含 `label`/`outputSchema`/`executionMode`/`replay`） | 保留，签名需按 1.3.0 调整（Step 4.x） |
| `ToolExecutionMode` | 仍在（`types.d.ts`） | 保留 |
| `StreamFn` | 仍在（`types.d.ts`，签名改为 `(model, TranscriptContext, options?) => AssistantMessageEventStream`） | 保留 |
| `Skill` | 1.3.0 移除 | 由本地类型承接（`skill-registry` 已有本地 `PiSkill` 结构） |
| `FileError` | 1.3.0 移除（随 `FileSystem` 抽象一起） | 不再需要 |
| `FileErrorCode` | 1.3.0 移除 | 不再需要 |
| `FileInfo` | 1.3.0 移除 | 不再需要 |
| `Result` | 1.3.0 移除 | 不再需要 |

### pi-ai 类型导入（2 项）

| 符号 | 1.3.0 去向 | 处置 |
|---|---|---|
| `Model` | 仍在（`types.d.ts`） | 保留 |
| `AssistantMessage` | 仍在（`types.d.ts`） | 保留 |

### 配置面与事件面（§8 补充说明的 8 字段 / 4 类事件）

| 0.75.5 配置字段 | 1.3.0 去向 | 处置 |
|---|---|---|
| `env`（`ExecutionEnv` = FileSystem + Shell） | **`AgentOptions` 已无此字段**——1.3.0 的 `Agent` 不再持有文件系统/Shell 抽象，工具自带 `execute` 自行完成 I/O | 不再需要（`harness-env.ts` 的 ExecutionEnv 构造随之退役；Baizer 的 vault I/O 本就走自建工具 + `vault.adapter`） |
| `session` | **`AgentOptions` 已无此字段**（`sessionId?: string` 仅作为 provider 缓存路由标识） | 由 Step 3 自建持久化层承接 |
| `model` | 移入 `initialState.model` | 直接替换为 `initialState.model` |
| `tools` | 移入 `initialState.tools` | 直接替换为 `initialState.tools` |
| `systemPrompt` | 移入 `initialState.systemPrompt`（并成为 transcript 首条 system message） | 直接替换为 `initialState.systemPrompt` |
| `thinkingLevel` | 移入 `initialState.thinkingLevel` | 直接替换为 `initialState.thinkingLevel` |
| `getApiKeyAndHeaders` | **直接替换为 `getApiKey`**（`(provider: string) => string \| undefined \| Promise<...>`，**只返回 key、不再返回 headers**） | 直接替换为 `getApiKey`；自定义 header 改经 `streamFn` 的 `SimpleStreamOptions.headers` 注入（见 Step 4.1，保留 `resolveCustomHeaders`/`buildOpenCodeGoHeaders` 行为） |
| `afterToolCall` | 仍在，但签名改为 `(context: AfterToolCallContext, signal?) => Promise<AfterToolCallResult \| undefined>`；`terminate` 语义仍在（批量早停） | 保留，签名按 1.3.0 调整（Step 4.1） |

| 0.75.5 事件 | 1.3.0 去向 | 处置 |
|---|---|---|
| `message_update`（含 `assistantMessageEvent`） | 仍在 | 保留（文本增量映射） |
| `tool_execution_start` / `tool_execution_end` | 仍在（`end` 新增 `durationMs`） | 保留（工具调用/结果映射） |
| `turn_end` / `agent_end` | 仍在 | 保留（回合结束映射） |
| — | **1.3.0 新增**：`agent_start`、`turn_start`、`message_start`、`message_end`、`tool_execution_update` | 需按 `functional-spec.md` §4 决策表逐型决策（Step 4.2/4.3，BR3.1） |

### 需要额外注意的两处「语义反转」

1. **`streamFn` 从可选变必填**：0.75.5 的 `AgentHarness` 内部按 `model.api` 路由到 pi api-registry、**不接受注入 streamFn**（见 `runtime-types.ts:30` 的 `@deprecated` 注释）；1.3.0 的 `AgentOptions.streamFn` 是**必填字段**。因此 `NativeChatHandle` 的 `streamFn` 从「已弃用」变为「唯一注入路径」，`runtime-types.ts` 的弃用注释需随之校正（Step 4.1）。
2. **`nativeChatFactory` 的 `getHeaders` 不再是 Harness 回调**：0.75.5 经 `getApiKeyAndHeaders` 一起返回；1.3.0 只能经 `streamFn(model, context, options)` 的 `options.headers` 透传，或经 `models.transformHeaders`。自定义 header 机制（`resolveCustomHeaders`/`buildOpenCodeGoHeaders`，来自合并 `577e9ef`）必须保留其可观察行为（Step 4.1 显式核对）。

## 升级后的基线失败清单（Step 2.3）

命令：`npx tsc -p tsconfig.json --noEmit` 与 `npm run build`。

**结论**：`npm run build` **成功**（esbuild 不做类型检查，符号消失不影响打包），产出 `dist/main.js` = **1.92 MB**（< 5 MB 红线）。失败点全部集中在 `tsc`，共 **13 个错误**：

| # | 位置 | 错误 | 归类 |
|---|---|---|---|
| 1-3 | `src/runtime/pi/harness-env.ts:1` | `FileError` / `FileInfo` / `Result` 无导出成员 | pi-agent-core `FileSystem` 抽象移除（Step 4.x 退役 `harness-env.ts`） |
| 4 | `src/runtime/pi/pi-native-model.ts:227` | `completeSimple` 不存在于 `pi-ai` 主入口 | 改走 `@earendil-works/pi-ai/compat`（Step 4.5） |
| 5-8 | `src/runtime/pi/vault-session-fs.ts:1` | `FileError` / `FileErrorCode` / `FileInfo` / `Result` 无导出成员 | 同上；本文件自建为纯 `VaultFileAdapter`（Step 3.7） |
| 9 | `src/skills/pi-skill-source.ts:15` | `Skill` 无导出成员 | pi 不再提供 `Skill` 类型（Step 4.5 本地类型承接） |
| 10 | `src/skills/skill-registry.ts:10` | `Skill` 无导出成员 | 同上 |
| 11-13 | `src/skills/skill-registry.ts:135,137,138` | `LoadedSkill \| null` 未窄化 | 级联自 #9/#10（`LoadedSkill` 类型因 `Skill` 导入失败而破损），随 Step 4.5 一并消失 |

**Step 3.7 后的现状：13 → 9 个错误**（#5-8 随 `vault-session-fs.ts` 改用本地结构定义而消失，`harness-env.ts` 的 #1-3 未级联增加）。剩余 9 条全部落在后续步骤的文件里：#1-3 → Step 4.1（退役 `harness-env.ts`）、#4 与 #9-13 → Step 4.5。Step 3.7 新增/修改的文件（`harness-session-manager.ts`、`session-branch-projector.ts`、`conversation-session.ts`、`store.ts`、`types.ts`、`harness-chat-runtime.ts`、`vault-session-fs.ts`）**零 tsc 错误**。`npm run build` 仍成功，`dist/main.js` = **2.04 MB**（< 5 MB）。

**Step 4.1/4.2 后的现状：9 → 5 个错误**（`npx tsc -p tsconfig.json --noEmit`）。`harness-env.ts` 的 #1-3（`FileError`/`FileInfo`/`Result`）已不再出现——该文件已改走 `vault-session-fs.ts` 的本地结构定义（非 pi 导出），早于本轮会话完成；本轮核实未回归。剩余 5 条全部是 Step 4.5 的范围（`pi-skill-source.ts`/`skill-registry.ts` 的 `Skill` 类型导入与级联的 `LoadedSkill | null` 窄化）。`src/runtime/pi/pi-event-adapter.ts`、`src/models/interfaces.ts`、`src/runtime/pi/harness-session-manager.ts`、`src/runtime/pi/harness-chat-runtime.ts` 本轮改动**零 tsc 错误**。

**未在本步修复**（按计划要求只记录）。注：`src/runtime/pi/session-store/store.ts` 自身曾有一条 TS6133（我引入的未使用局部变量），已在本步顺手清掉，不计入基线。

**与 `harness-chat-runtime.ts` / `harness-session-manager.ts` 的关系**：这两个文件当前对 pi 全走 `(pi as any)` 动态取符号（`harness-chat-runtime.ts:74,81` 的 `new (pi as any).AgentHarness`、`harness-session-manager.ts:136` 的 `mod.JsonlSessionRepo`），因此**不在 tsc 失败清单里**——类型检查器看不到它们，错误被 `as any` 吞掉了。这正是 FR3.1 要消除的「`as any` 构造」，也是 Step 4.1 的修复目标：去掉 `as any` 后这些错误才会显形。

## 已创建/修改文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `package.json` / `package-lock.json` | 修改 | `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 由 `^0.75.5` 改为精确 `1.3.0`（Step 2.1） |
| `src/runtime/pi/session-store/types.ts` | 新增 | `Session`/`Entry` 两层数据模型 + 两条实体级约束校验函数（Step 3.1）；Step 3.7 追加各类 Entry 的 payload 契约（`MessagePayload` 等）与 `SUPERSEDED_PENDING_MARKER` |
| `src/runtime/pi/session-store/store.ts` | 新增 | Session/Entry 读写仓储：vault adapter 落盘、`activeLeafEntryId` 指针更新、`supersededByEntryId` 标记、只读降级拒绝写入、`open()` 作为 BR1.1/1.2/1.3 的唯一入口（Step 3.3、3.5）；Step 3.7 追加 `legacyPath` 入口（旧命名文件迁移）、`openDegraded()`、读失败降级 |
| `src/runtime/pi/session-store/migrate.ts` | 新增 | 格式判定（BR1.1）、旧格式迁移（BR1.2）、迁移失败只读兜底读取（BR1.3）（Step 3.5） |
| `src/runtime/pi/session-store/compaction.ts` | 新增 | 自建压缩判定（阈值/估算逐值对齐 pi 0.75.5）（Step 3.7 复用） |
| `src/runtime/pi/session-store/memory-adapter.ts` | 新增 | 内存版 VaultFileAdapter（临时会话与单测）（Step 3.7 复用） |
| `src/runtime/pi/session-store/conversation-session.ts` | 新增 | 会话读写句柄 `ConversationSession` + 分支回溯 `resolveBranch` + 模型消息投影 `buildModelMessages`（Step 3.7） |
| `src/runtime/pi/harness-session-manager.ts` | 重写 | 内部实现全部改接自建持久化层；对外方法签名与可观察行为不变；退役手抄的 `PiSession`/`PiSessionRepo`/`CompactionSettings` 结构镜像（Step 3.7、FR3.2） |
| `src/runtime/pi/session-branch-projector.ts` | 重写 | 分支投影改吃 `Entry[]`（entities.md 模型），退役 pi 的 `SessionTreeEntry` 镜像与 `SUPERSEDED_LABEL` label 条目机制（Step 3.7） |
| `src/runtime/pi/harness-chat-runtime.ts` | 修改 | 会话读取改走 `ConversationSession`；entryId 锚定改按 `Entry.kind` 判定；新增 BR1.3 只读降级提示（Step 3.7） |
| `src/runtime/pi/vault-session-fs.ts` | 修改 | 去掉对 pi 已移除的 `FileError`/`FileErrorCode`/`FileInfo`/`Result` 的导入，改本地结构定义（Step 3.7） |
| `test/session-store-types.test.ts` | 新增 | 7 条（Step 3.2） |
| `test/session-store-branching.test.ts` | 新增 | 8 条（Step 3.4） |
| `test/session-store-migration.test.ts` | 新增 | 15 条（Step 3.6） |
| `test/harness-session-manager-regression.test.ts` | 新增 | 15 条（Step 3.8） |
| `test/run-tests.ts` | 修改 | 注册上述四个新测试文件 |
| `src/runtime/pi/pi-event-adapter.ts` | 修改 | 按 functional-spec §4 决策表逐型实现 + 决策依据写入文件头（Step 4.2） |
| `src/models/interfaces.ts` | 修改 | 新增 `StreamEvent.compaction` 变体（Step 4.2） |
| `src/runtime/pi/harness-session-manager.ts` | 修改 | `maybeCompact` 返回 `MaybeCompactResult`（Step 4.2） |
| `src/runtime/pi/harness-chat-runtime.ts` | 修改 | 压缩真实发生时产出 `StreamEvent.compaction`（Step 4.2） |
| `src/skills/pi-skill-source.ts` | 修改 | 本地 `PiSkill` 类型 + 自建 `formatSkillsForSystemPrompt`/`formatSkillInvocation`（Step 4.5） |
| `src/skills/skill-registry.ts` | 修改 | 改用本地类型与格式化器；删 `PiFormatters`/`formatters`/`init()`（Step 4.5） |
| `src/runtime/pi/prompt-template-service.ts` | 修改 | 自建 `loadPromptTemplates`/`parseCommandArgs`/`substituteArgs`（Step 4.5） |
| `src/services/model-service.ts` | 修改 | `harnessEnv` 由 `unknown` 收紧为 `PromptTemplateEnv \| null`（Step 4.5） |
| `main.ts` | 修改 | 删掉已无作用的 `skillRegistry.init()` 调用（Step 4.5） |
| `esbuild.config.mjs` | 修改 | 新增 `strip-json-import-attributes`、`stub-unused-pi-apis`；扩展 `stub-unused-pi-providers`（Step 5.1） |
| `test/pi-event-adapter.test.ts` | 修改 | +6 条"丢弃/不适用"确认不产出用例（Step 4.3） |
| `test/cross-phase-smoke.test.ts` | 修改 | `/compat`、新模型断言、补 `summarize` 与 `keepRecentTokens`（Step 4.1/4.5） |
| `test/harness-chat-runtime.test.ts` | 修改 | `registerApiProvider` 改走 `/compat`（Step 4.1） |
| `test/steering.test.ts` | 修改 | 同上（第三处同根因） |
| `test/harness-session-manager-regression.test.ts` | 修改 | 修正与 `kept > 0` 守卫矛盾的压缩断言（Step 4.5） |

## 关键实现决策

### 旧格式迁移的结构保真策略（Step 3.5）

旧格式（pi 0.75.5 `JsonlSessionRepo`，session version 3）的权威依据取自该版本 `dist/harness/session/jsonl-storage.js` 与 `session.js`（临时装入项目内 `.scratch-old-pi` 读取后已删除；`node_modules` 里已无 0.75.5）。迁移时做了三处关键取舍：

1. **保留旧 id 作为新 Entry.id**，而非重新生成——便于回溯，且旧文件里 `label`/`leaf` 条目的 `targetId` 引用仍然可解析。
2. **重定父而非补空条目**。旧树里夹着 7 类不产生新 Entry 的元数据条目（`label`/`leaf`/`thinking_level_change`/`model_change`/`custom`/`session_info`/`branch_summary`）。直接丢弃会让其子条目的 `parentId` 悬空，故每个存活条目的 `parentEntryId` 取「沿旧 `parentId` 链上溯的第一个存活条目」。消息层语义不变——旧投影的兄弟判定本就只看同一 `parentId` 下的 `message`，链上夹的元数据对消息层透明。
3. **`label` / `leaf` 从「条目」升为「字段」**。新模型把「重试作废」和「活跃叶子」建模为 `Entry.supersededByEntryId` / `Session.activeLeafEntryId`，而旧格式把它们写成独立条目（`label`、`leaf`）。迁移时：`label` 的 `baizer:superseded` 折叠为目标条目的 `supersededByEntryId`（取代者取同 `parentId` 下时间最早且晚于目标的 user message 兄弟；找不到取代者时保持 null——此时旧投影的作废过滤也无兄弟可过滤，行为等价）；`leaf` 的指针按旧实现 `leafIdAfterEntry` 的逐行推进规则取终值，再回溯到最近的存活条目。

### `availability = read_only_degraded` 是内存态，不落盘（Step 3.5 / BR1.3）

BR1.3 要求「保留原文件不做任何写入或删除」。但 `availability` 按 entities.md 是 Session 的持久字段，而 Session 就存在那个文件里——若写盘就违反了 BR1.3。故降级态只在本次 `open()` 的内存结果里体现，**一个字节都不写**；因为不落盘，下次打开会重新判定并确定性地得到同一结论。`appendEntry` 对该状态抛错，满足「拒绝写入任何新 Entry」。这条路径天然不触碰其他会话文件。

### 判定收敛：新格式要求 `formatVersion` 为合法正整数

entities.md 写「`formatVersion` 缺失该字段视为旧格式」，而 BR1.1 要求按内容特征判定。二者在实现上收敛：新格式判定要求 `record === 'session_meta'` **且** `formatVersion` 是正整数；缺失时既不满足新格式特征，也不满足旧格式的 `type:'session'` header 特征，于是落到 unknown → BR1.3 只读降级。两条读法得到同一结果，且都比「猜成旧格式」更安全。

## 测试覆盖摘要

| 测试文件 | 条数 | 结果 |
|---|---|---|
| `test/session-store-types.test.ts` | 7 | 全绿 |
| `test/session-store-branching.test.ts` | 8 | 全绿 |
| `test/session-store-migration.test.ts` | 15 | 全绿 |
| `test/harness-session-manager-regression.test.ts` | 15 | 全绿 |

Step 3.8 的 15 条按「每条需求至少一条可验证测试」覆盖：per-conversation 隔离与路径独立、跨重启恢复（换 manager 实例、同一 vault + ref 表）、临时会话无持久无跨轮、BR2.1 审批回灌（模型可见 / UI 不可见 + 固定可见性组合）、压缩判定四类跳过条件与两类越阈值行为、无 `compact()` 的能力缺口不抛错、BR1.2 旧文件迁移（经 ref 定位、内容落规范路径、旧文件消费掉、迁移后可写）、BR1.3 只读降级（原文件零写入、不静默重建空会话、不影响其他会话、拒绝新 Entry）、`clear` 原地重置且对降级会话拒绝、`purge` 同时删除规范/旧文件与 ref、重试作废不累积兄弟、分叉可切换且切换不改写 Entry、分支原语对非法目标的拒绝、`release` 只释放内存。

### Step 4 新增/修改的测试

| 测试文件 | 本轮变化 | 结果 |
|---|---|---|
| `test/pi-event-adapter.test.ts` | +6 条（`agent_start`/`turn_end`/`agent_end`/`message_start`/`message_end`/`tool_execution_update` 的"确认不产出"） | 18 条全绿 |
| `test/cross-phase-smoke.test.ts` | `/compat`；phaseB 改 `entry.kind`；phase1 两条改 `compaction_summary` + 新增 `StreamEvent.compaction` 正反断言；补 `summarize` 与 `keepRecentTokens` | 14 条全绿 |
| `test/harness-chat-runtime.test.ts` | `/compat` | 18 条全绿 |
| `test/steering.test.ts` | `/compat`（同根因第三处） | 全绿 |
| `test/harness-session-manager-regression.test.ts` | 修正一条与 `kept > 0` 守卫矛盾的压缩断言 | 15 条全绿 |

### 全量回归结果

`test/run-tests.ts` 注册的 **100 个测试文件**全部通过。`test/bundle-size.test.ts` 的软预算曾一度告警，已经人工确认上调到 4.8 MB 解决（见下方"体积预算决策"小节）。**未执行测试：无**（100 个文件全部实际运行过，不存在跳过或未跑的用例）。

## Step 3.7 / 3.8：会话管理器改接自建持久化层

### 退役 pi 结构镜像的方式：不留「兼容形状」垫片（FR3.2）

升级前 `harness-session-manager.ts` 手抄了 `PiSession`/`PiSessionRepo`/`CompactionSettings` 三个 pi 结构镜像，`session-branch-projector.ts` 手抄了 `SessionTreeEntry` 镜像。改造时**没有**做「把新模型映射回旧形状」的兼容垫片——那等于把刚退役的镜像换个地方留着。改为让消费方一起迁到 entities.md 的模型：

| 旧消费方 | 旧形状 | 新形状 |
|---|---|---|
| `HarnessSessionManager.getSession()` | pi `Session`（`getBranch`/`getEntries`/`getLeafId`/`moveTo`/`appendLabel`/`buildContext`/`appendCustomMessageEntry`） | `ConversationSession`（`getBranch`/`getAllEntries`/`getActiveLeafEntryId`/`append`/`moveActiveLeaf`/`markSuperseded`/`buildModelMessages`） |
| `getBranchEntries()` | `PiSessionTreeEntry[]` | `Entry[]` |
| `projectBranchToMessages(branch, all)` | `ProjectorEntry[]`（`type:'message'` + `message.role`，作废靠 `type:'label'` 条目） | `Entry[]`（`kind` + `payload`，作废靠 `supersededByEntryId` 字段） |
| `harness-chat-runtime` 的 entryId 锚定 | `entry.type === 'message' && entry.message.role` | `entry.kind === 'user_message' / 'assistant_message'` |
| `harness-chat-runtime` 的临时会话 | `new InMemorySessionRepo().create({})`（1.3.0 已移除） | `createInMemoryConversationSession()`（内存 adapter 跑同一套 store，逻辑零分叉） |

投影算法的可观察行为逐条对齐旧实现：`visibleToUiProjection=false` 不渲染（BR2.1）、非 user/assistant 不产出消息、空文本跳过、兄弟 ≥2 才附 `branch:{index,count,leafIds}`、`leafIds[k]` 取该兄弟子树按 `createdAt` 最新的叶子。作废过滤从「最新 label === `baizer:superseded`」换成「`supersededByEntryId !== null`」，语义等价。`SUPERSEDED_LABEL` 导出随之退役（`migrate.ts` 自带 `OLD_SUPERSEDED_LABEL` 常量识别旧文件，不受影响）。

### BR1.2 的迁移入口：必须经持久化 ref 定位旧文件，否则迁移代码永不可达

旧文件的路径由 pi 0.75.5 生成（会话 id 命名），与本层「`<sessionsRoot>/<conversationId>.jsonl`」的命名规则不同。若 `open()` 只看规范路径，**升级用户的会话文件永远不会被找到，历史会静默丢失**，而 Step 3.5 写的整套迁移逻辑在生产里等于死代码。

故 `SessionStore.open(conversationId, { legacyPath })` 增加旧路径入口：规范路径不存在但 `legacyPath`（由 `HarnessSessionManager` 从 `loadRef` 解析）存在时，按 BR1.1 判定 → 旧格式则迁移、已是新格式则搬运 → 内容落到规范路径后删掉旧文件（一个会话只留一份；否则用户显式删除会话后，旧文件里的对话原文会作为隐私残留永久留在盘上）。任一失败路径都**不动**旧文件，改走 BR1.3 只读降级。迁移产物的 `conversationId`/`Entry.sessionId` 归一到本次打开的 `conversationId`（旧文件里记的是 pi 生成的会话 id）。

这也是 `loadRef`/`saveRef` 在升级后仍然保留且**有意义**的原因：`loadRef` 是旧文件定位器，`saveRef` 让 `settings.sessionRefs` 与实际文件位置保持一致（`getRef` 的 `path` 仍按 conversationId 派生，故两个会话的 path 天然不同）。

### 压缩动作的能力缺口（1.3.0 无 `compact()`）——需后续步骤决策

1.3.0 的 `Agent` **不再提供 `compact()`**，`AgentOptions` 里也没有压缩/上下文窗口相关字段（逐项核对 `agent.d.ts`；`@earendil-works/pi-ai` 只有 `utils/overflow` 的溢出**检测** `isContextOverflow`/`isRecoverableLength`，无压缩实现）。

Step 3.7 的处置：**判定逻辑完整自建**（阈值、估算、防呆全部逐值对齐旧实现，行为不变），压缩**动作**改为能力探测调用——`harness.compact` 不是函数时记一条 warn 后返回，而不是静默当作已压缩（`fail loud`）。压缩动作的替代实现（`transformContext` 钩子自建摘要，或落盘时改写可见性 + 摘要条目）属 Step 4.x 的决策范围，本步不越界实现。这条缺口必须让 Step 4.x 显式处理，否则「自动压缩」在升级后只剩判定不剩动作。

### Step 4.1 的前置发现：runtime 必须自己把本轮消息落盘

升级前「把本轮 user/assistant 消息 append 进会话」是 pi 的 `AgentHarness.prompt()` 做的。1.3.0 的 `Agent` 只持有自己的 transcript（`initialState.messages` + 内部状态），**不再写任何持久层**。因此 Step 4.1 除了替换构造方式，还必须：

1. 用 `ConversationSession.buildModelMessages()` 组装 `initialState.messages`（已就绪，模型可见性过滤已在其中）；
2. 每轮结束后把 Agent 产出的新消息经 `ConversationSession.append()` 落成 Entry（`kind`/`payload` 契约见 `types.ts`）。

本步已把读写原语备齐（`buildModelMessages` / `append` / `getActiveLeafEntryId`），并把 `extractTurnEntryIds` 改成按新模型判定，故 Step 4.1 是接线工作而非再设计。**在此之前，entryId 锚定、跨轮上下文、压缩判定在生产路径上都不会真正生效**——这是升级的预期中间态（见下方既有测试红灯一节）。

### 其他实现决策

- **`supersededByEntryId` 的过渡标记**：重试流程是「先作废旧问答 → 再定位 → 重跑生成新 user Entry」，作废时刻取代者还不存在。但作废必须跨重启持久（否则重启后旧分支重新作为兄弟出现，UI 冒出多余的 `< n/m >`），故写入 `SUPERSEDED_PENDING_MARKER`。投影只判定「非 null 即已作废」，行为不受影响；迁移路径（BR1.2）能推出真实取代者时写入真实 id。
- **`clear` 语义**：升级前是「开一个全新文件、旧文件留存」，而 entities.md 规定一个 `conversationId` 对应一个 Session/文件，旧语义无法表达。改为**原地重置**（同路径覆盖写空会话），用户可见行为不变（历史清空、上下文从零），差异仅在磁盘不再留孤儿文件。只读降级会话拒绝重置（BR1.3 的零写入；那份文件是该会话历史唯一副本，清掉就真丢了），彻底删除走 `purge`。
- **读失败按 BR1.3 处理，绝不覆盖**：`open()` 的读失败（IO 错误等）与「内容无法识别」同等降级，`ensureConversation` 的兜底也从「新建会话」改为「只读降级」——升级前 `repo.create` 是开新文件所以安全，而本层新建会覆盖同一路径的既有文件，一次瞬时读错误就能把用户历史清成空会话。降级态是内存态，下次打开重新判定，可自愈。
- **`ConversationSession` 不刷新缓存的 Session**：重读出的 Session 在文件损坏时可能残缺（如缺 `availability`），刷新会把只读降级态冲掉；本句柄是单进程内该会话的唯一写者，指针由 `append`/`moveActiveLeaf` 维护，无需重读。
- **`vault-session-fs.ts`**：去掉对 pi 已移除的四个类型的导入，改本地结构定义（`Result`/`FileError`/`FileErrorCode`/`FileInfo`）。`VaultSessionFileSystem`/`JsonlSessionRepoFileSystem` 本身保留——其唯一消费方是 `harness-env.ts` 的 ExecutionEnv，而 1.3.0 的 `Agent` 已无 `env` 字段，该层随 Step 4.1 一并退役（届时这两个类与 `harness-env.ts` 一起删）。

## Step 4.1：pi 原生适配层接线（本步完成）

### ①②③④ 均已就位，⑤ 修完两处既有测试

Step 4.1 的五个子项在本轮会话开始时，①（`buildModelMessages` 组装 `initialState.messages`）②（`persistTurnMessages` 把 Agent 产出的新消息经 `ConversationSession.append()` 落 Entry）③（`HarnessSessionManager.maybeCompact` 接通真正的压缩动作：阈值判定触发后调用注入的 `summarize()` 生成摘要，经 `ConversationSession.applyCompaction()` 把旧 Entry 的 `visibleToModel` 置 false、`visibleToUiProjection` 保持可见）④（`createNativeStreamFn`/`createNativeCompleteFn` 的自定义 header 机制经 `/compat` 全须全尾保留）均已在 `harness-chat-runtime.ts`、`harness-session-manager.ts`、`pi-native-model.ts` 落地，`npx tsx --tsconfig tsconfig.test.json test/harness-chat-runtime.test.ts` 本就全绿（之前的会话已完成，本轮核实未回归）。

本轮完成⑤：修复 `test/cross-phase-smoke.test.ts` 里残留的 `registerApiProvider is not a function`（主入口改走 `@earendil-works/pi-ai/compat`，与 `test/harness-chat-runtime.test.ts` 的既有修法一致）与两处旧模型断言（**改写断言，未删用例**）：

| 位置 | 旧断言 | 新断言 |
|---|---|---|
| phaseB 反查 entryId | `entry.type === 'message' && entry.message.role === 'user'/'assistant'` | `entry.kind === 'user_message'/'assistant_message'`（`getBranch()` 现返回 `Entry[]`） |
| phase1 压缩落盘校验（两条：触发 / 不触发） | 断言 JSONL 含 `"type":"compaction"` | 断言 JSONL 含 `compaction_summary`（本层压缩动作落盘为 `kind:'custom_message'`、`payload.customType:'compaction_summary'` 的摘要 Entry，见 `session-store/store.ts` 的 `applyCompaction`） |

另发现 `buildStack` 测试脚手架此前未给 `HarnessSessionManager` 注入 `summarize` 选项——`maybeCompact` 在无 `summarize()` 时只记告警、不执行压缩动作（这是刻意的「失败显式而非静默」设计，见 `harness-session-manager.ts` 注释），导致「触发压缩」用例原本必然落空。补上 `summarize: async () => 'SUMMARY_OF_OLD_MESSAGES'`（不触网的定长摘要），使该用例真正验证到压缩动作而非只验证判定。

### 体积预算决策（Step 5 已完成，且下方问题已经人工拍板解决）

**已解决**：`npm run build` 原本**完全失败**（esbuild@0.17.19 不认识 pi-ai 1.3.0 源码里的 `import ... with { type: "json" }`），现已修好；bundle 也从升级后的 **5.54 MB 降到 4.77 MB**。

**Step 5.2 现已勾选**：验收标准「`main.js` 产出成功且 < 5 MB」已满足，且下方的软预算问题已经人工确认采用方案 2 解决，`test/bundle-size.test.ts` 全部断言通过。

**曾经存在、现已解决的问题**：`test/bundle-size.test.ts` 里另有一条**仓库自设的软预算**（`BUDGET_BYTES`，非计划要求）当时设为 4.6 MB，在实测 4.77 MB 下失败。该文件在 `test/run-tests.ts` 的数组里是**第 2 个**（第 1 个是 `test/brand.test.ts`），失败即 `process.exit`，曾把整个套件挡在第 2 个文件处。

**事实澄清（三条，都可复核）**：

1. **不是本次改造引入的回归**。升级到 1.3.0 后（在任何存根工作之前）bundle 已是 5.54 MB，**同时**越过 5 MB 硬限与 4.6 MB 预算。此前之所以"看起来通过"，是因为 `dist/` 未重建、测的是旧的 2.04 MB 产物（`bundle-size.test.ts` 对未构建状态是 SKIP）。任何人重新构建都会立刻暴露。
2. **5 MB 硬限（NFR1 / Obsidian Sync 的真实用户影响）现在是通过的**：5,003,337 字节 vs 上限 5,242,880 字节，余量 239,543 字节。失败的只是仓库自设的 4.6 MB 预警余量——该断言自己的文案也写着"仍在硬限内，只是余量在缩——趁没咬人先查"。
3. **这不是"存根没做"导致的**。存根面已按 1.3.0 的实际 provider 集合补齐（40 个 provider + 7 个 api），已用证据确认保留清单只含真正在用的模块；剩余体积全部是**必需依赖**（见下表），不存在"还有没存根掉的死重量"。

**体积构成（实测，按 esbuild 路径注释归集）**：

| 包 | 体积 | 是否必需 |
|---|---|---|
| `@earendil-works/pi-ai` | 1329 KB | 必需（含 `providers/data/*.json` 内置模型目录） |
| `@google/genai` | 856 KB | 必需（Gemini 路径） |
| **`yaml`** | **821 KB** | **仅本项目 4 个文件用于解析 frontmatter**（`prompt-template-service.ts`、`pi-skill-source.ts`、`skill-files.ts`、`obsidian-bases/executor.ts`）；pi-ai/pi-agent-core 完全不使用它 |
| `openai` | 782 KB | 必需（openai-completions/responses 路径） |
| `typebox` | 560 KB | 必需（pi-ai schema） |
| `@mozilla/readability` | 245 KB | 必需（web-clipper） |
| `@google/generative-ai` | 187 KB | 必需（video-transcription） |

**曾提出的两个方案（都超出已批准计划的步骤范围，等待人工决定）**：

1. 把 `yaml` 依赖换成极简 frontmatter 解析器。frontmatter 的实际形状很窄（`name`/`description` 标量 + `tools` 字符串数组 + `triggers.{commands,keywords}` + `mode`），自建解析可省 **~820 KB**，bundle 落到约 **3.9 MB**，两条阈值同时有余量。代价：动 4 个文件 + 移除依赖，有解析正确性风险，且**不在计划的 25 个步骤里**（计划 Step 5 只讲 esbuild 存根）。
2. **调高 `BUDGET_BYTES`（如 4.8 MB）**。属于放宽仓库自设的质量门槛。

**人工决策（已确认）**：采用方案 2，将 `BUDGET_BYTES` 从 4.6 MB 上调到 4.8 MB（见 `test/bundle-size.test.ts` 顶部的决策注释，含理由与日期）。理由：5 MB 硬限（Obsidian Sync 的真实限制）仍有 0.23 MB 余量；方案 1 需要新写解析器并承担正确性风险，评估后判定不值得为省 820 KB 去冒这个风险。

**其余体积没有可挖的空间**（已逐项核实，勿重复排查）：`@google/genai` 856 KB 由 pi-ai 的 `api/google-generative-ai.js` 直接依赖，而本应用 Gemini 路径走的正是该 api，**不能存根**；`openai` 782 KB 由 `api/openai-completions.js`/`openai-responses.js` 依赖，同理；`@earendil-works/pi-ai` 的 1329 KB 含 `providers/data/*.json` 内置模型目录（`compat.js` 顶层 `builtinModels()` 会读到）；`typebox`/`@mozilla/readability`/`@google/generative-ai` 分别服务 pi schema、web-clipper、video-transcription。**唯一的大头就是 `yaml`，决策已确认不动它。**

**当前处置**：Step 5.2 与 Step 7.3 **均已勾选**；`npx tsx test/run-tests.ts` 100 个文件全部通过（无需再逐文件运行）。

### 历史记录（已解决）：`npm run build` 曾经的失败

Step 2.3 的基线记录「`npm run build` 成功，产出 1.92 MB」，但 Step 4 期间核实 `npm run build` 当时**失败**：esbuild 报多个 `Expected ";" but found "with"`，指向 `node_modules/@earendil-works/pi-ai/dist/providers/*.models.js` 与 `providers/all.js` 用了 `import values from "./data/xxx.json" with { type: "json" }`，而项目锁定的 `esbuild@0.17.19` 不支持该语法。

**已在 Step 5.1 修复**（见上方的体积小节）：新增 `strip-json-import-attributes` 插件在 onLoad 层剥掉该 attribute；并更新 `stub-unused-pi-providers` 的导出名（0.75.5 的 `streamMistral` → 1.3.0 的 `mistralProvider`），随后把存根面从「只有 mistral」扩展到 40 个未用 provider + 7 个未用 api 实现。保留此段作为判断依据。

### 历史记录（已解决）：`cross-phase-smoke.test.ts` 的 phase3 曾为红灯

修完 `registerApiProvider` 后该测试才能跑到 phase3；当时失败原因是 `prompt-template-service.ts` 仍调用 1.3.0 已移除的 `loadPromptTemplates`。**已在 Step 4.5 自建加载修复**，phase3 及该文件其余 13 条用例现已全绿（见 Step 4.5 小节）。

## Step 4.2/4.3：事件决策表逐型实现（本步完成）

逐项核对 `@earendil-works/pi-agent-core@1.3.0` 的 `types.d.ts` 里 `AgentEvent` 联合类型（用 Grep 定点查符号，未整篇读取 dist 文件），确认 1.3.0 实际事件家族为：`agent_start`/`agent_end`/`turn_start`/`turn_end`/`message_start`/`message_update`/`message_end`/`tool_execution_start`/`tool_execution_update`/`tool_execution_end`（比 0.75.5 多出 `agent_start`/`message_start`/`message_end`/`tool_execution_update` 四类）。`pi-event-adapter.ts` 按 `functional-spec.md` §4 决策表逐行核实后的结论（已写入该文件顶部的文档注释，供日后维护者对照）：

- **延续现状映射四类**：文本增量（`message_update`+`assistantMessageEvent.type==='text_delta'`）、工具调用开始/结束（`tool_execution_start`/`tool_execution_end`）、回合结束（`turn_start`→`step_boundary`）、错误（provider 错误经 `message_end`+`stopReason:'error'`，已被 `harness-chat-runtime.ts` 的 `subscribe` 回调单独拦截，不经本函数）——均保持原有映射行为不变。
- **压缩事件行：原判定"现状丢弃"在 1.3.0 下改判"不适用"**（而非沿用计划文字"映射"）：逐项核对 1.3.0 `AgentEvent` 联合类型后，确认它不包含任何压缩相关事件——1.3.0 的 `Agent` 完全不做压缩，压缩是本项目自建的 `HarnessSessionManager.maybeCompact` 事后驱动。按 BR3.1 的落地口径（"使 UI 可感知压缩发生，不再是纯内部副作用"），映射目标改为：`maybeCompact` 新增返回值 `MaybeCompactResult{ compacted, foldedEntryCount }`，`harness-chat-runtime.ts` 据此在真正发生压缩时产出新增的 `StreamEvent.compaction`（`src/models/interfaces.ts` 新增变体）。这不经过 `pi-event-adapter.ts`（因为源头不是 pi 事件），故决策表落地点在 `harness-session-manager.ts`/`harness-chat-runtime.ts`，`pi-event-adapter.ts` 的文档注释里指明了这一点以免日后误以为遗漏。
- **usage/token 事件行：维持"丢弃"**，且升级后确认丢弃理由升级为"不适用"（1.3.0 没有独立的 usage 事件类型，usage 随 `AgentMessage.usage` 字段搭载在 `message_end` 等事件里，不是独立事件家族，无需专门处理）。
- **审批原生信号行：确认"不适用"**（计划文字预判的两种情形之一）：1.3.0 把审批信号折进 `afterToolCall` 回调（`harness-chat-runtime.ts` 已有实现），不是独立的 `AgentEvent` 类型。
- **1.3.0 新增四类事件**（`agent_start`/`message_start`/`message_end`/`tool_execution_update`）核对后均无决策表要求的映射目标，显式返回 `undefined`（与未知事件同处理），避免被误认为遗漏处理。

测试（`test/pi-event-adapter.test.ts` 新增 6 条、`test/cross-phase-smoke.test.ts` 的两条既有压缩用例各追加一条断言）：决策表每一行"映射"类型的可观察路径已有既有用例覆盖（文本增量/工具调用/回合结束三类沿用既有断言；压缩事件新增 `StreamEvent.compaction` 的正反两面断言，见下方 Step 4.1 小节的"⑤"之外新增内容）；"丢弃/不适用"类型新增 6 条"确认不产出"用例（`agent_start`/`turn_end`/`agent_end`/`message_start`/`message_end`/`tool_execution_update`）。`npx tsx --tsconfig tsconfig.test.json test/pi-event-adapter.test.ts` 共 18 条全绿。

## Step 4.4：1.3.0 `AgentOptions` 配置面盘点（只盘点，不启用）

逐项核对 `node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:7` 的 `AgentOptions`（Grep 定点读取，未整篇读 dist）。1.3.0 实际暴露 **20 个**字段：`initialState`/`convertToLlm`/`transformContext`/`streamFn`/`getApiKey`/`onPayload`/`onResponse`/`onProviderStreamEvent`/`beforeToolCall`/`afterToolCall`/`finishTurn`/`prepareRequest`/`prepareNextTurn`/`prepareNextTurnWithContext`/`steeringMode`/`followUpMode`/`sessionId`/`thinkingBudgets`/`transport`/`maxRetryDelayMs`/`toolExecution`（比计划文字列的 9 项多出 `onPayload`/`onResponse`/`onProviderStreamEvent`/`thinkingBudgets`/`transport`/`maxRetryDelayMs` 等，一并盘点）。

**现状已用（5 项）**：`initialState`（model/tools/systemPrompt/thinkingLevel/messages）、`streamFn`（必填，唯一 LLM 注入路径）、`getApiKey`、`afterToolCall`（审批检测 + `terminate`）、`sessionId`（provider 缓存路由标识）。均已核实接线正确。

**现状未用（15 项）与"是否合理"的结论**：

| 字段 | 现状未用是否合理 | 理由 |
|---|---|---|
| `convertToLlm` | **合理** | 默认实现把 `AgentMessage[]` 转成 provider 可理解的 `Message[]`。Baizer 落盘的 payload 就是 pi 消息对象本身（`session-store/types.ts` 的 `MessagePayload` 契约），已是 provider 直接可用的形状，无需自定义转换。 |
| `transformContext` | **合理，且刻意不用** | 这是"每次请求前改写 transcript"的钩子，会与 `buildModelMessages()` 形成两套投影机制、两个真相源。Baizer 的投影（含 `visibleToModel` 过滤、压缩隐藏）统一走 `buildModelMessages()`，一次算好交给 `initialState.messages`。若启用 `transformContext` 反而要防两处投影口径漂移。 |
| `onPayload`/`onResponse`/`onProviderStreamEvent` | **合理** | 三个 provider 层观测钩子（请求体/响应/流事件）。Baizer 已有自己的审计日志（`ModelService` 的 audit log）与 `StreamEvent` 通道，再加一层是同功能重复；且这属于新增可观测能力，超出本次 refactor 范围（FR5：不新增功能）。 |
| `beforeToolCall` | **合理** | 权限判定已在工具适配层完成：`pi-tool-adapter.ts` 的 `skillScope` 过滤 + `PermissionService`（`src/permissions/permission-service.ts` 的纯函数决策）。审批回灌则由 `afterToolCall` 检测 `approval_required` 完成。再挂 `beforeToolCall` 会把权限层拆成两处。 |
| `finishTurn` | **合理** | 钩子在每回合结束时给 agent loop 一个"是否继续"的决策（`AgentTurnDecision`）。Baizer 的回合收尾（落盘、entryId 锚定、压缩、记忆沉淀）都在 `agent.prompt()` resolve 后由 runtime 顺序执行，语义更直白且已验证（phase0/phase2 冒烟用例覆盖），无需把它塞进钩子里。 |
| `prepareRequest` | **合理** | 逐请求微调（改 model/context 等）。Baizer 的 model/凭证在每次 `queryStream` 调用时重建（settings 改动下一轮生效，见 CLAUDE.md 的架构说明），无需回合内逐请求改写。 |
| `prepareNextTurn`/`prepareNextTurnWithContext` | **合理** | 用于回合间替换 model/tools/context。Baizer 的运行中工具集替换走 `ActiveRunController` → `agent.state.tools` 直接赋值（`harness-chat-runtime.ts` 的 `steerable.setActiveTools`），已被 phase2 冒烟用例验证有效；`steer()` 亦经 `ActiveRunController` 接线。两者是同一需求的两条实现路径，现状选的是直接改 state。 |
| `steeringMode` | **合理** | 默认 `"one-at-a-time"`（`agent.js:139`）。Baizer 的 steering 场景是"用户在运行中补一句话"，天然一次一条，默认值即符合意图。 |
| `followUpMode` | **合理** | 默认 `"one-at-a-time"`（`agent.js:140`）。Baizer 根本未使用 `agent.followUp()`——"运行中补话"由 steering 覆盖，followUp（"等 agent 本来要停下时再跑"）在当前 UI 里没有对应交互。 |
| `toolExecution` | **合理** | Agent 级默认 `"parallel"`（`agent.js:145`），但**每个工具都已有自己的 `executionMode`**（`pi-tool-adapter.ts` 的 `inferToolExecutionMode`：写/插件控制类 → `sequential`，读/搜索类 → `parallel`），per-tool 设定优先。故 Agent 级默认只对"未显式声明执行模式"的工具兜底，现状无需覆盖。 |
| `thinkingBudgets` | **合理** | 逐档 thinking token 预算的显式覆盖。Baizer 的 thinking 档位已映射进 `Model.thinkingLevelMap`（`pi-native-model.ts` 的 `OPENAI_COMPAT_THINKING_LEVEL_MAP`）与 `initialState.thinkingLevel`，provider 侧有内置默认预算，显式覆盖属调优项而非本次重构必需。 |
| `transport` | **合理** | 传输方式偏好（如 SSE/HTTP 变体）。Baizer 的 provider 走标准 HTTP 流式，无特殊传输需求。 |
| `maxRetryDelayMs` | **合理** | provider 请求重试延迟上限。Baizer 未介入重试策略，用 pi 默认；若日后要加"重试封顶"再启用。 |

**结论**：15 项未用字段全部有明确理由，**没有一项是"升级后被迫弃用"或"漏接线"**——其中 `transformContext`/`prepareNextTurn*`/`beforeToolCall`/`finishTurn` 四项属"有等价替代路径且现状已验证"，其余属"能力超出本次重构范围"。按 FR3.4 的口径（本步只盘点、不强制启用），维持现状不启用。

## Step 4.5：符号移除的收尾（本步完成）

### 导入纪律核实（FR3.5）：已满足，升级未破坏

逐文件核实（`grep` 定点查，未整篇读文件）：`skill-registry.ts`、`pi-skill-source.ts`、`pi-native-model.ts`、`prompt-template-service.ts`、`harness-chat-runtime.ts`、`pi-tool-adapter.ts` 里**所有 pi 值导入都走动态 `import()`、所有类型导入都是 `import type`**，与升级前一致。FR3.5 无改动需求。

### 但三处「借 pi 导出的功能」在 1.3.0 下已成**运行期崩溃点**，必须自建

核实导入纪律时发现三组 pi 导出符号在 1.3.0 被移除，而调用方仍是老写法。这些不是"编译错误"而是"运行期 TypeError"（调用点都在 `as any` 或 `mod.x` 之后，tsc 看不见）：

| 文件 | 调用的已移除符号 | 后果 | 处置 |
|---|---|---|---|
| `src/skills/skill-registry.ts` | `formatSkillsForSystemPrompt` / `formatSkillInvocation`（经 `init()` 动态 import 后缓存） | `mod.x` 取到 `undefined`，`this.formatters` 却是**真值对象** → `getSkillSummaryText()`/`activateSkill()`/`resolveForRead()` 一调用即 `TypeError`（`init()` 由 `main.ts:134` 调用，非死代码） | 本地自建两个格式化函数，置于 `pi-skill-source.ts`（skill 模型的家），`skill-registry` 直接引用；删掉 `PiFormatters` 接口、`formatters` 字段与 `init()`（连同 `main.ts` 的那次调用——它唯一的作用就是加载这两个已不存在的符号） |
| `src/skills/pi-skill-source.ts`、`skill-registry.ts` | 类型 `Skill` | tsc 报"无导出成员"并级联出 `LoadedSkill` 破损 | 本地定义 `PiSkill` 接口（name/description/content/filePath/disableModelInvocation，字段语义与原 pi `Skill` 一致），`LoadedSkill.skill` 改用它 |
| `src/runtime/pi/prompt-template-service.ts` | `loadPromptTemplates` / `parseCommandArgs` / `substituteArgs` | 同上：`load()` 静默降级为空命令表（被 `catch` 吞掉），`resolve()` 同样走 `catch` 返回 null → **用户自定义 slash 命令全部失效** | 本地自建三函数：`loadTemplatesFromDir`（列目录 + 逐文件读 + frontmatter 切分）、`parseCommandArgs`（shell 风格切分，含单/双引号与转义，引号未闭合时抛错而非静默产半截参数）、`substituteArgs`（`$ARGUMENTS`/`$1..$9`/`${@:N}`） |

自建件的可观察契约与旧实现对齐：清单用 `<available_skills>` 包裹（`read_skill` 的工具描述按该标签名引用，故必须保留该标签）、每条带 `<location>`；`loadPromptTemplates` 的 frontmatter 语义（`description` 作命令描述、正文去掉 frontmatter、无 frontmatter 时 description 退化由 `describeTemplate` 兜底）保持原样。

顺带一处类型收紧：`ModelService.harnessEnv` 由 `unknown` 改为 `PromptTemplateEnv | null`（它在本层唯一剩下的消费方就是 `PromptTemplateService`，pi 的 `ExecutionEnv` 抽象随 1.3.0 移除后已无 `unknown` 的必要）。`harness-env.ts` 本身**未删**——它仍被 `PromptTemplateService` 用作 env 实现，且已不依赖任何 pi 导出符号；其"随 4.1 退役"的旧判断已不成立，故保留（见下方偏差说明）。

**结果**：`npx tsc -p tsconfig.json --noEmit` 由 9 个错误降到 **0 个**（Step 3.7 基线 9 → Step 4.1/4.2 后 5 → 本步后 0）。全量回归 `npx tsx test/run-tests.ts`：**100 个测试文件全部通过**。

### 一处既有测试断言的修正（非放宽质量目标）

`test/harness-session-manager-regression.test.ts` 的 `maybeCompact folds the old turn into a summary...` 原断言 `messages.map(m => m.content).join('|') === 'SUMMARY_TEXT'`（要求**整轮两条消息全部**被折叠）。这与 `pickCompactionCutoff` 的 `kept > 0` 守卫矛盾——该守卫保证**至少保留最新一条消息**逐字可见（对齐 pi 0.75.5 的 `compact()`：摘要之后必须仍有真实上下文，否则模型只剩一段摘要）。`keepRecentTokens=1` 且单轮两条消息时，被折叠的是较旧的 user 消息，最新 assistant 回答原样保留。

判定：**实现是对的，原断言写错了**（该测试与 `compaction.ts` 同由上一轮会话产出，断言早于压缩动作真正接线，未被真实执行过）。故改为断言实际且正确的行为：模型可见消息 = `[最新 assistant 回答, 摘要]` 两条，且被折叠的 user Entry 仍完整留在存储里、只是 `visibleToModel` 翻为 false。**未删用例、未放宽任何覆盖要求**；`cross-phase-smoke.test.ts` 的压缩用例另有调整（见下）。

### `test/cross-phase-smoke.test.ts` 压缩用例的两处调整

1. `buildStack` 补 `summarize` 注入（此前缺失 → `maybeCompact` 只判定不动作，用例必然落空）。
2. phase1 用例新增 `compactionSettings: { keepRecentTokens: 1 }`。原因：该用例的内容是极短的 `"reply"`，默认 `keepRecentTokens=20000` 会把全部消息都算作"最近"→ `cutoff=0` → 无可折叠内容。这是**测试脚手架的内容规模问题，不是实现缺陷**（真实场景里 usage 越阈值时内容量必然远超保留预算，两条路径结论一致）。调小后压缩动作真实执行（日志可见 `folded 1/3 entries`），`StreamEvent.compaction` 与落盘摘要断言同时成立。

## Step 5.1：esbuild 存根与构建脚手架（本步完成）

> **后人先读这一段，避免最常见的两种误解：**
>
> 1. **这四处改动不都是为了省体积。** 只有 ② 的"存根面扩展"与 ③ 是为了体积；① 是**修构建彻底失败**（不修则 `npm run build` 直接红）；② 的"返回值语义修正"是**修运行期崩溃**（不修则 `import('@earendil-works/pi-ai/compat')` 在模块顶层就抛错，整个插件起不来）。**如果有人为了"简化构建配置"把这四处删掉，插件会先构建失败、再运行崩溃。**
> 2. **存根面是按证据定的，不是按"看起来没用"猜的。** 保留清单只有 `google.js` 与 `openai.js`（因为 `buildGeminiModel`/`buildOpenAICompatModel` 给出的 `provider` 只会是 `'google'` 与 `'openai'`），api 保留清单只有 `google-generative-ai`/`openai-completions`/`openai-responses`（同上）。**动这两份清单前先看 `src/runtime/pi/pi-native-model.ts`。**
> 3. **`@google/genai`（856 KB）不能存根** —— pi-ai 的 `api/google-generative-ai.js` 依赖它，而本应用的 Gemini 路径走的正是这个 api。（已核实，别再往这个方向找体积。）
> 4. 存根的导出名**必须与 `all.js` 的 import 逐字一致**。这不是约定而是硬检查：名字不对时 esbuild 直接报 `No matching export`，构建失败。

`esbuild.config.mjs` 四处改动，全部是 1.3.0 结构变化导致的必要更新：

### ① 新增 `strip-json-import-attributes` 插件（修掉构建彻底失败）

1.3.0 的 `providers/all.js` 与每个 `providers/<x>.models.js` 写成
`import values from "./data/<x>.json" with { type: "json" };`，`esbuild@0.17.19` 解析不了该语法，
**整个构建红掉**。在 `onLoad` 层用 `/\s+with\s*\{\s*type:\s*["']json["']\s*\}/g` 剥掉即可——
`.json` 本就由 esbuild 按扩展名走 json loader，该 attribute 对打包结果无影响。
按仓库既有的"出声失败"风格，剥完再检查是否残留 `with { type:`，残留则抛错，避免留下"看起来成功"的包。

### ② `stub-unused-pi-providers`：导出名更新 + 存根面扩展 + 返回值语义修正

- **导出名**：0.75.5 的 `streamMistral`/`streamSimpleMistral` → 1.3.0 的 `mistralProvider`。
  导出名必须与 `all.js` 的 import 逐字一致（不一致时 esbuild 直接报 `No matching export`，本身就是防漂移检查）。
- **存根面**：从「只有 mistral」扩展到 **40 个**未用 provider（`google.js`/`openai.js` 保留真实实现）。
  原因：0.75.5 的 provider 是惰性 `import()` 且只有 9 个；1.3.0 的 `all.js` **静态** import 全部 42 个。
- **返回值语义（关键修正）**：旧存根"被调用就抛错"。1.3.0 的 `compat.js` 在模块顶层
  `const compatModels = builtinModels();` 里**立刻调用每个 `<x>Provider()`**，旧写法会让
  `import('@earendil-works/pi-ai/compat')` 直接炸掉整个插件。改为返回由真实 `createProvider()`
  构造的**惰性占位 provider**（`models: []` + 抛错的 `api.stream`/`streamSimple`），
  故 `setProvider` 接受、而只有用户真把 provider 配成这些家时才会看到可读错误。
  （该形状已用一次性探针脚本对真实 `createProvider`/`createModels().setProvider()` 实测通过，脚本已删。）

### ③ 新增 `stub-unused-pi-apis` 插件（体积的第二大头）

`compat.js` 顶部无差别 `export * from "./api/<x>.lazy.js"`（10 个）。这些 `.lazy.js` 只有一行
`lazyApi(() => import("./<x>.js"))`，但 cjs 无法 code splitting，于是每个 `<x>.js` 及其背后的
SDK 全被内联。只保留 Baizer 实际用到的三种 api（`google-generative-ai`/`openai-completions`/
`openai-responses`），其余 7 个换成同名导出 + 抛错实现的存根。
因为 `lazyApi` 只在 `stream`/`streamSimple` 被调用时才 `load()`，而这些存根 api **没有任何调用方**
（只被 `compat.js` 的 `export *` 重新导出），故无需引入真实 `lazyApi`，也就无需 resolveDir。

**副作用（已核实无害）**：`openai-codex-responses.js` 被存根后不再进 bundle，`stubNodeBuiltinDynamicImports`
针对它的启动期 unhandled-rejection 补丁自然失效——问题本身不存在了；该插件对 `env-api-keys.js` 的修补不受影响。

**实测结果**：`npm run build` 成功；`main.js` **5.54 MB → 4.77 MB**（**5,003,337 字节**）。硬限 5 MiB = 5,242,880 字节，**余量 239,543 字节** —— 硬限（5 MB / Obsidian Sync / NFR1）**通过**。

`test/bundle-size.test.ts` 三条断言的执行情况（软预算上调到 4.8 MB 后，三条全部真实执行）：

| # | 断言 | 结果 |
|---|---|---|
| 1 | 5 MB 硬限 | **PASS** |
| 2 | 4.8 MB 软预算 | **PASS**（4.77 MB） |
| 3 | 未用 SDK 不在包内（`@mistralai/mistralai`） | **PASS** |

第 3 条现已作为测试断言真实执行并通过；其实质同时用等价手段独立核实过：包内无 `// node_modules/@mistralai/mistralai/`、`@anthropic-ai/sdk`、`@aws-sdk` 标记；且保留路径真实存在（`generativelanguage.googleapis.com` / `api.openai.com` 可见）。

**后续**：仓库自设的软预算一度（4.6 MB 下）告警，已经人工确认上调到 4.8 MB 解决，`bundle-size.test.ts` 三条断言现已全部通过。
详见上方"体积预算决策"小节（含体积构成、两个方案与最终决策）。

## Step 6：回归验证（本步完成）

### 6.1 两条 LLM 路径的全部既有调用方（FR5.1）

逐个运行调用方的既有测试，全部通过：

| 调用方 | 测试文件 | 结果 |
|---|---|---|
| `KnowledgeCompiler` | `test/knowledge/compiler.test.ts`、`test/knowledge/compile-concurrency.test.ts` | OK |
| `GuardianCompletionService` | `test/guardian-completion.test.ts`、`test/guardian-request.test.ts`、`test/knowledge/guardian-context.test.ts` | OK |
| `MemoryManager` / `HindsightConsolidator` | `test/memory-manager.test.ts`、`test/hindsight-memory.test.ts` | OK |
| `PluginSkillGenerator` | `test/plugin-skill-generator.test.ts` | OK |
| `VideoTranscription` | `test/video-transcription.test.ts` | OK |
| `ModelCatalogService` | `test/provider-capabilities.test.ts` | OK |
| 门面本身 | `test/model-service.test.ts` | OK |

### 6.2 四条既有交互链路的针对性回归（FR5.2）

- **会话分叉/重试/编辑/兄弟切换**：`test/cross-phase-smoke.test.ts` 的 phaseB（entryId 锚定）、phaseC 三条（分叉产生兄弟分支并可在投影间切换、重试作废不累积兄弟、编辑首条 user 消息从 root 分叉）全绿；`test/harness-session-manager-regression.test.ts` 的分支原语与 supersede 两条全绿。
- **审批中断与回灌**：`test/cross-phase-smoke.test.ts` 的 phase0（审批 terminate、不再发第二次 provider 调用）、`test/harness-session-manager-regression.test.ts` 的 BR2.1（模型可见 / UI 不可见 + 固定可见性组合）、`test/pi-approval-policy.test.ts` 全绿。
- **Guardian 快/深双路径**：`test/guardian-completion.test.ts`、`test/guardian-request.test.ts` 全绿（按计划不新增测试）。
- **知识编译 Map-Reduce**：`test/knowledge/compiler.test.ts`、`test/knowledge/compile-concurrency.test.ts` 全绿（按计划不新增测试）。

### 全量执行结果

`test/run-tests.ts` 注册的 **100 个测试文件**全部通过（人工确认将软预算上调到 4.8 MB 后，`npx tsx test/run-tests.ts` 一次性跑完，不再需要逐文件方式）：

**100 个全部通过**，包括 `test/bundle-size.test.ts` 的全部三条断言（5 MB 硬限、4.8 MB 软预算、未用 SDK 不在包内）。根因与处置见上方"体积预算决策"小节。

## 可追溯性：需求 → 实现文件 → 验证（Step 7.4）

### 功能需求（FR）

| FR | 实现文件 | 验证 |
|---|---|---|
| FR1.1 版本升级 | `package.json`、`package-lock.json`（精确 `1.3.0`） | 构建成功、`tsc` 0 错误 |
| FR1.2 验收（类型/构建/测试全绿） | 全仓 | `tsc -p tsconfig.json` 0 错误；`npm run build` 成功（4.8 MB < 5 MB）；100 个测试文件全部通过 |
| FR1.3 逐符号核对 | `code-summary.md` 的"符号迁移映射" | 13 值导入 + 10 类型导入逐项标注去向 |
| FR2.1 会话行为保真 | `src/runtime/pi/harness-session-manager.ts`、`session-store/conversation-session.ts` | `test/harness-session-manager-regression.test.ts`（15 条）、`test/cross-phase-smoke.test.ts` |
| FR2.2 旧格式迁移 | `session-store/migrate.ts`、`session-store/store.ts`（`open()` 的 `legacyPath` 入口） | `test/session-store-migration.test.ts`（15 条） |
| FR2.3 vault 落盘、不碰 node fs | `session-store/store.ts`（注入 `VaultFileAdapter`）、`vault-session-fs.ts` | `test/session-store-branching.test.ts`、`harness-session-manager-regression` |
| FR3.1 去掉 `as any` 构造 | `src/runtime/pi/harness-chat-runtime.ts`（`new pi.Agent({...})`，真实类型） | `tsc` 0 错误 + `test/harness-chat-runtime.test.ts`（18 条） |
| FR3.2 退役手抄结构镜像 | `harness-session-manager.ts`、`session-branch-projector.ts`（改吃 `Entry[]`） | 同上两条回归 |
| FR3.3 事件决策表 | `src/runtime/pi/pi-event-adapter.ts`（表写入文件头注释）、`models/interfaces.ts`（新增 `compaction` 变体） | `test/pi-event-adapter.test.ts`（18 条）+ `cross-phase-smoke` 的压缩正反断言 |
| FR3.4 配置面盘点 | `code-summary.md` 的"Step 4.4"表（20 字段逐项结论） | 盘点即交付，无代码改动 |
| FR3.5 动态 import 纪律 | `skill-registry.ts`、`pi-skill-source.ts`、`pi-native-model.ts`、`prompt-template-service.ts`、`harness-chat-runtime.ts`、`pi-tool-adapter.ts` | 逐文件核实（值导入走 `import()`、类型走 `import type`） |
| FR4.1 esbuild 存根兼容 | `esbuild.config.mjs`（3 个插件：provider 存根扩展、api 存根、JSON attribute 剥离） | `npm run build` 成功 + 未用 SDK 不在包内的断言（`test/bundle-size.test.ts` 第 3 条，现已执行并通过） |
| FR5.1 既有调用方行为不变 | 无源码改动 | Step 6.1 的 7 组既有测试全绿 |
| FR5.2 四条交互链路回归 | 无源码改动 | Step 6.2（分叉/重试/编辑/兄弟、审批中断与回灌、Guardian 双路径、知识编译 Map-Reduce） |

### 业务规则（BR）

| BR | 实现文件 | 验证 |
|---|---|---|
| BR1.1 按内容特征判定格式 | `session-store/migrate.ts`（`detectFormat`）、`store.ts`（`open()` 为唯一入口） | `test/session-store-migration.test.ts` |
| BR1.2 旧格式迁移 | `session-store/migrate.ts`（`migrateOldToNew`）、`store.ts`（`legacyPath` 入口 + 消费掉旧文件） | `test/session-store-migration.test.ts`、`harness-session-manager-regression` 的 BR1.2 两条 |
| BR1.3 迁移失败只读降级 | `session-store/store.ts`（`openDegraded`/`appendEntry` 抛错、零写入）、`harness-chat-runtime.ts`（`queryStream` 产出 error 事件提示 UI） | `test/session-store-migration.test.ts`、`harness-session-manager-regression` 的 BR1.3 两条 |
| BR2.1 审批回灌可见性 | `session-store/types.ts`（`isValidApprovalOutcomeVisibility` + `appendEntry` 强制）、`conversation-session.ts`（`buildModelMessages` 过滤） | `harness-session-manager-regression` 的 BR2.1 用例 |
| BR2.2 分支切换只改指针 | `session-store/store.ts`（`moveActiveLeaf`/`markSuperseded`）、`conversation-session.ts` | `test/session-store-branching.test.ts`（8 条）、`cross-phase-smoke` phaseC 三条 |
| BR3.1 事件决策表落地 | `pi-event-adapter.ts`、`harness-session-manager.ts`（`maybeCompact` 返回 `MaybeCompactResult`）、`harness-chat-runtime.ts`（产出 `StreamEvent.compaction`）、`models/interfaces.ts` | `test/pi-event-adapter.test.ts`、`cross-phase-smoke` 的 phase1 两条 |

### 关于 `traceability.json`（决策与理由）

本 intent 里唯一的 `traceability.json` 位于 `construction/functional-design/`，是**功能设计阶段**的产物：它的每一行描述的是"该 FR 在设计阶段是否有对应的设计对象"，而不是"该 FR 在代码里落在哪个文件"（例如 FR1.1/FR1.2/FR3.5 在该文件里是 `N/A`，理由写在 `target` 里）。

**决策：不改写该文件，改为在 `code-summary.md` 内给出上面两张"FR/BR → 实现文件 → 验证"表。** 理由：

1. 该文件的语义是设计阶段的覆盖结论，那些 `N/A`/`Deferred` 行**至今仍然成立**（FR1.1 确实不产生领域实体、FR3.4 确实留待后续阶段），改写它们会破坏设计阶段的记录，而不是补充它。
2. 它由 `aidlc-traceability` 传感器按**该阶段**的上游 ID 集合校验（`matches: "**/traceability.json"`）。在 `code-generation/` 下另建一份同形状文件，会把一份"代码实现映射"喂给按设计阶段语义校验的检查器，有引入假 GAP/ORPHAN 的风险，收益只是形式上的文件名一致。
3. 计划 Step 7.4 的实质要求是"可追溯性"——把每条需求指到实现与验证。上面的两张表完整满足该实质要求，且比 JSON 更可读。

如果团队坚持要有 `code-generation/traceability.json`，请告知，我再按传感器 schema 补一份（需要先确认该阶段的 `upstream_ids` 解析口径）。

## 升级造成的既有测试红灯（**已在 Step 4.1/4.2/4.5 全部关闭**）

> **状态更新（Step 4 完成后）**：本节记录的三条红灯**全部已转绿**，`npx tsx test/run-tests.ts` 100 个测试文件全通过。
> - `test/harness-chat-runtime.test.ts`：18 条全绿（`registerApiProvider` 改走 `/compat`，见 Step 4.1 小节）。
> - `test/cross-phase-smoke.test.ts`：14 条全绿（`registerApiProvider` 改走 `/compat`；phaseB/phase1 的旧模型断言改写为新模型；补 `summarize` 注入与 `keepRecentTokens` 调整，见 Step 4.1/4.5 小节）。
> - `test/steering.test.ts`：同样改走 `/compat` 后全绿（**同一根因的第三处**，此前未被记录）。
> - `prompt-template-service.ts` 的 `loadPromptTemplates` 移除（本会被 phase3 暴露）已由 Step 4.5 自建加载修复。
>
> 以下为历史记录，保留以便回溯判断依据。

`npm run build` 成功掩盖不了运行期的问题：升级到 1.3.0 后，两个走真实 pi 运行时的既有集成测试**当前为红**，原因都是 pi-ai 1.3.0 主入口不再导出 `registerApiProvider`（改在 `/compat` 子路径）：

```
npx tsx --tsconfig tsconfig.test.json test/harness-chat-runtime.test.ts
  FAIL query consumes queryStream and returns the final done text: piAi.registerApiProvider is not a function
npx tsx --tsconfig tsconfig.test.json test/cross-phase-smoke.test.ts
  FAIL phase0+1: tool loop, cross-turn context, clean persisted history: piAi.registerApiProvider is not a function
```

这是升级的**预期中间态**，不是新缺陷：`AgentHarness` 已不存在、`session` 配置面已移除，两个测试都依赖这两者。按 Testing Contract 的 scope floor「保持既有测试全绿」，它们必须在 Step 4.1（`Agent` 构造）与 Step 4.2（事件映射）完成后重新转绿；Step 7.3 的全量回归是最终判据。**不得以删除或跳过这两条用例的方式达成绿灯。**

**Step 3.7 后的状态**：两条仍红，且**失败原因不变**（仍是 `piAi.registerApiProvider is not a function`），未因本步改造出现新的失败模式。但 `test/cross-phase-smoke.test.ts` 里有几处断言写的是 pi 时代的持久化内部结构，Step 4.1 必须一并按新模型改写（**改写断言、不得删用例**）：

| 位置 | 现断言 | 新模型下的等价断言 |
|---|---|---|
| phaseB 反查 entryId | `session.getBranch()` 里 `entry.type === 'message' && entry.message.role` | `entry.kind === 'user_message' / 'assistant_message'`（`getBranch()` 现返回 `Entry[]`） |
| phaseC 投影 | `getBranchEntries()` 返回 pi 树条目 | 现返回 `Entry[]`，`projectBranchToMessages` 已同步改吃新模型（测试里的 `as any` 调用点无需改） |
| phase1 压缩 | 落盘 JSONL 里出现 `"type":"compaction"` | 本层不再有 pi 的 compaction 条目（压缩动作见上文的 1.3.0 能力缺口），须改为断言自建判定被触发（或随压缩动作的实现一并改写） |
| `getRef().path` | 两会话 path 不同 | 仍成立（路径按 conversationId 派生） |

## 偏差与补充（相对已批准的计划步骤清单）

### 3. 计划步骤之外的必要修复：三组"运行期崩溃点"（Step 4.5 范围内，见该节）

Step 4.5 的计划文字只说"核实导入纪律"，但核实过程中发现三组借自 pi 的已移除符号仍在被调用（`skill-registry` 的两个格式化器、`prompt-template-service` 的三个函数），且都是 tsc 看不见的运行期崩溃点。自建替代实现属于该步骤的必然要求（不修则插件运行期必崩或用户命令静默全失效），已实现并记录于 Step 4.5 小节。

### 4. 计划步骤之外的必要修复：`main.ts` 删掉一次 `skillRegistry.init()` 调用（Step 4.5）

`init()` 唯一的作用就是动态 import 两个 1.3.0 已移除的 pi 导出，改成自建纯函数后它无事可做，故连同 `main.ts:134` 的调用一并删除。这是"只碰非改不可的地方"下的最小改动（保留一个只做无用动态 import 的方法更糟）。

### 5. `harness-env.ts` 未按 Step 4.1 的旧判断退役（Step 4.5）

code-summary 早前记录 `harness-env.ts` 应"随 Step 4.1 一并退役"。实际核实：它已不依赖任何 pi 导出符号（改用 `vault-session-fs.ts` 的本地结构镜像），且仍是 `PromptTemplateService` 的 env 实现——**不能删**。故保留，其 3 个 tsc 错误也早已消失。旧判断作废。

### 6. 测试断言的两处改写（Step 4.1 ⑤ 与 Step 4.5）

- `test/harness-session-manager-regression.test.ts` 的压缩用例：原断言与 `pickCompactionCutoff` 的 `kept > 0` 守卫矛盾，判定为**断言写错、实现正确**，改为断言实际行为（未删用例、未放宽覆盖）。详见 Step 4.5 小节。
- `test/cross-phase-smoke.test.ts`：`registerApiProvider` 改走 `/compat`；phaseB 的 `entry.type==='message'` 改 `entry.kind`；phase1 的 `"type":"compaction"` 改 `compaction_summary`；补 `summarize` 注入与 `keepRecentTokens` 调整（**改写、未删用例**）。

### 7. 新增第三处同根因修复：`test/steering.test.ts`（Step 4.1 ⑤ 的延伸）

计划只点了 `harness-chat-runtime.test.ts` 与 `cross-phase-smoke.test.ts` 两个文件，实际同一根因（`registerApiProvider` 移出主入口）还有第三处 `test/steering.test.ts:97`。一并修掉，否则全量回归不可能绿。

### 8. `traceability.json` 未改写（Step 7.4）

### 1. BR1.3 的「UI 必须给出明确提示」在计划步骤之外，按业务规则补齐（Step 3.7 已实现）

`rules.md` 的 BR1.3 原文明确要求「UI 必须向用户给出明确提示（该会话仅可查看历史，不能继续对话）」，但 `code-generation-plan.md` 的 25 个步骤里没有任何 UI 步骤，`traceability.json` 要求每条 BR 都能指向实现文件——该要求在计划中无处可指。按业务规则补齐最小可用实现（不改写已批准的计划文件，仅勾选复选框）。

**实现（Step 3.7）**：两层，都不新增 UI 组件——
1. `HarnessSessionManager.getAvailability(conversationId)` 暴露 `SessionAvailability`，供 UI 层查询该会话是否已降级；
2. `HarnessChatRuntime.queryStream()` 在拿到降级会话时**不进入 agent loop**，直接产出一条 `error` 事件：「该会话的历史记录无法迁移（文件格式无法识别或已损坏），已降级为只读：只能查看历史，不能继续对话。」——UI 的 error 事件本就渲染进对话流，用户在尝试继续对话的那一刻即得到明确提示，且「不能继续对话」由代码强制（不写历史的一轮对话没有意义）。

选择这一位置的理由：不需要新增 UI 组件或状态通道，提示出现在用户真正需要它的时刻（点击发送时），且该守卫与 Step 4.1 的 Agent 改造正交、不会在改造中被冲掉。

### 2. `availability = read_only_degraded` 是内存态、不落盘（实现决策）

BR1.3 要求「保留原文件不做任何写入或删除」。但 `availability` 按 `entities.md` 是 `Session` 的持久字段，而 `Session` 就存在那个文件里——写盘即违反 BR1.3。

**决策**：降级态只在本次 `open()` 的内存结果里体现，**一个字节都不写**。因为文件不变，下次打开会重新判定并确定性地得到同一结论，行为等价；这是唯一不违反「原文件零写入」的做法。BR1.3 的四项要求（置为 read_only_degraded、允许读、拒绝写、不影响其他会话）都不依赖该标记跨重启持久化，故不做持久化。`appendEntry` 对该状态抛错，满足「拒绝写入任何新 Entry」。
