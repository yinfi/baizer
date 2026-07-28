# Permissions And Approvals

## Settings Gates

Sensitive behavior is controlled by six settings, declared in `src/mcp/types.ts`:

**What kind of operation is allowed**

- `allowFileCreation` — may new files be created at all
- `allowFileModification` — may existing files be changed at all
- `allowPluginControl` — may other Obsidian plugins be inspected and driven (off by default)
- `confirmExecutions` — do risky actions become approval requests

**Where writes may land**

- `vaultWriteScope` — `read-only` | `current-note` | `configured-folders` | `all-vault` (default `all-vault`)
- `vaultWriteAllowedFolders` — the folder list consulted when scope is `configured-folders`

Scope and capability are **orthogonal**: a write must satisfy both. "Is this
path writable?" and "is this kind of edit permitted?" are separate questions,
answered by `checkWriteScope` and `checkFileCapability` respectively.

`.obsidian` is always blocked no matter the scope — that is enforced in the
vault-ops layer, not by these settings.

All six feed pure functions in `src/permissions/permission-service.ts`; policy
comes only from settings, never hardcoded.

## Tool-Level Enforcement

Write and privileged tools should enforce permission checks inside the tool layer.

Examples:

- `create_note` checks `allowFileCreation`
- `update_note`, `append_to_note`, `delete_note`, `rename_note` check `allowFileModification`
- plugin control tools check `allowPluginControl`

## Two-Tier Write Model

Not every write goes through pre-execution approval. Writes are split into two
tiers **by design**, so the common, low-risk edits stay low-friction while the
irreversible ones stay gated:

| Tier | Tools | Behavior under `confirmExecutions: true` |
|------|-------|-------------------------------------------|
| Direct-apply + undo | `create_note`, `update_note`, `append_to_note`, `create_file`, `update_file`, `save_webpage` | Applied **immediately**, then recorded as an undoable `WorkspaceEdit`. Pre-execution approval is intentionally skipped. |
| Pre-approval | `delete_note`, `rename_note`, plugin control | Return `approval_required`; nothing happens until the user approves. |

The direct-apply tier is routed through `WorkspaceEditService.executeWorkspaceTool`,
which injects `approved: true` before calling the tool — this is what bypasses the
tool-layer `needsApproval('write')` check. The safety guarantee for this tier is
**reversibility (undo)**, not prior confirmation. `delete_note` / `rename_note` are
deliberately excluded from the direct-apply set because they are hard to reverse,
so they fall back to the approval flow below.

> Consequence: with `confirmExecutions` on, `create/update/append` writes still land
> without a confirmation card. That is the intended trade-off (undo replaces the
> prompt), not a gap. See `isDirectApplyWorkspaceTool` in `workspace-edit-service.ts`.

## Approval Flow (Pre-approval tier)

When a pre-approval tool is called under `confirmExecutions`:

1. The tool does not execute immediately.
2. It returns a structured object with:
   - `approval_required`
   - `action`
   - `target`
   - `args`
   - `message`
3. `ChatController` converts that into an approval message.
4. `ShellView` renders an approval card.
5. On approval, `ModelService.executeApprovedAction(...)` replays the tool call with `approved: true`.
6. The real execution outcome is appended back into the conversation's pi session
   (as a `custom_message` entry) so the next model turn sees that the action was
   approved and what it produced — the session, not the UI history, is the
   cross-turn source of truth.

## Design Rule

Approval logic should be consistent:

- tools decide whether approval is required
- UI decides how approval is rendered
- approved actions re-enter through a single replay path

Avoid duplicating permission logic in multiple UI surfaces.
