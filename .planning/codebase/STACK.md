# Technology Stack

## Repository Type

- `obsidian-cli` is an Obsidian plugin packaged for the Obsidian desktop/mobile host. The distributable surface is `main.js`, `manifest.json`, and `styles.css`, with source rooted in `main.ts`.
- The codebase mixes plugin runtime code in `main.ts` and `src/`, generated output in `main.js`, developer docs in `README.md`, and lightweight/manual tests in `test/`.

## Languages And Assets

- TypeScript is the primary implementation language in `main.ts` and `src/**/*.ts`.
- JavaScript appears in generated or utility files such as `main.js`, `debug_youtube.js`, `reproduce_issue.js`, and `test/functional-test.js`.
- CSS styling lives in `styles.css` and `src/ui/guardian-styles.css`.
- JSON configuration/data appears in `manifest.json`, `package.json`, `tsconfig.json`, `tsconfig.test.json`, and `data.json`.
- Markdown docs live in `README.md` and `doc/`.

## Runtime Model

- The plugin entrypoint is `main.ts`, which subclasses Obsidian `Plugin`, loads settings, registers a custom view, commands, settings UI, editor extensions, and vault/workspace event handlers.
- Runtime services are layered around `src/services/model-service.ts` for provider orchestration, `src/mcp/tools.ts` for tool execution, and `src/memory/memory-manager.ts` for local memory.
- UI is built directly against the Obsidian host and CodeMirror 6 in `src/ui/shell-view.ts`, `src/ui/selection-menu.ts`, `src/ui/guardian-gutter.ts`, `src/ui/ghost-text.ts`, and `src/ui/guardian-modal.ts`.
- The code assumes an Obsidian/Electron-style environment that exposes browser APIs and enough Node capability for subprocess spawning in `src/mcp/mcp-client.ts`.

## Frameworks And Host APIs

- Obsidian plugin APIs are the core framework surface across `main.ts`, `src/settings.ts`, `src/mcp/tools.ts`, `src/ui/shell-view.ts`, and `src/ui/selection-menu.ts`.
- CodeMirror 6 editor extensions are used via `@codemirror/view` and `@codemirror/state` in `main.ts`, `src/ui/ghost-text.ts`, `src/ui/guardian-gutter.ts`, and `src/ui/selection-menu.ts`.
- Markdown rendering is delegated to Obsidian `MarkdownRenderer` in `src/ui/shell-view.ts` and `src/ui/selection-menu.ts`.
- The plugin extends Obsidian's typings for plugin and command inspection in `src/mcp/types.ts`.

## AI And Tooling Architecture

- `src/services/model-service.ts` owns provider selection, prompt assembly, tool-call loops, timeout/retry boundaries, and memory integration.
- `src/models/gemini.ts` implements a Gemini provider through `@google/generative-ai`.
- `src/models/openai.ts` implements an OpenAI-compatible provider over HTTP and is reused for OpenAI, DeepSeek, and Qwen-compatible endpoints configured in `src/mcp/types.ts`.
- `src/mcp/tools.ts` exposes built-in tool definitions for vault CRUD, file opening, webpage saving, web search, time lookup, plugin introspection, and MCP tool passthrough.
- `src/mcp/mcp-client.ts` adds stdio-based Model Context Protocol support for external tool servers.

## Direct Dependencies

- Runtime dependencies declared in `package.json` are `@google/generative-ai`, `@mozilla/readability`, and `youtube-transcript`.
- Current source code actively imports `@google/generative-ai` in `src/models/gemini.ts` and `@mozilla/readability` in `src/mcp/tools.ts`.
- `youtube-transcript` is declared in `package.json`, but the current transcript path is implemented manually in `src/utils/video_utils.ts` rather than through a direct import.
- Dev/build dependencies declared in `package.json` are `esbuild`, `typescript`, `obsidian`, `tslib`, `builtin-modules`, `@types/node`, and `@types/ws`.

## Build And Packaging

- `package.json` defines only two scripts: `dev` and `build`, both invoking `node esbuild.config.mjs`.
- `esbuild.config.mjs` bundles `main.ts` to CommonJS `main.js`, targets `es2022`, inlines sourcemaps in dev, and marks `obsidian`, `electron`, CodeMirror packages, Lezer packages, and Node built-ins as external.
- `tsconfig.json` enables strict TypeScript options, `module: "ESNext"`, `target: "ES2022"`, DOM plus ESNext libs, and includes all `**/*.ts`.
- `manifest.json` defines the Obsidian plugin identity and points Obsidian at `main.js`.

## Entry Points And Important Modules

- Plugin bootstrap: `main.ts`
- Settings UI: `src/settings.ts`
- Main shell view: `src/ui/shell-view.ts`
- Inline selection/chat UI: `src/ui/selection-menu.ts`
- Guardian/editor assistance: `src/ui/guardian-gutter.ts`, `src/ui/ghost-text.ts`, `src/ui/guardian-modal.ts`
- Model/provider abstraction: `src/services/model-service.ts`, `src/models/interfaces.ts`, `src/models/gemini.ts`, `src/models/openai.ts`
- Tool execution and MCP bridge: `src/mcp/tools.ts`, `src/mcp/mcp-client.ts`, `src/mcp/types.ts`
- Local memory and context: `src/memory/memory-manager.ts`, `src/memory/types.ts`, `src/services/context-manager.ts`
- URL/video ingestion helpers: `src/utils/video_utils.ts`

## Configuration Surface

- Provider, model, permission, Guardian, terminal, prompt, WeChat, and MCP settings are centralized in `src/mcp/types.ts`.
- The interactive settings UI is implemented in `src/settings.ts`, including provider-specific credential fields, connection testing, permission toggles, WeChat paths, and MCP server definitions.
- Plugin data is loaded and saved through Obsidian `loadData()` and `saveData()` in `main.ts`.

## Testing And Developer Workflow

- There is no `test` script in `package.json`; the declared workflow is build/watch only.
- The `test/` directory mixes styles:
- Hand-rolled `runTests()` scripts in `test/plugin-tools.test.ts`, `test/mcp-integration.test.ts`, `test/gemini-api-chat.test.ts`, and `test/functional-test.ts`.
- A compiled JavaScript variant in `test/functional-test.js`.
- Jest-style globals in `test/context-manager.test.ts` without a corresponding test runner declaration in `package.json`.
- `tsconfig.test.json` exists, but the repo does not currently advertise a single canonical test command.
