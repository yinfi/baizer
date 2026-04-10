# Codebase Concerns

This document captures the highest-value technical concerns found during repository review on 2026-04-06. The focus is on concrete user risk, fragility, security exposure, and maintenance cost.

## Critical Concerns

### 1. Permission and confirmation settings are largely UI-only

**Evidence**

- `src/mcp/types.ts:50-53` defines `allowFileCreation`, `allowFileModification`, and `confirmExecutions`.
- `src/settings.ts:304-338` exposes those controls in the settings UI.
- `src/mcp/tools.ts:319-379` executes `create_note`, `update_note`, `append_to_note`, `delete_note`, and `rename_note` without checking those settings.
- `src/mcp/tools.ts:434-738` allows `save_webpage` to fetch remote content and create notes without any confirmation gate.
- `src/ui/shell-view.ts:491-492` applies AI-generated code blocks by directly calling `vault.modify(...)` on the active file.
- By contrast, plugin access is explicitly gated by `allowPluginControl` in `src/mcp/tools.ts:209-240` and enforced at `src/mcp/tools.ts:747-773`.

**Why this matters**

The UI promises a human-in-the-loop safety model, but the implementation does not enforce it for the highest-risk actions. That creates a trust and security problem: users can reasonably believe file writes need approval when they do not.

**Likely impact**

- Accidental data loss or overwrites.
- AI-initiated vault mutations that bypass user expectations.
- Arbitrary outbound fetches and note creation even when the user expects confirmation.

### 2. MCP integration is only partially wired and is vulnerable to race conditions

**Evidence**

- `src/mcp/tools.ts:28` calls `initializeMcpClients()` from the constructor without awaiting it.
- `src/mcp/tools.ts:76-79` does the same on settings updates.
- `src/mcp/tools.ts:259-276` contains explicit TODO/Hack comments inside `getToolsDefinitions()` acknowledging that MCP tools are not integrated into the synchronous path.
- `src/mcp/tools.ts:282-295` adds `getToolsDefinitionsAsync()`, but `src/services/model-service.ts:190` still starts chats with the synchronous `getToolsDefinitions()`.
- `src/ui/shell-view.ts:144` calls `this.chatController.getTools()`, but `src/ui/chat-controller.ts` does not implement that method.
- `npx tsc --noEmit` currently fails on `src/ui/shell-view.ts:144` for exactly that missing method.

**Why this matters**

MCP is presented as a core extensibility surface, but the current plumbing can easily start a chat before external tools are ready and cannot reliably expose those tools to the model. The UI also contains a direct runtime/compile-time mismatch.

**Likely impact**

- MCP tools silently missing from some chat sessions.
- Tool availability depending on startup timing.
- Broken “Tools” UI path in the shell view.

### 3. OpenAI-compatible tool calling is acknowledged in code as incomplete

**Evidence**

- `src/models/openai.ts:113-154` contains multiple comments stating that tool call IDs are not properly tracked and that multi-turn tool calling may break.
- `src/models/openai.ts:127-133` only appends tool outputs if the previous assistant message contains `tool_calls`.
- `src/models/openai.ts:145` creates `assistantMsg` but never stores it in history.
- `src/services/model-service.ts:199-229` assumes every provider can sustain the same function-call loop.

**Why this matters**

This is not just debt; the implementation itself documents that the provider abstraction is not actually equivalent across providers. Gemini is likely the healthiest path, while OpenAI-compatible backends may fail specifically on tool-heavy requests.

**Likely impact**

- Provider-dependent behavior that is hard to debug.
- Infinite or broken tool loops on OpenAI/DeepSeek/Qwen.
- Support burden when users switch providers and lose tool reliability.

## High Concerns

### 4. Memory/profile loading has startup races, and privacy mode is not enforced

**Evidence**

- `src/memory/memory-manager.ts:23-30` triggers `loadProfile()`, `loadSummaries()`, and `loadChatHistory()` inside the constructor without awaiting them.
- `src/services/model-service.ts:103` constructs `MemoryManager`, and `src/services/model-service.ts:164` can immediately call `buildContext()` on it during chat.
- `src/mcp/types.ts:47,100` defines `privacyMode`, and `src/settings.ts:276-278` exposes it in the UI.
- `rg` search shows no runtime use of `privacyMode` outside settings/schema files.
- `src/memory/memory-manager.ts:17-19` persists `user-profile.json`, `session-summaries.json`, and `chat-history.json`.
- `src/memory/memory-manager.ts:97-131` automatically records messages and extracts profile data from user content.

**Why this matters**

The first request after startup can run before persisted memory is loaded, so context quality depends on timing. At the same time, the privacy toggle appears to be a no-op while the plugin still stores and mines personal conversation history by default.

