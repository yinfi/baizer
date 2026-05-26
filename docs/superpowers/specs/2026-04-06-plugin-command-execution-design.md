# Plugin Command Execution Recovery Design

**Date:** 2026-04-06
**Project:** `baizer`
**Status:** Approved design, pending implementation plan

## Goal

Restore the ability for the plugin's AI tool layer to execute commands from other Obsidian plugins while keeping the tool surface small, explicit, and consistent with the current codebase.

## Problem Statement

The repository currently claims that the AI can orchestrate other Obsidian plugins, but the runtime tool layer only exposes plugin listing, plugin command listing, and plugin settings lookup. The older execution-oriented API shape is still referenced by tests and repository narratives, while the current runtime implementation in `src/mcp/tools.ts` no longer provides a command execution tool.

That creates three concrete problems:

1. The plugin no longer delivers a user-facing capability that the project still describes as core behavior.
2. Tests and product messaging have drifted away from the current implementation.
3. There is no single, explicit contract for how plugin control should behave under permission restrictions and failure scenarios.

## Current Context

The existing plugin-control surface already lives in `src/mcp/tools.ts`:

- `list_plugins`
- `get_plugin_commands`
- `get_plugin_settings`

Those tools are gated by `allowPluginControl` from `src/mcp/types.ts` and configured in `src/settings.ts`.

The runtime already has direct access to Obsidian's command registry through `app.commands.listCommands()` and `app.commands.executeCommandById(...)`, so restoring command execution does not require a new subsystem or a new service layer. The missing pieces are:

- a first-class `execute_command` tool definition and implementation branch in `src/mcp/tools.ts`
- correct propagation of built-in tool definitions into normal chat sessions, including memory-backed sessions created through `src/services/model-service.ts` and `src/memory/memory-manager.ts`

## Decision Summary

The implementation will restore command execution as a formal built-in tool named `execute_command`.

This recovery will use a single official API surface:

- `list_plugins`
- `get_plugin_commands`
- `get_plugin_settings`
- `execute_command`

The design does **not** preserve the older `list_available_commands` tool name or any other deprecated plugin-control alias. Tests and documentation will be updated to align with the new official contract.

Discovery and execution semantics are intentionally aligned:

- `get_plugin_commands` only returns commands for enabled plugins
- if a plugin is installed but disabled, `get_plugin_commands` returns an explicit non-executable result
- `execute_command` only executes commands that are discoverable under those same enabled-plugin rules

Canonical `get_plugin_commands` response shapes:

- enabled plugin with commands:

```json
{
  "pluginId": "obsidian-kanban",
  "enabled": true,
  "commands": [{ "id": "obsidian-kanban:create-new-board", "name": "Create new board" }],
  "count": 1
}
```

- enabled plugin with zero commands:

```json
{
  "pluginId": "some-plugin",
  "enabled": true,
  "commands": [],
  "count": 0
}
```

- installed but disabled plugin:

```json
{
  "pluginId": "dataview",
  "enabled": false,
  "commands": [],
  "count": 0,
  "error_code": "plugin_disabled",
  "error": "Plugin is not enabled"
}
```

- unknown plugin:

```json
{
  "pluginId": "missing-plugin",
  "enabled": false,
  "commands": [],
  "count": 0,
  "error_code": "plugin_not_found",
  "error": "Plugin not found"
}
```

## Why This Approach

Three approaches were considered:

### Approach A: Restore execution and keep old aliases

This would bring back `execute_command` and also preserve older names such as `list_available_commands`.

Why not chosen:

- It keeps two API vocabularies alive for one feature.
- It increases maintenance cost without adding user value.
- It makes the tool layer harder to document and test cleanly.

### Approach B: Restore execution with one official API surface

This adds `execute_command` to the current runtime tool set and treats the existing current naming as canonical.

Why chosen:

- Smallest implementation that restores the missing capability.
- Fits the existing `ToolManager` architecture.
- Gives tests and docs one contract to target.
- Avoids carrying legacy names indefinitely.

### Approach C: Avoid tool-level execution and handle command execution elsewhere

This would move plugin command execution into shell commands or a model prompt convention instead of a formal tool.

Why not chosen:

- It would be more implicit and less testable.
- It would bypass the existing built-in tool contract.
- It would make permissions and structured results harder to reason about.

## Functional Requirements

### 1. Tool Availability

`src/mcp/tools.ts` must expose a built-in tool named `execute_command` whenever plugin control is enabled in settings.

The tool must:

- accept a required `id` string parameter
- describe itself as executing an Obsidian command ID
- appear alongside the existing plugin-control tools

