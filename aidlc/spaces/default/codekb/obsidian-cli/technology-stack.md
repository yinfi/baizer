# 技术栈 — Baizer（obsidian-cli）

## 1. 概览

| 维度 | 取值 |
|---|---|
| 主语言 | TypeScript 5.9.3（`strictNullChecks` / `noImplicitAny` / `noImplicitReturns` / `noImplicitThis` / `noUnusedLocals` 均开启；**未**开 `strict: true`） |
| 编译目标 | ES2022 |
| 模块体系 | 源码 `module: ESNext` + `moduleResolution: node`；bundle 输出 **CJS**；测试 `module: commonjs` |
| 运行时宿主 | Obsidian 渲染进程（Electron / 移动端 WebView），`minAppVersion: 1.7.2`，`isDesktopOnly: false` |
| 构建工具 | esbuild 0.17.19（单文件 bundle，`format: cjs`，`target: es2022`，tree-shaking 开） |
| 包管理 | npm（`package-lock.json` 锁定） |
| 测试运行器 | tsx 4.21.0 + 自建 runner（无第三方测试框架） |
| Lint | ESLint 9.39.5 flat config + typescript-eslint 8.64.0 |
| CI | GitHub Actions（Node 20，ubuntu-latest） |
| 许可证 | MIT |

## 2. 运行时依赖（`dependencies`）

| 包 | 声明范围 | 实装版本 | 用途 | 关键约束 |
|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | `^0.75.5` | **0.75.5** | 单一 agent 运行时：`AgentHarness`、`agentLoop`、`JsonlSessionRepo`、`InMemorySessionRepo`、会话压缩、skill 格式化器、prompt 模板 | **ESM-only**（`"type": "module"`，exports 仅 `import`）→ 所有值导入必须动态 `import()` |
| `@earendil-works/pi-ai` | `^0.75.5` | **0.75.5** | 统一 LLM API：`Model`、`streamSimple`、`completeSimple`、provider 注册表 | 同上 ESM-only；其 `providers/` 目录被 esbuild 存根插件按相对文件名匹配 |
| `@codemirror/state` | `^6.5.0` | 6.5.0 | CM6 状态与效果（Ghost Text、gutter、选区菜单） | 在 esbuild 中**外部化**（由 Obsidian 宿主提供） |
| `@codemirror/view` | `^6.38.6` | 6.38.6 | CM6 视图与装饰 | 同上外部化 |
| `@google/generative-ai` | `^0.21.0` | 0.21.0 | Gemini SDK（经 pi-ai google provider 使用） | 直接依赖但代码中不直接 import |
| `@mozilla/readability` | `^0.6.0` | 0.6.0 | 网页正文抽取（web-clipper） | 在 bundle 内 |
| `yaml` | `^2.8.3` | 2.8.3 | SKILL.md / `.base` 的 YAML 解析 | 与 pi-agent-core 自带的 `yaml@2.9.0` 可能双版本共存 |

## 3. 开发依赖（`devDependencies`）

| 包 | 声明范围 | 实装版本 | 用途 |
|---|---|---|---|
| `typescript` | `^5.9.3` | 5.9.3 | 类型检查（CI 非阻断） |
| `esbuild` | `0.17.19`（精确） | 0.17.19 | 构建 |
| `eslint` | `^9.39.5` | 9.39.5 | Lint（CI 阻断） |
| `typescript-eslint` | `^8.64.0` | 8.64.0 | TS 规则集 |
| `@eslint/js` | `^9.39.5` | 9.39.5 | ESLint 推荐规则集 |
| `tsx` | `^4.21.0` | 4.21.0 | 测试运行（`tsx --tsconfig tsconfig.test.json`） |
| `obsidian` | `^1.5.7` | **1.10.3** | 宿主 API 类型 + 测试 mock 的映射目标 |
| `@types/node` | `^16.11.6` | 16.18.126 | Node 类型（`child_process` 仅用于测试 runner） |
| `@types/ws` | `^8.5.10` | — | WebSocket 类型（pi 传递依赖的类型补丁） |
| `tslib` | `^2.4.0` | — | `importHelpers` 运行时辅助 |

**注意**：`obsidian` 声明 `^1.5.7` 但实装 1.10.3——类型版本高于 `manifest.json` 的 `minAppVersion: 1.7.2`，即类型层面可用的一些 API 在最低支持版本上可能不存在。

## 4. 外部化与打包策略

`esbuild.config.mjs` 的 `external` 列表：

```
obsidian, electron,
@codemirror/autocomplete, @codemirror/collab, @codemirror/commands,
@codemirror/language, @codemirror/lint, @codemirror/search,
@codemirror/state, @codemirror/view,
@lezer/common, @lezer/highlight, @lezer/lr,
...builtinModules
```

- 这些由 Obsidian 宿主在运行时提供，不打进 bundle
- `.md` 走 `loader: { '.md': 'text' }`——SKILL.md 以字符串内联
- 输出：`main.js`（仓库根，dev 带 inline sourcemap）+ `dist/{main.js, manifest.json, styles.css}`
- **体积红线**：Obsidian Sync Standard 不同步 >5 MB 的文件；`esbuild.config.mjs:23-43` 记录 `main.js` 曾达 6.0 MB

### 4.1 自定义 esbuild 插件：`stub-unused-pi-providers`

**问题**：pi-ai 的 `providers/register-builtins.js` 为全部 9 个 provider 注册惰性加载器，每个都是 `import("./<provider>.js")`。esbuild 在 `format: "cjs"` 下无法 code splitting，于是把这些动态 import **全部内联进单文件**——哪怕运行时永远走不到。Mistral SDK 1.2 MB 是纯死重。

