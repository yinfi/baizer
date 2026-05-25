# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project Overview

**Baizer** is an AI-powered Obsidian plugin that combines:

- A workbench-style chat interface inside Obsidian
- Guardian inline writing assistance
- A skill-and-tool orchestration layer
- A local knowledge wiki compiler
- Multi-provider model support
- Approval-based execution for sensitive actions

## Build And Test Commands

```bash
npm install
npm test
npm run build
npm run dev
```

`npm test` runs the maintained custom `tsx` test harness via `test/run-tests.ts`.

## Current Architecture

### Entry Point

- `main.ts`: bootstraps settings, registries, runtimes, views, editor extensions, and watchers

### Runtime Layer

| Module | Purpose |
|--------|---------|
| `src/services/model-service.ts` | UI-facing model facade, provider switching, settings updates |
| `src/services/obsidian-context-service.ts` | Collect current note, selection, backlinks, recent notes, and explicit scope context |
| `src/services/operation-audit-log.ts` | Persist user-visible write and approval records for later inspection |
| `src/runtime/chat-runtime.ts` | Prompt preparation, tool loop, and stream execution |
| `src/runtime/runtime-factory.ts` | Runtime construction |
| `src/runtime/provider-capabilities.ts` | Provider capability declaration |

### Tool And Skill Layer

| Module | Purpose |
|--------|---------|
| `src/skills/tool-registry.ts` | Register and execute atomic tools |
| `src/skills/skill-registry.ts` | Register skills, route slash commands and intent, expose summaries |
| `src/skills/skill-loader.ts` | Load user-defined `SKILL.md` files |
| `src/skills/builtin/` | Built-in skills and atomic tool registrations |

### Knowledge System

| Module | Purpose |
|--------|---------|
| `src/knowledge/runtime.ts` | Knowledge lifecycle orchestration |
| `src/knowledge/compiler.ts` | Note compilation into structured wiki summaries |
| `src/knowledge/indexer.ts` | Index and base-file generation |
| `src/knowledge/linter.ts` | Knowledge health checks |
| `src/knowledge/status-service.ts` | Active-note knowledge status derivation, stale detection, and aggregate counts |

### UI Components

| Component | Purpose |
|-----------|---------|
| `src/ui/shell-view.ts` | Main shell view, streaming UI, command suggestions |
| `src/ui/chat-controller.ts` | Slash-command dispatch, approval handling |
| `src/ui/approval-card.ts` | Approval request rendering |
| `src/ui/ghost-text.ts` | Inline suggestion rendering |
| `src/ui/guardian-gutter.ts` | Guardian editor gutter state |
| `src/ui/selection-menu.ts` | Selection-triggered AI actions |

## Key Patterns

1. **Skill-first orchestration**
   - Atomic tools live in `ToolRegistry`
   - Higher-level workflows live in `SkillRegistry`
   - Slash command suggestions and routing should prefer the skill registry instead of hardcoded tables

2. **Runtime boundary**
   - `ModelService` should stay a facade
   - Prompt assembly, function-call loops, and streaming execution belong in `ChatRuntime`
   - Note-aware context collection belongs in `ObsidianContextService`, not in view/controller code

3. **Approval flow**
   - Sensitive tools return structured `approval_required`
   - The UI renders approval cards
   - Approved actions replay through `ModelService.executeApprovedAction(...)`
   - Editor-side direct writes should reuse the same preview-first mental model and log through `OperationAuditLog`

4. **Capability-driven UI**
   - Providers declare capabilities such as image input and custom base URL support
   - Prefer capability checks over provider-name branching in UI code

5. **Context and preview first**
   - Prefer `@current`, `@backlinks`, `@recent`, and `@tag:*` scopes over ad hoc prompt stuffing
   - New AI mutation flows should produce a `preview` or diffable intermediate state before they write
   - Shell, Guardian, and selection-menu flows should converge on shared services rather than parallel prompt logic

## Notes For Development

- Build output goes to `main.js`
- External dependencies such as `obsidian`, `electron`, and `@codemirror/*` stay external in esbuild
- Mobile compatibility matters: avoid Node-only runtime dependencies in production plugin code
- Destructive or privileged operations must respect:
  - `vaultWriteScope`
  - `vaultWriteAllowedFolders`
  - `allowFileCreation`
  - `allowFileModification`
  - `allowPluginControl`
  - `confirmExecutions`
- `.obsidian` writes remain blocked even when the write scope is broad
- Plugin-command previews should state preconditions explicitly when they depend on the active note, editor focus, or current selection

## Shell And Skill Routing

When a user request clearly maps to a registered skill workflow, prefer routing through the skill system instead of hardcoding bespoke controller behavior.

Examples:

- Web save and clipping -> `web-clipper`
- Knowledge lookup -> `knowledge`
- Plugin inspection and command use -> `plugin-ctrl`

Keep local commands such as `/clear` and `/profile` local unless there is a strong reason to move them.
