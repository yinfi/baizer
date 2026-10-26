# 代码结构 — Baizer（obsidian-cli）

## 1. 包与模块组织

单包仓库，无 workspace / monorepo。`package.json` 无 `workspaces` 字段。

```
obsidian-cli/
├── main.ts                     插件引导（BaizerPlugin，1130 行）
├── src/
│   ├── mcp/                    设置模式、provider 配置、品牌常量
│   ├── models/                 跨层共享接口（StreamEvent / ToolDefinition / ChatMessage）
│   ├── runtime/                pi 运行时（准备层 + 执行层 + 适配层）
│   │   └── pi/                 pi 专项适配与持久化
│   ├── services/               门面与横切服务
│   ├── skills/                 工具注册表、技能注册表、内置技能与工具
│   │   └── builtin/            7 个内置技能（SKILL.md + executor）
│   ├── permissions/            权限决策纯函数层
│   ├── knowledge/              知识 Wiki 子系统
│   ├── memory/                 Hindsight 记忆子系统
│   ├── ui/                     视图、控制器、渲染器、组件
│   ├── i18n/                   界面文案（en/zh）
│   └── utils/                  日志、节流、文件操作契约、视频工具
├── test/                       95 个测试文件 + 自建 runner + 测试替身
├── scripts/                    许可证生成、启动性能探针、剪藏 frontmatter 修复
├── docs/                       架构专题 + ADR
├── assets/                     README 插图
├── .github/                    CI 工作流 + Issue/PR 模板
└── 构建与工程配置              esbuild / tsconfig / eslint / manifest / versions
```

## 2. 文件规模分布（`src/` + `main.ts` 共 30,980 行 TypeScript）

### 2.1 超过 500 行的文件（违反本仓 CLAUDE.md 的 500 行约定）

| 文件 | 行数 | 主要职责 |
|---|---|---|
| `src/settings.ts` | 2786 | 设置页（9 个分区、搜索、provider 管理、记忆管理、派生技能管理） |
| `src/ui/shell-view.ts` | 2203 | 工作台视图（视图生命周期、命令解析、建议弹窗、流渲染、时间线、上下文芯片、附件、Tab） |
| `src/ui/chat-controller.ts` | 1210 | 回合编排（流事件消费、文件写入文本缓冲、审批卡片、工作区编辑撤销、反馈） |
| `src/ui/guardian-completion.ts` | 1039 | Guardian 补全服务（快/深决策、质量门控、知识注入、诊断事件） |
| `src/services/model-service.ts` | 977 | 门面（provider 生命周期、注册表、记忆、会话、审计、设置变更） |
| `src/memory/memory-manager.ts` | 785 | 记忆门面（召回、沉淀、整合、查询扩展、图检索、矛盾更新） |
| `src/skills/builtin/plugin-ctrl/plugin-watcher.ts` | 767 | 插件监听与派生技能对账 |
| `src/knowledge/compiler.ts` | 752 | Map-Reduce 编译、分块、归并、提示构造、响应解析 |
| `src/skills/builtin/plugin-ctrl/skill-generator.ts` | 666 | 由已安装插件生成 skill |
| `src/knowledge/runtime.ts` | 658 | 知识子系统生命周期（命令、事件、自动编译、本体、Guardian 上下文） |
| `src/skills/builtin/vault-ops.ts` | 590 | 12 个 vault 读写工具 |
| `src/ui/renderers/message-renderer.ts` | 539 | 消息渲染 |
| `src/ui/selection-menu.ts` | 522 | 选区悬浮菜单（CM6 扩展 + 浮窗 + 聊天面板） |

### 2.2 行数分布概览

- **200–500 行**：约 30 个文件（含 `harness-session-manager.ts` 453、`base-chat-runtime.ts` 413、`skill-registry.ts` 401、`hindsight-store.ts` 367、`harness-chat-runtime.ts` 360 等）
- **100–200 行**：约 35 个文件
- **< 100 行**：约 45 个文件（多为单一职责的小工具与组件）

## 3. 文件分类

