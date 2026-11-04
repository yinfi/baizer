# chat-scroll-shots

A repeatable harness that captures the Baizer **chat view** (`ShellView`,
`VIEW_TYPE_SHELL`) scroll-follow behaviour out of a real, running Obsidian —
plus a machine-readable layout/scroll report measured from the same DOM state
— so that "before" and "after" screenshots for issue #64 are comparable and
the acceptance criteria can be checked without a human looking at pixels.

This is **not** a mock-up generator. Obsidian is launched with
`--remote-debugging-port`, the real `ShellView` instance is driven over CDP by
calling `view.handleStatusChange(bool)` / `view.handleStreamEvent(event)` —
the exact methods the real streaming pipeline calls — and every PNG comes
from `Page.captureScreenshot`.

## Why it exists

Issue #64's acceptance criteria are scroll-geometry and affordance-visibility
claims:

* streaming to the bottom, then scrolling up >= 1 screen, must NOT pull the
  viewport back down on further tokens or on stream completion;
* a "有新输出 · 回到最新" ("new output · back to latest") entry must appear
  only once paused AND new content has arrived, must not obstruct the
  message/input area, and clicking it must resume following;
* this must hold at a 300px-wide sidebar with no horizontal overflow.

None of that can be asserted from a bitmap alone, so every criterion that can
be expressed as a DOM measurement is measured in the page, next to the
screenshot, from the same DOM state, and written to a sibling
`*.layout.json`.

## Reuse vs. own code

This harness imports the two dependency-free, generic modules from
`tools/provider-settings-shots/lib/` directly:

* `../provider-settings-shots/lib/cdp.mjs` — the CDP client;
* `../provider-settings-shots/lib/vault.mjs` — throwaway vault + plugin
  install + global `obsidian.json` registration.

Everything else in `tools/provider-settings-shots/capture.mjs` (launch,
modal-handling, viewport control, DOM-stability waiting, …) is **not
exported** from that script — it is private to its own `main()` — so this
harness reimplements the generic (non-provider-settings-specific) subset of
it in `lib/obsidian.mjs`, rather than editing or copying from that directory.
`tools/provider-settings-shots/**` is read-only from here.

New, chat-specific code:

* `lib/chat-probe.mjs` — the chat scroll/affordance/overflow DOM probe.
* `lib/scenario.mjs` — the deterministic `StreamEvent` sequence (see
  `src/models/interfaces.ts:65` for the union) and the page-side driver that
  calls `view.handleStatusChange` / `view.handleStreamEvent`.
* `lib/sidebar.mjs` — resizes Obsidian's own right sidedock
  (`.workspace-split.mod-right-split`) to an exact pixel width, the same
  inline-style mechanism Obsidian's own splitter drag uses, so the 300px
  capture is the real app laying out at that width rather than a synthetic
  viewport trick.
* `capture.mjs` — the driver that ties it together.

## Requirements

Same as `tools/provider-settings-shots/`: Node >= 22 (global `fetch` +
`WebSocket`), Obsidian for Windows, a built plugin directory
(`main.js`/`manifest.json`/`styles.css`).

**On this machine, `Obsidian.exe` is NOT at `%LOCALAPPDATA%\Obsidian\` or
`C:\Program Files\Obsidian\`** (both are documented as autodetect candidates
in `tools/provider-settings-shots/README.md`, and neither exists here).
`winget list --name Obsidian` reports Obsidian 1.14.5 installed; the registry
uninstall entry (`HKLM:\...\Uninstall\Obsidian`) names the real location:

```
C:\obs-1.14.5-installed\Obsidian.exe
```

Always pass `--obsidian "C:\obs-1.14.5-installed\Obsidian.exe"` explicitly on
this host. (A second, apparently-unused copy also exists at
`C:\obs-1.14.5\Obsidian.exe`; the registry's `InstallLocation`/
`UninstallString` point at the `-installed` one, so that is the one these
captures used.)

## Quick start

```powershell
# 1. build the plugin revision you want to capture, in its OWN worktree/checkout —
#    never in the ticket tree while another agent is building there.
git worktree add .worktrees/baseline-cdcccb6 cdcccb6
cd .worktrees/baseline-cdcccb6; npm install; npm run build; cd ../..

