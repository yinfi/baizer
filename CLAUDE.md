# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Baizer** is an AI-powered Obsidian plugin that integrates multi-provider AI into the note-taking workflow. All LLM inference runs through a single runtime built on the `@earendil-works/pi-ai` / `pi-agent-core` agent loop. It provides:

- **Baizer Workbench**: A chat workspace (ShellView) for natural language interaction with your vault, with streaming output and a foldable tool/thinking timeline
- **Guardian Mode**: An AI co-writer providing inline completions via Ghost Text, with fast (auto) and deep (manual/auto-escalated) completion paths
- **Skills & Tools**: Atomic vault/web tools orchestrated by progressively-disclosed Skills (pi-native activation)
- **Knowledge Wiki**: Ontology-driven note compilation into a searchable, self-updating knowledge base
- **Hindsight Memory**: Local semantic memory (facts/experiences/observations) with recall, consolidation, and feedback lessons

> Provider abstraction: `ProviderConfig` (in `src/mcp/types.ts`) supports `gemini` and `openai-compatible` types. There is no longer a per-provider API wrapper — `pi-native-model.ts` maps each config to a pi-ai `Model` + `streamFn`.

## Build Commands

```bash
# Development mode (watch for changes)
npm run dev

# Production build
npm run build

# Install dependencies
npm install
```

## Architecture

The system is layered: **UI entry points → `ModelService` (facade) → pi runtime → Skills/Tools**, with Knowledge and Memory as side subsystems.

### Entry Point
- `main.ts` (`BaizerPlugin`) - Assembles all subsystems on `onload`; registers commands, the ShellView, CodeMirror extensions, and vault/editor events. Also owns the Guardian debounce/single-flight/auto-escalation logic.

### Facade
- `src/services/model-service.ts` (`ModelService`) - The single entry to all LLM work. `chat`/`chatStream` drive the stateful agent loop; `generate` does stateless one-shot generation. Holds and wires together the tool/skill registries, memory, session store, steering, audit log, and workspace-edit service. Settings changes (provider/model/key/context window/thinking level) take effect on the next turn because the model handle is rebuilt each call.

### Runtime (pi-agent, single implementation)

