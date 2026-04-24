# TODOS

## Integration tests for Map-Reduce compiler + stale detection
- **What:** Write integration tests for `compileNote()` map-reduce flow and `detectStaleFiles()`, requiring extended Obsidian mock
- **Why:** Pure function tests cover core logic (chunking, merging, hashing), but end-to-end flow (file I/O + state transitions + partial failure) needs integration tests
- **Pros:** Prevents state machine regressions, validates partial failure path works correctly
- **Cons:** Requires extending `test/mock-obsidian.ts` with vault read/write simulation, ~30min effort
- **Context:** The map-reduce compiler splits long documents into chunks, extracts in parallel, and merges results. `detectStaleFiles()` compares content_hash and schema_hash at startup to trigger recompilation. Both involve Obsidian's `App`, `TFile`, `vault`, and `metadataCache` APIs that need mocking.
- **Depends on:** Pure function implementation of `chunkDocument`, `mergeExtractions`, `computeContentHash` must be complete first
- **Added:** 2026-04-15 by /plan-eng-review

## Slash command dynamic routing
- **What:** Refactor chat-controller.ts slash command dispatch from hardcoded switch/case to dynamic resolution via SkillRegistry.resolveByCommand()
- **Why:** Every new slash command requires modifying chat-controller.ts. Dynamic routing lets new skills auto-register commands.
- **Pros:** New skills get slash commands for free; reduces chat-controller.ts coupling to specific skills
- **Cons:** Need to handle shell-view.ts autocomplete list dynamically too; ~1hr effort
- **Context:** Currently /clear, /profile, /wiki:compile, /wiki:query etc are hardcoded in chat-controller.ts handleSlashCommand(). SkillRegistry already has resolveByCommand() and commandIndex, but chat-controller doesn't use it. The autocomplete popup in shell-view.ts also has a hardcoded command list.
- **Depends on:** None
- **Added:** 2026-04-19 by /plan-eng-review (Codex outside voice finding #1)

## Skill execute() streaming support
- **What:** Extend Skill.execute() interface to support AsyncGenerator return type for streaming output
- **Why:** /emit and other long-running skills (10-30s) would benefit from streaming output to Shell UI. Current interface only supports Promise<any>.
- **Pros:** Much better UX for long-running skills; streaming UI infrastructure already exists (chatStream + Think timeline)
- **Cons:** Requires changing Skill interface, BuiltinSkill, chat-controller skill execution path; ~2hr effort
- **Context:** chatStream() and StreamEvent types already exist in model-service.ts. The gap is between Skill.execute() (returns Promise) and the streaming infrastructure. Need a new executeStream() method or overloaded return type.
- **Depends on:** None
- **Added:** 2026-04-19 by /plan-eng-review