When `allowPluginControl` is disabled, `execute_command` is hidden from `getToolsDefinitions()`. If it is invoked directly anyway, `ToolManager.execute(...)` must still return a structured permission-denied result as a defensive runtime contract.

### 2. Runtime Behavior

When `ToolManager.execute('execute_command', { id })` is called:

1. The tool manager checks `allowPluginControl`.
2. If plugin control is disabled, it returns a permission error result instead of executing anything.
3. If plugin control is enabled, it validates that `id` belongs to an enabled non-core plugin command.
4. Concretely, validation requires both of these conditions:
   - the command ID starts with an enabled plugin manifest ID plus `:`
   - the exact command ID exists in `app.commands.listCommands()`
5. If validation passes, it calls `app.commands.executeCommandById(id)`.
6. It returns a structured result payload.

This design intentionally limits execution to commands from other plugins. Core Obsidian commands such as `editor:*`, `app:*`, or any command not tied to an installed plugin manifest are out of scope for this recovery.

### 3. Result Shape

The execution result must be structured and stable.

Minimum success shape:

```json
{
  "success": true,
  "command_id": "plugin-id:command-name",
  "message": "Executed command: plugin-id:command-name"
}
```

Minimum failure shape:

```json
{
  "success": false,
  "command_id": "plugin-id:command-name",
  "error_code": "permission_denied",
  "error": "Reason for failure"
}
```

For validation failures where a usable command ID does not exist, the failure shape must still stay uniform:

```json
{
  "success": false,
  "command_id": null,
  "error_code": "missing_command_id",
  "error": "Command ID is required"
}
```

`execute_command` should always use the same result envelope on both success and failure. It should not mix plain `{ error: ... }` responses with `{ success: false, ... }` responses.

For permission-denied results, `command_id` should echo the provided ID when a non-empty string was supplied, otherwise `null`.

The same rule applies to all invalid-but-supplied IDs. If the caller supplied a non-empty string such as `editor:toggle-bold` or `fake-plugin:missing`, the failure payload must echo that exact string in `command_id`. `command_id` is `null` only when the input was missing, empty, or not a string.

Canonical failure codes for `execute_command` are:

- `permission_denied`
- `missing_command_id`
- `not_plugin_command`
- `plugin_disabled`
- `command_not_found`
- `execution_failed`
- `execution_error`

Canonical failure messages should be stable and human-readable, for example:

- `Permission denied`
- `Command ID is required`
- `Command is not owned by an enabled plugin`
- `Plugin is not enabled`
- `Command not found`
- `Command could not be executed`

Thrown execution errors must still use the same full failure envelope, for example:

```json
{
  "success": false,
  "command_id": "plugin-id:command-name",
  "error_code": "execution_error",
  "error": "Original error message"
}
```

Decision table for `execute_command` failures:

| Input class | `command_id` | `error_code` | `error` |
|-------------|--------------|--------------|---------|
| missing / empty / non-string | `null` | `missing_command_id` | `Command ID is required` |
| core command such as `editor:*` | echoed input | `not_plugin_command` | `Command is not owned by an enabled plugin` |
| unknown prefix such as `fake-plugin:*` | echoed input | `not_plugin_command` | `Command is not owned by an enabled plugin` |
| installed but disabled plugin command | echoed input | `plugin_disabled` | `Plugin is not enabled` |
| enabled plugin prefix but exact command missing | echoed input | `command_not_found` | `Command not found` |
| `executeCommandById(...)` returns `false` | echoed input | `execution_failed` | `Command could not be executed` |
| `executeCommandById(...)` throws | echoed input when available, otherwise `null` | `execution_error` | thrown message or fallback text |

### 4. Failure Cases

The implementation must explicitly handle:

- plugin control disabled
- missing or empty command ID
- command ID that is not owned by an installed plugin
- command ID for a plugin that is installed but not enabled
- command ID with a valid plugin prefix but no exact match in `app.commands.listCommands()`
- `executeCommandById` returning `false`
- `executeCommandById` throwing

When `execute_command` is invoked directly while plugin control is disabled, it must still return the structured permission-denied result for that tool. It should not degrade to `Unknown tool`.

Failure precedence is explicit:

1. permission gate
2. missing or empty ID
3. plugin ownership and enabled-state validation
4. command existence validation
5. runtime execution failure

### 5. Scope Boundaries

This change restores only built-in tool execution of Obsidian commands.

This change does **not** include:

- interactive human confirmation flow for `confirmExecutions`
- a new global command-search tool
- UI redesign for plugin command execution
- changes to MCP transport architecture

## Non-Functional Requirements

### Consistency