| 类别 | 位置 | 说明 |
|---|---|---|
| **配置** | `src/mcp/types.ts`、`main.ts`（`loadSettings` / `saveSettings`）、`src/settings.ts` | 设置模式与持久化；`loadSettings()` 含旧格式迁移 |
| **模型/接口** | `src/models/interfaces.ts`、`src/skills/types.ts`、`src/runtime/runtime-types.ts`、`src/knowledge/types.ts`、`src/memory/*types.ts`、`src/mcp/types.ts` | 跨层共享类型；纯声明，无运行期逻辑 |
| **服务/用例** | `src/services/*`、`src/knowledge/*`、`src/memory/*`、`src/skills/*-registry.ts` | 业务逻辑与编排 |
| **控制器/处理器** | `src/ui/chat-controller.ts`、`src/ui/controllers/*`、`src/ui/history/conversation-controller.ts`、`src/services/clip-protocol.ts` | 输入解析、回合编排、协议处理 |
| **数据访问** | `src/runtime/pi/vault-session-fs.ts`、`src/runtime/pi/harness-env.ts`、`src/memory/hindsight-store.ts`、`src/ui/history/conversation-store.ts`、`src/services/operation-audit-log.ts`、`src/knowledge/metadata-index.ts`、`src/knowledge/frontmatter.ts` | 经 Obsidian vault adapter 的持久化 |
| **工具/辅助** | `src/utils/*`、`src/i18n/*`、`src/services/context-budget.ts` | 日志、节流/去抖、文件操作契约、文案 |
| **中间件/策略** | `src/permissions/permission-service.ts`、`src/runtime/pi/pi-approval-policy.ts`、`src/runtime/active-run-controller.ts` | 横切策略：权限决策、审批判定、运行中控制 |
| **适配器** | `src/runtime/pi/pi-native-model.ts`、`pi-tool-adapter.ts`、`pi-event-adapter.ts`、`src/runtime/pi/vault-session-fs.ts`、`harness-env.ts` | 把本项目模型 ↔ pi 模型 / Obsidian vault ↔ pi FileSystem 互转 |
| **UI/渲染** | `src/ui/renderers/*`、`src/ui/components/*`、`src/ui/tabs/*`、`src/ui/selection-ai/*`、`src/ui/diff/*` | 视图与 DOM |
| **编辑器扩展** | `src/ui/ghost-text.ts`、`src/ui/guardian-gutter.ts`、`src/ui/selection-menu.ts` | CM6 StateField / StateEffect / ViewPlugin |
| **测试** | `test/**` | 95 个测试文件 + 替身 |

**无** 数据库迁移文件、无 HTTP 端点处理器、无模板文件（提示以字符串常量内联在源码中）。

## 4. 模块依赖方向

```
main.ts
  ├─→ src/ui/shell-view.ts ─→ src/ui/chat-controller.ts ─→ src/services/model-service.ts
  ├─→ src/knowledge/runtime.ts ─→ src/services/model-service.ts（generate 回调）
  ├─→ src/skills/*（注册表与内置技能）
  └─→ src/ui/guardian-completion.ts ─→ src/services/model-service.ts

src/services/model-service.ts
  ├─→ src/runtime/runtime-factory.ts ─→ src/runtime/pi/harness-chat-runtime.ts
  │                                        ├─→ src/runtime/base-chat-runtime.ts
  │                                        └─→ src/runtime/pi/{pi-native-model,pi-tool-adapter,pi-event-adapter,pi-approval-policy}
  ├─→ src/runtime/pi/{harness-session-manager,vault-session-fs,harness-env,prompt-template-service,session-branch-projector}
  ├─→ src/runtime/active-run-controller.ts
  └─→ src/memory/memory-manager.ts（构造并注入 generate）

src/runtime/base-chat-runtime.ts
  ├─→ src/utils/file-operation-contract.ts
  ├─→ src/services/{generation-quality,generation-strategy-service}.ts
  └─→ src/skills/{skill-registry,tool-registry}.ts（经 deps）

src/runtime/pi/pi-tool-adapter.ts ─→ src/services/workspace-edit-service.ts
src/skills/builtin/* ─→ src/permissions/permission-service.ts
src/permissions/permission-service.ts ─→ src/mcp/types.ts（只读设置）
```

### 4.1 分层约束（代码中可验证）

- **底层不反向依赖上层**：`src/mcp/types.ts` 用最小结构类型声明 `pluginWatcher?`（注释明确"types.ts 是底层模块，不该反向依赖 skills 层"）；`MemoryManager` 不 import `ModelService`，而是接收注入的 `generate` 回调
- **无循环依赖**：`model-service` → `memory-manager` 是单向的（回调注入打破潜在环）
- **`src/models/interfaces.ts` 是跨层共享的叶子模块**，不 import 任何 `src/` 内模块

## 5. 代码模式

### 5.1 门面模式

`ModelService` 是全部 LLM 工作的唯一入口。UI 只认门面，不直接接触 runtime 或 pi。

### 5.2 模板方法 / 准备-执行分离

`BaseChatRuntime` 是抽象类，`prepareTurn` 为具体实现，`query` / `queryStream` 为抽象；`HarnessChatRuntime` 继承并只实现执行侧。

### 5.3 适配器模式

- `pi-native-model.ts`：`ProviderConfig` → pi-ai `Model`
- `pi-tool-adapter.ts`：`ToolDefinition` → pi `AgentTool`（含超时、执行模式推断、审批 `terminate`）
- `pi-event-adapter.ts`：pi 事件 → `StreamEvent`
- `vault-session-fs.ts` / `harness-env.ts`：Obsidian vault adapter → pi `FileSystem` / `ExecutionEnv`

