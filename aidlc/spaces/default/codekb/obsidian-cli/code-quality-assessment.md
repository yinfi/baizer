# 代码质量评估 — Baizer（obsidian-cli）

## 1. 结论先行

| 维度 | 评级 | 依据 |
|---|---|---|
| 命名清晰度 | **good** | 文件名与类名一一对应；`harness-*` / `pi-*` 前缀稳定标识 pi 专项模块；常量 UPPER_SNAKE_CASE |
| 函数规模 | **fair** | 大量小函数与纯函数；但 13 个文件超 500 行，最大 2786 行 |
| 错误处理 | **good** | 171 个 catch 块，仅 4 处空 catch（且多为有意的"尽力而为"降级）；边界处显式处理；用 `Result<T, FileError>` 表达可恢复失败 |
| 测试存在性 | **good** | 95 个测试文件 / 24,021 行测试代码（相对 30,980 行源码约为 0.78:1）；关键路径均有覆盖 |
| 重复度 | **fair** | 权限决策已收敛为纯函数层；但 `chat-controller` 与 `guardian-completion` 内仍有重复的文件写入判定逻辑 |
| 死代码 | **good** | 0 处 `eslint-disable`；1 处 `TODO` 字样（实为生成提示中的示例文本，非真债务标记）；`src/` 仅 1 处 `console.log` |
| 类型安全 | **poor** | 256 处 `: any`；`harnessEnv` 类型为 `unknown`；pi 运行时对象全部 `as any`；CI 的类型检查非阻断 |
| 文档质量 | **good** | `CLAUDE.md` 模块地图 + `docs/architecture/` 4 篇 + `docs/adr/` 3 篇 + `CONTEXT.md` 领域词汇表 + 中英双语 README |
| CI/CD 强度 | **fair** | build + test + lint（阻断）+ tsc（非阻断）；无覆盖率、无安全扫描、无依赖更新机器人 |

---

## 2. 测试

### 2.1 规模与组织

| 指标 | 值 |
|---|---|
| 测试文件 | 95（`test/*.test.ts` 82 + `test/knowledge/*.test.ts` 13） |
| 测试代码行数 | 24,021 |
| 源码行数 | 30,980（`src/` + `main.ts`） |
| 比值 | 约 0.78 : 1 |
| 框架 | **无**（自建 runner） |
| 覆盖率工具 | **无** |
| 覆盖率阈值 | **无** |

### 2.2 自建 runner（`test/run-tests.ts`）

- 硬编码 95 个测试文件路径，逐个 `execSync('npx tsx --tsconfig tsconfig.test.json <file>', { stdio: 'inherit' })`
- 任一文件非零退出即 `process.exit(status)`
- **一致性良好**：清单与磁盘上的 95 个文件完全对齐，无遗漏、无悬挂条目（已核验）
- **缺点**：串行执行（每个文件一次 `tsx` 进程启动）；无并行、无超时、无失败聚合（首个失败即停）

### 2.3 测试替身

| 文件 | 用途 |
|---|---|
| `test/__mocks__/obsidian.ts` | tsconfig paths 映射的 Obsidian API mock（`App` / `Vault` / `Plugin` / `Modal` / `Notice` 等） |
| `test/mock-obsidian.ts` / `test/obsidian-mock.ts` | 额外的 Obsidian 替身（历史分层，两套并存） |
| `test/ui-fakes.ts` | UI 层测试用的假元素与假视图 |

**注意**：`tsconfig.test.json` 用 `paths` 把 `obsidian` 重定向到 mock，因此 **mock 的类型与真实 Obsidian 类型可能漂移**。仓库记忆中已记录过这个坑：用 `tsc -p tsconfig.test.json` 做类型检查会因 mock 报出 1600+ 假错误，真实检查必须用 `tsconfig.json`。

### 2.4 仓库级守卫型测试（质量工程亮点）