# 2. kill any stray Obsidian first (documented pitfall: a relaunched orphan
#    can hold the vault and starve the next launch's DevTools port)
Get-Process Obsidian -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. wide capture (4 PNGs + 4 layout.json + 1 run summary)
node tools/chat-scroll-shots/capture.mjs `
  --plugin-dir .worktrees/baseline-cdcccb6/dist `
  --out-prefix docs/assets/chat-scroll-2026-11-04-before-wide `
  --width 1353 --height 1053 --theme dark `
  --phase before --revision cdcccb6 `
  --obsidian "C:\obs-1.14.5-installed\Obsidian.exe"

# 4. narrow capture: same scenario, same theme, the chat view's own leaf resized
#    to exactly 300px wide (acceptance criterion 5)
node tools/chat-scroll-shots/capture.mjs `
  --plugin-dir .worktrees/baseline-cdcccb6/dist `
  --out-prefix docs/assets/chat-scroll-2026-11-04-before-narrow300 `
  --width 1353 --height 1053 --sidebar-width 300 --theme dark `
  --phase before --revision cdcccb6 `
  --obsidian "C:\obs-1.14.5-installed\Obsidian.exe"
```

The "after" runs are identical except `--plugin-dir` (the rebuilt ticket
branch), `--out-prefix`, `--phase after` and `--revision`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--plugin-dir` | *required* | Directory holding `main.js`, `manifest.json`, `styles.css` |
| `--out-prefix` | *required* | Prefix for every output file. Each scenario capture appends `-<slug>.png` / `-<slug>.layout.json`; a `-run.json` summary is also written |
| `--width` / `--height` | `1353` / `1053` | Requested Obsidian window viewport (see *Viewport control*) |
| `--sidebar-width` | – | If set, resizes the right sidedock (where the chat leaf is opened) to exactly this many px, via the same inline style Obsidian's own splitter drag sets. Use `300` for the acceptance-criterion-5 narrow scenario |
| `--theme` | `dark` | `dark` or `light`; asserted in the report |
| `--phase` | *required* | `before` / `after` |
| `--revision` | *required* | Git revision the plugin was built from |
| `--vault` | `%TEMP%\baizer-shots\obsidian` | Throwaway vault location |
| `--obsidian` | autodetected | Path to `Obsidian.exe` (pass explicitly on this host, see above) |
| `--port` | `9334` | DevTools port |
| `--locale` | `zh` | Obsidian UI language |
| `--ready-timeout` | `180000` | ms to wait for Obsidian's DevTools endpoint |
| `--keep-open` | off | Leave Obsidian running after the run (useful for manual poking) |

## The scenario

`lib/scenario.mjs` plays back, through the real view methods, in order:

1. `handleStatusChange(true)` (loading indicator).
2. 14 `text_delta` chunks of Chinese filler text (long enough to overflow
   `.shell-output-area` by more than one screen) — reaches the bottom.
3. A `step_boundary` / `thinking` / `tool_call` / `tool_result` /
   `step_boundary` sequence, so the thinking timeline has a real
   collapse/expand target.
4. 16 more `text_delta` chunks — reaches the bottom again, well past one
   screen of overflow.
5. **Scroll up >= 1 screen** (`scrollTop -= clientHeight * 1.3`), simulating
   the user reading history. **Capture 1** here.
6. 10 more `text_delta` chunks arrive *while scrolled up*. **Capture 2**
   here — this is where a "新输出 · 回到最新" affordance is expected to
   appear in the fixed implementation.
7. `done` (with `text: ''`, so `ShellView.finalizeStream` falls back to the
   already-rendered `streamAccumulatedText` instead of truncating it — see
   the comment in `scenario.mjs`) then `handleStatusChange(false)`.
   **Capture 3** here — the baseline bug is that this step snaps back to the
   bottom even though the user never asked to.
