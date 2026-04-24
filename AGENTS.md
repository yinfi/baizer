# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**Obsidian CLI** (also known as Gemini Shell) is an AI-powered Obsidian plugin that integrates Google Gemini AI into the note-taking workflow. It provides:

- **Gemini Shell**: A terminal-like interface for natural language interaction with your vault
- **Guardian Mode**: An AI co-writer that provides inline suggestions via Ghost Text
- **MCP-style Tools**: File operations, web search, webpage saving, and plugin orchestration
- **Persistent Memory**: User profiling and session history stored locally

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

### Entry Point
- `main.ts` - Plugin entry, registers commands, views, and CodeMirror extensions

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/gemini-api.ts` | Gemini API wrapper with retry logic, function calling, and memory integration |
| `src/mcp/tools.ts` | Tool definitions and execution (read/write notes, web search, plugin control) |
| `src/mcp/types.ts` | Settings interface (`GeminiSettings`) and default values |
| `src/settings.ts` | Plugin settings UI tab |

### UI Components

| Component | Purpose |
|-----------|---------|
| `src/ui/shell-view.ts` | Main terminal view (ItemView), command parsing, suggestion popups |
| `src/ui/ghost-text.ts` | CodeMirror extension for inline AI suggestions (Tab to accept, Esc to dismiss) |
| `src/ui/guardian-gutter.ts` | CodeMirror gutter extension showing Guardian state (thinking/suggestion/paused) |
| `src/ui/selection-menu.ts` | Floating menu on text selection for AI actions |
| `src/ui/guardian-modal.ts` | Modal for manual Guardian instructions |

### Memory System
- `src/memory/memory-manager.ts` - User profile extraction, session summaries, chat history
- `src/memory/types.ts` - UserProfile, SessionSummary, ChatMessage interfaces
- Data stored in `.obsidian/gemini-memory/`

### Key Patterns

1. **Function Calling**: Tools are registered via `ToolManager.getToolsDefinitions()` and executed through Gemini's native function calling with multi-turn support (up to 10 loops)

2. **CodeMirror Extensions**: Guardian features use CM6 StateFields and StateEffects for reactive UI updates:
   - `guardianModeField` - Global enabled/paused state
   - `ghostTextField` - Decoration management for inline suggestions
   - `setGuardianLineState` - Per-line thinking/suggestion state

3. **Settings Architecture**: All settings defined in `src/mcp/types.ts` with `DEFAULT_SETTINGS`, UI in `src/settings.ts`

## Shell Commands

Built-in commands in Gemini Shell:
- `/clear` - Clear session history
- `/profile` - View user profile
- `/tools` - List available MCP tools
- `/open <file>` - Open file by name
- `@` prefix - File autocomplete
- `/` prefix - Command autocomplete

## Hotkeys

- `Mod+J` - Open Gemini Shell
- `Mod+Shift+G` - Guardian manual trigger

## Supported Tools

Core vault operations: `read_note`, `create_note`, `update_note`, `append_to_note`, `delete_note`, `rename_note`, `list_notes`, `search_vault`, `open_file`

External: `save_webpage` (YouTube/Bilibili transcripts, WeChat articles), `web_search` (DuckDuckGo)

Plugin control (when enabled): `list_plugins`, `get_plugin_commands`, `get_plugin_settings`

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