| 测试 | 断言内容 |
|---|---|
| `test/bundle-size.test.ts` | `dist/main.js` < 5 MB 硬限（Obsidian Sync Standard 同步上限），并留 4.6 MB 预算余量；未构建时 SKIP 而非失败 |
| `test/startup-io-budget.test.ts` | 用一个"记账型 adapter"统计 `onload` 阻塞路径上的 IO 次数，把"启动不得做无谓 IO"变成可回归的硬约束（背景：7 个内置 skill 物化写盘 + 回扫目录 = 固定 54 次串行 IO，移动端过 native 桥放大成秒级白屏） |
| `test/release-guidelines.test.ts` | 版本号一致性（`package.json` / `manifest.json` / `versions.json`）、README 与 manifest 描述一致、CHANGELOG 存在对应条目 |
| `test/brand.test.ts` | 品牌常量一致性 |
| `test/cross-phase-smoke.test.ts` | 跨子系统冒烟 |
| `test/knowledge/compile-concurrency.test.ts` | 自动编译并发与补跑语义 |

这类"把不变量写成可执行断言"的做法，是本仓质量工程最值得肯定的部分。

### 2.5 关键路径覆盖（按模块）

| 模块 | 测试文件 |
|---|---|
| pi 运行时 | `harness-chat-runtime`、`base-chat-runtime`、`pi-runtime-factory`、`pi-approval-policy`、`pi-event-adapter`、`pi-tool-adapter`、`pi-native-model`、`steering` |
| 门面 | `model-service`、`provider-capabilities`、`settings-state` |
| 技能与工具 | `skill-registry`、`skill-routing`、`skill-files`、`file-tools`、`vault-permissions`、`plugin-tools`、`plugin-watcher`、`plugin-skill-generator`、`obsidian-markdown-skill` |
| 知识 | `knowledge/{compiler,indexer,linter,ontology,ontology-service,query,types,watcher,file-back,frontmatter-idempotent,frontmatter-fallback,guardian-context,compile-concurrency}` + `knowledge-status-panel`、`knowledge-status-service` |
| 记忆 | `memory-manager`、`hindsight-memory` |
| UI | `chat-controller`、`shell-input-layout`、`message-renderer`、`thinking-renderer`、`tool-renderer`、`approval-flow`、`selection-menu`、`ghost-text`、`guardian-completion`、`floating-panel`、`history-menu`、`tab-manager`、`conversation-*`、`command-dropdown`、`suggest-list`、`input-toolbar`、`context-chips` 等 |
| 横切 | `permission-service`、`operation-audit-log`、`workspace-edit-service`、`file-operation-contract`、`throttle`、`i18n-locale`、`action-registry`、`prompt-template-service` |
| 采集 | `web-clipper`、`web-search`、`video-transcription`、`video-utils`、`clip-input`、`clip-protocol`、`inbox-autosave`、`save-path` |

**无测试的模块**（未见对应测试文件）：`src/ui/shell-view.ts`（2203 行，仅有 `shell-input-layout` 间接覆盖）、`src/settings.ts`（2786 行，仅 `settings-state` 覆盖其纯函数部分）、`src/services/obsidian-context-service.ts` 有测试但 `src/ui/renderers/code-block-renderer.ts`、`src/ui/diff-modal.ts` 无。

---

## 3. Lint 与类型检查

### 3.1 ESLint

- 配置：`eslint.config.mjs`（ESLint 9 flat config）
- CI：`npx eslint .` **阻断式**
- 现状：0 error、若干 `any` 与未使用变量 **warn**（配置注释明确这是"已知技术债，作为开源后逐步收敛的 good-first-issue"）
- **0 处 `eslint-disable`**——说明规则没有被逐点绕过
- **排除范围**：`test/**`、`scripts/**`、`*.config.mjs` 完全不 lint

### 3.2 TypeScript

- 源码：`noImplicitAny` / `noImplicitReturns` / `noImplicitThis` / `noUnusedLocals` / `strictNullChecks` 全开；**未**开 `strict: true`（故 `strictFunctionTypes`、`strictPropertyInitialization`、`useUnknownInCatchVariables` 等关闭）
- CI：`npx tsc --noEmit || true` —— **非阻断**。CI 注释自认"main 上仍有已知的类型债（未使用变量 + 少量未标注的 Obsidian API 访问）"，并注明"债清零后请删掉 `|| true`"
- 实际风险：类型债可持续累积而 CI 全绿

