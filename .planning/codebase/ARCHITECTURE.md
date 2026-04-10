# Architecture

## System Purpose

- `obsidian-cli` is an Obsidian plugin whose runtime entry is `main.ts` and whose distributable output is the root trio `main.js`, `manifest.json`, and `styles.css`.
- The plugin combines three main user-facing capabilities:
- A chat-style shell in `src/ui/shell-view.ts` for vault interaction and tool-assisted AI responses.
- Editor-side Guardian assistance driven from `main.ts`, `src/ui/guardian-gutter.ts`, `src/ui/ghost-text.ts`, and `src/ui/selection-menu.ts`.
- Local memory, webpage/video ingestion, and optional MCP-backed external tool execution in `src/mcp/`, `src/services/`, `src/memory/`, and `src/utils/`.

## Runtime Entry Points

### Plugin Bootstrap

- `main.ts` subclasses Obsidian `Plugin`.
- On `onload()`, `main.ts` loads persisted settings, constructs `ToolManager` from `src/mcp/tools.ts`, constructs `ModelService` from `src/services/model-service.ts`, and wires the two together with `toolManager.setGeminiApi(this.modelService)`.
- `main.ts` also registers:
- The custom shell view type `VIEW_TYPE_GEMINI_SHELL` from `src/ui/shell-view.ts`.
- Commands for opening the shell and manually triggering Guardian.
- The settings tab implemented in `src/settings.ts`.
- CodeMirror editor extensions from `src/ui/guardian-gutter.ts`, `src/ui/ghost-text.ts`, and `src/ui/selection-menu.ts`.
- Vault and workspace event handlers, including markdown file modification monitoring for the WeChat inbox flow.

### Shell View

- `src/ui/shell-view.ts` is the main interactive view implementation.
- It owns the terminal-like UI, message rendering, provider/model selectors, slash-command and `@file` suggestions, paste/drop context capture, and context-chip rendering.
- It creates a `ChatController` from `src/ui/chat-controller.ts` plus a `ContextManager` from `src/services/context-manager.ts`.

### Editor Assistance

- `main.ts` owns the Guardian trigger path through `runGuardianCheck(...)`.
- `src/ui/guardian-gutter.ts` tracks enabled/paused state and per-line status markers.
- `src/ui/ghost-text.ts` renders inline suggestion widgets and accepts them on `Tab`.
- `src/ui/selection-menu.ts` adds selection-scoped AI actions inside the editor and spins up a local `ChatController` for that mini-chat surface.
- `src/ui/guardian-modal.ts` provides the manual instruction modal opened by the `Mod+Shift+G` command.

### Settings Surface

- `src/settings.ts` renders the full configuration UI.
- `src/mcp/types.ts` is the canonical schema for `GeminiSettings` and `DEFAULT_SETTINGS`.
- Settings changes flow back through `main.ts` `saveSettings()`, which updates both `ToolManager` and `ModelService`.

## Main Module Boundaries

### Configuration And Bootstrap

- `main.ts` is the orchestration-heavy bootstrap layer.
- `src/mcp/types.ts` defines the shared plugin settings, provider credentials, Guardian settings, permissions, terminal appearance, prompt configuration, WeChat paths, and MCP server config.
- `src/settings.ts` is the UI projection of those settings.

### Provider Abstraction

- `src/models/interfaces.ts` defines the abstraction boundary:
- `IModelProvider` for provider implementations.
- `IChatSession` for multi-turn conversations.
- `ToolDefinition`, `ToolCall`, `ToolResult`, and `GenerationResult` for function-calling orchestration.
- `src/models/gemini.ts` implements the Google Gemini path using `@google/generative-ai`.
- `src/models/openai.ts` implements the OpenAI-compatible HTTP path and is reused for `openai`, `deepseek`, and `qwen` settings profiles.

### Conversation Orchestration