The plugin-control tools should remain defined and implemented in one file, `src/mcp/tools.ts`, because that is already the current system boundary for built-in tools.

### Minimal Surface Area

No new service or controller layer should be introduced for plugin command execution. The existing `ToolManager` owns this responsibility.

### Testability

The behavior must be verifiable using current test doubles for `app.commands`.

### Backward Clarity

Repository docs and tests should clearly target the restored official tool contract and stop referencing older names that are no longer part of the runtime surface.

## Architecture

### Unit 1: Built-In Tool Definition

**Location:** `src/mcp/tools.ts`

Responsibility:

- add the `execute_command` tool definition to the built-in tool list when plugin control is allowed

Interface:

- input: `{ id: string }`
- output: tool declaration included in `getToolsDefinitions()`

Boundary:

- definition only
- no execution logic outside the switch branch

### Unit 2: Built-In Tool Execution

**Location:** `src/mcp/tools.ts`

Responsibility:

- implement the runtime branch for `execute_command`
- enforce plugin-control permission gate
- normalize success and failure results

Interface:

- input: tool name `execute_command` and args object with `id`
- output: structured execution result

Boundary:

- no chat orchestration logic
- no direct UI concerns

### Unit 3: Tool Exposure In Chat Sessions

**Locations:**

- `src/services/model-service.ts`
- `src/memory/memory-manager.ts`

Responsibility:

- ensure normal model sessions receive the current built-in tool definitions, including `execute_command`
- preserve the existing memory-backed chat behavior while removing any path where a session starts without tool declarations

Boundary:

- no new provider abstraction
- no new memory subsystem
- only the wiring needed so restored tools are actually visible to live chat flows

Ownership and interface rule:

- `ModelService` owns the current tool-definition list
- `MemoryManager` must accept built-in tool definitions when creating or refreshing a session
- this guarantee applies only to built-in tools required for the restored feature; dynamic MCP tool parity is out of scope for this recovery
- the implementation must make it impossible for the memory-backed chat path to reuse a session that was created without the current built-in tool declarations
- `ModelService` computes a concrete `toolsVersion` value from the current built-in tool definitions relevant to this feature
- `MemoryManager` stores the last `toolsVersion` used to create the cached session
- a memory-backed session must be recreated when the provider changes, when `toolsVersion` changes, or when the cached session predates the restored tool wiring

### Unit 4: Contract Verification

**Locations:**

- `test/mcp-integration.test.ts`
- `test/plugin-tools.test.ts`
- `test/plugin-control.contract.js`

Responsibility:

- verify the new official tool name appears where expected
- verify permission-denied behavior
- verify successful execution behavior
- verify failure behavior
- provide one authoritative executable runtime contract test entrypoint

Boundary:

- tests target the tool contract
- tests do not redesign plugin-control semantics

Conditional cleanup:

- `test/functional-test.ts`
- `test/functional-test.js`

These files are not the authoritative acceptance runner for this feature. If they still make deprecated command-execution claims, they should either be aligned to the restored contract or have those stale assertions removed.

### Unit 5: Documentation Alignment

**Location:** `README.md`

Additional in-scope files:

- `src/mcp/types.ts`
- `src/settings.ts`

Responsibility:

- align the feature description with the restored runtime capability
- remove outdated references to deprecated tool names if they appear in docs
- align model-facing prompt guidance and user-facing settings copy with the same runtime contract

Boundary:

- copy and prompt-text alignment only
- no new runtime behavior beyond wording and prompt-content updates needed to match the restored contract

Prompt alignment rule:

- the default prompt text in `src/mcp/types.ts` must not instruct the model to use plugin-control tools when those tools are unavailable
- the implementation may achieve this either by neutralizing the static default prompt or by conditionally adding plugin-control guidance only when `allowPluginControl` is enabled
- after this change, prompt behavior and runtime tool availability must not contradict each other

## Runtime Data Flow

1. The model receives tool definitions from `ToolManager`.
2. `ModelService` must ensure those tool definitions are passed into whichever chat session path is active, including memory-backed sessions.
3. The model decides to invoke `execute_command`.
4. `ModelService` routes the tool call into `ToolManager.execute(...)`.
5. `ToolManager` checks `allowPluginControl`.
6. `ToolManager` invokes `app.commands.executeCommandById(id)`.
7. `ToolManager` returns a structured payload to the model.
8. The model uses that payload to continue or finish the response.

## Permissions Model

`allowPluginControl` remains the only enforced runtime guard for plugin command execution in this change.

`confirmExecutions` already exists in settings, but this design intentionally does not wire it into an interactive approval flow yet. The reason is scope control: the missing feature is command execution itself, while a general confirmation framework is a separate, broader product behavior.

