# Developer Code Scan — obsidian-cli (Baizer)

## Developer Code Scan Results

### Scan Coverage

- **Analyzed deeply**:
  - `main.ts` — 插件引导（`BaizerPlugin`，1130 行）：子系统装配、命令注册、CodeMirror 扩展、Guardian 去抖/单飞/自动升级
  - `src/runtime/` — `runtime-types.ts`、`runtime-factory.ts`、`base-chat-runtime.ts`、`active-run-controller.ts`、`provider-capabilities.ts`
  - `src/runtime/pi/` — `harness-chat-runtime.ts`、`pi-native-model.ts`、`pi-tool-adapter.ts`、`pi-event-adapter.ts`、`pi-approval-policy.ts`、`harness-session-manager.ts`、`vault-session-fs.ts`、`harness-env.ts`、`session-branch-projector.ts`、`prompt-template-service.ts`
  - `src/services/` — `model-service.ts`（门面，977 行）以及 `model-catalog-service.ts`、`generation-strategy-service.ts`、`generation-quality.ts`、`workspace-edit-service.ts`、`operation-audit-log.ts`、`obsidian-context-service.ts`、`context-manager.ts`、`context-budget.ts`、`clip-input.ts`、`clip-protocol.ts`、`inbox-autosave.ts`、`video-transcription.ts` 的导出面
  - `src/skills/` — `skill-registry.ts`、`tool-registry.ts`、`types.ts`、`skill-files.ts`、`pi-skill-source.ts`，以及 `builtin/` 全部 7 个 SKILL.md 与各 executor
  - `src/permissions/permission-service.ts`
  - `src/models/interfaces.ts`、`src/mcp/types.ts`（设置模式与 `DEFAULT_SETTINGS`）
  - `src/memory/` — `memory-manager.ts`、`hindsight-store.ts`、`hindsight-retriever.ts`、`hindsight-consolidator.ts`、`hindsight-types.ts`、`hindsight-migration.ts`、`types.ts`
  - `src/knowledge/` — `runtime.ts`、`compiler.ts`、`indexer.ts`、`metadata-index.ts`、`ontology.ts`、`ontology-service.ts`、`frontmatter.ts`、`query.ts`、`file-back.ts`、`linter.ts`、`watcher.ts`、`status-service.ts`、`types.ts`
  - `src/ui/` — `shell-view.ts`、`chat-controller.ts`、`guardian-completion.ts`、`ghost-text.ts`、`guardian-gutter.ts`、`selection-menu.ts`、`approval-card.ts`、`diff-modal.ts`、`types.ts`、`command-suggestions.ts`、`guardian-modal.ts`、`guardian-request.ts` 及 `components/`、`controllers/`、`renderers/`、`tabs/`、`history/`、`state/`、`selection-ai/`、`diff/` 各模块导出面
  - `src/i18n/`、`src/utils/`
  - `test/` — 95 个 `*.test.ts` 与 `run-tests.ts`、`__mocks__/obsidian.ts`、`ui-fakes.ts`
  - 构建与工程配置 — `package.json`、`package-lock.json`（依赖树）、`tsconfig.json`、`tsconfig.test.json`、`esbuild.config.mjs`、`eslint.config.mjs`、`manifest.json`、`versions.json`
  - 工程文档 — `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`CONTEXT.md`、`CONTRIBUTING.md`、`SECURITY.md`、`THIRD-PARTY-LICENSES.md`、`CLAUDE.md`、`docs/architecture/*.md`、`docs/adr/*.md`
  - CI 与脚本 — `.github/workflows/ci.yml`、`.github/ISSUE_TEMPLATE/*`、`.github/pull_request_template.md`、`scripts/*.mjs`

- **Skimmed only**:
  - `styles.css`（110 KB）— 只确认了它是单一手写样式表，未逐条阅读规则
  - `assets/` — 仅确认只有一张 README 插图
  - `LICENSE` — 仅确认 MIT

- **Left out**（按 `.gitignore` 与 code-analysis-guide 的 "What to Skip" 跳过，未打开）:
  - `node_modules/`（依赖目录）
  - `dist/`（esbuild 构建产物；根目录 `main.js` 同为产物）
  - `.worktrees/`、`.omc/`、`.crush/`、`.superpowers/`、`.understand-anything/`、`.planning/`、`.orca/`（工具运行时状态与 worktree 副本）
  - `doc/`（被 `.gitignore` 忽略）
  - `docs/superpowers/`（被 `.gitignore` 忽略的内部规划/spec）
  - `FORYF.md`、`AGENTS.md`、`TODOS.md`（被 `.gitignore` 标注为项目私有/个人文件）
  - `.claude/`、`aidlc/`（AI-DLC 自身安装与工作区，非本项目代码）

### Packages Found

- `baizer` — Obsidian 插件（单包） — TypeScript — AI 知识工作台：聊天工作台、行内补全、知识 Wiki、本地语义记忆
- 无 workspace / monorepo：`package.json` 无 `workspaces` 字段，全仓仅一个包

### Build System

- **Type**: esbuild（单文件 CJS bundle） + npm scripts
- **Config Files**: `package.json`（`dev` = watch，`build` = production）、`esbuild.config.mjs`、`tsconfig.json`（源码类型检查）、`tsconfig.test.json`（测试，`module: commonjs`）、`eslint.config.mjs`
- **Build Dependencies**:
  - `main.ts` → `src/**` → 外部化 `obsidian` / `electron` / `@codemirror/*` / `@lezer/*` / Node builtins
  - `main.js`（输出，仓库根）与 `dist/main.js`（输出 + 静态资源拷贝）
  - `.md` 走 esbuild text loader，SKILL.md 以字符串内联进 bundle
  - 自定义 esbuild 插件 `stub-unused-pi-providers`：把 pi-ai 的 `./mistral.js` 解析成抛错存根，压 bundle 体积（Obsidian Sync 5 MB 同步上限）

### APIs Discovered

本项目**不对外暴露 HTTP/RPC API**——它是 Obsidian 客户端插件。对外契约是三类内部接口面：

- **LLM 供应方契约** — `src/mcp/types.ts` `ProviderConfig`（`type: 'gemini' | 'openai-compatible'`，含 `apiFlavor: 'completions' | 'responses'`）；由 `src/runtime/pi/pi-native-model.ts` 映射为 pi-ai `Model` + `completeSimple`
- **工具契约（25 个原子工具）** — `src/skills/builtin/`：
  - vault 读写 12 个：`read_note`、`create_note`、`update_note`、`append_to_note`、`delete_note`、`rename_note`、`list_notes`、`search_vault`、`open_file`、`read_file`、`create_file`、`update_file`
  - 技能读取 1 个：`read_skill`
  - 知识 2 个：`query_knowledge`、`file_back_knowledge`
  - 插件控制 4 个：`list_plugins`、`get_plugin_commands`、`get_plugin_settings`、`execute_plugin_command`
  - 校验 2 个：`validate_json_canvas`、`validate_base_yaml`
  - 外部 2 个：`save_webpage`、`web_search`
- **斜杠命令契约** — `src/runtime/base-chat-runtime.ts` `LOCAL_SLASH_COMMANDS`（11 条本地命令）+ 技能命令（`/save`、`/wiki:query`）+ 用户自定义命令（`.obsidian/baizer-commands/*.md`，经 pi `loadPromptTemplates`）
- **插件内事件契约** — `StreamEvent`（`src/models/interfaces.ts`）：`thinking` / `text_delta` / `tool_call` / `tool_result` / `step_boundary` / `done`（含 `entryIds`）/ `error`
- **Obsidian 协议处理器** — `src/services/clip-protocol.ts`：`obsidian://baizer-clip?url=...`

### Frameworks & Libraries

运行时依赖（`dependencies`）：

- `@earendil-works/pi-agent-core` — ^0.75.5（实装 0.75.5）— 单一 agent 运行时：`AgentHarness`、`agentLoop`、`JsonlSessionRepo`、`InMemorySessionRepo`、会话压缩、skill 格式化器、prompt 模板
- `@earendil-works/pi-ai` — ^0.75.5（实装 0.75.5）— 统一 LLM API：`Model`、`streamSimple`、`completeSimple`、provider 注册表
- `@codemirror/state` / `@codemirror/view` — ^6.5.0 / ^6.38.6 — Ghost Text、gutter、选区菜单的 CM6 扩展
- `@google/generative-ai` — ^0.21.0 — 仅作为 pi-ai google provider 的传递依赖面
- `@mozilla/readability` — ^0.6.0 — 网页正文抽取（web-clipper）
- `yaml` — ^2.8.3 — SKILL.md / `.base` frontmatter 解析

开发依赖（`devDependencies`）：

- `obsidian` ^1.5.7（类型 + 外部化）、`esbuild` 0.17.19、`typescript` ^5.9.3、`eslint` ^9.39.5 + `typescript-eslint` ^8.64.0 + `@eslint/js` ^9.39.5、`tsx` ^4.21.0（测试运行器）、`@types/node` ^16.11.6、`@types/ws` ^8.5.10、`tslib` ^2.4.0

关键版本约束：两个 pi 包**均为 ESM-only**（`"type": "module"`，exports 只给 `import`），而 bundle 是 CJS、测试 tsconfig 是 `module: commonjs`——因此所有 pi 的**值**导入必须走动态 `import()`，只有类型导入可以静态写。

### Test Coverage

- **Test Directories**: `test/`（95 个 `*.test.ts`，含 `test/knowledge/` 子目录 13 个）
- **Test Frameworks**: 无第三方测试框架；自建 runner `test/run-tests.ts` 用 `execSync` 逐个 `npx tsx` 跑，任一失败即 `process.exit`
- **Coverage Config**: 不存在（无 c8/nyc/istanbul 配置，无覆盖率阈值）；`test/bundle-size.test.ts` 与 `test/release-guidelines.test.ts` 是仓库级守卫型断言
- **测试替身**: `test/__mocks__/obsidian.ts`（tsconfig paths 映射）、`test/mock-obsidian.ts`、`test/obsidian-mock.ts`、`test/ui-fakes.ts`
- **注册表一致性**: `run-tests.ts` 的清单与磁盘上的 95 个测试文件完全对齐（无遗漏、无悬挂条目）

### Code Quality Indicators

- **Linting**: ESLint 9 flat config `eslint.config.mjs`；`@typescript-eslint/no-explicit-any` 与 `no-unused-vars` 为 **warn**，其余 error 阻断 CI
- **Type checking**: `tsconfig.json` 开了 `noImplicitAny` / `noImplicitReturns` / `noImplicitThis` / `noUnusedLocals` / `strictNullChecks`；CI 里 `tsc --noEmit || true`（非阻断，注释标注为已知类型债）
- **CI/CD**: `.github/workflows/ci.yml` 单 job `build-and-test`（Node 20）：`npm ci` → `npm run build` → `npm test` → `npx eslint .`（阻断）→ `tsc --noEmit || true`（非阻断）
- **Documentation**: 质量显著高于同类插件。`CLAUDE.md` 是模块级架构地图；`docs/architecture/` 4 篇专题（runtime / skills / permissions / settings）；`docs/adr/` 3 篇 ADR；`CONTEXT.md` 是领域词汇表（区分 Tool/Skill、Memory/Knowledge Wiki 等最易混概念）；README 中英双语。源码注释大量使用"为什么这样设计"的说明式中文注释，而非复述代码

### Technical Debt Signals

- **pi 运行时被 `any` 掏空（与本次 intent 直接相关）**：`src/runtime/pi/harness-chat-runtime.ts:64,75,93` 用 `const pi = await import('@earendil-works/pi-agent-core')` 后 `new (pi as any).AgentHarness({...})`；`harness-session-manager.ts:135,370` 同样 `as any`。pi 的**类型面没有被使用**——升级时类型检查器不会报任何错。
- **pi 会话 API 被手抄一遍**：`harness-session-manager.ts:10-50` 手写 `PiSession` / `PiSessionRepo` / `CompactionSettings` 结构接口（注释说明是为了避免 value import）。这是对上游 API 形状的人工镜像，上游变更不会被编译器捕获。
- **废弃字段仍在**：`src/runtime/runtime-types.ts:29-33` `NativeChatHandle.streamFn` 标 `@deprecated`（"HarnessChatRuntime 忽略它"）；`harness-chat-runtime.ts:306-317` `resolveModelHandle` 仍兼容三种句柄形态。历史分层残留。
- **类型逃逸口**：`runtime-types.ts:63` `harnessEnv?: unknown`；`src/services/model-service.ts:53` `harnessEnv: unknown`；`model-service.ts:667` `(this.memoryManager as any).retainLesson`；`base-chat-runtime.ts:268` `(this.deps.skillRegistry as any).listCommandEntries`。
- **`any` 密度**：`src/` + `main.ts` 共 256 处 `: any`，集中在 `src/ui/chat-controller.ts`（35）、`main.ts`（13）、`src/skills/builtin/web-clipper/executor.ts`（10）、`src/memory/hindsight-migration.ts`（10）。
- **编码损坏**：`src/ui/chat-controller.ts:62,72,89` 附近的中文注释出现乱码（如 `5绉掔紦瀛?`，疑为 UTF-8/GBK 转换残留）；`src/ui/guardian-completion.ts` 含使 `grep` 判定为二进制的字节（疑为 BOM 或异常字节）。
- **巨型文件（>500 行，违反本仓 CLAUDE.md 的 500 行约定）**：`src/settings.ts` 2786、`src/ui/shell-view.ts` 2203、`src/ui/chat-controller.ts` 1210、`src/ui/guardian-completion.ts` 1039、`src/services/model-service.ts` 977、`src/memory/memory-manager.ts` 785、`src/skills/builtin/plugin-ctrl/plugin-watcher.ts` 767、`src/knowledge/compiler.ts` 752、`src/skills/builtin/plugin-ctrl/skill-generator.ts` 666、`src/knowledge/runtime.ts` 658、`src/skills/builtin/vault-ops.ts` 590、`src/ui/renderers/message-renderer.ts` 539、`src/ui/selection-menu.ts` 522。
- **TODO/FIXME 债务极低**：全仓 `src/`+`main.ts`+`test/` 仅 1 处 `TODO` 字样，且是 `skill-generator.ts:119` 生成 prompt 里的示例文本，不是真债务标记。
- **无 eslint-disable**：0 处。
- **类型检查非阻断**：CI 的 `|| true` 意味着类型债可持续累积而 CI 全绿（注释已自认，标为 good first issue）。
- **构建脆点**：`esbuild.config.mjs` 的 `stub-unused-pi-providers` 用正则 `^\./<file>$` 匹配 pi-ai `providers/` 下的相对 import。pi-ai 升级若改变 provider 文件命名或目录结构，该插件会静默失效（bundle 体积回涨越过 Obsidian Sync 5 MB 上限），而不会有任何报错。

## Handoff Summary

- **Intent-relevant finding**:
  本次 intent（`pi-runtime-refactor`：平台迁移不充分 + pi 版本过旧）在代码中有**直接、可证伪**的对应证据，且问题集中在"未充分利用 pi-agent 能力"这一半：

  1. **pi 的 Harness 被当作不透明对象使用**。`src/runtime/pi/harness-chat-runtime.ts:93` 以 `new (pi as any).AgentHarness({ env, session, model, tools, systemPrompt, thinkingLevel, getApiKeyAndHeaders, afterToolCall })` 构造，仅用到 8 个配置面；订阅侧 `harness.subscribe((event: any) => ...)`（同文件 :133）只消费 4 类事件。
  2. **pi 的事件面被收窄到 4 类**。`src/runtime/pi/pi-event-adapter.ts:17-57` 的 `mapPiEventToStreamEvent` 只处理 `turn_start`、`message_update`（`text_delta` / `thinking_delta`）、`tool_execution_start`、`tool_execution_end`。pi 侧的会话压缩、usage/成本、审批原生信号等事件全部丢弃——而 `StreamEvent`（`src/models/interfaces.ts:65-84`）只有 7 个变体，是比 pi 事件模型更窄的自造契约。这正是"迁移不充分"的机制层证据。
  3. **pi 的类型系统完全未被使用**：所有 pi 运行时对象都是 `as any`，`harnessEnv` 类型是 `unknown`，会话 API 手抄成 `PiSession`/`PiSessionRepo` 本地接口（`harness-session-manager.ts:10-50`）。升级到新版本时，**编译器提供零保护**。
  4. **版本确实落后且被两处钉死**：`package.json:30-31` 两个 pi 包均为 `^0.75.5`（实装 0.75.5）；`package-lock.json` 锁定同一版本。
  5. **升级的结构性阻力已被代码记录**：pi 是 ESM-only，而 bundle 是 CJS（`esbuild.config.mjs:101` `format: "cjs"`）、测试是 commonjs（`tsconfig.test.json` `module: "commonjs"`），故所有 pi 值导入必须动态 `import()`——`pi-native-model.ts:14-16`、`skill-registry.ts:62-63`、`harness-session-manager.ts:7-8` 的注释都在解释这一点。
  6. **构建层还有一个静默脆点**：`esbuild.config.mjs:41-74` 的 pi provider 存根依赖 pi-ai `providers/` 下的相对路径命名。

  当前 pi 能力消费清单（升级影响面，共 14 个符号）：
  - `pi-agent-core` 值导入：`AgentHarness`、`JsonlSessionRepo`、`InMemorySessionRepo`、`DEFAULT_COMPACTION_SETTINGS`、`buildSessionContext`、`estimateContextTokens`、`shouldCompact`、`formatSkillsForSystemPrompt`、`formatSkillInvocation`、`loadPromptTemplates`、`parseCommandArgs`、`substituteArgs`
  - `pi-agent-core` 类型导入：`AgentTool`、`ToolExecutionMode`、`Skill`、`StreamFn`、`FileError`、`FileErrorCode`、`FileInfo`、`Result`
  - `pi-ai` 值导入：`completeSimple`；类型导入：`Model`、`AssistantMessage`

  另一半（"继续选 pi-agent 还是 deepseek harness"）在本仓无既成答案：`ProviderConfig.type` 只有 `'gemini'` 与 `'openai-compatible'` 两种（`src/mcp/types.ts:29`），DeepSeek 目前**是作为 OpenAI 兼容端点接入的**（`DEFAULT_PROVIDERS.deepseek`，`src/mcp/types.ts:66-72`），并没有独立的 deepseek harness 抽象层——决策是绿地设计，不是替换。

- **Risks / follow-up**:
  - 未登记的 project-root 仓库：快照 `source_fingerprint` 为 `git:4bd40d55e0a7c0a67b4f173e876edeaccebb70e1`，`head_commit` 为 `7ed9f75f291e06c69fba5c3281d377f1f5bec751`。本次扫描时工作树有 5 个未提交改动（`.gitignore`、`src/runtime/pi/harness-chat-runtime.ts`、`src/runtime/pi/pi-native-model.ts` 及两个对应测试），内容为 OpenCode Go 会话头（`x-opencode-session`）。指纹覆盖磁盘现状，故已包含这些改动。
  - `HarnessChatRuntime` 自身在 500 行以内（360 行），但它承担的职责跨了三层（模型解析、会话获取、事件桥接、审批终止、记忆沉淀、压缩触发、entryId 锚定）。任何 pi 升级都必须先决定这条流水线哪些段落交还给 pi。
  - 无覆盖率度量工具，因此"升级后行为不变"无法用覆盖率数字证明，只能靠 95 个自建测试文件回归。
  - `docs/architecture/runtime.md` 提到 `src/runtime/steering-controller.ts`，但该文件已不存在（现为 `active-run-controller.ts`）；同类文档漂移在 `CLAUDE.md` 中也存在（提到 `PiChatRuntime` 等已退役实现）。文档不能作为升级范围的唯一依据。
  - 移动端约束（`manifest.json` `isDesktopOnly: false`）：不得引入 `child_process` 等 Node API；pi 的 `ExecutionEnv` shell 侧已被 `HarnessExecutionEnv.exec()` 显式做成 `shellUnavailable`（`harness-env.ts:37,128`）。任何引入 pi 新能力的方案都必须守住这条线。
  - bundle 体积红线：Obsidian Sync Standard 不同步 >5 MB 文件，`esbuild.config.mjs:23-43` 的注释记录 main.js 曾达 6.0 MB。pi 升级带来的新传递依赖（如新增 provider SDK）必须重新验证体积，`test/bundle-size.test.ts` 是守卫。