- `src/services/model-service.ts` is the central runtime service.
- It selects and configures the active provider.
- It creates or reuses chat sessions.
- It assembles prompts from memory, context items, selected text, and the current timestamp.
- It executes model-issued function calls in a loop by delegating to `ToolManager`.
- It records user/model turns into local memory and handles provider refresh on settings changes.
- `src/ui/chat-controller.ts` is a thin interaction controller on top of `ModelService`; it handles shell slash commands locally and delegates normal chat requests downward.

### Tooling And MCP

- `src/mcp/tools.ts` is both the built-in tool registry and the execution engine.
- Built-in tools cover vault CRUD, search/open, webpage saving, time lookup, web search, and optional plugin inspection.
- MCP passthrough is namespaced by server name, so tool calls prefixed like `<server>_<tool>` are forwarded to the corresponding client.
- `src/mcp/mcp-client.ts` manages stdio JSON-RPC communication with external MCP servers by spawning child processes and exchanging newline-delimited JSON messages.

### Context And Memory

- `src/services/context-manager.ts` tracks transient chat context items such as files, images, URLs, YouTube links, or free text.
- `src/memory/memory-manager.ts` persists longer-lived user profile data, session summaries, and chat history under `.obsidian/gemini-memory`.
- `src/memory/types.ts` defines `UserProfile`, `SessionSummary`, `ChatMessage`, and `DEFAULT_USER_PROFILE`.

### UI Helpers

- `src/ui/diff-modal.ts` provides a lightweight review/accept dialog for applying AI-generated code/text changes.
- `src/ui/guardian-modal.ts` provides manual prompt capture for editor assistance.
- `src/ui/guardian-styles.css` contains UI-specific styling for Guardian-related surfaces.

### Utilities

- `src/utils/video_utils.ts` resolves transcripts and metadata for YouTube and Bilibili URLs.
- `src/utils/logger.ts` implements an in-memory plus `localStorage` logger singleton used across services.

## Primary Data Flows

### 1. Shell Chat Flow

1. User enters a prompt in `src/ui/shell-view.ts`.
2. `GeminiShellView.processCommand()` resolves transient contexts from `src/services/context-manager.ts`, attaches the active file and current editor selection, and forwards the request to `src/ui/chat-controller.ts`.
3. `ChatController.processCommand()` handles slash commands locally or calls `ModelService.chat(...)` in `src/services/model-service.ts`.
4. `ModelService.chat(...)` builds the full prompt from:
- `MemoryManager.buildContext()` in `src/memory/memory-manager.ts`
- timestamp metadata
- explicit context items
- optional selected text
- the raw user request
5. `ModelService` obtains an `IChatSession` from the active provider implementation in `src/models/gemini.ts` or `src/models/openai.ts`.
6. If the model returns tool/function calls, `ModelService` loops through them and delegates execution to `ToolManager.execute(...)` in `src/mcp/tools.ts`.
7. Tool results are sent back into the provider chat session until a final text response is produced or the function-call loop limit is reached.
8. The final answer is recorded to local memory and rendered back in the shell view.

### 2. Guardian Suggestion Flow

1. `main.ts` listens to Obsidian `editor-change` events.
2. After a debounced inactivity window, `runGuardianCheck(...)` collects nearby editor context and builds either a completion prompt or a manual-edit prompt.
3. The request goes through `ModelService.chat(...)` just like shell traffic, but expects JSON-only responses describing a completion, edit, answer, or no-op.
4. The parsed suggestion updates CodeMirror UI state via `updateGuardianState(...)` from `src/ui/guardian-gutter.ts`.
5. Inline text suggestions are rendered through `showGhostText(...)` in `src/ui/ghost-text.ts`.

### 3. Selection Menu Flow

1. `src/ui/selection-menu.ts` watches editor selection state.
2. A button tooltip appears when text is selected.
3. Clicking it opens a compact chat surface backed by a new `ChatController`.
4. Messages route through `ModelService`, and the last AI response can be used to replace the selected text directly in the editor.

### 4. Webpage And Inbox Flow

