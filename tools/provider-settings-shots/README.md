# provider-settings-shots

A repeatable harness that captures the Baizer **provider settings panel** out of a
real, running Obsidian — plus a machine-readable layout report measured from the
same DOM state — so that "before" and "after" screenshots are comparable and the
layout requirements can be checked without a human looking at pixels.

This is **not** a mock-up generator. Obsidian is launched with
`--remote-debugging-port`, the renderer is driven over CDP, and the PNG comes
from `Page.captureScreenshot`.

---

## Why it exists

The delivery requirements for the provider-settings work are:

* both **Before** and **After** visual evidence, clearly labelled, with the
  baseline and changed revision identified;
* captured from the **same scenario, viewport and theme**;
* **actual application captures** — not a mock-up presented as the previous
  implementation;
* no horizontal overflow, no overlapping controls, no value that can only be
  read while truncated, consistent label/value alignment.

A PNG cannot be asserted against, and the agent that produced these captures
cannot view images at all. So every criterion that can be expressed as a DOM
measurement is measured in the page, next to the screenshot, from the same DOM
state, and written to a sibling `*.layout.json`. Anything that genuinely cannot
be asserted programmatically is listed in `report.limitations` rather than
approximated.

## Requirements

* **Obsidian for Windows** (the captures in `docs/assets/` use **1.14.5**).
  Detected at `--obsidian <path>`, else `$env:OBSIDIAN_EXE`, else
  `%LOCALAPPDATA%\Obsidian\Obsidian.exe`, else `%PROGRAMFILES%\Obsidian\Obsidian.exe`.
* **Node >= 22** — the harness uses the built-in global `WebSocket` and `fetch`,
  so it has **no npm dependencies of its own**.
