# Runtime Architecture

## Overview

The runtime boundary separates UI-facing model management from turn execution.

- `ModelService` owns provider lifecycle, settings changes, memory flushing, and shell-facing helper methods.
- `ChatRuntime` owns prompt preparation, tool injection, tool-call loops, and stream execution.

This split keeps provider-specific execution details out of UI controllers and makes future runtime features easier to add.

## Main Flow

1. UI calls `ModelService.chat(...)` or `ModelService.chatStream(...)`.
2. `ModelService` creates a runtime through `createChatRuntime(...)`.
3. `ChatRuntime.prepareTurn(...)` builds:
   - memory context
   - formatted context items
   - selected text context
   - final user request prompt
   - active tool definitions
4. `ChatRuntime.query(...)` or `queryStream(...)` runs the provider chat session.
5. Tool calls are resolved through:
   - `ToolRegistry.execute(...)` for atomic tools
   - `SkillRegistry.activateSkill(...)` for `use_skill`
6. Results are recorded back into memory when enabled.

## Why This Boundary Exists

- Keeps `ModelService` from becoming a God object
- Makes provider adapters easier to extend
- Gives plan mode, approval handling, and future session behaviors a clear home
- Improves testability by letting runtime behavior be verified without full UI setup

## Files

- `src/services/model-service.ts`
- `src/runtime/chat-runtime.ts`
- `src/runtime/runtime-types.ts`
- `src/runtime/runtime-factory.ts`
- `src/runtime/provider-capabilities.ts`
