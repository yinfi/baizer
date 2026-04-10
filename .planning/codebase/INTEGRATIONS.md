# External Integrations

## Summary

- The plugin's external boundary is centered on Obsidian host APIs, remote LLM providers, generic web fetching, video/webpage ingestion, optional MCP subprocesses, and local vault/memory persistence.
- Most integrations are mediated through `src/services/model-service.ts`, `src/mcp/tools.ts`, `src/mcp/mcp-client.ts`, `src/utils/video_utils.ts`, `src/services/context-manager.ts`, and `main.ts`.

## Obsidian Host Integration

- `main.ts` registers the plugin lifecycle, custom view, commands, editor extensions, ribbon icon, settings tab, and vault/workspace listeners.
- `src/ui/shell-view.ts` integrates with Obsidian `ItemView`, active leaves, active files, Markdown rendering, and plugin settings mutation.
- `src/settings.ts` uses `PluginSettingTab`, `Setting`, `Modal`, and `Notice` to expose provider credentials, permissions, WeChat paths, and MCP server definitions.
- `src/mcp/tools.ts` uses Obsidian vault/workspace/plugin/command APIs to read, create, modify, append, delete, rename, search, and open notes, inspect installed plugins, inspect plugin settings, and enumerate plugin commands.
- `src/ui/selection-menu.ts` and `src/ui/shell-view.ts` render model output through Obsidian `MarkdownRenderer`.

## LLM Provider Integrations

### Google Gemini

- `src/models/gemini.ts` integrates with Google Gemini through `@google/generative-ai`.
- `src/services/model-service.ts` selects Gemini when `provider === 'gemini'`.
- Credentials and model names are configured in `src/mcp/types.ts` and edited in `src/settings.ts`.
- Gemini is used both for normal chat/tool-calling and for memory/profile extraction in `src/memory/memory-manager.ts`.

### OpenAI-Compatible APIs

- `src/models/openai.ts` sends `POST` requests to `${baseUrl}/chat/completions` using Obsidian `requestUrl`.
- Authentication is bearer-token based through the `Authorization: Bearer <apiKey>` header in `src/models/openai.ts`.
- The same provider class is reused by `src/services/model-service.ts` for:
- OpenAI using defaults from `src/mcp/types.ts`
- DeepSeek using `deepseekBaseUrl` and `deepseekModel` from `src/mcp/types.ts`
- Qwen using `qwenBaseUrl` and `qwenModel` from `src/mcp/types.ts`
- Provider switching and credential entry are exposed in `src/settings.ts` and `src/ui/shell-view.ts`.

## Auth And Secret Handling

- API keys are collected through the settings UI in `src/settings.ts` and stored via Obsidian plugin persistence in `main.ts`.
- The codebase uses simple API-key auth only; there is no OAuth, device flow, or user account login implementation in the repository.
- Local execution permissions are represented by booleans in `src/mcp/types.ts` such as `allowFileCreation`, `allowFileModification`, `allowPluginControl`, and `confirmExecutions`.

## MCP And External Tool Servers

- `src/mcp/types.ts` defines `mcpServers` as a map of `{ command, args }`.
- `src/settings.ts` provides CRUD UI for MCP server definitions.
- `src/mcp/mcp-client.ts` spawns external processes with `child_process.spawn`, then speaks newline-delimited JSON-RPC over stdio.
- The MCP handshake uses `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` in `src/mcp/mcp-client.ts`.
- `src/mcp/tools.ts` dynamically exposes MCP tools under a `${serverName}_${toolName}` naming convention and forwards execution back to each `StdioMcpClient`.
- This is the main integration point that can reach arbitrary external services beyond the repo's built-in toolset.

## Network Services And Remote Content

### Web Search

- `src/mcp/tools.ts` implements `web_search` by requesting DuckDuckGo's HTML endpoint at `https://html.duckduckgo.com/html/?q=...`.
- Results are parsed from raw HTML rather than through a JSON search API.

### Generic Web Fetching

- `src/mcp/tools.ts` fetches arbitrary webpage URLs with Obsidian `requestUrl`, converts content using `Readability` plus `htmlToMarkdown`, and writes clipped notes back into the vault.
- `src/services/context-manager.ts` can also fetch arbitrary URLs and strip HTML into plain text for chat context.

### WeChat

- `main.ts` monitors the configured `wechatInboxPath` note for raw URLs and auto-invokes `save_webpage`.
- `src/mcp/tools.ts` has WeChat-specific extraction logic for `mp.weixin.qq.com`, including author extraction and `#js_content` parsing.
- `src/mcp/types.ts` and `src/settings.ts` define `wechatInboxPath` and `wechatStoragePath`.

### YouTube

- `src/utils/video_utils.ts` fetches YouTube watch pages, extracts `captionTracks`, downloads transcript payloads, and returns transcript/title/author metadata.
- `src/services/context-manager.ts` contains a second YouTube transcript path for context resolution by scraping `captionTracks` and transcript XML.
- `src/mcp/tools.ts` uses `getVideoTranscript()` from `src/utils/video_utils.ts` when `save_webpage` receives YouTube URLs, optionally summarizes the transcript through the configured model provider, and stores a note or media link in the vault.

### Bilibili

- `src/utils/video_utils.ts` supports `bilibili.com` and `b23.tv` URLs.
- It requests Bilibili page HTML, extracts `cid` and `bvid`, then calls `https://api.bilibili.com/x/player/v2?cid=...&bvid=...` to locate subtitle data.
- Subtitle payloads are fetched from the returned subtitle URL and flattened into note content for `save_webpage`.

### Obsidian URI Scheme

- `src/mcp/tools.ts` writes `obsidian://mx-open?url=...` links for video notes, which is an integration point with Media Extended or compatible handlers inside Obsidian.

## File I/O And Local Persistence

- Vault note CRUD is implemented in `src/mcp/tools.ts` through `vault.read`, `vault.create`, `vault.modify`, `vault.trash`, `vault.rename`, `vault.getMarkdownFiles`, and `vault.getFiles`.
- `main.ts` reads and rewrites the inbox note during auto-save flows, creates folders, checks path existence through `vault.adapter.exists`, and moves saved clips into the configured storage folder.
- `src/memory/memory-manager.ts` persists local memory under `.obsidian/gemini-memory` using:
- `user-profile.json`
- `session-summaries.json`
- `chat-history.json`
- `src/memory/memory-manager.ts` uses `vault.adapter.exists`, `read`, `write`, and `mkdir` directly for that storage.

## Plugin-To-Plugin Integration

- When `allowPluginControl` is enabled, `src/mcp/tools.ts` can inspect installed Obsidian plugins, list commands namespaced by plugin ID, and read plugin settings/data via `app.plugins.getPlugin(...)`.
- The default system prompt in `src/mcp/types.ts` explicitly instructs the model to prefer installed plugin commands over creating generic notes, so plugin orchestration is part of the intended product behavior.

## Other Client-Side Integrations

- `src/ui/selection-menu.ts` writes to `navigator.clipboard` for copy actions.
- `src/ui/shell-view.ts` can apply AI-generated edits back into the active note after showing a diff via `src/ui/diff-modal.ts`.
- `src/services/model-service.ts` installs a global `unhandledrejection` listener on `window`, which is an application-host integration rather than a remote service.
