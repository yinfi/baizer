# Pi Runtime Refactor Design

## Goal

Introduce Pi as Baizer's underlying agent runtime while preserving the existing Obsidian-facing APIs, approval model, provider abstractions, and UI event contracts.

The first implementation must be reversible. Baizer should be able to run either the current legacy runtime or the Pi-backed runtime behind the same `ChatRuntime` interface while compatibility, bundle size, and Obsidian runtime behavior are verified.

## Context

Baizer currently owns a custom agent loop in `src/runtime/chat-runtime.ts`. That loop prepares prompts, scopes tools by active skill, executes tool calls, stops on approval requests, tracks write success, applies generation quality checks, retains memory, and emits streaming events for the shell UI.

Pi provides a more complete agent runtime with event streaming, configurable tool execution, pre/post tool hooks, abort support, queued steering and follow-up messages, and session/context utilities. These features map well to Baizer's long-term direction as an Obsidian workbench, but Pi also brings compatibility risks because the published package requires a recent Node engine and depends on a broader provider SDK layer.

## Non-Goals

- Do not replace Baizer's model providers in the first pass.
- Do not introduce Pi coding-agent tools or CLI behavior.
- Do not bypass Baizer's vault permission checks, approval cards, or operation audit log.
- Do not rewrite shell UI, Guardian, knowledge compiler, or skill registration as part of the initial integration.
- Do not make Pi the only runtime until tests and an Obsidian build confirm compatibility.

## Architecture

The integration will use an adapter-first design.

`ModelService` will continue to call `createChatRuntime(...)`. `runtime-factory` will decide whether to construct the legacy `DefaultChatRuntime` or a new Pi-backed implementation. Both implementations must satisfy the same `ChatRuntime` interface from `src/runtime/runtime-types.ts`.

New Pi-specific code should live under `src/runtime/pi/`:

- `pi-chat-runtime.ts`: implements Baizer's `ChatRuntime` interface using Pi.
- `pi-tool-adapter.ts`: adapts Baizer tools and registries into Pi agent tools.
- `pi-message-adapter.ts`: converts prepared Baizer prompts and provider messages into Pi-compatible agent messages.
- `pi-event-adapter.ts`: maps Pi events into Baizer `StreamEvent` objects.
- `pi-approval-policy.ts`: centralizes approval-stop and write-failure behavior for Pi tool results.

The existing `DefaultChatRuntime` remains available as the rollback path.

## Runtime Selection

Runtime selection should start as an internal feature flag rather than a user-visible setting.

The first implementation should support:

```ts
type RuntimeEngine = 'legacy' | 'pi';
```

The selected engine may initially be controlled by a small internal constant or environment-style helper in `runtime-factory.ts`. A user-facing setting should be proposed in a separate settings-design change only after the Pi runtime passes the compatibility spike and behavior parity tests.

Default behavior should remain `legacy` until the Pi compatibility spike passes.

## Tool Scheduling

Baizer tools should gain optional scheduling metadata without requiring every tool to change immediately.

Proposed additions to `Tool`:

```ts
executionMode?: 'parallel' | 'sequential';
timeoutMs?: number;
risk?: 'read' | 'write' | 'plugin-control' | 'network' | 'unknown';
```

Default behavior should be conservative:

- Read/search/query tools can run in parallel when explicitly marked or inferred as safe.
- Vault write tools must run sequentially.
- Plugin-control tools must run sequentially.
- Approval-producing tools must terminate the Pi loop before any model success claim.
- Unknown tools should default to sequential until classified.

The adapter should also preserve active skill scoping. If a skill is active, a tool outside the active skill's allowed set must return the same style of error as the legacy runtime.

## Approval And Safety

Approval remains owned by Baizer.

When a tool result contains `approval_required: true`, the Pi adapter should:

- emit a Baizer `tool_result` event with the original approval payload,
- prevent any follow-up LLM call that could claim success,
- complete the stream with an empty `done.text`,
- retain the approval message in memory consistently with the legacy runtime.

