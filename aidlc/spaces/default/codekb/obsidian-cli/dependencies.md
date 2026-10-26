# 依赖分析 — Baizer（obsidian-cli）

## 1. 结论先行

- **单包仓库**：`package.json` 无 `workspaces` 字段，全仓只有一个包，因此**不存在跨包（cross-package）内部依赖**。
- **内部依赖**是文件级 / 目录级模块依赖，方向严格单向（底层叶子模块不反向依赖上层），无循环依赖。
- **外部依赖**分三类：运行时（7 个）、开发期（10 个）、宿主提供（esbuild `external` 列表）。
- **最大的外部耦合面是 pi**：两个 `@earendil-works/pi-*` 包共 23 个符号（12 值 + 11 类型），且全部通过 `as any` / 动态 `import()` 使用，类型系统不提供任何升级保护。

---

## 2. 外部依赖

### 2.1 运行时依赖（`dependencies`，会进 bundle 或由宿主提供）

| 包 | 版本 | 类别 | 使用位置 | 是否外部化 |
|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | 0.75.5 | 核心运行时 | `src/runtime/pi/*`、`src/skills/{skill-registry,pi-skill-source}.ts`、`src/runtime/runtime-types.ts` | 否（打进 bundle） |
| `@earendil-works/pi-ai` | 0.75.5 | LLM 客户端 | `src/runtime/pi/pi-native-model.ts`、`src/runtime/runtime-types.ts` | 否 |
| `@codemirror/state` | 6.5.0 | 编辑器扩展 | `src/ui/{ghost-text,guardian-gutter,selection-menu}.ts` | **是**（宿主提供） |
| `@codemirror/view` | 6.38.6 | 编辑器扩展 | 同上 + `main.ts` | **是** |
| `@google/generative-ai` | 0.21.0 | LLM SDK | 无直接 import（经 pi-ai google provider 使用） | 否（传递） |
| `@mozilla/readability` | 0.6.0 | 网页抽取 | `src/skills/builtin/web-clipper/executor.ts` | 否 |
| `yaml` | 2.8.3 | 解析 | SKILL.md / `.base` frontmatter | 否 |

### 2.2 开发期依赖（`devDependencies`）

| 包 | 版本 | 用途 |
|---|---|---|
| `esbuild` | 0.17.19 | 构建（**精确锁定，无 `^`**） |
| `typescript` | 5.9.3 | 类型检查 |
| `eslint` + `@eslint/js` + `typescript-eslint` | 9.39.5 / 9.39.5 / 8.64.0 | Lint |
| `tsx` | 4.21.0 | 测试运行器 |
| `obsidian` | 1.10.3（声明 `^1.5.7`） | 宿主 API 类型 + 测试 mock 映射目标 |
| `@types/node` | 16.18.126 | Node 类型 |
| `@types/ws` | — | WebSocket 类型 |
| `tslib` | — | `importHelpers` 运行时辅助 |

### 2.3 传递依赖中值得注意的

| 包 | 来源 | 备注 |
|---|---|---|
| `typebox` 1.1.38 | pi-agent-core | pi 的 schema 工具 |
| `ignore` 7.0.5 | pi-agent-core | 文件忽略规则 |
| `yaml` 2.9.0 | pi-agent-core | 与顶层 `yaml@2.8.3` **可能双版本共存** |
| 各 LLM SDK（mistral 等 8 个 provider） | pi-ai | 被 esbuild 存根插件部分排除 |

### 2.4 版本风险