**方案**：不改上游代码，在打包层把该模块解析到存根：

```js
const STUBBED_PI_PROVIDERS = [
  { file: "mistral.js", exports: ["streamMistral", "streamSimpleMistral"] },
];
// 正则 filter: /^\.\/mistral\.js$/，且要求 args.importer 含 "pi-ai"
// onLoad 生成同名导出函数，调用时抛出可读错误
```

**理由**：Baizer 的 `ProviderConfig.type` 只有 `gemini` 与 `openai-compatible` 两种，传给 pi 的 `api` 只会是 `google-generative-ai` 或 `openai-completions`。

**脆弱点**：该插件按 pi-ai `providers/` 下的**相对文件名**匹配。pi-ai 升级若改变 provider 文件命名或目录结构，存根会静默失效（不报错），bundle 体积回涨越过 5 MB 同步上限。`test/bundle-size.test.ts` 是唯一的兜底守卫。

## 5. TypeScript 配置

### 5.1 `tsconfig.json`（源码）

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true, "inlineSources": true,
    "module": "ESNext", "target": "ES2022",
    "allowSyntheticDefaultImports": true, "importHelpers": true,
    "moduleResolution": "node",
    "noImplicitAny": true, "noImplicitReturns": true, "noImplicitThis": true,
    "noUnusedLocals": true, "strictNullChecks": true,
    "lib": ["DOM", "ESNext"], "types": ["node"], "skipLibCheck": true
  },
  "include": ["main.ts", "src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test", ".worktrees"]
}
```

### 5.2 `tsconfig.test.json`（测试）

- `module: "commonjs"`、`target: "ES2020"`
- `paths: { "obsidian": ["./test/__mocks__/obsidian.ts"] }` —— Obsidian API 由自建 mock 提供
- `esModuleInterop: true`、`noUnusedLocals: false`
- `include: ["src/**/*.ts", "test/**/*.ts"]`

**由此产生的架构约束**：测试走 commonjs，而 pi 是 ESM-only，故**任何 pi 值导入都必须动态 `import()`**；静态 `import type` 可以。这条约束贯穿 `pi-native-model.ts`、`skill-registry.ts`、`harness-session-manager.ts`、`prompt-template-service.ts`、`harness-chat-runtime.ts`。

## 6. ESLint 配置（`eslint.config.mjs`）

ESLint 9 flat config，`tseslint.config(...)`：

- **ignores**：`node_modules`、`dist*`、`main.js`、`.worktrees`、`.claude`、`test`、`scripts`、`*.config.mjs`
- 基础集：`js.configs.recommended` + `tseslint.configs.recommended`
- **降级为 warn**（以免阻断 CI）：`@typescript-eslint/no-explicit-any`、`no-unused-vars`（允许 `_` 前缀）、`no-empty-object-type`、`no-unsafe-function-type`、`no-unused-expressions`、`ban-ts-comment`、`no-empty`（允许空 catch）、`no-useless-escape`、`no-case-declarations`、`no-irregular-whitespace`、`prefer-const`
- **关闭**：`no-undef`、`no-unused-vars`（基础 JS 版，交给 TS）

**注意**：`test/**` 与 `scripts/**` 被完全排除在 lint 之外。

## 7. 运行环境约束

| 约束 | 来源 | 影响 |
|---|---|---|
| 移动端兼容，禁止 `child_process` 等 Node API | 本仓 `CLAUDE.md`；`manifest.json` `isDesktopOnly: false` | pi 的 `ExecutionEnv` shell 侧被显式做成 `shellUnavailable`（`harness-env.ts:37,128`） |
| 文件落盘必须走 `vault.adapter` | 移动端无 node fs | `VaultSessionFileSystem` / `HarnessExecutionEnv` 都基于注入的 adapter |
| bundle < 5 MB | Obsidian Sync Standard 上限 | `stub-unused-pi-providers`；`test/bundle-size.test.ts` |
| 启动路径不得阻塞 | 移动端 native 桥延迟 | 技能物化写盘移到后台；`test/startup-io-budget.test.ts` 守卫 |
| Obsidian 最低 1.7.2 | `manifest.json` + `versions.json` | 但 `obsidian` 类型包实装 1.10.3 |

## 8. 上游 pi 能力消费清单（升级影响面）

**`@earendil-works/pi-agent-core`**

- 值导入（全部经动态 `import()`）：`AgentHarness`、`JsonlSessionRepo`、`InMemorySessionRepo`、`DEFAULT_COMPACTION_SETTINGS`、`buildSessionContext`、`estimateContextTokens`、`shouldCompact`、`formatSkillsForSystemPrompt`、`formatSkillInvocation`、`loadPromptTemplates`、`parseCommandArgs`、`substituteArgs`
- 类型导入：`AgentTool`、`ToolExecutionMode`、`Skill`、`StreamFn`、`FileError`、`FileErrorCode`、`FileInfo`、`Result`

**`@earendil-works/pi-ai`**

- 值导入：`completeSimple`
- 类型导入：`Model`、`AssistantMessage`

共 **12 个值符号 + 11 个类型符号**。`AgentHarness` 的配置面用到 8 个字段（`env`、`session`、`model`、`tools`、`systemPrompt`、`thinkingLevel`、`getApiKeyAndHeaders`、`afterToolCall`），事件面消费 4 类。

## 9. 不使用的技术

无 React/Vue/Svelte（DOM 手写）、无状态管理库、无测试框架（Vitest/Jest）、无覆盖率工具、无 ORM、无数据库、无格式化器（无 Prettier 配置）、无 bundler 之外的构建编排（无 Makefile / turbo / nx）、无 Docker、无 IaC。