| Module | Purpose |
|--------|---------|
| `src/runtime/runtime-factory.ts` | `createChatRuntime()` → always returns a `HarnessChatRuntime` |
| `src/runtime/runtime-types.ts` | `ChatRuntime`/`ChatRuntimeDeps`/`PreparedChatTurn` interfaces |
| `src/runtime/base-chat-runtime.ts` | `BaseChatRuntime` — the preparation layer: `prepareTurn` (prompt assembly: memory recall + time + context + skill list + slash contract + generation plan), skill resolution, short-confirmation/continuation handling, `retainCompletedTurn` |
| `src/runtime/pi/harness-chat-runtime.ts` | `HarnessChatRuntime` — drives pi `agentLoop`, maps pi events → `StreamEvent`, handles approval termination, steering, and dynamic tool sets |
| `src/runtime/pi/pi-native-model.ts` | Maps `ProviderConfig` → pi-ai `Model` + injects apiKey into `streamFn`/`completeFn` (`buildGeminiModel`/`buildOpenAICompatModel`/`createNativeStreamFn`/`createNativeCompleteFn`) |
| `src/runtime/pi/pi-tool-adapter.ts` | Wraps Baizer tools as pi `AgentTool` (timeout, execution mode, approval `terminate`) |
| `src/runtime/pi/pi-event-adapter.ts` / `pi-approval-policy.ts` | pi event → `StreamEvent` mapping; approval detection and final-text resolution |
| `src/runtime/active-run-controller.ts` | Mid-run "steering": queue user follow-ups (next turn) and swap the active tool set |
| `src/runtime/pi/harness-session-manager.ts` (`HarnessSessionManager`) + `vault-session-fs.ts` (`VaultSessionFileSystem`) | JSONL session persistence in the vault + auto-compaction (summary via the app's own provider) |

### UI Components

| Component | Purpose |
|-----------|---------|
| `src/ui/shell-view.ts` | Main Workbench view (ItemView), command parsing, suggestion popups |
| `src/ui/chat-controller.ts` | Orchestrates a chat turn: streams events, buffers file-write text, approval cards, workspace-edit undo, 👍/👎 feedback |
| `src/ui/ghost-text.ts` | CM extension for inline AI suggestions (Tab to accept, Esc to dismiss) |
| `src/ui/guardian-completion.ts` | Guardian completion service (fast/deep decisions, quality gating, knowledge injection) |
| `src/ui/guardian-gutter.ts` | CM gutter extension showing Guardian state (thinking/suggestion/paused) |
| `src/ui/selection-menu.ts` | Floating menu on text selection for AI actions |
| `src/ui/guardian-modal.ts` | Modal for manual Guardian instructions |

### Skills & Tools
- `src/skills/tool-registry.ts` (`ToolRegistry`) - Registry of **atomic tools**; always exposed in full to the model.
- `src/skills/skill-registry.ts` (`SkillRegistry`) - **Skills** = behavior instructions, not execution. Uses pi-native activation: built-in `SKILL.md` files are *materialized* to a hidden vault dir on load; the system prompt only lists skills, and the model calls `read_skill(name)` to pull full instructions (progressive disclosure). Slash commands / keywords can force-activate a skill and narrow its tool subset.
- `src/permissions/permission-service.ts` - Pure-function permission decisions (write scope / file capability / plugin control / approval need); policy comes only from settings. Skill enable/disable is orthogonal (`settings.disabledSkills`).
- `src/skills/builtin/*` - vault-ops, web-search, web-clipper, knowledge, plugin-ctrl, json-canvas, obsidian-bases. `plugin-ctrl/plugin-watcher.ts` + `skill-generator.ts` auto-generate skills for *other* Obsidian plugins.

### Knowledge System
- `src/knowledge/runtime.ts` (`KnowledgeRuntime`) - Lifecycle facade; registers commands/events, exposes `getQueryExecutor`/`getFileBackExecutor`.
- `compiler.ts` (Map-Reduce compilation, content-hash staleness), `indexer.ts` + `metadata-index.ts` (searchable index + `.base` file), `ontology-service.ts`/`ontology.ts` (schema discovery/driven extraction), `query.ts`, `file-back.ts`, `linter.ts`, `watcher.ts`.
- Compiled output lives in `<knowledgeWikiFolder>/Articles/`; per-note compile status (`pending`/`processing`/`done`/`failed`) travels in each note's frontmatter.

### Memory System
- `src/memory/memory-manager.ts` (`MemoryManager`) - Facade over Hindsight; also holds a legacy `user-profile.json`.
- `hindsight-store.ts` / `hindsight-retriever.ts` / `hindsight-consolidator.ts` - Store, semantic recall, and periodic consolidation of memory records (`world`/`experience`/`observation`).
- Data stored in `.obsidian/baizer-memory/` (`MEMORY_DIR`).

### Key Patterns

1. **Single agent loop, two LLM paths**: Chat goes through pi `agentLoop` (tools + history + steering); stateless work (knowledge compilation, session summaries, Guardian completion) goes through `ModelService.generate` → pi `completeSimple`. Both build the model from the same `ProviderConfig`.

2. **Cross-turn context source of truth is `SessionStore`**: When persistence is available, prior messages are derived from the JSONL session (with compaction view), and the UI's `priorMessages` are ignored (UI becomes pure rendering). Without it, the runtime falls back to UI-supplied history.

3. **Preparation vs execution separation**: `BaseChatRuntime` owns all prompt assembly (~250 lines); `HarnessChatRuntime` only drives the loop. A legacy runtime was retired in favor of this single implementation.

4. **CodeMirror Extensions**: Guardian features use CM6 StateFields and StateEffects for reactive UI updates:
   - `guardianModeField` - Global enabled/paused state
   - `ghostTextField` - Decoration management for inline suggestions
   - `setGuardianLineState` - Per-line thinking/suggestion state

5. **Guardian dual-path single-flight**: Fast completion (lightweight, aborted on each keystroke) and deep completion (manual or auto-escalated after a 1.2s dwell, reads knowledge-base summary text, not interrupted by typing) use two independent `AbortController`s. Each anchor escalates to deep at most once.

6. **Settings Architecture**: All settings defined in `src/mcp/types.ts` with `DEFAULT_SETTINGS`, UI in `src/settings.ts`. Providers are a `providers: Record<string, ProviderConfig>` map with `activeProvider`; `loadSettings()` migrates the old flat format.

## Shell Commands

Built-in commands in Baizer (handled in `src/ui/chat-controller.ts`; skill commands are merged in dynamically):
- `/clear` - Clear session history (also starts a fresh persistent session)
- `/memory [overview|observations|search <query>|forget <field>]` - View/search/forget Hindsight memory (`/profile` and `/forget` are kept as aliases)
- `/tools` - List available tools
- `/new <title>` - Create a new note
- `/edit <instruction>` - AI-edit the selected text
- `/open <file>` - Open file by name
- `/file-back <message-id>` - Archive a previous AI answer into the knowledge wiki
- `/wiki:compile [path]` / `/wiki:index` / `/wiki:lint` - Knowledge wiki compile / open index / health check
- `@` prefix - File autocomplete
- `/` prefix - Command autocomplete

## Hotkeys

- `Mod+J` - Open Baizer
- `Mod+Shift+G` - Guardian manual trigger

## Supported Tools

Core vault operations (`src/skills/builtin/vault-ops.ts`): `read_note`, `create_note`, `update_note`, `append_to_note`, `delete_note`, `rename_note`, `list_notes`, `search_vault`, `open_file`

Skill loading: `read_skill` (fetches a skill's full instructions by name; always registered as a core tool)

Knowledge (`src/skills/builtin/knowledge/`): `query_knowledge`, `file_back_knowledge`

External: `save_webpage` (YouTube/Bilibili transcripts, WeChat articles), `web_search` (DuckDuckGo)

Plugin control (`src/skills/builtin/plugin-ctrl/`, gated by `allowPluginControl`): `list_plugins`, `get_plugin_commands`, `get_plugin_settings`, `execute_plugin_command`

Also: `json-canvas` and `obsidian-bases` builtin skills for `.canvas` / `.base` generation.

## Notes for Development

- Build output goes to `main.js` (single bundled file)
- External dependencies: `obsidian`, `electron`, `@codemirror/*` packages are marked external in esbuild config
- Mobile compatibility required: avoid Node.js-specific APIs like `child_process`
- All destructive operations (delete/overwrite) should respect `confirmExecutions` setting



## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