### 3.3 格式化

- **无 Prettier 配置**，无格式化检查
- 缩进不统一：多数文件 2 空格，`src/settings.ts` 与 `src/ui/chat-controller.ts` 用 4 空格

---

## 4. CI/CD

`.github/workflows/ci.yml` —— 单 job `build-and-test`，`ubuntu-latest` + Node 20，触发于 push/PR 到 `main`：

| 步骤 | 阻断 |
|---|---|
| `actions/checkout@v4` | — |
| `actions/setup-node@v4`（Node 20，npm 缓存） | — |
| `npm ci` | 是 |
| `npm run build` | 是 |
| `npm test` | 是 |
| `npx eslint .` | 是 |
| `npx tsc --noEmit \|\| true` | **否** |

**缺失**：
- 无覆盖率报告 / 阈值
- 无依赖漏洞扫描（`npm audit`、Dependabot、Snyk）
- 无依赖更新机器人（Renovate / Dependabot）
- 无发布流水线（发布靠手动打 tag，Obsidian 社区目录从 GitHub Release 拉取）
- 无多 Node 版本矩阵

---

## 5. 文档质量

| 文档 | 状态 | 评价 |
|---|---|---|
| `README.md` / `README.zh-CN.md` | 完善 | 中英双语，按业务管线（Capture/Process/Remember/Consume）组织，非按代码目录组织 |
| `CLAUDE.md` | 完善 | 模块级架构地图（表格化），含 Key Patterns 与 Shell 命令清单；面向 AI 助手与贡献者 |
| `CONTEXT.md` | 完善 | 领域词汇表，主动区分易混概念（Tool/Skill、Memory/Knowledge Wiki、三种技能），并标注"代码中用得不一致的地方以本表为准" |
| `docs/architecture/` | 4 篇 | runtime / skills / permissions / settings 专题 |
| `docs/adr/` | 3 篇 | 发布完整 git 历史、ChatController 拥有消息列表、关键词命中永不收窄工具集 |
| `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` | 存在 | 开源就绪 |
| `CHANGELOG.md` | 存在 | Keep a Changelog 格式，中英双语 |
| `THIRD-PARTY-LICENSES.md` | 存在 | 由 `scripts/gen-third-party-licenses.mjs` 生成 |
| 源码注释 | 良好 | 大量"为什么这样设计"的中文说明（如"为什么在意体积"、"为什么用 box 属性访问绕开 TS 窄化缺陷"），而非复述代码 |

### 5.1 已知文档漂移

| 文档 | 漂移内容 |
|---|---|
| `docs/architecture/runtime.md` | 文件清单列出 `src/runtime/steering-controller.ts`，该文件已不存在（现为 `active-run-controller.ts`） |
| `CLAUDE.md` | 提及 `PiChatRuntime` 等已退役实现；`src/runtime/pi/pi-provider-bridge.ts` 已在注释中被引用但文件不存在 |
| `CLAUDE.md` | 声称 `/memory` 命令；实际 `LOCAL_SLASH_COMMANDS` 含 `/help` 但 CLAUDE.md 的 Shell Commands 节未列全 |

（仓库记忆中也已记录该风险：`docs/architecture` 曾出现三处失效描述，改架构后必须同步该目录。）

---

## 6. 技术债清单

### 6.1 高优先级（与本次 intent 直接相关）

