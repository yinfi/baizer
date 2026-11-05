# Settings Page Architecture

`src/settings.ts` is the largest single file in the plugin (~2,600 lines). This
document explains the one design decision that shapes all of it, the constraints
that follow from that decision, and what is still outstanding.

## The central constraint: partial re-render

The settings page originally updated itself by calling `this.display()`, which
does `containerEl.empty()` and rebuilds the entire page. That one decision was
the root cause of three separate user-visible defects:

- The search box lost focus on every keystroke, because the `<input>` being typed
  into was destroyed and rebuilt. Search was effectively unusable.
- Dragging a slider (font size, opacity, context window) rebuilt the whole page
  on every increment, wrote settings to disk dozens of times, and re-initialized
  the LLM client each time.
- Nested "advanced" blocks collapsed on every update, hiding required fields
  that had just appeared.

It is now split:

| Method | Responsibility |
|--------|----------------|
| `display()` | Builds the skeleton only: hero, search row, and an `accordionHost` container |
| `renderAccordion()` | Redraws just the accordion contents |

**If you are adding a settings control, call `renderAccordion()`, not
`display()`.** Calling `display()` from a change handler reintroduces the focus
loss and the slider thrash. There are ~33 handlers that were converted from one
to the other; matching them is the convention.

## Rendering is scheduled, never re-entrant

`renderAccordion()` only *requests* a repaint; the DOM work happens in
`renderAccordionNow()` / `renderAccordionContents()` via
`src/utils/render-scheduler.ts`. That scheduler:

- coalesces every request made in the same task into one repaint (microtask);
- never nests a repaint: a request made while rendering runs once after the
  current pass finishes;
- is cancelled by `hide()`, so a closed panel cannot be repainted afterwards.

This exists because several code paths request a repaint from inside a render —
`renderMemorySection()` triggers the first memory load, and the `<details>`
`toggle` handler used to rebuild the whole accordion from within the toggle
event. The old synchronous rebuilds emptied the container that was still being
built, produced detached nodes, and multiplied the work per interaction. On a
low-end mobile WebView that turns into multi-second main-thread tasks.

Two consequences worth knowing:

- Expanding a collapsed section no longer rebuilds the accordion. The toggle
  handler injects that one section's content in place.
- The first memory load is started before the section renders, so the current
  paint already shows "Loading memory..." instead of painting empty and then
  repainting for the loading state.

## Search is debounced and gated

The search box does not repaint per keystroke. Input is debounced by 150 ms, and
when it fires `applySearchRender()` compares the new match set with the sections
that are already on screen (`isSameSettingsSectionList()`). Typing more
characters that match the same sections does not repaint at all.

## Network work is cached, not repeated

- The model field (`renderModelField`) receives the last `AvailableModelsResult`
  from `SettingTab`'s cache keyed by endpoint identity
  (`getModelFieldCacheKey()`: provider + protocol + base URL + key prefix).
  Rerenders reuse it; only the "Refresh list" button forces a request. The
  underlying `ModelService` also coalesces concurrent in-flight requests, and
  `/models` calls carry a timeout (see `model-catalog-service.ts`).
- `KnowledgeStatusService.getGlobalCounts()` is cached with a 30 s TTL, shares
  one in-flight traversal, and traverses tracked notes in bounded batches. Only
  explicit knowledge actions (`Discover`, `Mark stale pending`) pass
  `forceFresh: true`. Counts can therefore be up to 30 s stale after a compile
  triggered elsewhere.
- The knowledge status line itself is also memoised for 5 s
  (`SettingTab.ontologyStatusCache`), so a section re-mount inside that window
  skips the schema read and readiness scan entirely; the 30 s service-level
  cache sits underneath it for the count traversal.

## Persistence has two paths

`saveSettings` distinguishes fields that require rebuilding the provider from
fields that are purely cosmetic:

- `saveSettings()` — full path. Runs cleanup, re-initializes the provider, and
  invalidates the model list cache **only for providers whose base URL or key
  actually changed**. Correct for provider, model, key, and context window
  changes.
- `saveSettingsLight()` — writes to disk only. Correct for appearance settings.
  Paired with `debouncedPersistLight` for sliders.

Getting this wrong is not a visual bug — routing a cosmetic slider through the
full path re-initializes the model client on every drag increment.

Debounced persistence has one honest boundary: text fields write about 400 ms
after the last keystroke. `hide()` flushes the pending write, and an open panel
also flushes on `visibilitychange` when the app goes to the background, so
normal close / app switch does not lose the edit. A hard process kill inside
that 400 ms window can still lose the last edit — no callback runs then.

## Expansion state

Three pieces of state survive a re-render, and all three have to be maintained
explicitly because the DOM is rebuilt:

- `openSectionIds` — which top-level accordion sections are open. On first open,
  `overview` and `connection` are expanded, so the page is not entirely
  collapsed.
- `openAdvanced` (via `trackAdvancedDetails()`) — nested `<details>` blocks, e.g.
  under permissions and ontology.
- Search matches auto-expand the sections they hit.

## Destructive actions need confirmation

Any irreversible control goes through `MemoryConfirmModal`. Current members of
that set: delete provider, clear memory, plugin-control toggle, Clear API Key,
Restore Default Prompt, and the permission presets that escalate privileges.

The rule to follow when adding a control: if a mis-click destroys something the
user cannot retype from memory, it needs the modal. Note that a permission
*preset* which silently enables `allowPluginControl` counts as escalation and
needs the same confirmation as the individual toggle.

## Accessibility invariants

- Async status containers (connection test, memory list, ontology status) carry
  `role="status"` / `role="alert"` with `aria-live`. Because the page rebuilds,
  these must keep existing across renders and only have their `textContent`
  updated — recreating the node defeats the announcement.
- The memory tabs use `role="tablist"` / `role="tab"` / `aria-selected`, with a
  non-colour selection indicator.
- Icons use `setIcon()` with `aria-hidden="true"`, not literal characters.
- `prefers-reduced-motion` covers `.baizer-settings-page *`.

## Styles live in `styles.css`

There was a period where the same class names existed in three places —
`styles.css` (flex version), a later grid override, and an inline "fallback"
string injected from `settings.ts` — with different values, so rendering depended
on insertion order. Some classes that actually rendered (`baizer-memory-*`,
`baizer-settings-task`) existed *only* in the injected string.

`styles.css` is now the single source. Do not reintroduce style definitions in
`settings.ts`.

## i18n

All user-facing strings go through `t()` (`src/i18n/`). Counted strings use
placeholder templates rather than concatenation. Note that LLM-facing prompts
stay in English — the `t()` rule is for UI text only.

## Known gaps

Deliberately outstanding, in rough priority order:

- No retry entry point when model loading fails; a "refresh models" button
  calling with `forceRefresh=true` is the fix.
- The `capture` section's description promises general capture but only three
  WeChat paths are implemented. Either narrow the name or finish it.
- `terminalFont` (`src/mcp/types.ts`) is a zombie setting: no UI, no consumer.
- `inline-note` without a tone renders as bare text; it needs a neutral
  container style.
- `getProviderListSummary` and `loadDynamicModelOptions` are dead code.

One thing that cannot be verified by the test suite: CSS visual regressions
require looking at the real Obsidian UI. The test suite covers settings *state*
(`test/settings-state.test.ts`), not appearance.