This means the repository should not claim that plugin command execution is confirmation-gated until a real confirmation mechanism exists.

Because this affects user-visible product expectations, the settings copy in `src/settings.ts` is in scope for alignment wherever it currently implies confirmation-gated command execution.

The target wording rule is:

- `confirmExecutions` may remain visible as a setting
- its copy must not claim that plugin command execution is currently protected by an implemented confirmation workflow
- its copy may describe itself as a future-facing or partially implemented confirmation control, but it must not promise behavior the runtime does not enforce

## Error Handling

The tool must never rely on uncaught exceptions as the public contract.

Required behaviors:

- missing `id` returns a structured failure
- disabled permission returns `Permission denied`
- non-plugin or unknown command IDs return a structured failure
- false return from `executeCommandById` returns a structured failure indicating the command could not be executed
- thrown errors are caught and mapped to `error: <message>`

## Testing Strategy

### Primary Tests

Update `test/mcp-integration.test.ts` to verify:

- the built-in tool definitions include `execute_command` when plugin control is enabled
- the built-in tool definitions omit `execute_command` when plugin control is disabled
- `execute_command` succeeds when `executeCommandById` returns true
- `execute_command` returns permission denied when plugin control is disabled
- `execute_command` rejects non-plugin command IDs such as `editor:toggle-bold`
- `execute_command` rejects IDs with a valid plugin prefix but no exact command match
- `execute_command` rejects commands for disabled plugins
- `execute_command` returns structured failure when execution fails

Update `test/plugin-tools.test.ts` to verify:

- plugin command discovery still works
- command execution result shape is stable and explicit
- `get_plugin_commands` follows the canonical response matrix for enabled, disabled, unknown, and zero-command plugin cases

Create or update `test/plugin-control.contract.js` as the authoritative executable feature-contract test for:

- discovery behavior when plugin control is on and off
- successful plugin command execution
- stable error envelope and `error_code` values
- live-chat tool exposure wiring after the session-creation fix

Update `test/functional-test.ts` and `test/functional-test.js` only as conditional cleanup if they still reference deprecated plugin-control tool names or outdated constructor contracts.

The test fixtures and mocks are expected to include:

- `app.plugins.manifests`
- `app.plugins.enabledPlugins`
- `app.commands.listCommands()`
- `app.commands.executeCommandById(...)`

### Secondary Validation

The implementation must provide feature-scoped verification commands so this recovery is not blocked by unrelated repository-wide test debt.

The blocking executable acceptance endpoints for this feature are:

- `npm run typecheck:plugin-control`
- `npm run test:plugin-control`

`npm run test:plugin-control` must run the single authoritative runtime contract test entrypoint for this feature.

`npm run typecheck:plugin-control` must typecheck the files and wiring directly affected by this feature rather than relying on unrelated repo-wide failures.

If the repository does not already have these scripts, adding them and wiring them to focused feature checks is in scope.

## Documentation Strategy

`README.md` should describe plugin orchestration in terms that are true after this work:

- the AI can inspect plugins and their commands
- the AI can execute enabled plugin command IDs when plugin control is enabled

The README should not mention deprecated tool names or imply a confirmation flow that does not exist.

`src/mcp/types.ts` system-prompt guidance is also in scope for alignment if it still describes an outdated command-execution contract.

`src/settings.ts` is also in scope for alignment if the settings copy still implies universal confirmation behavior for command execution.

Any repository guidance file that directly describes plugin command execution behavior is conditionally in scope for wording alignment if it contradicts the restored contract.

## Risks

### Risk 1: Tool contract drift continues

Mitigation:

- treat `execute_command` as the single official execution entry point
- update tests and README in the same change

### Risk 2: Permission behavior remains ambiguous

Mitigation:

- keep the gate explicit in `ToolManager`
- keep docs honest about `allowPluginControl`

### Risk 3: Scope grows into a broader confirmation framework

Mitigation:

- explicitly defer `confirmExecutions` integration
- keep this work focused on restoring runtime capability

## Success Criteria

- `execute_command` is defined as a built-in tool in `src/mcp/tools.ts`
- `execute_command` successfully executes Obsidian commands through `app.commands.executeCommandById(...)`
- plugin-control permission gating applies to command execution
- tests cover success and failure behavior for the restored tool
- README matches the final supported behavior

## Out Of Scope

- global command-search alias restoration
- deprecated plugin-control tool name compatibility
- confirmation dialogs or approval workflows
- refactoring MCP integration
- broader cleanup of unrelated stale tests