### 5.4 注册表模式

`ToolRegistry`（原子工具，全量暴露给模型）与 `SkillRegistry`（行为指令，渐进式披露）。技能经 `SKILL.md` 的 YAML frontmatter 声明 `triggers` 与 `tools` 子集。

### 5.5 纯函数策略层

`permission-service.ts` 的四个导出全是纯函数，只读设置、不碰 `app` 与 IO；`activeNote` 由调用方从 `ctx.app` 取出后传入，保持可单测。

### 5.6 CodeMirror 6 响应式状态

Guardian 与选区菜单用 `StateField` / `StateEffect` 驱动：
- `guardianModeField` — 全局启用/暂停态
- `ghostTextField` / `ghostTextStateField` — 行内建议的装饰与状态
- `setGuardianLineState` — 逐行 thinking/suggestion 状态
- `selectionMenuField` / `setSelectionMenuState` — 选区菜单状态

### 5.7 动态 `import()` 隔离 ESM-only 依赖

pi 包是 ESM-only，而 bundle 是 CJS、测试是 commonjs。因此**所有 pi 值导入**写成 `await import('@earendil-works/pi-agent-core')`，仅**类型导入**用静态 `import type`。`tsx` 走 commonjs 时静态导入 ESM-only 包会报 "No exports main defined"。

### 5.8 结果类型（Result）而非异常

pi 的 FileSystem 契约用 `Result<T, FileError>`；`vault-session-fs.ts` 与 `harness-env.ts` 提供 `ok()` / `err()` 辅助构造，把 Obsidian 异常翻译成 pi 的 `FileErrorCode`。

### 5.9 事件队列桥接

`harness-chat-runtime.ts:329-360` 用一个极简异步队列（`push` / `close` / `drain` 异步迭代器）把 pi 的回调式事件流桥接成 `AsyncGenerator<StreamEvent>`。

### 5.10 延迟物化（启动路径优化）

内置 skill 的磁盘路径是**确定性拼接**（`resolveBuiltinPaths` 纯计算、零 IO），真正写盘推到后台（`void materializeBuiltins(...)`），`read_skill` 另有内存兜底。

### 5.11 版本迁移兜底

`loadSettings()` 迁移旧扁平 provider 格式；`sessionRef`（全局单例）迁移到 `sessionRefs`（per-conversation）；`hindsight-migration.ts` 导入旧记忆文件。

## 6. 命名与风格约定

- **文件命名**：kebab-case（`harness-session-manager.ts`、`ghost-text.ts`），与导出的类名对应
- **类型命名**：PascalCase；接口不加 `I` 前缀（例外：`IPlugin`，为兼容层）
- **常量**：UPPER_SNAKE_CASE（`DEFAULT_SETTINGS`、`USER_SKILLS_DIR`、`SUPERSEDED_LABEL`）
- **私有成员**：显式 `private` 修饰符；依赖注入用 `constructor(private readonly x)` 简写
- **pi 命名空间前缀**：`pi-*` / `harness-*` 标识 pi 专项模块
- **注释语言**：源码注释以中文为主，说明"为什么这样设计"而非复述代码；面向模型的提示文本（system prompt、skill 指令）为英文
- **格式**：4 空格缩进（`src/settings.ts`、`src/ui/chat-controller.ts` 用 4 空格；部分较新文件用 2 空格，未强制统一）
- **无 Prettier 配置**（仓库根无 `.prettierrc`）；风格由 ESLint 与惯例约束

## 7. 构建产物流向

```
main.ts  →  esbuild  →  main.js（仓库根，CJS，ES2022，tree-shaking 开）
                     →  dist/main.js + dist/manifest.json + dist/styles.css
```

- 外部化：`obsidian`、`electron`、`@codemirror/*`、`@lezer/*`、Node builtins
- `.md` 走 text loader（SKILL.md 内联为字符串）
- 自定义插件 `stub-unused-pi-providers` 把 pi-ai 的 `./mistral.js` 换成抛错存根
- `npm run dev` 进入 watch 模式；`npm run build` 单次构建后退出

## 8. 测试组织

- 扁平 + 一个子目录：`test/*.test.ts`（82 个）与 `test/knowledge/*.test.ts`（13 个）
- **自建 runner**：`test/run-tests.ts` 硬编码 95 个文件路径，逐个 `execSync` 跑 `npx tsx --tsconfig tsconfig.test.json <file>`，任一失败即 `process.exit`
- **测试替身**：`test/__mocks__/obsidian.ts`（tsconfig paths 映射，Obsidian API mock）、`test/mock-obsidian.ts`、`test/obsidian-mock.ts`、`test/ui-fakes.ts`
- **约定**：每个测试文件自带 `assert`，用 `console.log` 输出进度；`test/functional-test.js` 与 `test/setup-mock.js` 不在 runner 清单内（历史遗留）
