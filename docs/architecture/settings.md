# Settings Page Architecture

`src/settings.ts` renders the plugin settings through Obsidian's **declarative
settings API** (`PluginSettingTab#getSettingDefinitions()`), available since
Obsidian **1.13.0** — which is also this plugin's `minAppVersion`. `display()` is
not implemented: on 1.13+ Obsidian ignores it whenever `getSettingDefinitions()`
returns a non-empty array (and the community scorecard's
`settings-tab/prefer-setting-definitions` rule requires the new API).

## Why declarative

Declarative settings buy three things the old imperative accordion could not:

- **Settings search.** Every definition is indexed by Obsidian's global settings
  search, so users can find "thinking level" or "API key" without knowing which
  page it lives on.
- **One persistence path.** `control` definitions read/write through the tab's
  `getControlValue` / `setControlValue`, and validation runs before the value is
  stored.
- **Native rendering.** Row layout, page navigation, back button, search UI and
  keyboard focus are Obsidian's, so the plugin stops hand-rolling them.

## Shape: one page per former section

`getSettingDefinitions()` returns (in order):

1. an optional `Needs attention` group — the replacement for the old
   "Overview" section; it lists missing API keys and overly broad permissions
   with the page that fixes them (`getSettingsOverviewActions`);
2. one `SettingDefinitionPage` per section: **Connection, Behavior, Memory,
   Permissions, Skills, Capture, Knowledge, Guardian, Appearance, Plugin
   Skills**. Page names/descriptions come from the existing
   `getSettingsSections()` metadata so i18n stays in one place.

The **Connection** page is a `type: 'list'` of provider sub-pages: add is a
modal (`AddProviderModal`), delete asks for confirmation, and each provider page
holds its own name / protocol / API type / Base URL / API key / model / custom
headers / connection test. Editing a provider no longer requires activating it
first; the provider page has an explicit "Use this provider" action.

## Storage adapter

`control.key` is not always a property name. The tab overrides both storage
methods:

| Key shape | Meaning |
|-----------|---------|
| `contextWindow`, `thinkingLevel`, … | direct `plugin.settings[key]` |
| `provider.<id>.<field>` | one field of `plugin.settings.providers[id]` |
| `skill.<name>` | inverted into `disabledSkills` (the denylist) |
| `knowledgeSourceFolders`, `vaultWriteAllowedFolders`, `pluginSkillExcludeList` | newline/comma text ⇄ `string[]` |

`setControlValue` keeps the pre-existing persistence semantics instead of the
framework's default `saveData()`:

- plain toggles/dropdowns → `saveSettings()` (rebuilds provider/guardian/
  knowledge);
- text fields and sliders → 400 ms debounce around `saveSettings()`
  (`debouncedPersist`), because re-initializing the LLM client per keystroke or
  per slider step is what made the old page freeze on mobile;
- appearance fields (`terminalTheme/FontSize/Opacity`) → `saveSettingsLight()`,
  which only writes `data.json`;
- `language` → `plugin.applyLanguageChange()` and a full `update()` so every
  page re-renders in the new locale.

`hide()` flushes both debouncers, and an open tab also flushes on
`visibilitychange` before the mobile WebView can be suspended. A hard process
kill inside the 400 ms window can still lose the last edit — no callback runs
then.

## When a page/row is not declarative

The framework cannot express async or stateful widgets, so these stay imperative
and the docs' guidance is followed (only as much as needed):

- **`render` rows** — provider API key (masked input + Reveal/Clear), model
  field (`renderModelField`), custom headers (multi-line editor with per-line
  validation feedback), connection test (probe + `role="status"` result),
  ontology status line, effective-permissions summary, derived plugin-skill
  rows, and the two toggles that must confirm before changing
  (`allowPluginControl`, `confirmExecutions`).
- **`SettingPage` subclass** — `MemoryBrowserPage`: memory data is an async
  list with search/tabs/delete, so the memory *settings* are declarative on the
  Memory page and the browser lives behind a nested page entry.

Both are documented limitations for search: rows/pages rendered imperatively are
not indexed by the global settings search. That is why every provider page and
every important action still carries a declarative name/description (and why the
memory page entry exists) — the entry is searchable even though its content is
not.

## Network and status work is cached

- `renderModelField` receives the last `AvailableModelsResult` from
  `SettingTab.modelFieldCache`, keyed by endpoint identity
  (`getModelFieldCacheKey`: provider + protocol + base URL + key prefix). Only
  the "Refresh list" button forces a new `/models` request.
- Non-active provider pages list models through
  `model-catalog-service.listModels(config)` rather than the active provider's
  `ModelService` loader.
- `KnowledgeStatusService.getGlobalCounts()` has a 30 s TTL, and the ontology
  status line adds a 5 s DOM-level cache (`ontologyStatusCache`) so reopening
  the Knowledge page does not traverse the vault again.

## Destructive actions need confirmation

Irreversible controls go through `MemoryConfirmModal`: delete provider, delete
memory record, clear all memory, clear API key, restore the default system
prompt, delete a generated plugin skill, the plugin-control toggle, turning off
execution confirmation, and the two permission presets that escalate privileges
(`open`, `automation`). Toggles that need a confirm use a `render` row so the
switch can be reverted when the modal is cancelled.

## Layout: stacked rows

Declarative rows place their control in a narrow right-hand column. Long Base
URLs, multi-line custom headers and the model picker need the full row width, so
those `render` callbacks add `baizer-setting-stacked` to the row. The rules live
in **both** `styles.css` and the fallback sheet in `src/settings.ts`:

- `styles.css` is the normal path;
- the fallback sheet is injected by `ensureSettingsFallbackStyles()` and covers
  the settings tab when it renders in Obsidian's separate popout settings
  window, where the plugin stylesheet has historically not been applied.

Keep the two copies in sync when touching settings CSS.

## Visual evidence

The declarative UI is captured with
`node tools/declarative-settings-shots/capture.mjs` (before/after pairs of the
pre-migration accordion use `tools/provider-settings-shots/capture.mjs`). Both
harnesses launch a real Obsidian with `--remote-debugging-port` and capture the
renderer over CDP; see their READMEs for options, report fields and known
limitations.

## i18n

All user-facing strings go through `t()` (`src/i18n/`). Counted strings use
placeholder templates rather than concatenation. LLM-facing prompts stay in
English — the `t()` rule is for UI text only. New page names/descriptions reuse
the existing `getSettingsSections()` keys; new action/description strings were
added to `zh-messages.ts` in the same change.

## Known gaps

- The memory browser, provider rows and derived-skill rows are not indexed by
  the global settings search (see above).
- Page entries cannot show a status badge yet: `displayValue` / `status` on
  `SettingDefinitionPage` require Obsidian 1.13.1 and this plugin declares
  1.13.0. The `Needs attention` group and the provider page descriptions cover
  the common cases.
- `terminalFont` (`src/mcp/types.ts`) is still a zombie setting: no UI, no
  consumer.
- CSS visual regressions cannot be asserted in Node; they are covered by the
  screenshot harnesses above, not by `npm test`.