| 风险 | 说明 |
|---|---|
| **pi 落后** | 两个 pi 包均钉在 `^0.75.5`（实装 0.75.5）。`package-lock.json` 锁定同一版本 |
| **pi 类型未使用** | 所有 pi 运行时对象以 `as any` 构造；`harnessEnv` 类型为 `unknown`；pi 会话 API 被手抄成本地结构接口。**升级时编译器零保护** |
| **esbuild 版本偏旧** | 精确锁定 0.17.19（2023 年发布）；较新 esbuild 对 CJS + 动态 import 的处理与插件 API 有变化 |
| **obsidian 类型漂移** | 声明 `^1.5.7` 但实装 1.10.3，高于 `manifest.json` 的 `minAppVersion: 1.7.2` |
| **构建存根脆弱** | `stub-unused-pi-providers` 按 pi-ai `providers/` 相对文件名正则匹配，上游改名即静默失效 |
| **无安全审计工具** | 无 `npm audit` / Dependabot / Snyk 配置；CI 不含依赖漏洞扫描 |
| **无依赖更新工具** | 无 Renovate / Dependabot 配置 |

---

## 3. 内部依赖（模块级）

### 3.1 依赖分层

```
第 0 层（叶子，不 import 任何 src 内模块）
  src/models/interfaces.ts
  src/utils/logger.ts
  src/utils/throttle.ts
  src/utils/file-operation-contract.ts
  src/i18n/zh.ts, zh-messages.ts
  src/skills/types.ts

第 1 层（只依赖第 0 层 + obsidian）
  src/mcp/types.ts
  src/runtime/provider-capabilities.ts
  src/permissions/permission-service.ts
  src/runtime/runtime-types.ts（仅类型依赖第 0/1 层）

第 2 层（注册表与适配器）
  src/skills/tool-registry.ts
  src/skills/skill-files.ts
  src/skills/pi-skill-source.ts
  src/skills/skill-registry.ts        → ToolRegistry
  src/runtime/pi/vault-session-fs.ts
  src/runtime/pi/harness-env.ts
  src/runtime/active-run-controller.ts
  src/runtime/pi/{pi-event-adapter,pi-approval-policy}.ts
  src/services/{generation-quality,generation-strategy-service,context-budget}.ts

第 3 层（pi 专项）
  src/runtime/pi/pi-native-model.ts
  src/runtime/pi/pi-tool-adapter.ts
  src/runtime/pi/harness-session-manager.ts
  src/runtime/pi/session-branch-projector.ts
  src/runtime/pi/prompt-template-service.ts

第 4 层（运行时）
  src/runtime/base-chat-runtime.ts
  src/runtime/pi/harness-chat-runtime.ts
  src/runtime/runtime-factory.ts

第 5 层（子系统门面）
  src/services/model-service.ts
  src/services/workspace-edit-service.ts
  src/services/operation-audit-log.ts
  src/services/obsidian-context-service.ts
  src/memory/memory-manager.ts
  src/knowledge/*（runtime 为门面，compiler/indexer/linter/watcher 等为其内部）

第 6 层（UI）
  src/ui/**（chat-controller → model-service）

第 7 层（引导）
  main.ts
```

### 3.2 关键依赖边（含打破潜在环的设计）

| 从 | 到 | 方式 | 备注 |
|---|---|---|---|
| `main.ts` | 全部子系统 | 直接构造 | 唯一的装配点 |
| `ui/chat-controller` | `services/model-service` | 直接 | UI 只认门面 |
| `services/model-service` | `runtime/runtime-factory` | 直接 | 恒返回 `HarnessChatRuntime` |
| `services/model-service` | `runtime/pi/harness-session-manager` | 直接 | 会话/分支/压缩 |
| `services/model-service` | `runtime/active-run-controller` | 直接 | 补话与动态工具集 |
| `services/model-service` | `memory/memory-manager` | **构造 + 回调注入** | `MemoryManager` **不** import `ModelService`，只接收 `generate` 回调——这是打破环的关键设计 |
| `services/model-service` | `knowledge/runtime` | **回调注入** | `KnowledgeRuntime` 接收 `modelService.generate` 而非整个 ModelService |
| `runtime/base-chat-runtime` | `skills/{skill,tool}-registry` | 经 `deps` | 不直接 import 实例 |
| `runtime/pi/pi-tool-adapter` | `services/workspace-edit-service` | 直接（类型 + 判定函数） | 直接应用型写工具走专用路径 |
| `skills/builtin/*` | `permissions/permission-service` | 直接 | 权限决策收敛 |
| `mcp/types.ts` | skills 层 | **不依赖** | 用最小结构类型声明 `pluginWatcher?`，注释明确"types.ts 是底层模块，不该反向依赖 skills 层" |

