# Permissions And Approvals

## Settings Gates

Sensitive behavior is controlled by four settings:

- `allowFileCreation`
- `allowFileModification`
- `allowPluginControl`
- `confirmExecutions`

## Tool-Level Enforcement

Write and privileged tools should enforce permission checks inside the tool layer.

Examples:

- `create_note` checks `allowFileCreation`
- `update_note`, `append_to_note`, `delete_note`, `rename_note` check `allowFileModification`
- plugin control tools check `allowPluginControl`

## Approval Flow

When `confirmExecutions` is enabled:

1. Tools do not execute immediately.
2. They return a structured object with:
   - `approval_required`
   - `action`
   - `target`
   - `args`
   - `message`
3. `ChatController` converts that into an approval message.
4. `ShellView` renders an approval card.
5. On approval, `ModelService.executeApprovedAction(...)` replays the tool call with `approved: true`.

## Design Rule

Approval logic should be consistent:

- tools decide whether approval is required
- UI decides how approval is rendered
- approved actions re-enter through a single replay path

Avoid duplicating permission logic in multiple UI surfaces.
