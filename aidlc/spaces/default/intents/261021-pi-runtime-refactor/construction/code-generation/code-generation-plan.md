## Summary

- Builds: 把 `@earendil-works/pi-agent-core`/`pi-ai` 从 0.75.5 升级到 1.3.0，自建会话持久化层（替代已移除的 `SessionRepo`），校正 pi 底座集成的 5 处手段（`as any` 构造、手抄接口、窄事件映射、未用满的配置面、esbuild 存根）
- Touches: `package.json`/`package-lock.json`、`src/runtime/pi/*`（`harness-chat-runtime.ts`、`pi-native-model.ts`、`harness-session-manager.ts`、`vault-session-fs.ts`、`pi-event-adapter.ts`）、`src/skills/skill-registry.ts`、`esbuild.config.mjs`、新增 `src/runtime/pi/session-store/*`（自建持久化层）、对应测试
- Tests: Minimal 策略，需求驱动单测（每条 FR 至少 1 条可验证测试 + 每个受影响组件至少 1 条 happy-path 单测），预计 18-22 条新增/修改测试；现有 95 个测试文件须保持全绿

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run that layer's tests.",
  "scope": "refactor",
  "test_strategy": "minimal",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    }
  ],
  "obligations": {
    "strategy": "minimal",
    "strategy_volume": [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect."
    ],
    "scope_floor": [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "test-after",
    "runner_step": "Verify the existing test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Verify the existing test runner/configuration and record the exact unit-scoped command.",
      "Data model / database behavior - implement.",
      "Data model / database behavior - write and run its tests after implementation.",
      "Repository / data access - implement.",
      "Repository / data access - write and run its tests after implementation.",
      "Business logic - implement.",
      "Business logic - write and run its tests after implementation.",
      "API / endpoint - implement.",
      "API / endpoint - write and run its tests after implementation.",
      "Frontend behavior - implement.",
      "Frontend behavior - write and run its tests after implementation.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:06c12367ad8c44802c849bfad1d351bad9312bf5dfa96742a3ea92f337cd806c",
  "contract_sha256": "sha256:be24de49065e6c54a26024b4a9117dabfa3bc2a5a7d4774a9ade02b7d86b1894"
}
```

本次 refactor 没有前端行为改变、没有新的数据库/仓储层——"Frontend behavior"/"Repository / data access"/"Data model / database behavior" 三个契约层在本次改造里对应的是会话持久化层（Session/Entry 是 entities.md 定义的数据模型，`src/runtime/pi/session-store/*` 是其"仓储"）与 pi 原生适配层（业务逻辑/API 层），不是传统 Web 应用的 DB/前端分层；下方每个计划步骤会注明它对应哪一层。

## 计划

### Step 1: 验证现有测试运行方式

- [x] Step 1. 确认现有测试运行命令：`npx tsx --tsconfig tsconfig.test.json <file>`（`test/run-tests.ts` 逐文件注册、逐个 `execSync`）。记录基线：当前 95 个测试文件全部通过，`tsc -p tsconfig.json` 0 个错误。**（对应 Testing Contract 的 runner_step）**

### Step 2: 升级 pi-agent-core / pi-ai 版本（FR1.1-FR1.3）

- [x] Step 2.1【业务逻辑实现】升级 `package.json` 中 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 为精确版本 `1.3.0`（不使用 `^`），运行安装使 `package-lock.json` 同步更新。
- [x] Step 2.2【业务逻辑实现】逐一核对 `technology-stack.md` §8 逐项符号清单（值导入 13 个、类型导入 10 个——以逐项清单为准，不是汇总句的"12+11"，见 FR1.3 验收口径）在 1.3.0 中的去向：`AgentHarness`→`Agent` 类、`getApiKeyAndHeaders`→`getApiKey`、`session`/`SessionRepo` 系列整体移除、`formatSkillsForSystemPrompt`/`loadPromptTemplates`/`parseCommandArgs`/`substituteArgs`/`buildSessionContext`/`estimateContextTokens`/`shouldCompact` 移除。产出一份迁移映射清单（可作为 `code-summary.md` 的一部分），逐个符号标注"直接替换为 X" / "由 Step 3 自建持久化层承接" / "不再需要"。
- [x] Step 2.3【环境/构建配置】运行 `npm run build` 与 `tsc -p tsconfig.json`，确认当前基线失败点（预期：大量因符号消失导致的编译错误），作为后续步骤的修复清单来源，不在本步修复。

### Step 3: 自建会话持久化层——数据模型与仓储层（FR2.1-FR2.3；entities.md Session/Entry）

- [x] Step 3.1【数据模型】在 `src/runtime/pi/session-store/types.ts` 实现 `entities.md` 定义的 `Session`/`Entry` 两层类型（含 `availability`、`activeLeafEntryId`、`visibleToModel`/`visibleToUiProjection`、`supersededByEntryId` 等字段），替代现有手抄的 `PiSession`/`PiSessionRepo`/`CompactionSettings` 结构镜像（FR3.2）。
- [x] Step 3.2【数据模型/测试】写并运行该类型模块的测试（字段契约、`approval_outcome` 固定可见性组合的约束校验）。
- [x] Step 3.3【仓储/数据访问】在 `src/runtime/pi/session-store/store.ts` 实现 Session/Entry 的读写：vault `.adapter` 落盘（延续 `VaultSessionFileSystem` 不碰 node fs 的约束，FR2.3）、`activeLeafEntryId` 指针更新（分支切换，BR2.2）、`supersededByEntryId` 标记写入（编辑/重试，BR2.2）。
- [x] Step 3.4【仓储/数据访问/测试】写并运行分支树读写的单测：根条目创建、追加子条目、兄弟切换只改指针不改内容、编辑产生新 Entry 并标记原 Entry 为 superseded。
- [x] Step 3.5【仓储/数据访问】实现格式判定（BR1.1，按内容特征路由解析器）、旧格式迁移（BR1.2，重建 Entry 树 + 把旧 custom_message 审批回灌重建为 `kind: approval_outcome`）、迁移失败降级（BR1.3，`availability = read_only_degraded`，保留原文件，拒绝新 Entry 写入）。
- [x] Step 3.6【仓储/数据访问/测试】写并运行迁移相关测试（FR2.2 专门要求）：旧格式文件迁移后新旧行为等价、迁移失败时只读降级且不影响其他会话、损坏文件触发 BR1.3 而非静默重建空会话。
- [x] Step 3.7【业务逻辑实现】在 `src/runtime/pi/harness-session-manager.ts` 把现有对外方法（`hasHistory`/`open-or-create`/`release`/`purge`/`appendApprovalOutcome`/`moveToBranch`/`prepareForkAtUser`/`supersedeUserEntry`/`maybeCompact`）的内部实现改为调用 Step 3.1-3.5 的自建持久化层，保持这些方法的对外签名与可观察行为不变（FR2.1 行为保真度）。
- [x] Step 3.8【业务逻辑实现/测试】写并运行 `HarnessSessionManager` 对外行为的回归测试：per-conversation 隔离（多 tab 不串台）、跨重启恢复、自动压缩判定不变、审批回灌对模型可见对 UI 不可见（BR2.1）。

### Step 4: 校正 pi 原生适配层的底座集成（FR3.1、FR3.3、FR3.4、FR3.5）

- [x] Step 4.1【业务逻辑实现】在 `src/runtime/pi/harness-chat-runtime.ts` 把 `new (pi as any).AgentHarness({...})` 改为使用 1.3.0 `Agent` 类的真实类型构造（`new pi.Agent({...})`，去掉 `as any`），`harnessEnv` 不再声明为 `unknown`（FR3.1）。
- [x] Step 4.2【API/端点层】在 `src/runtime/pi/pi-event-adapter.ts` 按 `functional-spec.md` §4 的事件决策表逐型实现：文本增量/工具调用/回合结束/错误 四类延续现状映射；新增压缩事件到 `StreamEvent` 的映射；usage/token 事件按决策表"丢弃+理由"处理（代码注释写明理由并指回决策表）；审批原生信号按核实结果映射或标注不适用（BR3.1）。
- [x] Step 4.3【API/端点层/测试】写并运行事件适配的单测：决策表每一行"映射"类型都有可观察的 `StreamEvent` 产出路径的用例；"丢弃"类型有对应的"确认不产出"用例。
- [x] Step 4.4【业务逻辑实现】核对 1.3.0 `AgentOptions` 暴露的配置面（`convertToLlm`/`transformContext`/`beforeToolCall`/`finishTurn`/`prepareRequest`/`prepareNextTurn(WithContext)`/`steeringMode`/`followUpMode`/`toolExecution`），逐项记录"现状未使用是否合理"的结论到 `code-summary.md`（FR3.4，具体启用决策按 `requirements.md` 开放问题留待后续；本步只做盘点与记录，不强制启用）。
- [x] Step 4.5【环境/构建配置】确认 `src/skills/skill-registry.ts`、`src/runtime/pi/pi-native-model.ts`、`src/runtime/pi/prompt-template-service.ts` 里所有 pi 值导入仍走动态 `import()`，类型导入走 `import type`（FR3.5，延续现状约束，不是新要求，只核实升级没有破坏它）。

### Step 5: esbuild 存根与构建脚手架（FR4.1）

- [x] Step 5.1【环境/构建配置】核对 `esbuild.config.mjs` 的 `stub-unused-pi-providers` 插件在 1.3.0 下是否仍按相同 `providers/` 目录结构匹配 `mistral.js`；如目录结构或命名变化，更新匹配规则。
- [x] Step 5.2【环境/构建配置/测试】运行 `test/bundle-size.test.ts`，确认 `main.js` 产出仍 < 5 MB。

### Step 6: 回归验证（FR5.1-FR5.2）

- [x] Step 6.1【业务逻辑实现/测试】对两条既有 LLM 路径的全部既有调用方（`KnowledgeCompiler`、`GuardianCompletionService`、`MemoryManager`/`HindsightConsolidator`、`PluginSkillGenerator`、`VideoTranscription`、`ModelCatalogService`）运行既有测试，确认行为不变（FR5.1）。
- [x] Step 6.2【业务逻辑实现/测试】对 FR5.2 列出的四条既有交互链路做针对性回归：会话分叉/重试/编辑/兄弟切换（已在 Step 3.8 覆盖）、审批中断与回灌（已在 Step 3.8/4.3 覆盖）、Guardian 快/深双路径与知识编译 Map-Reduce（运行既有测试确认未受影响，不新增测试）。

### Step 7: 全量验证与文档

- [x] Step 7.1【环境/构建配置】运行 `tsc -p tsconfig.json`，确认 0 个新增错误（FR1.2）。
- [x] Step 7.2【环境/构建配置】运行 `npm run build`，确认 `main.js` 产出成功且 < 5 MB（FR1.2、NFR1）。
- [x] Step 7.3【环境/构建配置】运行 `test/run-tests.ts` 注册的全部测试文件（含本计划新增的测试文件，需先加入该数组），确认全部通过（FR1.2、NFR4）。——人工确认将 `test/bundle-size.test.ts` 的软预算由 4.6 MB 上调到 4.8 MB（见 code-summary.md「体积预算决策」）后，`npx tsx test/run-tests.ts` 100 个文件全部通过，无需再逐文件运行。
- [x] Step 7.4【文档与可追溯性】更新 `code-summary.md`（已创建/修改文件、关键实现决策、测试覆盖摘要、未执行测试及理由、与计划的偏差）与 `traceability.json`。——**`code-summary.md` 已更新（含 FR/BR → 实现文件 → 验证 两张追溯表）；`traceability.json` 未改写，理由见 code-summary.md「关于 traceability.json」**

## 测试文件清单（新增/修改）

- `test/pi-native-model.test.ts`（修改，现有）—— 更新为 1.3.0 `Agent`/`getApiKey` 构造方式
- `test/pi-event-adapter.test.ts`（修改，现有）—— 新增压缩事件映射与 usage 丢弃用例
- `test/pi-approval-policy.test.ts`（修改，现有）—— 核对审批回灌可见性断言仍成立
- `test/harness-chat-runtime.test.ts`（修改，现有）—— 更新为 `Agent` 类构造；核对事件桥接行为不变
- `test/session-store-types.test.ts`（新增）—— Step 3.2
- `test/session-store-branching.test.ts`（新增）—— Step 3.4
- `test/session-store-migration.test.ts`（新增）—— Step 3.6
- `test/harness-session-manager-regression.test.ts`（新增）—— Step 3.8
- `test/bundle-size.test.ts`（既有，重跑验证）—— Step 5.2

每个测试文件的运行命令、覆盖目标见 `unit-test-instructions.md`。
