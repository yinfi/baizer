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

## Persistence has two paths

`saveSettings` distinguishes fields that require rebuilding the provider from
fields that are purely cosmetic:

- `saveSettings()` — full path. Runs cleanup, re-initializes the provider, and
  clears the model list cache. Correct for provider, model, key, and context
  window changes.
- `saveSettingsLight()` — writes to disk only. Correct for appearance settings.
  Paired with `debouncedPersistLight` for sliders.

Getting this wrong is not a visual bug — routing a cosmetic slider through the
full path re-initializes the model client on every drag increment.

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