* A built plugin: a directory containing `main.js`, `manifest.json` and
  `styles.css` (the repo's `dist/` after `npm run build`).
* Windows OCR (built in) only if you want the `compare-text.mjs` cross-check.

## Quick start

```powershell
# 1. build the plugin revision you want to capture (in its own checkout)
npm run build

# 2. wide capture
node tools/provider-settings-shots/capture.mjs `
  --plugin-dir dist `
  --scenario tools/provider-settings-shots/scenarios/cch-opencode.json `
  --out docs/assets/provider-settings-2026-11-03-before-wide.png `
  --width 1353 --height 1053 `
  --label before-wide --phase before --revision 154e483

# 3. narrow capture (same scenario, same theme, panel/mobile-like width)
node tools/provider-settings-shots/capture.mjs `
  --plugin-dir dist `
  --scenario tools/provider-settings-shots/scenarios/cch-opencode.json `
  --out docs/assets/provider-settings-2026-11-03-before-narrow.png `
  --width 520 --height 900 `
  --label before-narrow --phase before --revision 154e483
```

Each run writes the PNG and, next to it, `<name>.layout.json`.

The "after" runs are identical except for `--plugin-dir` (pointing at the
rebuilt revision), `--out`, `--label`, `--phase after` and `--revision`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--plugin-dir` | *required* | Directory holding `main.js`, `manifest.json`, `styles.css` |
| `--out` | *required* | Output PNG path |
| `--layout-out` | `<out>` with `.layout.json` | Output layout report path |
| `--width` / `--height` | `1353` / `1053` | Requested viewport (see *Viewport control*) |
| `--theme` | `dark` | `dark` or `light`; written to the vault and asserted in the report |
| `--label` | PNG basename | Free-form label echoed into the report |
| `--phase` | – | `before` / `after` |
| `--open-section` | – | Open the settings accordion section whose `data-section-id` matches (e.g. `capture`), then scroll its content to the top of the viewport. Needed for any control outside the default-open `overview` / `connection` sections. |
| `--revision` | – | Git revision the plugin was built from |
| `--scenario` | – | JSON file installed as the plugin's `data.json` |
| `--vault` | `%TEMP%\baizer-shots\obsidian` | Throwaway vault location |
| `--obsidian` | autodetected | Path to `Obsidian.exe` |
| `--port` | `9333` | DevTools port |
| `--locale` | `zh` | Obsidian UI language (`localStorage.language`); reloads once if it changes |
| `--ready-timeout` | `180000` | ms to wait for Obsidian's DevTools endpoint |
| `--expect-active` | – | Provider id the scenario's `activeProvider` must load as, asserted before the settings tab opens (see *Waiting for the plugin's settings*) |
| `--expect-providers` | – | Comma-separated provider ids that must be loaded, same guard |
| `--focus-type-select` | off | Reset the pane's scroll and scroll the minimum needed to put the provider **type** `<select>` on screen (see *Capturing the provider-type dropdown*) |
| `--expand-type-select` | off | As above, plus a `size` on that `<select>` so every option renders inline. Bare = `size = <option count>`; pass a number (`--expand-type-select 3`) to pin the same row count in both phases (implies the focus behaviour) |
| `--keep-open` | off | Leave Obsidian running (useful for manual poking) |

## What a run does

1. **Vault** — (re)creates `--vault` with
   `.obsidian/plugins/baizer/{main.js,manifest.json,styles.css}`,
   `.obsidian/community-plugins.json` = `["baizer"]`,
   `.obsidian/app.json` with restricted mode off,
   `.obsidian/appearance.json` with the requested theme,
   and the `--scenario` JSON as the plugin's `data.json`.
   `core-plugins.json` is deliberately left alone so the vault keeps Obsidian's
   default core plugins (they are visible in the settings nav, and the committed
   baseline shows them).
2. **Registration** — merges the vault into
   `%APPDATA%\obsidian\obsidian.json` as the only entry with `"open": true`.
   The original file is copied **once** to `obsidian.json.dsh-backup` before the
   first rewrite.
3. **Launch** — `Obsidian.exe --remote-debugging-port=<port>`, then waits for
   `/json/version`, and connects to the page target that is actually *drivable*:
   the main window (`app://obsidian.md/index.html`), proven by evaluating
   `typeof app !== 'undefined' && !!app.workspace` in it. A popped-out window is
   served from `about:blank` and has no `app`, so it is skipped here.
4. **Drive** — over CDP, in the main window: waits for `app.workspace`, applies
   the locale, clears the **first-open trust dialog** (see below), detaches the
   **release-notes leaf**, ensures the `baizer` plugin is enabled
   (`app.plugins.setEnable(true)` + `loadManifests()` + `enablePlugin('baizer')`
   as a fallback to the on-disk config), waits for the plugin instance to exist,
   and opens the Baizer settings tab.
5. **Locate the panel** — the settings modal renders either in the main window or
   in Obsidian's own popout settings window (see *Where the settings panel
   renders*). The harness scans the page targets for the one that actually
   contains `.baizer-settings-provider-card` and measures/captures **that**
   window; the `app`-derived facts come from the main window.
6. **Viewport** — `Emulation.setDeviceMetricsOverride` on the panel's window.
7. **Measure** — `Runtime.evaluate` of the probe in `lib/probe.mjs`.
8. **Capture** — `Page.captureScreenshot` (`fromSurface: true`), then verifies
   the PNG's real dimensions against the request and exits non-zero on a
   mismatch, because that means viewport control failed.
9. **Cleanup** — `taskkill /T /F` on the Obsidian process tree unless
   `--keep-open`.

### Where the settings panel renders (read this before changing the vault config)

Obsidian decides between an inset modal and a standalone settings window with
`Setting#shouldUsePopout()`, which is literally
`this.app.vault.getConfig("settingsPopoutWindow")` — a vault config key that
**defaults to `true`** on 1.14.5 and 1.15.0. `lib/vault.mjs` writes it as `true`
explicitly, because that is the app default *and* the presentation the committed
baseline shows (its title is the popout's own `设置 - obsidian - Obsidian 1.14.5`,
and its settings nav starts at x≈31, i.e. the settings fill the whole window).

The two presentations are not interchangeable for this harness:

* the popout is a **separate CDP page target** (`about:blank`) with **no `app`
  global** — Obsidian also repoints the `activeWindow`/`activeDocument` globals
  at it, after which even `typeof app` becomes `undefined` in the main window;