8. The harness locates and clicks the affordance (if present/clickable).
   **Capture 4** here — should show the view back at the bottom with
   following resumed.

The filler sentences deliberately avoid the issue's own affordance copy
(回到最新 / 有新输出 / "back to latest" / "new message") so the probe's
text-heuristic affordance search in `lib/chat-probe.mjs` cannot
false-positive match streamed prose instead of a real control (this *did*
happen during development — see Troubleshooting).

## The layout/scroll report

Each `*.layout.json` carries, from the exact DOM state the adjacent PNG was
captured from:

* `scroll.{scrollTop,scrollHeight,clientHeight,distanceFromBottom,isAtBottom}`
  — `isAtBottom` is `distanceFromBottom <= 2`.
* `scroll.{scrollWidth,clientWidth,noHorizontalOverflow}` — the scroll
  container's own overflow check.
* `overflow.document.{scrollWidth,clientWidth,noHorizontalOverflow}` — the
  document-level check.
* `affordance.{found,visible,clickable,box,text,classes,withinOutputArea,overlapsOutputArea}`
  — located by a short allow-list of likely class/`data-testid` names, with a
  fallback that only matches a real `<button>`/`[role="button"]` whose own
  (short, <40 char) text starts with an expected phrase. `affordanceCandidates`
  lists every match if more than one was found.
* `content.{entryCount,timelineCount,timelineCollapsedCount}`.
* `viewport.{innerWidth,innerHeight,devicePixelRatio}`, `theme`, `plugin`,
  `windowTitle`, `obsidianVersionInPage`.
* `image.{width,height,requestedWidth,requestedHeight,sizeMatchesRequest}`.
* `limitations` — what this probe does NOT assert (colour/contrast/animation;
  affordance-naming assumptions).

The run-level `*-run.json` additionally carries `harness.sidebarResize`
(requested vs. measured sidedock width, before/after), `harness.blockingModals`,
`harness.pluginEnableAttempt`, `harness.affordanceClicked` (whether capture 4's
click actually found something to click), and the Obsidian version/exe facts
in the same spirit as `provider-settings-shots`' report.

## Troubleshooting

* **`Obsidian.exe not found`** — see *Requirements* above; the autodetected
  paths do not exist on this host. Pass `--obsidian "C:\obs-1.14.5-installed\Obsidian.exe"`.
* **Orphan Obsidian holding the vault** — same pitfall as
  `provider-settings-shots`: kill every `Obsidian.exe` before each run
  (`Get-Process Obsidian -ErrorAction SilentlyContinue | Stop-Process -Force`).
* **Affordance heuristic matches ordinary prose** — happened once during
  development: the scenario's filler sentences originally contained the
  phrase "回到最新", and the probe's then-looser fallback (which allowed any
  `div[tabindex]`/`<a>` and up to 60 chars of *own* text) matched a
  `.baizer-thinking-header` blockquote line. Fixed by (a) keeping the
  scenario's filler text free of the affordance's own vocabulary and (b)
  narrowing the fallback to only `button`/`[role="button"]` elements whose
  own text is short and starts with an expected phrase. If a real
  implementation names its affordance something this heuristic cannot
  anticipate, `affordance.found: false` is the honest result — not a
  guessed/assumed absence — and must be reported as a probe limitation, not
  silently treated as "no affordance in the app".
* **`done.text` collapsing the capture** — also happened during development:
  passing a short placeholder string as `done.text` made
  `ShellView.finalizeStream` replace the whole rendered response with that
  placeholder (by design: `done.text` is meant to let the runtime replace the
  final text, e.g. after a generation-quality rewrite). Use `text: ''` so it
  falls back to the UI's own accumulated text instead.
* **Sidedock width is not exactly `--sidebar-width`** — `harness.sidebarResize.after.rectWidth`
  in the run summary is the ground truth; a run whose measured width
  disagrees by more than 3px with the request appends a note to
  `harness.explanations` rather than silently reporting the requested number.
