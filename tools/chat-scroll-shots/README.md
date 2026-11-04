# chat-scroll-shots

A capture harness for the chat scroll-follow change (issue #64). It drives a
**real Obsidian window** over CDP and writes a PNG plus a machine-readable
layout report from the same DOM state. It is not a mock-up generator.

## What the scenario does

Both phases run the identical script:

1. open the Baizer shell view in the right sidebar and fit the view to the
   requested content width (520 px wide / 300 px narrow);
2. seed a tall conversation through the real `ShellView.appendMessage`;
3. move the viewport to ~35 % of the scroll range and dispatch a `scroll`
   event — a reader who has scrolled up;
4. feed thinking + three text chunks through the real `StreamController`.

The baseline (pre-change) is pulled to the bottom by its unconditional
`scrollToEnd()` and has no return entry. The changed revision stays at the
reading anchor and shows **有新输出 · 回到最新**.

Each run writes:

- `<out>.png` — the shell view cropped from the actual window;
- `<out>.layout.json` — scroll positions, distance from bottom, entry text and
  geometry, overflow and width assertions.

## Usage

The Obsidian process is a Windows process, so run this with **Windows Node**
(a Linux `node` cannot spawn/attach to it on WSL):

```powershell
node tools/chat-scroll-shots/capture.mjs `
  --plugin-dir dist `
  --out docs/assets/chat-scroll-2026-11-04-after-wide.png `
  --phase after --revision <sha> --label after-wide --view-width 520
```

Repeat with `--view-width 300` for the narrow sidebar, and with the baseline
build for `--phase before`.

## Timing regression scenarios (issue #75)

`--scenario` selects what the harness drives. The default, `reading-anchor`, is
the #64 scenario above. The other three reproduce the timing defects that were
still present after #70; each writes the same PNG + layout JSON pair and adds a
`scenarioData` block plus per-scenario booleans under `assertions`.

| `--scenario` | What it drives | What the fix must hold |
| --- | --- | --- |
| `tab-switch-clamp` | A tall tab B (following, at the bottom) -> a short tab A that was left paused at `scrollTop=150` with an unread entry. While A's `scrollTop` is clamped from B's bottom to A's new max, a real `scroll` event is dispatched inside the 50 ms restore window. | A returns to 150, stays paused, keeps its unread entry; the clamp scroll is treated as layout noise. |
| `async-render-identity` | A's Markdown block render is held open (the harness wraps `MessageRenderer.renderAiContent` once), the user switches to B, then A's render resolves. | B's viewport does not move; the stale completion callback is dropped by session/render-generation identity. |
| `layout-growth-threshold` | A simulated delayed image grows the content 600 px with no user scroll (so `following` stays `true` while the reader is 600 px from the bottom), then a new token arrives. | The viewport stays put, follow pauses and the unread entry appears instead of snapping to the bottom. |

Both extra fixtures are explicit and local to the harness: the "image" is a
bordered placeholder div appended to the active message container, and the
render gate wraps only the next `renderAiContent` call so B's normal message
rendering is unaffected. They stand in for the real async image load and
Markdown render, which cannot be held open deterministically otherwise.

Determinism note: occluded/headless Chromium may coalesce or drop the
browser-generated scroll event that follows a `scrollTop` clamp. `tab-switch-clamp`
therefore moves the viewport to the clamp result (A's max) and dispatches a real
`DOM scroll` event inside the restore window. The event, container and controller
are real; only its delivery timing is pinned so the regression is reproducible.

`layout-growth-threshold` cannot be expressed in jsdom: jsdom has no layout, so
`scrollHeight`/`clientHeight` stay 0 and there is no clamping, scroll anchoring
or asynchronous scroll delivery to reproduce. That is why these cases live in
the Obsidian harness rather than `npm test`; the controller-level timing rules
are additionally covered by `test/scroll-follow.test.ts`, which models clamping
and async scroll delivery.

Run the three scenarios for both phases:

```powershell
# changed revision
node tools/chat-scroll-shots/capture.mjs --plugin-dir dist `
  --scenario tab-switch-clamp --phase after --revision <fix-sha> `
  --out docs/assets/chat-scroll-tab-switch-after.png --view-width 520
# baseline (cc33a19 build), identical scenario
node tools/chat-scroll-shots/capture.mjs --plugin-dir <baseline-dist> `
  --scenario tab-switch-clamp --phase before --revision cc33a19 `
  --out docs/assets/chat-scroll-tab-switch-before.png --view-width 520
```

Repeat with `async-render-identity` and `layout-growth-threshold`. On the
baseline the `assertions` block is expected to contain `false` values: that is
the reproduction. On the fixed revision every boolean must be `true`.


## Isolation

- The vault lives under `%TEMP%\baizer-shots\obsidian` and is recreated per run.
- Chat history, memory and workspace layout are removed before each launch, so
  one phase cannot inherit another phase's conversation.
- Obsidian runs with its own `--user-data-dir` (`%TEMP%\baizer-shots\chat-profile`)
  and its own `obsidian.json`; the user's real `%APPDATA%\obsidian` config and
  any already-running Obsidian instance are left alone.
- The plugin is copied from `--plugin-dir`; that directory must contain
  `main.js`, `manifest.json` and `styles.css`.

## Limitations

- A PNG cannot be asserted against; the JSON report carries the numeric checks.
- The seeded conversation and the streamed text are fixtures, not model output;
  the harness exercises the real rendering and scroll code paths, not a real
  provider request.