* the inset modal lives in the main window but is only `min(1100px, 90vw)` wide,
  so it squeezes the settings content much harder than the real (popout) app
  does — at a 520px viewport the modal left the Baizer page only ~191px wide
  versus ~244px in the popout, which turns verdicts that pass in the real app
  into failures.

Because a popout has no `app`, the probe cannot read `app.plugins.plugins.baizer`
there; `capture.mjs` reads those facts off the main window and passes them in as
`cfg.pluginInfo`, and `report.plugin.source` records where they came from.

### Viewport control

`Emulation.setDeviceMetricsOverride` is used rather than resizing the OS window:
it makes the renderer lay out at exactly the requested width, which is what the
comparison needs, and it is deterministic regardless of window chrome. The
harness records both the requested size and the size of the PNG it actually got,
and `report.viewport` records `window.innerWidth/innerHeight` observed *inside*
the page. If those disagree with the request, the run fails loudly.

## The layout report

`report.verdict` holds the pass/fail booleans; everything else is the raw
evidence behind them.

| Verdict key | Assertion |
| --- | --- |
| `allRequiredNodesPresent` | Every expected settings node was found |
| `pluginLoaded` | `app.plugins.plugins.baizer` exists |
| `themeMatchesExpectation` | `body.theme-dark` / `body.theme-light` matches `--theme` |
| `noDocumentHorizontalOverflow` | `documentElement.scrollWidth <= clientWidth` |
| `noContainerHorizontalOverflow` | Every named settings container has `scrollWidth <= clientWidth + 1`, **and** no element's box spills outside the settings panel |
| `noInteractiveOverlap` | No two visible `input/select/textarea/button` in the active provider detail have intersecting `getBoundingClientRect()` (area > 0.5px²) |
| `noUnreachableTruncatedValues` | No field whose text overflows its box is also disabled with no `title` (i.e. the user could not read it at all) |
| `noEllipsizedStaticText` | No `text-overflow: ellipsis` element is actually clipping |
| `customHeadersHelpNotClipped` | The `{{conversationId}}` help note neither overflows horizontally nor is clipped vertically |
| `secretActionsOnOneRow` | The Reveal/Clear buttons share a row |
| `labelColumnConsistent` | All detail rows use one `grid-template-columns` |
| `providerTypeSelectFound` | The active provider's detail has a **type** `<select>` |
| `providerTypeSelectOnScreen` | That `<select>` is fully inside the viewport (`--focus-type-select` arranges this) |

The last two are **not** part of `allPass`: they answer a different question
("is the dropdown whose option list changed on screen?") from the layout
criteria this harness was built to assert, and adding them to `allPass` would
have made every older report/consumer start failing for an unrelated reason.

Raw sections: `overflow.{document,containers,offenders,spill}`,
`overlap.{controlCount,pairs}`, `truncation.{fields,ellipsizedStaticText}`,
`wrapping.{customHeadersHelp,secretActionButtons,secretRow}`,
`alignment.{rows,distinctLabelWidths,distinctValueWidths,connectionGridTemplateColumns,branch}`,
`providerTypeSelect.{options,optionTexts,optionCount,value,inViewport,renderedAsList,sizeAttribute,scrollContext}`,
plus `providerCards`, `connectionCards`, `presence`, `viewport`, `theme`,
`language`, `plugin`, `windowTitle`, `appGlobalAvailable` and `harness` (exe
path, vault, scenario, copied plugin file sizes, launch/stability timings, which
window the panel rendered in, the browser UA, which blocking modals were
cleared, and the settings/scroll guards described below).

### Which app version produced a capture

`report.obsidianVersionInPage` is the version of the app that **actually ran**,
with `report.obsidianVersionSource` saying how it was obtained. The settings panel
usually renders in a popout window that has no `app` global, so the in-page
globals are unavailable there and the version comes from the window title
(`… - Obsidian 1.15.0`), which Obsidian maintains. `report.obsidianVersionFromExe`
is a *different* fact: the FileVersion of the binary `--obsidian` named, read from
its PE version resource. They legitimately disagree here — a 1.14.5 executable runs
1.15.0 app code because `%APPDATA%\obsidian\obsidian-1.15.0.asar` is preferred
over the app's own `resources/obsidian.asar`; `harness.obsidianAsarFiles` records
which downloaded bundles were present, so the discrepancy is evidenced rather than
asserted. Quote `obsidianVersionInPage` when stating which version produced
evidence.