| # | 债务 | 位置 | 影响 |
|---|---|---|---|
| T1 | **pi 运行时对象全部 `as any`** | `harness-chat-runtime.ts:64,75,93,133`；`harness-session-manager.ts:135,370` | 升级 pi 时编译器零保护 |
| T2 | **pi 会话 API 被手抄成本地结构接口** | `harness-session-manager.ts:10-50`（`PiSession` / `PiSessionRepo` / `CompactionSettings`） | 上游变更不被捕获 |
| T3 | **`harnessEnv` 类型为 `unknown`** | `runtime-types.ts:63`；`model-service.ts:53` | 装配错误延到运行期 |
| T4 | **pi 事件面只消费 4 类** | `pi-event-adapter.ts:17-57` | 压缩 / usage / 成本 / 原生审批信号被丢弃 |
| T5 | **废弃字段与多形态兼容残留** | `runtime-types.ts:29-33`（`streamFn` `@deprecated`）；`harness-chat-runtime.ts:306-317`（`resolveModelHandle` 兼容三种句柄） | 认知负担；难以判断哪些路径是活代码 |
| T6 | **构建存根按 pi-ai 文件名正则匹配** | `esbuild.config.mjs:41-74` | 上游改名即静默失效，bundle 体积回涨越 5 MB |

### 6.2 中优先级

| # | 债务 | 位置 |
|---|---|---|
| T7 | 256 处 `: any`，集中于 `chat-controller.ts`（35）、`main.ts`（13）、`web-clipper/executor.ts`（10）、`hindsight-migration.ts`（10） | 全仓 |
| T8 | 13 个文件超 500 行（本仓 CLAUDE.md 自定约定）：最大 `settings.ts` 2786、`shell-view.ts` 2203 | `src/settings.ts` 等 |
| T9 | CI 类型检查非阻断（`\|\| true`） | `.github/workflows/ci.yml:39` |
| T10 | 无覆盖率度量，无法证明"行为不变" | 工程配置 |
| T11 | 无依赖漏洞扫描与更新机器人 | `.github/` |
| T12 | `test/**` 与 `scripts/**` 不 lint | `eslint.config.mjs:15-16` |
| T13 | 类型逃逸口：`(this.memoryManager as any).retainLesson`、`(this.deps.skillRegistry as any).listCommandEntries` | `model-service.ts:667`；`base-chat-runtime.ts:268` |
| T14 | 双 Obsidian mock（`mock-obsidian.ts` + `obsidian-mock.ts`）并存 | `test/` |

### 6.3 低优先级

| # | 债务 | 位置 |
|---|---|---|
| T15 | 编码损坏：中文注释出现乱码（如 `5绉掔紦瀛?`，疑 UTF-8/GBK 转换残留） | `src/ui/chat-controller.ts:62,72,89` 附近 |
| T16 | `src/ui/guardian-completion.ts` 含使 `grep` 判定为二进制的字节（疑 BOM 或异常字节） | 同文件 |
| T17 | 无 Prettier，缩进风格不统一（2 空格 vs 4 空格） | 全仓 |
| T18 | 测试 runner 串行、首个失败即停、无超时 | `test/run-tests.ts` |
| T19 | `test/functional-test.js`、`test/setup-mock.js` 不在 runner 清单内（历史遗留） | `test/` |
| T20 | `@types/node` 停留在 16.x（实装 16.18.126） | `package.json` |
| T21 | `obsidian` 声明 `^1.5.7` 但实装 1.10.3，高于 `minAppVersion: 1.7.2` | `package.json` |
| T22 | 文档漂移（`docs/architecture/runtime.md` 指向已删文件） | `docs/` |

### 6.4 值得肯定的部分

- **TODO/FIXME 债务几乎为零**：全仓仅 1 处 `TODO` 字样，且是生成提示里的示例文本
- **0 处 `eslint-disable`**：规则没有被逐点绕过
- **`src/` 仅 1 处 `console.log`**：日志走统一 `logger` 单例
- **171 个 catch 中仅 4 处空 catch**，且多为有意降级（如"压缩是优化，失败静默降级"），并在注释中说明理由
- **三处潜在循环依赖都被显式设计切断**（回调注入 + 最小结构类型）
- **守卫型测试**把"bundle 体积"与"启动 IO 次数"变成可回归约束——这是把非功能需求工程化的好做法
- **领域词汇表（`CONTEXT.md`）** 主动消解 Tool/Skill、Memory/Knowledge 这类高频混淆
