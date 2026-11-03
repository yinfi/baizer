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
| `--revision` | – | Git revision the plugin was built from |
| `--scenario` | – | JSON file installed as the plugin's `data.json` |
| `--vault` | `%TEMP%\baizer-shots\obsidian` | Throwaway vault location |
| `--obsidian` | autodetected | Path to `Obsidian.exe` |
| `--port` | `9333` | DevTools port |
| `--locale` | `zh` | Obsidian UI language (`localStorage.language`); reloads once if it changes |
| `--ready-timeout` | `180000` | ms to wait for Obsidian's DevTools endpoint |
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

Raw sections: `overflow.{document,containers,offenders,spill}`,
`overlap.{controlCount,pairs}`, `truncation.{fields,ellipsizedStaticText}`,
`wrapping.{customHeadersHelp,secretActionButtons,secretRow}`,
`alignment.{rows,distinctLabelWidths,distinctValueWidths,connectionGridTemplateColumns}`,
plus `providerCards`, `connectionCards`, `presence`, `viewport`, `theme`,
`language`, `plugin`, `windowTitle`, `appGlobalAvailable` and `harness` (exe
path, vault, scenario, copied plugin file sizes, launch/stability timings, which
window the panel rendered in, the browser UA, and which blocking modals were
cleared).

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
