# 需求分析 —— pi 运行时底座重构

## 意图分析

**用户想达成什么**（不只是功能，而是目标）：解决底座迁移不充分和 pi-agent 版本过旧这两个历史遗留问题——把 Baizer 的 LLM 运行时**彻底**迁移到以 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 为底座，并升级到当前最新版本，使项目不再"钉死在一个旧快照上、手抄接口绕过类型系统"，而是真正吃到上游能力与安全更新。

**技术选型结论**（已在对话中确认，详见下方"来源"）：继续使用 pi-agent，不引入 DeepSeek Harness。DeepSeek Harness 定位是独立终端编码代理，嵌入第三方宿主只能走进程外 stdio JSON-RPC SDK server，这与 Obsidian 移动端禁用 `child_process` 的硬约束（`manifest.json` `isDesktopOnly: false`；本仓 `CLAUDE.md`）直接冲突；且它 2026-08-13 才开源，仍是"开发者预览"，官方自己说明会有破坏性变更。这不是"换一个供应商"的选择，而是在既定底座上把两个历史问题一次解决：

1. **底座迁移不充分** —— 当前代码把 pi 当"黑盒工具箱"而非"底座"：`AgentHarness`/`session` 均以 `as any` 构造，`harnessEnv` 类型为 `unknown`，会话 API（`PiSession`/`PiSessionRepo`/`CompactionSettings`）被手抄成本地结构接口而非使用 pi 自带类型；事件面只映射 4 类，比 pi 原生事件模型窄得多；`AgentHarness` 的 8 个配置面也未用满。
2. **版本过旧** —— `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 均锁定在 `^0.75.5`（实装 0.75.5），而 npm 当前最新是 **1.3.0**。中间 0.86~0.99 是官方自己后续要废弃的过渡态（`AgentHarness` 重写为 `lane()`/`AgentLane`），不值得迁过去再迁一次。

## 来源

- `[desc]` 用户初始描述（`project-description.json`）："我想对这个底层架构做改造，之前架构有两个问题：1.平台迁移不充分，没有完全以pi-agent作为底座，充分利用pi-agent的能力；2. 使用的pi-agent版本比较老，现在的pi-agent有较大升级。现在要解决这两个问题，进行彻底重构，是继续选pi-agent还是deepseek harness"
- `[scope]` 工作流选定方案：refactor（7 阶段，Minimal 深度）
- `[Q-pi-vs-dsh]` 对话中确认：继续选 pi-agent，不引入 DeepSeek Harness（嵌入形态冲突 + 开发者预览稳定性不足）
- `[Q-upgrade-scope]` 对话中确认：本次把"用深 pi-agent 现有能力"与"升级到 1.3.0"合并为一件事
- `[Q1]`/`[Q2]`/`[Q3]` Requirements Analysis 阶段澄清问题的回答（见 `requirements-analysis-questions.md`）
- CodeKB（`aidlc/spaces/default/codekb/obsidian-cli/`）：`architecture.md` §4/§6/§7/§8、`technology-stack.md` §2/§8、`component-inventory.md`（pi 原生适配层 / Harness 会话与执行环境 / 运行中控制）、`dependencies.md` §2.4/§3.4、`code-structure.md`
- 外部调研：`@earendil-works/pi-agent-core` 1.3.0 包实测（`npm pack` 解包核查 `agent.d.ts`/`index.d.ts`：`AgentHarness` 已不存在，替换为 `Agent` 类，`SessionRepo`/`JsonlSessionRepo`/`formatSkillsForSystemPrompt`/`loadPromptTemplates`/`buildSessionContext`/`shouldCompact` 等 0.75.5 时期使用的符号在 1.3.0 中全部消失）；DeepSeek Harness 公开资料（[deepseekharness.io](https://deepseekharness.io/)、[eesel.ai](https://www.eesel.ai/blog/deepseek-harness)、[betterstack.com](https://betterstack.com/community/guides/ai/deepseek-harness-plugin/)、[GitHub sdk/server README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md)）

## 功能性需求

### FR1：pi-agent-core / pi-ai 版本升级

**FR1.1** 把 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 从 `^0.75.5`（实装 0.75.5）升级到当前最新 `1.3.0`，`package.json` 与 `package-lock.json` 均更新到该精确已验证版本。

**FR1.2** 升级后项目必须能通过现有的类型检查（`tsc -p tsconfig.json`，基线 0 个新增错误；`tsconfig.test.json` 因 obsidian mock 本身有已知噪声，不作为本次基线）、ESLint（CI 阻断级别不新增违规）、`npm run build`（`main.js` 产出且体积仍 < 5 MB）与 `test/run-tests.ts` 注册的全部测试。

**FR1.3** 升级过程中识别并替换 1.x 中已移除/改名的 API（已知：`AgentHarness` → `Agent` 类；`getApiKeyAndHeaders` → `getApiKey` + 新的 header 机制；`session`/`SessionRepo` 系列整体移除；`formatSkillsForSystemPrompt`/`loadPromptTemplates`/`parseCommandArgs`/`substituteArgs`/`buildSessionContext`/`estimateContextTokens`/`shouldCompact` 等 agent-core 辅助函数移除），逐一确认 1.x 的等价能力或自建替代方案，不得遗漏任何当前被使用的符号。**验收以 `technology-stack.md` §8 的逐项符号清单本身为准**（该清单逐条列出的实际合计是 13 个值符号——`@earendil-works/pi-agent-core` 12 个 + `@earendil-works/pi-ai` 的 `completeSimple` 1 个——与 10 个类型符号——`@earendil-works/pi-agent-core` 8 个 + `@earendil-works/pi-ai` 的 `Model`/`AssistantMessage` 2 个；该文件自身的汇总句"12 个值符号 + 11 个类型符号"与逐项清单不一致，以逐项清单为准，不得按汇总句数字验收完整性），跨 7 个文件。

### FR2：会话持久化自建层（替代已移除的 `SessionRepo`）

**FR2.1** 自建一套会话持久化层，承接现有 `HarnessSessionManager` + `VaultSessionFileSystem` 基于 pi 0.75.5 自带 `JsonlSessionRepo` 实现的全部用户可见行为，逐项保持一致：
- per-conversation 会话隔离（`conversationId` = tab id，多 tab 互不串台）
- vault 内 JSONL 落盘与可读性
- 跨重启恢复（`hasHistory`、open-or-create、并发去重、release、purge）
- 自动压缩（按真实 token 用量触发 `maybeCompact` 语义）
- 分叉/重试/编辑/兄弟切换（`moveTo` + `projectBranchToMessages` 重投影语义，而非 `navigateTree`）
- 审批结果回灌（对模型可见、对 UI 分支投影不可见的 custom_message 语义，即 `appendApprovalOutcome`/`appendCustomMessageEntry` 现有行为）

内部实现、存储的 JSON 结构细节可以与现状不同；允许的是**实现**改变，不允许的是以上**行为**发生可观察的语义变化。（来源：`[Q1]` = A）

**FR2.2** vault 中已存在的旧版会话 JSONL 文件，在升级后**首次被打开时自动迁移**到新存储格式，不需要用户手动操作或运行独立迁移脚本；迁移逻辑需要有专门的测试覆盖（新旧格式往返、迁移失败的降级处理）。（来源：`[Q2]` = B）

**FR2.3** 新建自建持久化层时，必须同样遵守"文件落盘走 `vault.adapter`、不碰 node fs、移动端禁 `child_process`"的现有运行环境约束（`technology-stack.md` §7；本仓 `CLAUDE.md`），不得为实现会话持久化引入 Node-only API。

### FR3：把 pi-agent 用深——校正现有"没用满"的底座集成

以 CodeKB `technology-stack.md` §8 记录的 pi 能力消费清单为这次校正的完整基线（来源：`[Q3]` = A），逐项消除当前"黑盒工具箱"式用法：

**FR3.1** 移除/收窄 `as any` 的 pi 构造方式：`AgentHarness`（升级后为 `Agent` 类）、`session` 相关对象改为使用 pi 自带的类型定义构造，而非当前 `harness-chat-runtime.ts:93` 的 `new (pi as any).AgentHarness({...})` 模式；`harnessEnv` 不再声明为 `unknown`。

**FR3.2** 移除手抄的会话结构镜像（`PiSession`/`PiSessionRepo`/`CompactionSettings` 本地接口），改为：若 1.x 仍提供对应类型则直接复用；若 1.x 已移除（已知移除），则 FR2 的自建持久化层以 pi 1.x 实际暴露的 `Agent`/事件/消息类型为基础自行定义接口，不再是对某个已废弃内部结构的"镜像猜测"。

**FR3.3** 审视并按需拓宽当前只映射 4 类的 pi 事件 → `StreamEvent` 映射（`pi-event-adapter.ts:17-57`），确保 1.x `Agent` 实际产生的事件类型（含压缩、usage、审批等现状被丢弃的信号）在适配层有明确的"映射"或"有意识丢弃并记录理由"两种结果之一，不再是未经评估的窄化。

**FR3.4** 审视当前 `AgentHarness` 仅使用的 8 个配置面（`env`/`session`/`model`/`tools`/`systemPrompt`/`thinkingLevel`/`getApiKeyAndHeaders`/`afterToolCall`），对照 1.x `Agent`/`AgentOptions` 实际暴露的配置面（如 `convertToLlm`/`transformContext`/`beforeToolCall`/`finishTurn`/`prepareRequest`/`prepareNextTurn(WithContext)`/`steeringMode`/`followUpMode`/`toolExecution` 等），逐项判断"现状未使用是否合理"，对确有价值但未使用的配置面给出启用方案或记录为后续阶段的待办。

**FR3.5** 所有 pi 值导入继续通过动态 `import()`（pi 仍为 ESM-only，bundle 仍为 CJS、测试仍为 commonjs），类型导入继续使用 `import type`；升级不改变这一既有工程约束，只校正其下的符号集合。

### FR4：esbuild provider 存根与构建脚手架的兼容性

**FR4.1** 校验自定义 esbuild 插件 `stub-unused-pi-providers`（按 pi-ai `providers/` 目录下相对文件名正则匹配 `mistral.js` 等未使用 provider）在 1.3.0 下是否仍按相同目录结构工作；若 1.x 的 provider 文件命名或目录结构有变化，相应更新该插件的匹配规则，使 bundle 体积守卫（`test/bundle-size.test.ts`，< 5 MB）继续有效。

### FR5：回归与双向验证

**FR5.1** 升级与底座校正完成后，Baizer 两条既有 LLM 路径（会话型 `chatStream`/`AgentHarness`→`Agent`；无状态型 `generate`→`completeSimple`）的全部既有调用方（`KnowledgeCompiler`、`GuardianCompletionService`、`MemoryManager`/`HindsightConsolidator`、`PluginSkillGenerator`、`VideoTranscription`、`ModelCatalogService`）行为不变，且设置变更（provider/model/key/contextWindow/thinkingLevel）仍在下一轮自动生效的既有语义不变。

**FR5.2** Guardian 快/深双路径、Workbench 工具调用与审批中断/回灌、会话分叉/重试/编辑/兄弟切换、知识编译（Map-Reduce）四条既有交互链路（`architecture.md` §7 四张交互图所刻画的行为）在升级后保持可观察行为一致，作为本次重构的端到端验证基准。

## 非功能性需求

**NFR1（兼容性/体积）**：升级后 `main.js` 产出体积仍须小于 5 MB（Obsidian Sync Standard 同步上限），由现有 `test/bundle-size.test.ts` 继续守护。

**NFR2（可维护性/类型安全）**：升级后 pi 相关对象的类型断言（`as any`）数量相对当前基线不得增加；FR3.1/FR3.2 所覆盖的构造点必须有真实类型覆盖而非断言绕过，使编译器对后续上游变更重新具备检测能力。

**NFR3（移动端兼容）**：全部改动（含 FR2 自建持久化层）必须同时运行于桌面端与移动端（`isDesktopOnly: false`），不得引入 `child_process` 等 Node-only API；该约束延伸到技术选型本身——这正是本次排除 DeepSeek Harness 嵌入方案的理由。

**NFR4（可测试性）**：FR2.2 的会话迁移逻辑、FR3 各项底座校正点，均需要新增或更新自动化测试，纳入 `test/run-tests.ts` 的现有 95 个测试文件注册清单；现有测试套件在改动后必须保持全绿（`refactor` scope 的既定测试底线：不新增覆盖率下限要求，但现有套件必须保持通过）。

## 约束

- **技术约束**：继续使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 作为唯一 LLM 运行时底座（已确认，不引入 DeepSeek Harness 或其他 agent 框架）。
- **平台约束**：Obsidian 插件沙箱、移动端禁用 Node `child_process`、单一 bundle（`main.js`）< 5 MB、ESM-only 上游包与 CJS/commonjs 构建输出并存的既有工程约束保持不变。
- **依赖管理约束**：升级版本使用精确或已验证版本号，不使用开放范围（延续本仓既有 `esbuild` 精确锁定的做法）。
- **测试约束**：`refactor` scope 的既定测试策略（Minimal：不新增覆盖率下限，但要求现有测试套件保持全绿）适用于本次改造；FR2.2 的迁移逻辑例外，需要新增专门测试。

## 假设

- **[assumption]** 假设 pi-agent-core 1.3.0 是本次升级的目标版本（而非等待更新的后续版本）；若在 Functional Design / Code Generation 阶段开始实施时 npm 上已发布更新的次版本且无已知破坏性变更，可顺带纳入，但不作为本次需求的强制目标。
- **[assumption]** 假设"会话持久化自建层"在 Domain Design/Functional Design 阶段会产出具体的存储格式与迁移算法设计；本阶段只确定行为保真度要求（FR2.1）与迁移时机（FR2.2），不预先设计实现细节。
- **[assumption]** 假设 FR3.3/FR3.4 中"按需拓宽"的具体取舍（哪些新增事件/配置面值得启用）留给后续设计阶段基于 1.x 实际 API 形状决定，本阶段只要求"有意识评估并给出结论"而非预先列出启用清单。

## 范围外

- 不包含引入或试验 DeepSeek Harness（已在对话中明确排除，见"技术选型结论"）。
- 不包含 pi-agent-core/pi-ai 之外的其他运行时迁移（例如更换 LLM SDK 的 provider 抽象、更换知识/记忆子系统的存储引擎）。
- 不包含本次 CodeKB 已记录但与"pi 底座"无关的其他架构改进建议：`settings.ts`/`shell-view.ts` 等超过 500 行文件的拆分、构建存根脆弱性、`StreamEvent` 事件面偏窄的既有观察、文档漂移（均为 `architecture.md` §8"改进机会"中与本次 intent 无直接关系的既有观察）；以及 `esbuild`/`obsidian` 类型包版本漂移的单独升级（`dependencies.md` §2.4"版本风险"表中记录的既有观察）。以上均不纳入本次重构范围。
- 不包含生产环境部署策略或 CI/CD 流水线变更（本次 scope 为 `refactor`，不含 `ci-pipeline` 阶段）。

## 开放问题

- **[Q-future]** 升级到 1.3.0 后，`Agent` 类新增的 `prepareRequest`/`finishTurn`/`toolExecution` 等配置面是否要在本次就启用，还是记录为后续独立 intent——FR3.4 要求本阶段先做盘点，具体启用决策留给 Functional Design/Code Generation 阶段基于实现复杂度判断。
- **[Q-future]** `docs/architecture/runtime.md` 中仍指向已删除的 `src/runtime/steering-controller.ts`、`CLAUDE.md` 提到的已退役 `PiChatRuntime` 等文档漂移（CodeKB 逆向工程阶段记录的 Open question），是否在本次重构中一并修正文档，待 Functional Design 阶段确认。
