# Structure

## Top-Level Layout

- `main.ts` is the source bootstrap file for the Obsidian plugin.
- `main.js` is the bundled output generated from `main.ts` by `esbuild.config.mjs` and committed at the repo root.
- `manifest.json` and `styles.css` sit beside `main.js` as the plugin assets Obsidian loads.
- `src/` contains almost all TypeScript source modules after bootstrap.
- `test/` contains manual, mock-heavy, and partially outdated test files.
- `doc/` contains product/reference docs such as `doc/prd.md` and `doc/UX.md`.
- `.planning/codebase/` contains generated codebase map documents such as `.planning/codebase/STACK.md`.
- `README.md` is the human-facing overview, while `CLAUDE.md` is a repo-local assistant guide.
- `debug_youtube.js`, `reproduce_issue.js`, and `data.json` are root-level support/debug artifacts rather than part of the main runtime path.

## Directory Map

```text
.
|- main.ts
|- main.js
|- manifest.json
|- styles.css
|- esbuild.config.mjs
|- package.json
|- tsconfig.json
|- tsconfig.test.json
|- README.md
|- CLAUDE.md
|- doc/
|  |- prd.md
|  `- UX.md
|- src/
|  |- settings.ts
|  |- mcp/
|  |- memory/
|  |- models/
|  |- services/
|  |- ui/
|  `- utils/
|- test/
|  |- *.test.ts
|  |- *.js
|  `- *mock*.ts
`- .planning/codebase/
```

## `src/` Layout

### `src/settings.ts`

- The settings tab implementation lives directly at `src/settings.ts`, not under a dedicated `settings/` folder.
- This file is large and central because it owns the entire configuration UI surface for providers, Guardian options, permissions, terminal settings, prompt customization, WeChat paths, and MCP server definitions.

### `src/mcp/`

- `src/mcp/types.ts`
- Shared plugin settings, defaults, and a small Obsidian typing augmentation.
- `src/mcp/tools.ts`
- Built-in tool definitions and tool execution logic.
- `src/mcp/mcp-client.ts`
- Stdio-based MCP client implementation.

Notes:

- The `mcp` directory contains more than MCP protocol code.
- It is also the home of the global settings schema, permission toggles, and built-in non-MCP tool registry.

### `src/models/`

- `src/models/interfaces.ts`
- Provider-agnostic contracts such as `IModelProvider`, `IChatSession`, and tool-call/result types.
- `src/models/gemini.ts`
- Google Gemini implementation.
- `src/models/openai.ts`
- OpenAI-compatible implementation reused for OpenAI, DeepSeek, and Qwen-style providers.

### `src/services/`

- `src/services/model-service.ts`
- Central orchestration service that glues providers, memory, and tool execution together.
- `src/services/context-manager.ts`
- Transient context storage/resolution for URLs, files, images, and text attached to a conversation.

### `src/memory/`

- `src/memory/memory-manager.ts`
- Local profile, summary, session, and chat-history persistence.
- `src/memory/types.ts`
- Memory-specific interfaces and defaults.

### `src/ui/`

- `src/ui/shell-view.ts`
- Main chat/shell view and its UI controls.
- `src/ui/chat-controller.ts`
- Controller layer used by the shell and selection-menu chat.
- `src/ui/guardian-gutter.ts`
- CodeMirror gutter state and markers.
- `src/ui/ghost-text.ts`
- Inline ghost-text rendering and accept/dismiss behavior.
- `src/ui/selection-menu.ts`
- Selection tooltip and inline mini-chat surface.
- `src/ui/guardian-modal.ts`
- Manual instruction modal.
- `src/ui/diff-modal.ts`
- Review/apply modal for AI-generated file/text replacements.
- `src/ui/guardian-styles.css`
- UI-specific CSS colocated with the related TypeScript modules.

### `src/utils/`

- `src/utils/logger.ts`
- Shared logger singleton.
- `src/utils/video_utils.ts`
- YouTube/Bilibili transcript helpers and metadata extraction.

## Supporting Directories

### `test/`