Approved actions must still replay through `ModelService.executeApprovedAction(...)`, not through Pi.

Workspace write tools should continue to route through `WorkspaceEditService` where the legacy runtime already does this. The Pi adapter must not directly write to the vault except through the existing registered Baizer tools and workspace edit service.

## Event Mapping

Pi events should be translated into existing Baizer stream events so `ChatController`, `ShellView`, `ThinkingRenderer`, and `ToolRenderer` need minimal initial changes.

Mapping:

- Pi text delta -> Baizer `text_delta`
- Pi thinking delta -> Baizer `thinking`
- Pi tool execution start -> Baizer `tool_call`
- Pi tool execution end -> Baizer `tool_result`
- Pi agent end -> Baizer `done`
- Pi provider or tool error -> Baizer `error` or tool result error, depending on phase

The adapter should preserve provider tool call IDs when available.

## Provider Boundary

The first Pi integration should avoid replacing Baizer's `IModelProvider` implementations. Baizer already handles Gemini and OpenAI-compatible providers, provider capabilities, model listing, and Obsidian-specific configuration.

If Pi requires its own model abstraction for the loop, the adapter should use a thin bridge that delegates actual generation and streaming to Baizer's current provider/session API. Replacing providers with Pi's `@earendil-works/pi-ai` is out of scope for this branch and should require a separate provider-boundary design if bundle size and provider behavior prove acceptable.

## Compatibility Spike

Before wiring production behavior, run a spike:

1. Add the minimal Pi dependency.
2. Build with esbuild.
3. Run the maintained test harness.
4. Inspect generated bundle size and dependency graph.
5. Confirm no Node-only APIs are pulled into production plugin code in a way that breaks Obsidian or mobile assumptions.

If the spike fails because Pi's published package is not compatible with the plugin environment, fall back to implementing a local Pi-inspired scheduler without the dependency.

## Testing Strategy

Existing behavior must remain protected by the current tests:

- `test/chat-runtime.test.ts`
- `test/chat-controller.test.ts`
- `test/approval-flow.test.ts`
- `test/model-service.test.ts`
- `test/openai-provider.test.ts`
- `test/workspace-edit-service.test.ts`

New tests should cover:

- Runtime factory can select legacy or Pi runtime.
- Pi runtime emits the same Baizer `StreamEvent` sequence for normal text, tool calls, approval stops, and errors.
- Vault write tools execute sequentially.
- Safe read tools can execute in parallel.
- Active skill tool scope is enforced.
- Approval results terminate before a follow-up success claim.
- Abort signals reach the Pi loop and adapted tools.
- Write-request failure messages match legacy behavior.

## Rollout

Phase 0: Pi compatibility spike.

Phase 1: Add runtime selection and a Pi runtime skeleton that delegates to legacy behavior or covers a no-tool text turn.

Phase 2: Adapt tool definitions and execute simple read tools through Pi.

Phase 3: Add sequential write-tool handling, approval termination, and workspace edit routing.

Phase 4: Switch streaming turns through Pi and map Pi events to Baizer stream events.

Phase 5: Run full tests, build, and compare legacy/Pi behavior on representative chat, skill, approval, and file-write flows.

Phase 6: Consider advanced Pi features such as steering, follow-up queues, and context transforms after the replacement is stable.

## Open Decisions

- Whether Pi can be used as a production dependency in the Obsidian plugin environment.
- Whether runtime selection should become a visible setting after the branch stabilizes.
- Whether provider replacement with `@earendil-works/pi-ai` is worthwhile after this branch proves the runtime adapter stable.

## Success Criteria

- `npm test` passes.
- `npm run build` passes.
- Legacy runtime still works.
- Pi runtime can be enabled without changing UI code.
- Approval, vault permission, and audit behavior remain equivalent to legacy behavior.
- The branch can be rolled back by switching the runtime engine to `legacy`.
