# Contributing to Baizer

_English · [简体中文](#为-baizer-做贡献)_

Thanks for your interest in improving Baizer! This guide covers how to set up
the project, the conventions we follow, and how to submit changes.

## Understanding the Codebase

Before your first change, read these in order:

1. [`CLAUDE.md`](./CLAUDE.md) — the fullest module-by-module map of the whole
   plugin, including the key architectural patterns and their rationale.
2. [`docs/architecture/runtime.md`](./docs/architecture/runtime.md) — how a chat
   turn is prepared and executed.
3. [`docs/architecture/skills.md`](./docs/architecture/skills.md) and
   [`docs/architecture/permissions.md`](./docs/architecture/permissions.md) — the
   skill/tool split and the permission model.
4. [`CONTEXT.md`](./CONTEXT.md) — the domain glossary. Worth skimming even if you
   only plan a small change; it is what makes issue threads legible.

Touching the settings page? Read
[`docs/architecture/settings.md`](./docs/architecture/settings.md) first — it is
the largest file in the plugin and has one convention (partial re-render) that is
easy to break without noticing.

The single most common source of confusion: **skills are instructions, tools are
execution.** A skill never runs anything; it tells the model how to behave and
which tools to reach for.

## Development Setup

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build (outputs dist/main.js + manifest.json + styles.css)
npm run build

# Run the test suite
npm test

# Type-check without emitting
npx tsc --noEmit

# Lint
npx eslint .
```

> **Known debt:** `tsc --noEmit` currently reports errors on `main` (mostly
> unused locals plus some untyped Obsidian API access), and `eslint` reports
> warnings for `any` usage. `npm run build` and `npm test` **are** clean and are
> enforced in CI. Clearing the remaining type errors is a good first
> contribution — see the issues labelled `good first issue`.

To test inside Obsidian, symlink or copy `dist/main.js`, `manifest.json`, and
`styles.css` into a vault's `.obsidian/plugins/baizer/` folder, then reload.

## Conventions

- **Language**: TypeScript, strict null checks and `noImplicitAny` are on.
- **Mobile compatibility is required.** Do not use Node.js-only APIs
  (`fs`, `path`, `child_process`, etc.); the same bundle must run on iOS/Android.
  Use Obsidian's `Vault`/adapter APIs for file access.
- **Logging** goes through the shared `logger` in `src/utils/logger.ts`, not raw
  `console.*` calls.
- **LLM-facing prompts stay in English**; user-facing UI strings go through the
  `t()` i18n helper (`src/i18n/`).
- Match the style, naming, and structure of the surrounding code.
- Keep authoring and review separate: run tests and type-checks before opening a PR.

## Submitting Changes

1. Fork and create a feature branch (never commit directly to `main`).
2. Make your change with focused, well-scoped commits.
3. Ensure `npm run build` and `npm test` pass, and that `npx tsc --noEmit`
   reports no *new* errors beyond the known debt noted above.
4. Open a pull request describing **what** changed and **why**, plus how you tested it.
5. Link any related issue.

## Reporting Bugs

Open a GitHub issue with reproduction steps, expected vs. actual behavior, and
your plugin/Obsidian versions. For **security** issues, follow
[SECURITY.md](./SECURITY.md) instead — do not open a public issue.

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).

---

# 为 Baizer 做贡献

_[English](#contributing-to-baizer) · 简体中文_

感谢你有兴趣改进 Baizer!本指南介绍如何搭建项目、我们遵循的约定,以及如何提交
变更。

## 读懂这个代码库

第一次改动前,按顺序读这几份:

1. [`CLAUDE.md`](./CLAUDE.md) —— 最完整的逐模块地图,含关键架构模式及其理由。
2. [`docs/architecture/runtime.md`](./docs/architecture/runtime.md) —— 一轮对话
   如何准备与执行。
3. [`docs/architecture/skills.md`](./docs/architecture/skills.md) 与
   [`docs/architecture/permissions.md`](./docs/architecture/permissions.md) ——
   技能/工具之分与权限模型。
4. [`CONTEXT.md`](./CONTEXT.md) —— 领域术语表。即使只做小改动也值得扫一遍,
   它决定了 issue 讨论能不能看懂。

最容易搞错的一点:**技能是指令,工具才执行。** 技能自己不运行任何东西,它只告诉
模型该怎么做、该去调哪些工具。

要动配置页?先读
[`docs/architecture/settings.md`](./docs/architecture/settings.md) —— 它是插件里
最大的单文件,有一条(局部重渲染)约定很容易在不知情的情况下破坏。

## 开发环境搭建

```bash
# 安装依赖
npm install

# 开发构建(监听模式)
npm run dev

# 生产构建(输出 dist/main.js + manifest.json + styles.css)
npm run build

# 运行测试套件
npm test

# 仅类型检查、不产出文件
npx tsc --noEmit

# 代码检查
npx eslint .
```

> **已知技术债:** `tsc --noEmit` 目前在 `main` 上会报错(多为未使用的局部变量,
> 以及少量未标注类型的 Obsidian API 访问),`eslint` 会对 `any` 的使用报出警告。
> `npm run build` 和 `npm test` **是干净的**,并在 CI 中强制通过。清理剩余的类型
> 错误是很好的第一份贡献 —— 请看标记为 `good first issue` 的 issue。

要在 Obsidian 中测试,将 `dist/main.js`、`manifest.json`、`styles.css` 软链接或
复制到某个库的 `.obsidian/plugins/baizer/` 目录,然后重新加载。

## 代码约定

- **语言**:TypeScript,已开启严格空值检查与 `noImplicitAny`。
- **必须保证移动端兼容。** 不要使用仅 Node.js 的 API(`fs`、`path`、
  `child_process` 等);同一份产物必须能在 iOS/Android 上运行。文件访问请使用
  Obsidian 的 `Vault`/adapter API。
- **日志**统一走 `src/utils/logger.ts` 中的 `logger`,不要直接调用 `console.*`。
- **面向 LLM 的提示词保持英文**;面向用户的界面文案走 `t()` 国际化辅助函数
  (`src/i18n/`)。
- 与周围代码保持一致的风格、命名和结构。
- 编写与审查分离:提交 PR 前先跑通测试和类型检查。

## 提交变更

1. Fork 并创建特性分支(切勿直接提交到 `main`)。
2. 以聚焦、范围清晰的提交完成你的改动。
3. 确保 `npm run build` 与 `npm test` 通过,且 `npx tsc --noEmit` 没有在上述已知
   技术债之外产生**新的**报错。
4. 提交 PR,说明**改了什么**、**为什么**,以及你如何测试。
5. 关联相关 issue。

## 报告 Bug

创建 GitHub issue,附上复现步骤、预期与实际行为,以及你的插件/Obsidian 版本。
对于**安全**问题,请改为遵循 [SECURITY.md](./SECURITY.md) —— 不要创建公开 issue。

## 行为准则

参与本项目须遵守[行为准则](./CODE_OF_CONDUCT.md)。

## 许可证

提交贡献即表示你同意你的贡献以 [MIT 许可证](./LICENSE) 授权。