### Capturing the provider-type dropdown

A **closed** `<select>` paints only its selected option, so an option that was
removed from the provider-type dropdown cannot be seen in a screenshot no matter
how the capture is framed — two revisions that differ only in that option list
produce byte-identical PNGs. So:

* `--focus-type-select` puts the control on screen and `providerTypeSelect` in
  the report carries the **option list itself**, which is the machine-checkable
  form of the claim ("the Gemini option is present before and absent after").
* `--expand-type-select` additionally sets `size = <option count>` on that one
  `<select>`, turning it into a native list box so every option is rendered into
  the bitmap. That is a presentation-modified view — the report records
  `renderedAsList: true` and `sizeAttribute`, so it can never be mistaken for the
  stock rendering — and it is the only way the removal is *visible* in a PNG.

Both flags scroll the pane only when the control is actually outside the
viewport, and they **reset `scrollTop` to 0 first**: Obsidian persists the
settings pane's scroll position (`workspace.json`), so a reused vault otherwise
starts a run wherever the previous one ended (observed: 0 vs 1228 px, which moves
the same control by 1200 px and makes before/after frames incomparable).

### Waiting for the plugin's settings

`--expect-active` / `--expect-providers` close a race that silently produced
worthless evidence: on a vault Obsidian has not seen before, the first-open trust
dialog is what enables the plugin, and the settings tab could then render before
`loadSettings()` replaced the defaults. The tab does not re-read settings, so the
capture showed the *first* provider as active — and the plugin persisted that
back to `data.json`, so the evidence looked self-consistent while documenting the
wrong provider. The harness now waits until the plugin's loaded
`settings.activeProvider`/`settings.providers` match the flags before opening the
tab, and records `harness.pluginSettingsWait` plus a `limitations` note if they
never do.

### `alignment.branch`: which side of the hero breakpoint a capture landed on

