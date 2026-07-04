# Baizer 运行时彻底重构设计 — 迁移到 pi AgentHarness

> 日期:2026-07-04
> 范围:P0(运行时迁移到 AgentHarness)+ P1(prompt-template 用户命令 + 知识编译并发)
> 策略:分阶段(0→1→2→3),连 UI 消费层一起重构

## 一、目标与第一性原理

**核心问题不是缺功能,而是"站在 pi 的地基上又浇了一遍地基"。**

pi-agent-core 导出了完整的应用层 `AgentHarness`(`harness/agent-harness.d.ts`),内置了会话树+JSONL持久化+fork、自动 compaction(带 hook)、steering/follow-up/next-turn 三队列、skill/prompt-template 加载、运行中切 model/thinking、tool_call 审批 hook。项目却绕过它、直接用最底层的 `agentLoop`,再手工重造这一切。

**重构原则:凡 pi-agent 已有的能力,一律用 pi 的,删除自造实现。**

### 删除清单(重构后不复存在)

| 自造实现 | 行数 | pi 原生替代 |
|---|---|---|
| `SessionStore` + `vault-session-fs` 持久化逻辑 | ~399 | `AgentHarness` + `JsonlSessionRepo` |
| `SessionStore.maybeCompact` 自造压缩触发 | — | Harness 自动 compaction + `session_before_compact` hook |
| `SteeringController` 自造队列 | ~110 | Harness `steer()`/`nextTurn()`/`setActiveTools()` |
| `createNativeStreamFn` 手写 push/pull stream 包装 | ~90 | Harness 内部 `streamSimple` + `getApiKeyAndHeaders` 回调 |
| `pi-chat-runtime` 的 `holdSteeringForPendingToolResults` 暂缓逻辑 | — | Harness 内部处理 tool-result 与 steering 排序 |
| `pi-chat-runtime` 手工补 `usage:0`/`stopReason` 占位 | — | Harness 从 session `buildContext` 派生真实历史 |
| 硬编码 slash 命令契约文本(`base-chat-runtime.ts:19-31`) | — | pi `loadPromptTemplates` + 动态生成 |

## 二、关键技术前提(决定接入方式)

已通过阅读 pi 源码验证的三个事实,是本设计的地基:

1. **`AgentHarness` 构造函数强制需要一个 `Session`**(`AgentHarnessOptions.session` 必填)。因此"只换引擎不动 session"技术上不成立。pi 导出了 `MemorySessionRepo`(内存版),用它可获得等价于"无持久化"的语义 —— 这让阶段0 与阶段1 得以严格分离。

2. **Harness 内部用 `streamSimple` + `getApiKeyAndHeaders(model)` 回调注入密钥**(`agent-harness.js:293-302`)。项目那段脆弱的 `createNativeStreamFn` 手写 stream 包装将整段删除,apiKey 注入从"闭包"改为"回调"。

3. **pi-ai 不导出任何 embedding 能力**。记忆系统的 BM25 词法检索是约束下的合理选择,不在本次重构范围内(P2,另议)。

## 三、架构:契约边界的抉择

**决定:重写 UI 消费层,直接消费 AgentHarness 原生事件,不保留 StreamEvent 中间契约。**

现状:UI 经 `StreamEvent`(`text_delta/tool_call/tool_result/step_boundary/done/error`)+ `StreamController`(纯分发器)消费 runtime 输出。`pi-event-adapter` 把 pi 事件映射成 StreamEvent。

重构后:runtime 暴露 Harness 的 `subscribe(listener)` 事件流,UI 消费层直接订阅 `AgentEvent`(`turn_start`/`message_update`/`tool_execution_start`/`tool_execution_end`/`agent_end` 等)。`StreamController` 与 `pi-event-adapter` 的职责被 Harness 事件订阅取代。

> **工作量边界(诚实记录):** `chat-controller.ts` 约 1161 行,其中与引擎耦合的仅 `processCommand` 的事件循环;其余(审批缓冲、workspace edit 撤销、👍👎 反馈、slash 命令、memory 视图)是业务逻辑。重写消费层意味着这些业务逻辑需围绕 Harness 事件重新组织,回归面较大。此为用户明确选择的方向。

## 四、模块目标形态

```
UI 层 (shell-view / chat-controller)
  │  订阅 harness.subscribe(AgentEvent)
  ▼
ModelService (门面,签名基本不变)
  │  chatStream / chat / generate / steerActiveRun / setActiveTools / clearSession
  ▼
HarnessChatRuntime (新,取代 PiChatRuntime + BaseChatRuntime 的执行部分)
  │  持有 AgentHarness 实例;prepareTurn 仍负责 prompt 组装(memory/context/skill/plan)
  ▼
AgentHarness (pi 原生)
  ├── Session (阶段0: MemorySessionRepo → 阶段1: JsonlSessionRepo)
  ├── ExecutionEnv (VaultSessionFileSystem + NoopShell)
  ├── getApiKeyAndHeaders(model) → { apiKey }
  ├── systemPrompt 回调 (取代空串 + user prompt 拼装)
  ├── afterToolCall hook (审批 terminate)
  ├── resources.skills / resources.promptTemplates (阶段3)
  └── 自动 compaction (阶段1)
```

**保留不动:** `prepareTurn` 的 prompt 组装职责(memory 召回、context、skill 清单、generation plan)。这些是 Baizer 业务,不是 pi 能力,继续保留。但 systemPrompt 部分从"拼进 user prompt"迁移到 Harness 的 `systemPrompt` 回调。

## 五、分阶段实施

### 阶段 0 — AgentHarness 引擎接入 + UI 消费层重写(内存 Session)

