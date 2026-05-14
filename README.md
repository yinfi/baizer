# Obsidian CLI

Obsidian CLI is an AI-powered Obsidian plugin that turns your vault into a lightweight agent workspace. It combines a shell-style chat view, editor-side Guardian suggestions, skill-driven tool orchestration, and a local knowledge system.

![main](https://github.com/user-attachments/assets/d0ab9014-ea13-4300-8d76-d8839fd0c046)

## What It Does

- Shell chat inside Obsidian with file, web, knowledge, and plugin workflows
- Guardian inline writing help with Ghost Text and gutter state
- Editor-first rewrite and review flows with diff previews before mutation
- Skill-based orchestration on top of atomic tools
- Local memory and knowledge compilation stored in the vault
- Visible knowledge status for the active note, plus archive-to-wiki actions from chat
- Approval flow for destructive or privileged actions
- Multi-provider support with Gemini and OpenAI-compatible backends

## Architecture Snapshot

### Core Runtime

- `main.ts`: plugin bootstrap and lifecycle wiring
- `src/services/model-service.ts`: provider facade, settings updates, and UI-facing methods
- `src/runtime/chat-runtime.ts`: prompt assembly, tool loop, and stream loop execution
- `src/runtime/provider-capabilities.ts`: provider capability declaration

### Tools And Skills

- `src/skills/tool-registry.ts`: atomic tool registration and execution
- `src/skills/skill-registry.ts`: skill discovery, command routing, and intent routing
- `src/skills/builtin/`: built-in skills for vault ops, web search, web clipping, knowledge, and plugin control

### Knowledge System

- `src/knowledge/runtime.ts`: knowledge lifecycle orchestration
- `src/knowledge/compiler.ts`: map-reduce style note compilation
- `src/knowledge/indexer.ts`: wiki index generation
- `src/knowledge/linter.ts`: knowledge health checks

### UI

- `src/ui/shell-view.ts`: shell workspace and stream rendering
- `src/ui/chat-controller.ts`: command dispatch and approval flow orchestration
- `src/ui/approval-card.ts`: approval request UI
- `src/ui/ghost-text.ts`: inline completion decorations
- `src/ui/guardian-gutter.ts`: editor gutter state

## Interaction Model

- `editor-first`: selection rewrites and code-block review flows can be applied from the editor surface without routing everything through shell chat
- `knowledge-visible`: the active shell session shows whether the current note is unregistered, pending, stale, failed, or already compiled into the knowledge wiki
- `preview-before-mutation`: file writes, plugin commands, and local rewrite applies go through explicit previews or approval cards before they mutate vault state

## Supported Providers

- Google Gemini
- OpenAI-compatible providers such as OpenAI, DeepSeek, and Qwen

Provider capabilities are declared in code and used by the UI, so features like image context and custom base URLs can differ by backend.

## Shell Commands

Built-in local commands:

- `/clear`
- `/profile`
- `/tools`
- `/help`
- `/open <file>`
- `/forget <field>`
- `/wiki:compile`
- `/wiki:index`
- `/wiki:lint`

Skill-backed commands:

- `/save <url>` via `web-clipper`
- `/wiki:query` via `knowledge`

Command suggestions in the shell are now driven by local commands plus registered skill commands.

## Permissions And Approvals

- `vaultWriteScope`: high-level write boundary for AI writes (`read-only`, `current-note`, `configured-folders`, `all-vault`)
- `vaultWriteAllowedFolders`: folder allowlist used when the write scope is `configured-folders`
- `allowFileCreation`: gates note creation
- `allowFileModification`: gates note updates, append, rename, delete
- `allowPluginControl`: gates plugin inspection and command execution
- `confirmExecutions`: turns write and plugin actions into approval requests

When confirmation is enabled, the shell renders an approval card. Approved actions replay the original tool call with an explicit approval flag. Editor-side direct writes reuse the same preview-first pattern and now write operation records into the local audit log.

## Development

### Scripts

```bash
npm install
npm test
npm run build
npm run dev
```

### Test Harness

The repository uses a custom `tsx`-based test harness instead of Jest/Vitest. `npm test` runs the maintained suite through `test/run-tests.ts`.

## Installation

1. Download the latest release from the [Releases](https://github.com/yinfie/obsidian-cli/releases) page.
2. Extract `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/obsidian-cli/`.
3. Reload Obsidian and enable the plugin.

## Hotkeys

- `Mod+J`: open Obsidian Shell
- `Mod+Shift+G`: open Guardian manual trigger

## License

MIT