**Likely impact**

- Inconsistent memory behavior across restarts.
- Users believing privacy protections exist when they do not.
- Hard-to-reproduce bugs where recent memory appears missing or stale.

### 5. Verification is too weak to catch current breakage

**Evidence**

- `package.json:6-8` only defines `dev` and `build`; there is no `test`, `typecheck`, or lint script.
- `esbuild.config.mjs:14-44` bundles with esbuild but does not run TypeScript type checking.
- Verified on 2026-04-06: `npx tsc --noEmit` fails with live errors including:
  - missing `ChatController.getTools()` used by `src/ui/shell-view.ts:144`
  - missing `scrollToBottom()` used by `src/ui/shell-view.ts:503`
  - numerous invalid test references and constructor mismatches
- The production bundle still builds via `npm run build`, which means the release path can ship code that does not type-check.

**Why this matters**

The repository can produce a distributable bundle while type errors and stale code paths remain in-tree. That is exactly the situation where regressions accumulate quietly until users hit them at runtime.

**Likely impact**

- Broken features shipping unnoticed.
- Higher cost to refactor because the codebase no longer has a trusted safety net.
- Increased reliance on manual testing inside Obsidian.

### 6. Test files are stale and inconsistent with the current implementation

**Evidence**

- `test/mcp-integration.test.ts:50,128` instantiates `new ToolManager(mockApp, true|false)`, but the current constructor expects `GeminiSettings`.
- `test/mcp-integration.test.ts:115-129` still expects `list_available_commands` and `execute_command`, which are not implemented in `src/mcp/tools.ts`.
- `test/functional-test.ts:47` has the same outdated constructor assumption.
- `test/context-manager.test.ts:22-66` uses Jest globals (`jest`, `describe`, `test`, `expect`) even though `package.json` does not include Jest/Vitest dependencies or scripts.
- `npx tsc --noEmit` currently fails across those test files for missing globals, wrong signatures, and missing modules.

**Why this matters**

The test tree is not merely incomplete; parts of it target an older API surface. That creates false confidence for maintainers and makes future cleanup harder because the intended behavior is no longer clear.

**Likely impact**

- Regressions survive because tests are not trustworthy.
- Contributors spend time debugging the test harness instead of the product.
- Old product assumptions remain encoded in the repo.

## Medium Concerns

### 7. Context collection can grow large quickly and has weak size controls

**Evidence**

- `src/ui/shell-view.ts:412` reads the entire active file into context for every request.
- `src/ui/shell-view.ts:645-653` and `src/ui/shell-view.ts:691-699` store pasted/dropped images as base64 data URLs.
- `src/services/context-manager.ts:15` allows up to 50 active contexts.
- `src/services/context-manager.ts:49-56` eagerly resolves URL and YouTube contexts by fetching remote content.
- `src/services/context-manager.ts:63-109` pulls full page/transcript content with no token-aware truncation.

**Why this matters**

The current design mixes full note contents, fetched web pages, transcripts, and base64 images in a single prompt assembly path. The count is capped, but the payload size is not.

**Likely impact**

- Large prompts and higher API costs.
- Slow UI on large notes or pasted screenshots.
- Provider errors from oversized requests.

### 8. Product/docs/tests have drifted apart around plugin orchestration and privacy claims

**Evidence**

- `README.md:13` claims the AI can “list, control, and execute commands from other Obsidian plugins”.
- Current runtime code in `src/mcp/tools.ts:209-240` and `src/mcp/tools.ts:746-773` only supports listing plugins, listing commands, and reading plugin settings.
- Legacy tests still reference the removed command-execution tool surface in `test/mcp-integration.test.ts:115-129`.
- `README.md:32` describes the memory layer as “Privacy-First”, while `privacyMode` is not enforced anywhere in runtime code.

**Why this matters**

This is a product risk as much as a code risk. Documentation and stale tests describe capabilities that the current implementation does not provide, which makes issue triage and user expectations harder to manage.

**Likely impact**

- Support churn from users following outdated promises.
- Confusion about which features are intentionally supported.
- Increased risk of accidental regressions during future cleanup.

## Summary

The main pattern across the repo is incomplete enforcement of product promises: safety toggles exist without enforcement, provider abstractions exist without feature parity, MCP exists without a fully wired async lifecycle, and tests/docs no longer describe the code accurately. The next stabilization pass should prioritize:

1. Enforcing write/confirmation/privacy settings in runtime code.
2. Repairing MCP and provider-specific tool-call flows.
3. Adding a mandatory typecheck/test gate to the release path.
4. Deleting or fixing stale tests and outdated product claims.