**目标:** 用 Harness 替换 agentLoop 直调,UI 消费层改为订阅 Harness 原生事件。用 `MemorySessionRepo` 保持"无持久化"语义,隔离 session 变化。

**改动:**
- 新增 `HarnessChatRuntime`:构造 `AgentHarness`(env = `VaultSessionFileSystem` + NoopShell;session = MemorySessionRepo 建;model 来自 `buildNativeChatHandle`;`getApiKeyAndHeaders` 回调返回当前 provider 的 apiKey)。
- 工具:`adaptToolDefinitionsToPi` 复用(Harness 的 tools 与 agentLoop 同为 `AgentTool[]`)。
- 审批:`afterToolCall` hook 检测 `approval_required` → 返回 `{ terminate: true }`。
- 事件:UI 消费层订阅 `harness.subscribe`,处理 `AgentEvent`。删除 `StreamController` + `pi-event-adapter` 的 StreamEvent 映射(或改为 thin 适配)。
- 删除 `createNativeStreamFn`(手写 stream 包装),保留 `buildGeminiModel`/`buildOpenAICompatModel`/`createNativeCompleteFn`(generate 仍用 completeSimple)。

**验证:** 全量测试绿;手工冒烟(单轮问答、多轮、工具调用、审批卡、中断)。

### 阶段 1 — session + compaction 交给 Harness

**目标:** 内存 Session 换成 `JsonlSessionRepo`,删除自造 `SessionStore`。

**改动:**
- Harness 的 session 由 `JsonlSessionRepo`(env = VaultSessionFileSystem)创建/恢复。
- **删除** `SessionStore`(399 行)+ `maybeCompact`。开启 Harness 自动 compaction(`CompactionSettings`,reserveTokens/keepRecentTokens)。
- 跨轮上下文:不再由 UI 回灌 `priorMessages`;Harness 从 session 派生。`ChatController.buildPriorMessages` 与 `ChatTurnRequest.priorMessages` 移除。
- 删除手工 `usage:0` 占位、`holdSteering` 暂缓逻辑 —— Harness 用真实 usage 驱动 token 估算与压缩。
- 会话恢复:插件启动时用持久化的 session 引用 `repo.open`;`clearSession` 用 `repo.create` 开新会话。
- **附赠:** session tree 的 fork/分支摘要能力就位(为未来"编辑历史重跑"埋接口,本阶段不做 UI)。

**验证:** 跨重启会话恢复;长对话自动压缩触发;全量测试绿。

### 阶段 2 — steering 交给 Harness

**目标:** 删除自造 `SteeringController`,改用 Harness 队列。

**改动:**
- **删除** `SteeringController`(110 行)+ `filterPiToolsByActiveTools`。
- `ModelService.steerActiveRun(text)` → `harness.steer(text)` 或 `harness.nextTurn(text)`(按"运行中补话"语义选 steer)。
- `ModelService.setActiveTools(names)` → `harness.setActiveTools(names)`(read_skill 兜底保留逻辑迁入 active tools 计算)。
- 门面方法签名不变,UI 调用点零改动。

**验证:** 运行中补话生效;运行时收窄工具集生效;全量测试绿。

### 阶段 3 — prompt-template 用户命令 + 知识编译并发(P1,与 0/1/2 解耦)

**目标 A — 用户自定义 slash 命令:**
- vault 隐藏目录 `.obsidian/baizer-commands/` 放 `.md` 模板文件。
- 启动时 `loadPromptTemplates(env, dir)` 加载,`substituteArgs` 支持 `$ARGUMENTS`/`$1`/`${@:N}`。
- 挂到 Harness `resources.promptTemplates`;用户输入 `/cmd args` → `harness.promptFromTemplate(name, args)`。
- `/` 补全动态列出模板;硬编码的 `LOCAL_SLASH_COMMANDS` 契约文本改为动态生成(内置命令 + 用户模板合并)。

**目标 B — 知识编译并发:**
- `compiler.ts:compileAllPending`(第 701 行)从文件级串行 `for + await` 改为**带全局并发上限**的文件级并发。
- 复用单文件内已验证的 `Promise.allSettled` 批处理模式(第 595 行),外加并发闸避免打爆 provider 速率限制。并发度可配(默认保守,如 3)。

**验证:** 用户放置 `.md` 后 `/cmd` 可用;大 vault 编译耗时显著下降;速率限制不被触发;全量测试绿。

## 六、风险与回滚

| 风险 | 缓解 |
|---|---|
| Harness 内部 `streamSimple` 静态 import,CJS 测试环境加载失败 | 沿用现有动态 import 模式对 Harness 整体 lazy-load |
| NoopShell 被 Harness 内部调用抛错 | Shell 方法返回 pi `Result` 的 err 形态(不 throw),而非直接抛异常 |
| UI 消费层重写引入交互回归(审批/中断/反馈) | 每阶段手工冒烟清单;阶段0 用内存 session 隔离,先证明引擎无回归再动 session |
| 自动 compaction 摘要质量/时机不符预期 | 复用 Harness `session_before_compact` hook 可定制摘要 prompt |
| 跨轮上下文语义变化(UI 回灌 → session 派生) | 阶段1 独立验证;保留一次可回退的提交边界 |

## 七、验证策略(每阶段通用)

1. `npm run build` 通过(esbuild 打包无误)。
2. `npm test`(tsx run-tests)全量绿。
3. 手工冒烟清单:单轮/多轮问答、工具调用时间线、文件写入审批、运行中中断、👍👎 反馈、/斜杠命令、跨重启会话恢复(阶段1+)。
4. 安全:审批门控(`confirmExecutions`)在重构后仍拦截破坏性写入。