1. `main.ts` watches markdown modifications and filters for the configured WeChat inbox path from `src/mcp/types.ts`.
2. Raw URLs found in that inbox file are passed to `ToolManager.execute('save_webpage', ...)` in `src/mcp/tools.ts`.
3. `save_webpage` either:
- Uses `src/utils/video_utils.ts` to resolve video metadata/transcripts and optionally summarize them with the configured AI service.
- Or fetches a normal webpage, extracts readable content, converts it to markdown, and saves it as a vault note.
4. `main.ts` optionally moves the saved file into the configured storage folder and replaces the raw URL in the inbox note with a wikilink.

### 5. MCP Tool Flow

1. MCP server definitions live in `GeminiSettings.mcpServers` in `src/mcp/types.ts` and are edited through `src/settings.ts`.
2. `ToolManager.initializeMcpClients()` in `src/mcp/tools.ts` builds one `StdioMcpClient` per configured server.
3. `StdioMcpClient.connect()` in `src/mcp/mcp-client.ts` performs the `initialize` handshake and marks the server ready.
4. MCP tool calls are routed by prefix through `ToolManager.execute(...)` and then over stdio JSON-RPC through `StdioMcpClient.callTool(...)`.

## Core Abstractions

### `GeminiSettings`

- `src/mcp/types.ts` centralizes almost all configurable behavior in one settings object.
- That object is wider than the `mcp` folder name suggests: it also covers provider credentials, UI behavior, permissions, prompt configuration, WeChat automation, and terminal styling.

### `IModelProvider` And `IChatSession`

- `src/models/interfaces.ts` gives the rest of the codebase a provider-neutral contract.
- `src/services/model-service.ts` depends on the abstraction rather than on Gemini or OpenAI-specific SDK calls directly.

### `ToolManager`

- `src/mcp/tools.ts` is the tool boundary for both local vault/plugin actions and external MCP-backed actions.
- It serves double duty as:
- the schema source for function-call declarations
- the concrete executor for tool invocations

### `ContextItem`

- `src/services/context-manager.ts` models shell-attached context explicitly through `ContextItem` objects.
- This allows the UI layer to hold structured context separately from the main text prompt.

### `MemoryManager`

- `src/memory/memory-manager.ts` isolates long-lived user context and chat persistence from the shell/editor surfaces.
- The rest of the application consumes it through `ModelService` rather than accessing memory files directly.

## Persistence And External Dependencies

- Plugin settings are persisted through Obsidian plugin storage in `main.ts` via `loadData()` and `saveData()`.
- User profile, summaries, and chat history are persisted as JSON files under `.obsidian/gemini-memory` by `src/memory/memory-manager.ts`.
- Network-bound features rely on:
- Google Gemini via `src/models/gemini.ts`
- OpenAI-compatible APIs via `src/models/openai.ts`
- DuckDuckGo HTML search in `src/mcp/tools.ts`
- direct page fetches through Obsidian `requestUrl(...)` in `src/mcp/tools.ts`, `src/services/context-manager.ts`, and `src/utils/video_utils.ts`
- Optional external process integration depends on `child_process` in `src/mcp/mcp-client.ts`.

## Build And Packaging Shape

- `esbuild.config.mjs` bundles `main.ts` into the committed root artifact `main.js`.
- `manifest.json` advertises the plugin to Obsidian.
- `styles.css` is part of the shipped plugin asset set alongside `main.js`.

## As-Built Architectural Notes

- The architecture is only partly layered: `main.ts` still contains meaningful runtime logic for Guardian execution and inbox URL processing, so orchestration is split between the bootstrap file and `src/`.
- The current runtime path is centered on `src/services/model-service.ts`; surrounding repo documentation and some tests still reference a historical `src/gemini-api.ts` module that is not present in the current tree.
- The repo structure suggests a move toward provider-neutral and MCP-capable composition, but the top-level naming (`GeminiShellPlugin`, `GeminiShellView`, `GeminiSettings`) still reflects the original Gemini-first design.