### 3.3 循环依赖检查

**未发现循环依赖。** 三处最易成环的地方都被显式设计切断：

1. `ModelService ↔ MemoryManager`：`MemoryManager` 接收 `generate` 回调（`model-service.ts:169-176`），不 import ModelService
2. `ModelService ↔ KnowledgeRuntime`：同上，注入 `(prompt) => modelService.generate(...)`
3. `mcp/types.ts ↔ skills/*`：`IPlugin.pluginWatcher` 用最小结构类型而非 `import PluginWatcher`

### 3.4 对 pi 的依赖集中度

| 文件 | pi 依赖形式 |
|---|---|
| `src/runtime/pi/harness-chat-runtime.ts:64,93` | 动态 `import()` + `new (pi as any).AgentHarness(...)` |
| `src/runtime/pi/harness-session-manager.ts:135,144,370` | 动态 `import()` + `as any`；手写 `PiSession` / `PiSessionRepo` / `CompactionSettings` 结构镜像 |
| `src/runtime/pi/pi-native-model.ts:200` | 动态 `import('@earendil-works/pi-ai')` 取 `completeSimple` |
| `src/runtime/pi/prompt-template-service.ts:51,103` | 动态 `import()` 取 `loadPromptTemplates` / `parseCommandArgs` / `substituteArgs` |
| `src/skills/skill-registry.ts:67` | 动态 `import()` 取 `formatSkillsForSystemPrompt` / `formatSkillInvocation` |
| `src/runtime/pi/{harness-env,vault-session-fs}.ts:1` | 仅 `import type`（`FileError` / `FileInfo` / `Result` / `FileErrorCode`） |
| `src/runtime/pi/pi-tool-adapter.ts:1` | 仅 `import type`（`AgentTool` / `ToolExecutionMode`） |
| `src/skills/{pi-skill-source,skill-registry}.ts:15,10` | 仅 `import type`（`Skill`） |
| `src/runtime/runtime-types.ts:1-2` | 仅 `import type`（`Model` / `StreamFn`） |

**pi 耦合集中在 `src/runtime/pi/` + `src/skills/skill-registry.ts` 共 7 个文件**——这是一个相对收敛的替换边界。

---

## 4. 宿主提供的依赖（esbuild `external`）

`obsidian`、`electron`、`@codemirror/{autocomplete,collab,commands,language,lint,search,state,view}`、`@lezer/{common,highlight,lr}`、全部 Node builtins。

这些在运行时由 Obsidian 宿主注入，不打进 bundle；但 `@codemirror/state` 与 `@codemirror/view` 同时出现在 `dependencies` 中（提供类型与开发期解析）。

---

## 5. 依赖相关的工程约束

| 约束 | 落点 | 后果 |
|---|---|---|
| 所有 pi 值导入必须动态 `import()` | pi 是 ESM-only，测试是 commonjs | 无法 tree-shake pi 的部分；无法静态分析 pi 的导出使用 |
| pi provider SDK 需部分排除 | `esbuild.config.mjs:41-74` | bundle 体积守卫；正则匹配脆弱 |
| 移动端禁 Node API | 本仓 `CLAUDE.md` | pi 的 shell 能力不可用（`harness-env.ts:128`） |
| `test/**` 与 `scripts/**` 不 lint | `eslint.config.mjs:15-16` | 测试代码的 `any` 与死代码不可见 |
| CI 无依赖安全扫描 | `.github/workflows/ci.yml` | 无 `npm audit` 步骤 |