- `test/context-manager.test.ts`
- Jest-style unit test syntax for context management.
- `test/plugin-tools.test.ts`
- Hand-rolled async test runner for plugin tool behavior.
- `test/mcp-integration.test.ts`
- Hand-rolled integration script for tool execution.
- `test/gemini-api-chat.test.ts`
- Legacy/provider-path test that still imports a non-present `src/gemini-api.ts`.
- `test/functional-test.ts` and `test/functional-test.js`
- Functional-style test harnesses with mocked Obsidian surfaces.
- `test/mock-obsidian.ts` and `test/obsidian-mock.ts`
- Two different mock implementations of Obsidian-like APIs.
- `test/setup-mock.js`
- Extra test setup support script.

### `doc/`

- `doc/prd.md` captures product requirements.
- `doc/UX.md` captures UX direction.

### `.planning/codebase/`

- Mapping output for repository understanding.
- Existing files include `.planning/codebase/STACK.md` and `.planning/codebase/INTEGRATIONS.md`.

## Major Root Files

- `package.json`
- Minimal npm metadata plus `dev` and `build` scripts only.
- `package-lock.json`
- Locked dependency tree.
- `esbuild.config.mjs`
- Bundler configuration for producing `main.js`.
- `tsconfig.json`
- Main TypeScript compiler settings for source files.
- `tsconfig.test.json`
- Separate TypeScript config for `test/`.
- `README.md`
- Public project overview and installation guide.
- `CLAUDE.md`
- Assistant-facing repo notes and a partial architecture summary.
- `manifest.json`
- Obsidian plugin manifest consumed by the host app.

## Naming And Location Conventions

### Bootstrap At Root, Features Under `src/`

- The repo does not use a `src/index.ts` bootstrap.
- The real plugin entry lives at the root in `main.ts`.
- Most other implementation files live under `src/`.

### Kebab-Case File Names

- Multiword files consistently use kebab-case, for example `src/services/model-service.ts`, `src/ui/shell-view.ts`, and `src/mcp/mcp-client.ts`.

### Type Definitions Are Colocated By Subsystem

- Shared provider interfaces live in `src/models/interfaces.ts`.
- Settings and plugin typing live in `src/mcp/types.ts`.
- Memory-specific data contracts live in `src/memory/types.ts`.
- The codebase prefers small `types.ts` or `interfaces.ts` files inside the relevant subsystem over a single global types directory.

### UI Code Is Grouped By Surface

- Shell-specific rendering and interaction stay in `src/ui/shell-view.ts`.
- Editor enhancement code stays in separate CodeMirror-oriented modules such as `src/ui/ghost-text.ts`, `src/ui/guardian-gutter.ts`, and `src/ui/selection-menu.ts`.
- Modal components remain in `src/ui/guardian-modal.ts` and `src/ui/diff-modal.ts`.

### Services Sit Between UI And Providers/Storage

- Runtime orchestration is in `src/services/` rather than in the UI files, with `src/services/model-service.ts` acting as the key seam.
- `main.ts` still keeps some orchestration logic at the root, so the separation is useful but not absolute.

### Tests Are Flat And Mixed-Style

- The `test/` directory is flat rather than mirrored from `src/`.
- Test filenames generally use `*.test.ts`, but execution style is inconsistent:
- some files assume Jest globals
- some files implement their own `runTests()`
- one compiled JavaScript test file (`test/functional-test.js`) is checked in beside the TypeScript source

### Generated And Source Artifacts Coexist

- The repo keeps generated output `main.js` in version control beside the source `main.ts`.
- This is normal for Obsidian plugin distribution, but it means the root contains both development and release artifacts at once.

## Navigation Shortcuts

- Start at `main.ts` to understand lifecycle wiring.
- Move to `src/services/model-service.ts` to understand model orchestration.
- Use `src/mcp/tools.ts` to inspect the actionable tool surface.
- Use `src/ui/shell-view.ts` for the main user interaction path.
- Use `src/settings.ts` and `src/mcp/types.ts` for configuration changes.
- Use `src/memory/memory-manager.ts` when tracing persistence or personalization behavior.

## Structural Drift Worth Knowing

- Some repo-local docs and tests still refer to `src/gemini-api.ts`, but the current runtime code is organized around `src/services/model-service.ts` plus the provider files in `src/models/`.
- The folder name `src/mcp/` understates its scope because it also holds global plugin settings and the built-in tool catalog.
- The test surface is present on disk, but the location and naming conventions do not imply a single canonical runner from `package.json`.
