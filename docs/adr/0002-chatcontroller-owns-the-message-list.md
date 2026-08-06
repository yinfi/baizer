# 0002 — ChatController owns the message list; tab state holds a read-only projection

**Status:** Accepted
**Date:** 2026-07-31

## Context

A streamed AI reply was being created twice, independently:

- `ChatController.messages` — `src/ui/chat-controller.ts:242`
- `tab.state` (`ChatState.messages`) — `src/ui/shell-view.ts:1868`

Each generated its own `Date.now() + Math.random()` id, so the two ids never
matched. The action toolbar rendered from `tab.state`'s copy — deliberately, because
only that copy carries `sessionEntryId` — while the 👍/👎 handlers looked the id up
in `ChatController.messages` and returned silently on a miss. Thumbs-up (archive to
the knowledge wiki) and thumbs-down (improve and re-answer) were silent no-ops for
every streamed reply, which is nearly all of them.

Investigating ownership turned up a second divergence with a different cause. On
abort, `chat-controller.ts:262` emits a synthetic `done` event — so `ShellView`
creates its copy — but the `return` on the next line skips the record at `:249`
entirely. For an interrupted reply, `tab.state` has the message and
`ChatController.messages` does not.

So the two lists diverged in two ways: different ids in the normal case, and
different *contents* in the abort case.

Both stores are otherwise reasonable. `ChatState` is a clean per-tab container
(deep-copying getters, dirty tracking) that also holds tool run state, workspace
edits, and the streaming flag — none of which has ever had this problem, because
nothing else co-owns them.

## Decision

**`ChatController` owns the message list. `ChatState` keeps `messages` as a
read-only projection.**

Four consequences follow:

1. **`tab.state.messages` stays.** Persistence (`conversation-controller.ts:28`),
   the virtualised renderer (`renderActiveTabMessages`), and the `dirty` flag all
   read it. It is received, never authored.
2. **Recording and drawing are separated by a fact, not by two entry points.**
   `onMessageAdded(msg, { alreadyRendered })`. The host always writes the
   projection; it draws only when the message has not already reached the screen
   via stream events.
3. **`addMessage` gains an optional `extra` argument** carrying `sessionEntryId`,
   `metadata`, and `alreadyRendered`. The streaming path calls it instead of
   pushing directly, so `shell-view.ts:1868` can be deleted. 50 of the 51 existing
   call sites pass two arguments and need no change.
4. **The record moves ahead of the `done` event.** The toolbar renders during
   `done` handling, so the projection has to be populated before it fires.
   Verified safe: all three `yield { type: 'done' }` sites in
   `harness-chat-runtime.ts` (`:209`, `:221`, `:236`) are immediately followed by
   `return` or the end of the generator, so no `tool_result` can arrive after
   `done` and the write-outcome flags are already final.

## Consequences

**What we get.** One creation site. The ids cannot diverge because there is only
one. The abort path records through the same call as every other path, so the
contents cannot diverge either. Two user-visible features start working.

**What we accept.** "Read-only" is a convention, not a constraint — nothing stops
a future change from calling `tab.state.addMessage` directly, which is exactly how
this arose. That risk is mitigated by a test asserting the two lists hold the same
ids, not by the type system.

**Why not delete `messages` from `ChatState` outright.** This was the first
instinct and it was wrong. Auditing the call sites found:

- 19 direct call sites in `ShellView`
- Persistence reads `tab.state` from a *different module* (`history/`), so the
  change would spill outside the UI
- **The `dirty` flag has no other signal source.** `markDirty()` fires from
  `addMessage` / `updateMessage` / `removeMessage` / `clearMessages`. Remove
  messages and "this tab has unsaved conversation changes" loses its trigger —
  `tabs/tab.ts:20` and `conversation-controller.ts:53` both depend on it.
- Branch switching (`shell-view.ts:2135`) replaces the whole list, so
  `ChatController` would need a `replaceMessages()` that nothing else should ever
  call — a dangerous entry point added to the owner's interface
- 15 assertions in `chat-state.test.ts` would need rewriting

The root cause is not *that a second copy exists*. It is that **both copies were
authored independently**. Demoting the copy addresses the cause; deleting it would
have dismantled three working mechanisms to address a symptom.

**Where the seam actually is.** `ChatController` is created per tab
(`shell-view.ts:1813`, held in `tabSessions: Map<TabId, ShellTabSession>`), so the
owner/projection pairing is one-to-one. `ShellView.chatController` is only a mirror
of the active tab's instance (`:1785`). Two of the three `new ChatController` sites
are in `selection-menu.ts` and have **no tab at all** — they read `getMessages()`
to render their own small list. That constraint is why `ChatController` had to be
the owner: it is the only one of the two that every consumer can reach.

## Note for future readers

If you are wondering why `ChatState` exposes `addMessage` but `ShellView` is not
supposed to call it for AI replies: that method is how the projection *receives*
updates from the owner. Authoring a message anywhere other than
`ChatController.addMessage` re-creates the bug this ADR exists to close.

See [`CONTEXT.md`](../../CONTEXT.md) for **message projection** vs **branch
projection**, which are different things that share a word in the code.
