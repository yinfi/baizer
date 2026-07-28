# Runtime Architecture

## Overview

All LLM inference in Baizer goes through a single runtime built on the
`@earendil-works/pi-agent-core` agent loop. There is exactly one `ChatRuntime`
implementation; earlier per-provider adapters have been removed.

The runtime is split along a **preparation vs. execution** seam:

| Layer | Owns |
|-------|------|
| `ModelService` (`src/services/model-service.ts`) | The facade. Provider lifecycle, settings changes, registries, memory, session store, audit log. The single entry point for all LLM work. |
| `BaseChatRuntime` (`src/runtime/base-chat-runtime.ts`) | Preparation. Prompt assembly, skill resolution, short-confirmation and continuation handling, turn retention. |
| `HarnessChatRuntime` (`src/runtime/pi/harness-chat-runtime.ts`) | Execution. Drives the pi `agentLoop`, maps pi events to `StreamEvent`, handles approval termination, steering, and dynamic tool sets. |

`HarnessChatRuntime` extends `BaseChatRuntime`. Keeping ~250 lines of prompt
assembly out of the loop driver is what makes each half testable on its own.

## Two LLM paths

Both paths build their model from the same `ProviderConfig`, via
`src/runtime/pi/pi-native-model.ts`:

- **Stateful chat** → pi `agentLoop`. Tools, history, steering, approvals.
  Used by the Workbench.
- **Stateless one-shot** → pi `completeSimple`, through
  `ModelService.generate`. Used by knowledge compilation, session summaries,
  and Guardian completions. No tools, no history.

## Main flow (stateful)

1. UI calls `ModelService.chat(...)` or `chatStream(...)`.
2. `ModelService` builds a runtime through `createChatRuntime(...)`, which
   always returns a `HarnessChatRuntime`.
3. `prepareTurn(...)` assembles the turn:
   - recalled memory
   - current time
   - context items and selected text
   - the available-skills list
   - the slash-command contract
   - the generation plan
4. `HarnessChatRuntime` runs the pi `agentLoop`.
5. Tool calls resolve through `ToolRegistry.execute(...)`. Skills are *not*
   executed — the model pulls a skill's instructions by calling the ordinary
   `read_skill` tool, which is always registered.
6. Completed turns are retained into memory when enabled.

> **Note on skill activation:** there is no `use_skill` meta-tool. Skills are
> listed in the system prompt under `<available_skills>`, and the model reads
> one on demand via `read_skill`. This is progressive disclosure — the full
> instruction text never sits in the prompt unless it is needed.

## Where cross-turn context comes from

`SessionStore` is the source of truth. When persistence is available, prior
messages are derived from the JSONL session (through the compaction view) and
the UI's `priorMessages` are **ignored** — the UI becomes pure rendering.
Without persistence, the runtime falls back to UI-supplied history.

Sessions live in the vault as JSONL, managed by `HarnessSessionManager` over
`VaultSessionFileSystem`, with auto-compaction that summarises through the
app's own configured provider.

## Memory flow

`MemoryManager` is a facade over a local Hindsight-style store. The
user-facing command is `/memory`; `/profile` and `/forget` are compatibility
aliases and should not be offered by the slash-command contract.

1. `prepareTurn(...)` performs query-aware recall against the user's request.
2. Relevant records are formatted into a `[Relevant Memory]` block.
3. After the turn, the request and outcome are retained as structured records.
4. Every few retained turns, raw records are consolidated into observations
   that carry evidence IDs.

## Why this boundary exists

- Keeps `ModelService` from becoming a god object.
- Lets prompt assembly be tested without spinning up a provider or the UI.
- Gives approval handling, steering, and session behaviour one clear home.
- Confines provider differences to a single mapping file.

## Files

- `src/services/model-service.ts` — facade
- `src/runtime/runtime-factory.ts` — `createChatRuntime()`
- `src/runtime/runtime-types.ts` — `ChatRuntime` / `ChatRuntimeDeps` / `PreparedChatTurn`
- `src/runtime/base-chat-runtime.ts` — preparation
- `src/runtime/pi/harness-chat-runtime.ts` — execution
- `src/runtime/pi/pi-native-model.ts` — `ProviderConfig` → pi-ai `Model`
- `src/runtime/pi/pi-tool-adapter.ts` — Baizer tool → pi `AgentTool`
- `src/runtime/pi/pi-event-adapter.ts` — pi event → `StreamEvent`
- `src/runtime/pi/pi-approval-policy.ts` — approval detection
- `src/runtime/steering-controller.ts` — mid-run steering
- `src/runtime/pi/harness-session-manager.ts` — JSONL sessions + compaction
- `src/runtime/provider-capabilities.ts` — declared per-provider capabilities
