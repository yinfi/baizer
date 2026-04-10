# Conventions

## Snapshot

- The codebase is TypeScript-first and class-heavy. Core runtime pieces are organized as plugin entry points in `main.ts`, services in `src/services/`, providers in `src/models/`, UI modules in `src/ui/`, MCP tooling in `src/mcp/`, and persistence helpers in `src/memory/`.
- `tsconfig.json` enables strict compiler checks such as `noImplicitAny`, `noImplicitReturns`, `noUnusedLocals`, and `strictNullChecks`, but the current repository does not fully satisfy those checks.
- There is no repository-level formatter or linter config checked in. Style is enforced by habit and by TypeScript errors rather than by ESLint or Prettier.

## Code Style

- Four-space indentation, semicolons, and single-quoted strings are the dominant style across `main.ts`, `src/services/model-service.ts`, `src/ui/chat-controller.ts`, and `src/mcp/tools.ts`.
- Imports use ES module syntax and are usually grouped external-first, then internal relative imports, for example in `main.ts` and `src/settings.ts`.
- Most modules export a single class or a small group of related types plus a class, for example `src/models/interfaces.ts`, `src/mcp/types.ts`, and `src/utils/logger.ts`.
- Public methods often omit explicit access modifiers, while internal helpers and configuration values use `private` or `private readonly`, for example in `src/services/model-service.ts`, `src/memory/memory-manager.ts`, and `src/mcp/mcp-client.ts`.
- Type annotations are used heavily for interfaces and method signatures, but `any` is still used at integration boundaries where the code talks to Obsidian, provider SDKs, or loosely typed AI payloads. Examples: `main.ts`, `src/mcp/tools.ts`, `src/ui/selection-menu.ts`, and `src/services/model-service.ts`.
- Comments are a mix of English and Chinese. Some comments appear mojibaked in the checked-in source, especially in `src/services/model-service.ts`, `src/memory/memory-manager.ts`, `src/ui/ghost-text.ts`, and `src/ui/guardian-gutter.ts`.

## Naming

- Class names use PascalCase: `GeminiShellPlugin` in `main.ts`, `ModelService` in `src/services/model-service.ts`, `MemoryManager` in `src/memory/memory-manager.ts`, and `StdioMcpClient` in `src/mcp/mcp-client.ts`.
- Interfaces and types also use PascalCase and often carry an `I` prefix for contracts, for example `IModelProvider`, `IChatSession`, and `IGeminiShellPlugin` in `src/models/interfaces.ts` and `src/mcp/types.ts`.
- File names are predominantly kebab-case and reflect the exported module responsibility: `src/ui/shell-view.ts`, `src/services/context-manager.ts`, `src/utils/video_utils.ts`, `src/mcp/mcp-client.ts`.
- Constants use uppercase snake case when globally shared, such as `DEFAULT_SETTINGS` in `src/mcp/types.ts` and `VIEW_TYPE_GEMINI_SHELL` in `src/ui/shell-view.ts`.
- Internal caps, TTLs, and limits are usually `private readonly` fields in all-caps or descriptive camelCase, for example `MAX_MEMORY_CHAT_HISTORY` in `src/memory/memory-manager.ts` and `FILE_SEARCH_CACHE_TTL` in `src/ui/chat-controller.ts`.

## Structural Patterns

- The plugin root in `main.ts` wires long-lived collaborators during `onload()`: settings, `ToolManager`, `ModelService`, the shell view, and CodeMirror extensions.
- Provider behavior is abstracted behind interfaces in `src/models/interfaces.ts`, with concrete implementations in `src/models/gemini.ts` and `src/models/openai.ts`. `src/services/model-service.ts` selects a provider with a `switch` on `settings.provider`.
- Runtime behavior is mostly imperative and service-oriented rather than functional. Classes hold mutable state and expose side-effecting methods. This pattern is consistent in `src/services/model-service.ts`, `src/ui/chat-controller.ts`, `src/memory/memory-manager.ts`, and `src/mcp/tools.ts`.
- UI logic is split between Obsidian view classes and CodeMirror extensions. Obsidian view composition lives in `src/ui/shell-view.ts` and `src/settings.ts`; editor-level state is modeled with `StateField` and `StateEffect` in `src/ui/ghost-text.ts`, `src/ui/guardian-gutter.ts`, and `src/ui/selection-menu.ts`.
- Tool execution follows a command-dispatch style. `src/mcp/tools.ts` declares tool metadata in `getToolsDefinitions()` and dispatches behavior with a large `switch` inside `execute()`.
- The repository favors local helper functions inside larger methods when behavior is specific to one path. Examples include `extractTags` inside `src/mcp/tools.ts` and inline prompt assembly in `main.ts` and `src/services/model-service.ts`.

