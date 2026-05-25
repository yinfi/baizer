# Baizer

Baizer is an AI knowledge workbench for Obsidian. Inspired by Bai Ze, the mythic knower of hidden things, it helps your vault read, write, search, remember, and act through a note-native assistant layer.

![main](https://github.com/user-attachments/assets/d0ab9014-ea13-4300-8d76-d8839fd0c046)

## What It Does

- Chat with your vault from a compact Baizer workspace with streaming responses, tool timelines, tabs, history, and context chips.
- Mention scoped context such as the current note, backlinks, recent notes, files, tags, selections, and images where supported.
- Rewrite, review, and apply editor selections with preview-first flows instead of silent mutation.
- Use Guardian for inline writing help with Ghost Text, gutter state, manual triggers, and optional automatic suggestions.
- Route work through skills for web search, web clipping, knowledge lookup, Obsidian Markdown, JSON Canvas, Bases, and plugin control.
- Compile selected notes into a local Knowledge Wiki, track per-note knowledge status, query compiled knowledge, and archive useful answers back into the wiki.
- Save webpages and videos into the vault, including ordinary pages plus YouTube, Bilibili, and WeChat article workflows.
- Control Obsidian plugins through generated plugin skills when permissions allow it.
- Keep local memory for durable user facts, prior outcomes, observations, and query-aware recall.
- Require approvals for sensitive writes and plugin commands, with audit records and undoable workspace edits where possible.
- Switch between Gemini and OpenAI-compatible providers such as OpenAI, DeepSeek, Qwen, or custom endpoints.

## Product Model

Baizer is built around three surfaces:

- **Workbench**: a chat-first sidebar for asking, searching, clipping, editing, running tools, and inspecting AI execution.
- **Guardian**: an editor-side assistant that suggests continuations or edits without pulling you away from the note.
- **Knowledge Wiki**: a compiler that turns chosen vault folders into structured, searchable wiki pages that Baizer can cite and reuse.

The goal is not to bolt a generic chatbot onto Obsidian. Baizer tries to work with Obsidian's own language: notes, wikilinks, frontmatter, backlinks, canvases, bases, plugins, selections, and explicit write permissions.

## Architecture Snapshot

### Core Runtime

- `main.ts`: plugin bootstrap, runtime wiring, commands, editor extensions, and watchers.
- `src/services/model-service.ts`: provider facade, model switching, approved action replay, memory, and workspace edit integration.
- `src/runtime/chat-runtime.ts`: prompt preparation, skill routing, tool loop execution, streaming, approval interruption, and file-write contracts.
- `src/runtime/provider-capabilities.ts`: provider feature declarations used by the UI.

### Tools And Skills

- `src/skills/tool-registry.ts`: atomic tool registration and execution.
- `src/skills/skill-registry.ts`: skill discovery, command routing, intent routing, and skill activation.
- `src/skills/builtin/`: built-in workflows for vault operations, web search, web clipping, knowledge, plugin control, Obsidian Markdown, JSON Canvas, and Bases.
- `.obsidian/baizer/skills/`: user and generated plugin skills loaded at startup.

### Knowledge System

- `src/knowledge/runtime.ts`: knowledge lifecycle orchestration, commands, watchers, ontology discovery, and Guardian knowledge context.
- `src/knowledge/compiler.ts`: note compilation into structured wiki summaries.
- `src/knowledge/indexer.ts`: wiki index and Base file generation.
- `src/knowledge/linter.ts`: knowledge health reports.
- `src/knowledge/status-service.ts`: active-note knowledge status, stale detection, and aggregate counts.

### UI

- `src/ui/shell-view.ts`: Baizer workspace, tabs, history, context chips, streaming UI, and workspace edit bar.
- `src/ui/chat-controller.ts`: slash commands, approval handling, streaming coordination, and local command behavior.
- `src/ui/approval-card.ts`: approval request rendering with compact change previews.
- `src/ui/ghost-text.ts`: inline completion decorations.
- `src/ui/guardian-gutter.ts`: Guardian editor gutter state.
- `src/ui/selection-menu.ts`: selection-triggered AI actions.

## Interaction Model

- `editor-first`: selection rewrites and review flows start from the editor and produce previews before writing.
- `knowledge-visible`: the current note can show whether it is unregistered, pending, stale, failed, or compiled into the Knowledge Wiki.
- `skill-routed`: requests that map to a workflow use registered skills instead of hardcoded controller branches.
- `preview-before-mutation`: writes, plugin actions, and local rewrite applies go through previews, approval cards, or undoable workspace edit records.
- `capability-driven`: UI behavior follows provider capabilities such as image input and custom base URL support.

## Local Storage

Baizer keeps operational data inside the vault:

- `.obsidian/baizer-memory/`: local memory, profiles, session summaries, and retained observations.
- `.obsidian/baizer/`: conversation history, audit records, generated skills, and other Baizer runtime data.
- `Knowledge Wiki/` by default: compiled knowledge output, unless configured otherwise.

## Supported Providers

- Google Gemini
- OpenAI-compatible providers, including OpenAI, DeepSeek, Qwen, and custom base URLs

Provider capabilities are declared in code and used by the UI, so features like image context and custom endpoint support can differ by backend.

## Shell Commands

Built-in local commands:

- `/clear`
- `/memory`
- `/memory observations`
- `/memory search <query>`
- `/memory forget <field|all>`
- `/tools`
- `/help`
- `/open <file>`
- `/new <title>`
- `/edit <instruction>`
- `/file-back <message-id>`
- `/wiki:compile [path]`
- `/wiki:index`
- `/wiki:lint`

Skill-backed commands:

- `/save <url>` via `web-clipper`
- `/wiki:query` via `knowledge`

Command suggestions are driven by local commands plus registered skill commands.
Legacy aliases `/profile` and `/forget` remain available for compatibility.

## Permissions And Approvals

- `vaultWriteScope`: write boundary for AI writes (`read-only`, `current-note`, `configured-folders`, `all-vault`)
- `vaultWriteAllowedFolders`: folder allowlist used when the write scope is `configured-folders`
- `allowFileCreation`: gates note and file creation
- `allowFileModification`: gates note updates, appends, renames, and deletes
- `allowPluginControl`: gates plugin inspection and command execution
- `confirmExecutions`: turns write and plugin actions into approval requests

`.obsidian` writes are blocked even when the vault write scope is broad. When confirmation is enabled, Baizer renders approval cards and replays approved actions with an explicit approval flag. Editor-side direct writes use the same preview-first model and record operations in the local audit log.

## Development

```bash
npm install
npm test
npm run build
npm run dev
```

`npm test` runs the maintained custom `tsx` harness through `test/run-tests.ts`.

## Installation

1. Download the latest release from the [Releases](https://github.com/yinfie/baizer/releases) page.
2. Extract `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/baizer/`.
3. Reload Obsidian and enable Baizer.

## Hotkeys

- `Mod+J`: open Baizer
- `Mod+Shift+G`: open Guardian manual trigger

## License

MIT
