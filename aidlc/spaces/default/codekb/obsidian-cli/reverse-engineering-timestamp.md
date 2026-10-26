# Reverse Engineering Timestamp

## Run Record

- Date: 2026-10-21
- Commit: 7ed9f75f291e06c69fba5c3281d377f1f5bec751

### 本次运行的说明

- 扫描类型：**首次全量扫描**（`NO_STORE` 重跑守卫结论——本仓库此前无 CodeKB，故本次九件产物全部由本次运行创建）
- 扫描范围：整个仓库 `./`（`kind: full`）
- 扫描时工作树状态：`main` 之外的 `fix/startup-blocking-io` 分支上有 5 个未提交改动（`.gitignore`、`src/runtime/pi/harness-chat-runtime.ts`、`src/runtime/pi/pi-native-model.ts` 及两个对应测试文件），内容为 OpenCode Go 会话头（`x-opencode-session`）。指纹覆盖磁盘现状，故已包含这些改动。
- 快照元数据：`paths: ["./"]`，`store_generation: none`，`source_fingerprint: git:4bd40d55e0a7c0a67b4f173e876edeaccebb70e1`，`head_commit: 7ed9f75f291e06c69fba5c3281d377f1f5bec751`
- 扫描方式：只读代码，**未**运行项目的测试、构建或程序（遵守 reverse-engineering 阶段的只读约束）

### 覆盖边界

- **深度分析**：`main.ts`、`src/` 全部 11 个子目录与约 150 个 TypeScript 文件、`test/`（95 个测试文件 + 自建 runner + 测试替身）、构建与工程配置（`package.json`、`package-lock.json` 依赖树、`tsconfig.json`、`tsconfig.test.json`、`esbuild.config.mjs`、`eslint.config.mjs`、`manifest.json`、`versions.json`）、工程文档（`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`CONTEXT.md`、`CONTRIBUTING.md`、`SECURITY.md`、`THIRD-PARTY-LICENSES.md`、`CLAUDE.md`、`docs/architecture/*`、`docs/adr/*`）、CI 与脚本（`.github/**`、`scripts/*.mjs`）
- **仅略读**：`styles.css`（110 KB，只确认它是单一手写样式表，未逐条阅读规则）；`assets/`（只确认仅一张 README 插图）；`LICENSE`（只确认 MIT）
- **完全未打开**（按 `.gitignore` 与 code-analysis-guide 的 "What to Skip" 跳过）：`node_modules/`、`dist/`、根目录 `main.js`（构建产物）、`.worktrees/`、`.omc/`、`.crush/`、`.superpowers/`、`.understand-anything/`、`.planning/`、`.orca/`、`doc/`（gitignored）、`docs/superpowers/`（gitignored）、`FORYF.md` / `AGENTS.md` / `TODOS.md`（gitignored 的项目私有文件）、`.claude/` 与 `aidlc/`（AI-DLC 自身安装与工作区，非本项目代码）

### 本次运行发现的 intent 相关结论（供后续阶段引用）

本次 intent 为 `pi-runtime-refactor`（改造底层架构：pi-agent 作为底座不充分 + pi 版本过旧）。扫描给出的机制层证据：

1. pi 的 `AgentHarness` 以 `new (pi as any).AgentHarness({...})` 构造，只用到 8 个配置面（`harness-chat-runtime.ts:93`）
2. pi 事件面只映射 4 类（`pi-event-adapter.ts:17-57`），比 pi 自身的事件模型窄得多
3. pi 会话 API 被手抄成本地结构接口（`harness-session-manager.ts:10-50`），上游变更不被编译器捕获
4. 两个 pi 包均钉在 `^0.75.5`（实装 0.75.5）
5. pi 是 ESM-only，而 bundle 是 CJS、测试是 commonjs——所有 pi 值导入必须动态 `import()`
6. esbuild 的 pi provider 存根按上游相对文件名正则匹配（`esbuild.config.mjs:41-74`），升级时是静默脆点
7. DeepSeek 当前**是作为 OpenAI 兼容端点接入的**（`src/mcp/types.ts:66-72`），并无独立 harness 抽象层——"继续选 pi-agent 还是 deepseek harness" 是绿地设计决策，不是替换

pi 能力消费清单（共 12 个值符号 + 11 个类型符号，跨 7 个文件）详见 `technology-stack.md` §8 与 `dependencies.md` §3.4。

## Scope of Analysis

```yaml
scope_version: 1
kind: full
intent: pi-runtime-refactor
fingerprint: 4bd40d55e0a7c0a67b4f173e876edeaccebb70e1
analyzed:
  paths:
    - ./
  components:
    - Plugin Bootstrap
    - ModelService 门面
    - Chat Runtime（准备层与执行层）
    - pi 原生适配层
    - Harness 会话与执行环境
    - 运行中控制
    - 工具注册表
    - 技能注册表
    - 内置技能与工具
    - 插件控制与派生技能
    - 权限服务
    - 知识子系统
    - 记忆子系统
    - UI 层：Workbench
    - UI 层：Guardian 与选区
    - 服务层（横切）
    - 国际化
    - 工具与契约库
    - 共享类型与设置模式
    - 构建与测试工程
shallow:
  paths:
    - styles.css
    - assets/
```