## Error Handling

- Network, filesystem, and provider calls are usually wrapped in `try/catch` blocks. Examples: `src/services/model-service.ts`, `src/services/context-manager.ts`, `src/mcp/mcp-client.ts`, `src/mcp/tools.ts`, and `src/utils/video_utils.ts`.
- Recoverable failures are often returned as structured objects instead of thrown exceptions, especially in tool execution paths in `src/mcp/tools.ts` where handlers return shapes like `{ success: false, error: '...' }`.
- User-visible failures commonly surface through `new Notice(...)` in `main.ts`, `src/settings.ts`, `src/utils/video_utils.ts`, `src/ui/guardian-modal.ts`, and `src/ui/shell-view.ts`.
- Internal diagnostics use both the shared logger from `src/utils/logger.ts` and direct `console.*` calls. The logger is used more consistently in `src/services/model-service.ts`, `src/services/context-manager.ts`, `src/models/gemini.ts`, `src/models/openai.ts`, `src/ui/chat-controller.ts`, and `src/mcp/mcp-client.ts`. Raw `console.log`, `console.warn`, and `console.error` remain common in `main.ts`, `src/mcp/tools.ts`, `src/memory/memory-manager.ts`, and `src/utils/video_utils.ts`.
- Cleanup is explicit when a feature owns resources. Examples: `modelService.shutdown()` in `main.ts`, `cleanupMcpClients()` in `src/mcp/tools.ts`, `cleanup()` in `src/ui/chat-controller.ts`, and `cleanup()` in `src/services/context-manager.ts`.

## State Management

- Persistent plugin state is centered on `settings` in `main.ts`, loaded with `loadData()` and merged with `DEFAULT_SETTINGS` from `src/mcp/types.ts`, then saved through `saveData()`.
- Service state is held in mutable class fields rather than in a centralized store. Examples include provider/session state in `src/services/model-service.ts`, memory/profile history in `src/memory/memory-manager.ts`, active contexts in `src/services/context-manager.ts`, and MCP client processes in `src/mcp/tools.ts`.
- UI conversation state is encapsulated in `ChatController` in `src/ui/chat-controller.ts`, while the shell view in `src/ui/shell-view.ts` owns DOM references, suggestion state, and heartbeat timers.
- Editor-specific UI state is modeled with CodeMirror primitives rather than ad hoc globals: `StateField`/`StateEffect` in `src/ui/ghost-text.ts`, `src/ui/guardian-gutter.ts`, and `src/ui/selection-menu.ts`.
- The code uses caps and TTLs to constrain in-memory growth. Examples include `MAX_ACTIVE_CONTEXTS` in `src/services/context-manager.ts`, `MAX_MEMORY_CHAT_HISTORY` in `src/memory/memory-manager.ts`, and `FILE_SEARCH_CACHE_TTL` in `src/ui/chat-controller.ts`.
- `WeakMap` is used where editor view lifecycle matters, specifically in `src/ui/selection-menu.ts`, to avoid holding strong references to stale `EditorView` instances.

## Practical Guidance

- Follow the existing class-and-service structure when adding behavior. New responsibilities usually become a new service, manager, provider, or UI module instead of a large free function.
- Match existing naming and file layout: kebab-case files, PascalCase classes, and colocated types in `types.ts` or `interfaces.ts` when multiple modules need them.
- Preserve the current failure model: catch at I/O boundaries, log enough context, return structured error payloads for tool-like operations, and use `Notice` only for user-facing feedback.
- Be careful with refactors that assume the codebase is already strict-clean. `tsconfig.json` is strict, but current code in `src/` and `test/` still contains unused symbols, `any` escapes, and stale call sites.