The hero-collapsing rule is a `@container` query on the **settings page** width, not on the
viewport, so which branch a capture exercised is not a function of the window size alone. The probe
records the resolved values (`heroGridTemplateColumns`, `heroGridTemplateAreas`,
`providerCardInnerGridTemplateColumns`, and the container's `clientWidth`) and derives
`wideBranch`.

**Do not use the connection grid's column count to tell the branches apart.** The reworked layout
renders `.baizer-settings-connection-flow` as a single-column flow at *every* width, so it reports
`grid-template-columns: none` even at 1353px. The discriminators are the hero areas
(`"title search" "subtitle subtitle"` wide vs `"title" "subtitle" "search"` narrow) and the
provider-card inner grid (3 columns wide vs 1 narrow).

`wideBranch` is **three-valued**: `true`/`false` when the layout declares `grid-template-areas`, and
`null` when it does not, because `getComputedStyle().gridTemplateAreas` returns the string `"none"`
in that case — reporting `false` there would wrongly claim the narrow branch. Note also that
`wideBranch` answers "does the subtitle span **both** hero columns", not "is the viewport wide": the
pre-rework hero declared `"title search" / "subtitle search"`, confining the subtitle to the left
column, so `before-wide` reports `false` while still being the wide branch of the old breakpoint.
That difference is precisely the subtitle fix, which is why the field is worth reading.

`plugin.loaded`/`plugin.version` and `windowTitle` are the two fields to sanity
check first: a popped-out settings window has no `app` global, so `plugin` is
filled from the main window and `plugin.source` says so; `windowTitle` is how the
Obsidian version actually running is identified (see Troubleshooting).

Truncation is measured, not eyeballed: the rendered width of the value is
computed with `CanvasRenderingContext2D.measureText` using the control's own
computed font, and compared with the control's content box
(`clientWidth - paddingLeft - paddingRight`).

## Cross-checking that two captures are comparable

Because the agent cannot look at the images, `compare-text.mjs` OCRs two PNGs
with the Windows OCR engine and compares the text **and its coordinates**:

```powershell
node tools/provider-settings-shots/compare-text.mjs `
  --baseline docs/assets/provider-settings-obsidian-2026-11-03.png `
  --candidate docs/assets/provider-settings-2026-11-03-before-wide.png `
  --out docs/assets/provider-settings-2026-11-03-before-wide.textdiff.json
```

`summary.verdict.sameImageSize` and `everyMatchedLineWithinTolerance` are the
"same scenario, same viewport" evidence. `onlyInBaseline` / `onlyInCandidate`
list genuine content differences and must be explained, not waved away.

## What is deliberately NOT asserted

Recorded per run in `report.limitations`:

* colour, contrast, font rendering, iconography and animation;
* overlap between non-interactive elements (only controls are checked, as agreed);
* which specific ancestor clips an overflowing element (the offender scan finds
  the element, not the culprit ancestor);
* whether a truncated *editable* value is subjectively readable — it is counted
  as reachable because the user can focus, scroll and edit it;
* OCR is a heuristic: it misreads glyphs (`opencode` → `opencc`) and cannot read
  password fields. Treat `compare-text.mjs` as corroboration, not ground truth.

## Baseline provenance (for the committed comparison)

`docs/assets/provider-settings-obsidian-2026-11-03.png` is **1353x1053** and,
read back with the Windows OCR engine, shows:

* title `设置 - obsidian - Obsidian 1.14.5` → Obsidian **1.14.5**, Chinese UI,
  vault named `obsidian`;
* provider cards `cch` (badge `Ready`, meta `模型：gpt-5.6-sol`) and `opencode`
  (badge `Active`, meta `模型：deepseek-v4.1-flash`) — so **`opencode` is the
  active, expanded provider**;
* the expanded detail: `服务商名称` → `opencode`, `API 端点`, `OpenAI 兼容`,
  `Chat Complet…`, `deepseek-v4.1…`, `https://opencc…`, `x-opencode-se…`, the
  long `{{conversationId}}` help note, `运行测试`.

`scenarios/cch-opencode.json` reproduces that state. Values that a bitmap cannot
reveal (the `cch` endpoint, both API keys, exact protocol of `cch`) are marked
`_unverified` inside the fixture.

Note that the committed baseline **already** shows clipped values in the API
endpoint input, the model select and the custom-headers textarea — they are
editable controls, so they are "reachable", but this is the honest starting
point against which the rework must be judged.

**The committed baseline is not pixel-reproducible by this harness**, and the
`before-*` captures are not meant to be pixel-identical to it. `compare-text.mjs`
reports `sameImageSize: true` (both 1353x1053) but `matchedWithinTolerance: 0`.
Two environmental reasons, both confirmed by OCR:

* the baseline's settings **nav item set** differs from a fresh throwaway
  vault's (baseline: 关于/界面/编辑器/核心插件/第三方插件/笔记重组/网页浏览器/页面;
  harness vault: 外观/日记/同步/文件恢复/…). The harness deliberately preserves the
  vault's default `core-plugins.json`, and the baseline appears to come from a
  real user vault (its vault is named `obsidian`, like the developer's own);
* the baseline's Baizer content appears **scrolled down** — its provider list
  starts at y≈58 with no `Baizer 配置` page header or `概览/连接/行为/记忆` tabs
  visible, whereas a fresh run renders those and puts the provider list at y≈386.

So treat the committed PNG as a **scenario reference** (which providers, which
one active and expanded, dark theme, 1353x1053), and compare `before-*` against
`after-*`, which share scenario, viewport, theme, presentation and harness.

## Canonical viewport set

| label suffix | viewport | why this width |
| --- | --- | --- |
| `-wide` | 1353x1053 | desktop, matching the committed baseline capture |
| `-narrow` | **600x900** | the canonical narrow: exactly the settings popout's declared `minWidth: 600`, i.e. the narrowest window the app itself will ever produce |
| `-narrow520` | 520x900 | stress: below the app's declared floor, but the viewport where the pre-rework layout actually truncated fields |
| `-mobile` | 400x800 | a desktop window squeezed via `Emulation.setDeviceMetricsOverride` — **not** Obsidian mobile; diagnostic only |

**Why 600 is the canonical narrow and not 520:** a pass at 520 does not imply a pass at 600, because a
breakpoint can sit between them. A `@media (min-width: 600px)` wide-branch would hand the
minimum-width window the *desktop* layout — the one configuration most likely to leak and the one a
520-only test cannot see. Measure at 600 to test that boundary, and keep 520 as the stress case.

**Why the two narrow widths rank differently:** baseline field truncation is *not* monotonic in
viewport width. At 1353px the connection grid is two columns (`314px 314px`) and squeezes the value
column to 150.67px, so three fields truncate; at 600px the grid has already collapsed to one 272px
column (value column 250.67px), so nothing truncates; at 520px the single column is down to 170.67px
and three fields truncate again. A wider window is therefore not automatically the safer one.

Obsidian did not clamp either 400 or 520 (the override sets `innerWidth` to exactly what was
requested), but the popout declares `minWidth: 600`, so both are below the app's supported floor —
treat their verdict failures as diagnostics, not as user-facing regressions.

## Comparing two reports

`compare-layout.mjs` turns a before/after pair of `.layout.json` files into the metric table used
as the machine-readable half of the PR's visual evidence, so those numbers are reproduced from the
committed evidence rather than retyped:

```bash
node tools/provider-settings-shots/compare-layout.mjs \
  --before docs/assets/provider-settings-2026-11-03-before-wide.layout.json \
  --after  docs/assets/provider-settings-2026-11-03-after-wide.layout.json \
  --title  "cch-opencode wide (1353x1053)" \
  --out    tools/provider-settings-shots/metrics/cch-opencode-wide.metrics.md
```

It writes a `.md` plus a `.json` twin, marks every row that changed, and lists the verdict keys
that flipped. It tolerates a report that predates a field, so a pair never fails to render just
because the probe grew a field in between.

Its table includes the provider-type rows above, so a pair whose only difference is the dropdown's
option list still reports `Gemini/Google option present: yes -> no` instead of "no row changed".

### Bundle-size evidence

`bundle-size-diff.mjs` diffs two `dist/esbuild-meta.json` files and writes the Before/After byte
counts plus per-module attribution (`.md` + `.json`):

```bash
BAIZER_METAFILE=1 npm run build          # in each worktree, writes dist/esbuild-meta.json
node tools/provider-settings-shots/bundle-size-diff.mjs \
  --before-meta <before>/dist/esbuild-meta.json --before-main <before>/dist/main.js --before-revision <sha> \
  --after-meta  <after>/dist/esbuild-meta.json  --after-main  <after>/dist/main.js  --after-revision  <sha> \
  --out-json tools/provider-settings-shots/metrics/<name>.metrics.json \
  --out-md   tools/provider-settings-shots/metrics/<name>.metrics.md
```

* Attribution comes from `outputs["dist/main.js"].inputs[].bytesInOutput` — the bytes a module
  actually occupies in the bundle. The top-level `inputs` map only carries the module's own source
  size, which is a *different* number; using it overstates a dependency's contribution. The script
  exits non-zero if a metafile ever stops emitting `bytesInOutput`, so an empty attribution can
  never be reported as a result.
* It cross-checks each metafile's own output size against the real `dist/main.js` on disk and
  records a sha256 of both artifacts, so the two builds being compared are identifiable.
* `--before-label` / `--after-label` carry the human context a bare SHA cannot (e.g. "tree-identical
  to main @ <sha>", or "pre-rebase; replaced by <sha> with the same tree").

`baseline-provenance.mjs` answers the other half of the question — *why should anyone believe the
Before artifact is the revision it claims to be*:

```bash
node tools/provider-settings-shots/baseline-provenance.mjs \
  --worktree <dir> --dist <dir>/dist --revision <sha> \
  --tree-identical-to <other-sha> --same-bundle-as <other-sha> \
  --marker '@google/genai' --marker 'Gemini API' \
  --note "..." --out-json tools/provider-settings-shots/metrics/<name>.json
```

It records the revision's **tree** hash, whether the worktree's bundled inputs match that tree
(asserted against the tree, not HEAD — a rebase rewrites HEAD without changing a byte), whether the
metafile agrees with the artifact on disk, whether the bundle was built in place (module comments
say `// node_modules/…` rather than `// ../…`), a sha256, substring marker counts, and which
on-disk source files are absent from the metafile with a proof that each is type-only. `--note` is
free text that lands in the record, which is where a caveat belongs if a bare marker count could be
misread (see *Marker counts are not a support check* below).

`capture-summary.mjs` turns N layout reports into one environment/parity record:

```bash
node tools/provider-settings-shots/capture-summary.mjs \
  --capture docs/assets/<before>.layout.json --capture docs/assets/<after>.layout.json \
  --out-json tools/provider-settings-shots/metrics/<name>.metrics.json \
  --out-md   tools/provider-settings-shots/metrics/<name>.metrics.md
```

It asserts the properties that make a before/after pair meaningful at all — same Obsidian version,
theme, locale, scenario, plugin version and viewport set across every capture, the type dropdown on
screen in all of them, and Gemini present before / absent after — and exits non-zero if any fails.
The Obsidian version is taken from the running window title, because the executable named by
`--obsidian` can be older than the app code Obsidian actually loads (`obsidian-<version>.asar` in
`%APPDATA%\obsidian` wins over the exe).

### Marker counts are not a support check

`--marker` counts are case-sensitive substring counts over the **bundle**, and this build is not
minified, so **comments ship**. A revision that fully removed a provider can still contain the
provider's name in a comment, and a revision that removed an api *implementation* still names its id
because pi-ai's compat registry calls every api factory. Read the counts next to the module table:
`@google/genai` / `@google/generative-ai` / `// node_modules/@google/` at 0 is the real assertion;
a surviving `Gemini` inside `node_modules/@earendil-works/pi-ai/...` or inside one of our own
comments is not support. That is why the size record — not a string search — is the evidence that
the implementation is gone.

### Measuring both revisions with one probe

The probe must find the *same logical field* in both revisions, or a pure rename shows up as
"field not found" — which reads like a regression that never happened. So the selectors match
either wording, and the field lookup falls back positionally:

| Concept | Pre-rework | Post-rework |
| --- | --- | --- |
| connection container | `.baizer-settings-connection-detail-grid` | `.baizer-settings-connection-flow` |
| API-key actions | `.baizer-settings-detail-secret-actions` | `.baizer-settings-field-actions` |
| connection cards | `基本`, `凭据` | `服务商身份与协议`, `连接地址与凭证`, `模型`, `测试结果` |
| model field | inside the basic card | its own `模型` card |
| endpoint / protocol labels | `API 端点`, `协议` | `服务地址（Base URL）`, `API 类型` |
| custom-headers help | `.baizer-settings-inline-note` | `.baizer-settings-field-hint` + a `<pre>` example, inside a `<details>` |

Two consequences worth knowing:

* **Collapsed `<details>` blocks must be opened before measuring.** A closed advanced block has
  `clientWidth: 0`, so a naive clipping check passes vacuously. `capture.mjs` clicks the
  `details.baizer-settings-advanced` summaries open (twice — a viewport change can trigger a
  re-render that closes them again) and the probe requires every help block to be `visible`
  before it will pass `customHeadersHelpNotClipped`.
* **The help text may be split across several blocks.** Post-rework it is two hints plus a `<pre>`
  example, so the report carries `customHeadersHelp.blocks[]` (each with its own width, line count
  and overflow flags) and the verdict requires *all* of them to be unclipped.

## Troubleshooting

* **`Start-Process : 已添加项。字典中的关键字:"HTTPS_PROXY"…`** — this host's
  environment block contains both `HTTPS_PROXY` and `https_proxy`, which breaks
  PowerShell's environment provider (so `Get-ChildItem Env:` and `Start-Process`
  both fail). The harness sidesteps it entirely: Node's `spawn` is used for
  child processes. If you need a shell one-liner here, avoid `Start-Process`.
* **DevTools port never opens** — Obsidian may already be running; a second
  instance hands the request to the first. Kill all `Obsidian.exe` first.
* **Wrong vault opens** — another vault has `"open": true` in
  `%APPDATA%\obsidian\obsidian.json`; the harness clears those, but a
  concurrently running Obsidian can rewrite the file.
* **Image size ≠ requested** — viewport control failed; the run exits non-zero
  and says so.
* **A build from a copy reports a bigger `dist/main.js` than the same revision built in place** —
  esbuild embeds every module's resolved path, both as a `// <path>` comment and as the string key
  in `__esm({ "<path>"() {…} })`. If the copy reaches the repo's `node_modules` through a junction,
  those paths become long relative paths (`../../…/node_modules/…`) instead of `node_modules/…`,
  and the bundle grows by roughly the number of modules times the prefix length — about **+158 KB**
  for this repo (~1,974 paths). The *code* is identical: normalising that prefix back to
  `node_modules/` reproduces the in-place byte count exactly (verified: 5,176,487 → 5,006,087 and
  4,289,379 → 4,131,459). So quote byte counts only from an in-place build; `test/bundle-size.test.ts`
  must run in place, and it does.
* **The run hangs waiting for `.baizer-settings-provider-card`** — historically
  caused by the first-open **trust dialog** (`你是否信任这个仓库的作者？`,
  `.modal.mod-trust-folder`). Until it is accepted, Obsidian never loads the
  community plugin, so no Baizer settings node can ever appear. Its accept button
  ("信任仓库作者并启用插件") has **no class at all** — only the *decline* button
  carries one (`.mod-cancel`) — so a generic `.modal-close-button, .mod-cta`
  sweep clicks nothing. `handleBlockingModals()` now finds the button by text.
  This dialog only appears on a vault Obsidian has not been asked about before,
  so it shows up on a fresh machine or a fresh `--vault`, not on every run.
* **`document.title` reads `版本说明 <ver> - …` instead of `设置 - …`** — the
  app's `most-recently-installed-version` (localStorage) is newer than the
  version actually running, so Obsidian opens the release-notes **leaf**. It is a
  workspace view, not a modal, and it takes over the window title; the harness
  detaches it. Harmless if it reappears, but it changes the title bar text and
  therefore the OCR comparison.
* **The app reports a different version than the executable you launched** —
  Obsidian prefers a downloaded `%APPDATA%\obsidian\obsidian-<ver>.asar` over its
  own `resources/obsidian.asar`. Renaming that file aside is **not** enough: the
  running app re-downloads it. To actually pin a version, also make the path
  impossible to recreate (e.g. replace it with a directory), otherwise a 1.14.5
  executable will quietly run 1.15.0 code. `report.harness.browserUserAgent` and
  `report.windowTitle` are recorded so the version actually used is auditable.
* **A run fails with `DevTools endpoint … unreachable within 180000 ms (fetch
  failed)` and no Obsidian window appears** — the previous run left an orphan
  `Obsidian.exe` holding the vault. Loading the downloaded `.asar` makes Obsidian
  **relaunch itself**, and the harness's `taskkill /T /F` targets the process it
  spawned, so the relaunched one survives; the next launch then hands the vault
  off to that orphan (which has no `--remote-debugging-port`) and exits. Kill
  every instance before each run:
  `Get-Process Obsidian -ErrorAction SilentlyContinue | Stop-Process -Force`.
* **Two revisions that differ only in a dropdown's option list produce
  byte-identical PNGs** — expected, not a harness bug: a closed `<select>` paints
  only its selected option. See *Capturing the provider-type dropdown* for the
  option list in the report and the `--expand-type-select` view that makes it
  visible.
* **The same control lands at a different Y between runs** — Obsidian persists the
  settings pane's scroll offset in `workspace.json`, so a reused `--vault`
  resumes wherever the last run left it (observed: 0 vs 1228 px). Pass
  `--focus-type-select`, which resets `scrollTop` before scrolling minimally.
