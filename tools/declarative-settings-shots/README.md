# declarative-settings-shots

A repeatable harness that captures the **declarative** Baizer settings pages
(Obsidian 1.13+ `getSettingDefinitions()`) out of a real, running Obsidian, plus a
machine-readable report written next to each PNG.

This is not a mock-up generator: Obsidian is launched with
`--remote-debugging-port`, the renderer is driven over CDP, and the PNG comes from
`Page.captureScreenshot`.

## Why a second harness

`../provider-settings-shots/capture.mjs` captures the **pre-migration** settings
tab. It locates the panel by `.baizer-settings-provider-card` and opens accordion
sections by `data-section-id`; neither exists after the declarative migration.
This harness locates the panel by Obsidian's own `.vertical-tab-content`, navigates
by clicking the visible row text of a page/sub-page, and records the row list in
the report so the navigation is auditable.

Use the old harness for **Before** evidence and this one for **After** evidence.
Both use the same CDP client (`../provider-settings-shots/lib/cdp.mjs`) and the
same throwaway-vault helper (`../provider-settings-shots/lib/vault.mjs`), so a
pair shares viewport, theme, locale and the fixture scenario.

## Requirements

- Windows with Obsidian installed (the committed evidence uses app **1.15.0**;
  the executable can be older — Obsidian prefers a downloaded
  `%APPDATA%\obsidian\obsidian-<version>.asar`).
- Node >= 22 (global `fetch`/`WebSocket`; no npm dependencies).
- A built plugin: `npm run build` produces `dist/main.js`, `dist/manifest.json`,
  `dist/styles.css`.

## Quick start

```powershell
# Build the revision to capture
npm run build

# Root settings tab (page list + "Needs attention")
node tools/declarative-settings-shots/capture.mjs `
  --plugin-dir dist `
  --scenario tools/provider-settings-shots/scenarios/cch-opencode.json `
  --out docs/assets/declarative-settings-2026-11-06-after-root-wide.png `
  --width 1353 --height 1053 --theme dark --locale zh `
  --label after-root-wide --phase after --revision <sha>

# Navigate: Connection -> provider "opencode"
node tools/declarative-settings-shots/capture.mjs `
  --plugin-dir dist `
  --scenario tools/provider-settings-shots/scenarios/cch-opencode.json `
  --out docs/assets/declarative-settings-2026-11-06-after-wide.png `
  --width 1353 --height 1053 --theme dark --locale zh `
  --label after-wide --phase after --revision <sha> `
  --page "连接" --subpage "opencode"
```

`--page` accepts a `>`-separated path (`--page "连接>opencode"` is equivalent to
`--page "连接" --subpage "opencode"`). Each step clicks the first
`.setting-item` whose visible text contains the given string.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--plugin-dir` | required | Directory with `main.js` / `manifest.json` / `styles.css` |
| `--out` | required | Output PNG path |
| `--layout-out` | `<out>.layout.json` | Report path |
| `--scenario` | – | JSON installed as the plugin's `data.json` |
| `--width` / `--height` | `1353` / `1053` | Viewport (Emulation override in the panel window) |
| `--theme` | `dark` | Written to the throwaway vault and asserted in the report |
| `--locale` | `zh` | Obsidian UI language (`localStorage.language`) |
| `--page` | – | Page path to open before capturing |
| `--subpage` | – | Extra row to click after `--page` |
| `--label` / `--phase` / `--revision` | – | Echoed into the report |
| `--expect-active` / `--expect-providers` | – | Wait until the plugin has loaded the scenario's settings |
| `--vault` | `%TEMP%\baizer-shots\obsidian` | Throwaway vault |
| `--obsidian` | autodetected | Path to `Obsidian.exe` |
| `--port` | `9334` | DevTools port |
| `--ready-timeout` | `180000` | ms to wait for DevTools / first render |
| `--dump-dom` | off | Store a shallow DOM tree of the rendered tab in the report |
| `--eval` | – | Diagnostic: evaluate JS in the **panel window** after navigation |
| `--eval-main` | – | Diagnostic: then evaluate JS in the **main window** (where `app` lives) |
| `--keep-open` | off | Leave Obsidian running |

The `--eval` / `--eval-main` pair is how the migration's write path was verified
without an assertion framework: click a declarative toggle/dropdown in the panel,
then read `plugin.settings` from the main window.

## The report

`<out>.layout.json` contains:

- `theme`, `language`, `windowTitle`, `viewport` — the facts that make a
  before/after pair comparable;
- `page.requestedPages` and `page.rows` — every rendered `.setting-item` with its
  name, description and classes, i.e. the declarative definitions that actually
  rendered;
- `page.contentText` — visible text, for grep/OCR-style spot checks;
- `image` — path, bytes, real PNG dimensions and whether they match the request
  (a mismatch fails the run);
- `harness.navigation` — each requested row, whether it was found and what was
  clicked (a renamed row fails the run instead of silently measuring another
  row);
- `harness.settingsPanelLocation` — `popout-window` or `main-window`;
- optional `harness.domDump`, `harness.eval`, `harness.evalMain`.

## Before/After pairing

The committed evidence pairs these files (same scenario, viewport, theme, locale):

| State | Before (old accordion UI) | After (declarative pages) |
| --- | --- | --- |
| Connection, wide 1353×1053 | `declarative-settings-2026-11-06-before-wide.png` | `declarative-settings-2026-11-06-after-wide.png` |
| Connection, narrow 600×900 | `declarative-settings-2026-11-06-before-narrow.png` | `declarative-settings-2026-11-06-after-narrow.png` |
| Memory, wide | `…-before-memory-wide.png` | `…-after-memory-wide.png` |
| Knowledge, narrow | `…-before-knowledge-narrow.png` | `…-after-knowledge-narrow.png` |
| Permissions, wide | `…-before-permissions-wide.png` | `…-after-permissions-wide.png` |

The "after" root-page captures have no "before" counterpart: the old UI had no
page list. They document the new navigation, not a regression.

The Before captures were produced from revision `9b80502` in a separate worktree
(built with a junction to the same `node_modules`):

```powershell
git worktree add ../baseline-declarative 9b80502
# in that worktree: create a node_modules junction, then npm run build
node tools/provider-settings-shots/capture.mjs --plugin-dir ../baseline-declarative/dist ...
```

## Limitations

Recorded per run:

- colour, contrast, font rendering, iconography and animation are not asserted;
- navigation is by visible row text, so the harness is locale-sensitive by design
  (it reloads once if `localStorage.language` differs from `--locale`);
- the report only sees the rendered page, not controls on pages that were never
  navigated to;
- the settings panel usually renders in Obsidian's separate popout settings
  window (`settingsPopoutWindow: true`), which is a CDP target with no `app`
  global — all plugin-state reads therefore happen in the main window
  (`--eval-main`).

## Troubleshooting

- **DevTools port never opens / wrong vault** — kill all `Obsidian.exe` first;
  the harness registers its throwaway vault as the only open one and kills its
  own process tree on exit, but an orphan from a previous run can hold the vault.
- **A run hangs before the first screenshot** — check `/json/list`: if only an
  `about:blank` target exists, the settings popout has not been created yet; the
  harness polls for `.vertical-tab-content` in every page target. The first-open
  **trust dialog** also blocks plugin loading; the harness clicks it by text.
- **`nav "…" -> NOT FOUND`** — the row text changed (usually an i18n edit). The
  report lists the rows that did render, so the failure names the mismatch
  instead of producing a misleading screenshot from the wrong page.
