# approval-card-shots

Captures the Baizer approval card out of a **real, running Obsidian** and writes
a machine-readable layout report from the same DOM state.

This exists because the delivery requirements for the approval-card change are
visual and geometric (visible text buttons, readable action + object in a 300px
sidebar, no overflow) and the agent cannot look at a PNG. The PNG proves what
was on screen; the sibling `*.layout.json` proves the geometry.

It is **not** a mock-up generator:

* Obsidian is launched with `--remote-debugging-port`;
* the plugin is loaded from `--plugin-dir` into a throwaway vault;
* the real `baizer-shell-view` is opened and the scenario approval message is
  injected into that view's tab projection;
* the card is rendered by the production `renderApprovalCard()` with
  `styles.css`;
* the PNG comes from `Page.captureScreenshot`.

## Requirements

* Windows Node (the harness uses `taskkill`/`tasklist` and the Windows
  `Obsidian.exe`). It was run from WSL with the repo addressed through its
  `\\wsl$` UNC path.
* Obsidian installed; detected via `--obsidian`, `$env:OBSIDIAN_EXE`,
  `%LOCALAPPDATA%\Obsidian\Obsidian.exe`, or `%PROGRAMFILES%\Obsidian\Obsidian.exe`.
* A built plugin directory with `main.js`, `manifest.json`, `styles.css`.

## Usage

```powershell
node tools/approval-card-shots/capture.mjs `
  --plugin-dir dist `
  --out docs/assets/approval-card-2026-11-04-after-narrow.png `
  --width 300 --height 1000 `
  --phase after --revision <sha> --label after-narrow
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--plugin-dir` | *required* | Build directory (`dist` after `npm run build`) |
| `--out` | *required* | Output PNG |
| `--width` | `300` | Right-sidebar width; the view content is a little narrower |
| `--height` | `1000` | Window height |
| `--phase` | – | `before` / `after` |
| `--revision` | – | Git revision the plugin was built from |
| `--state` | `pending` | `pending` / `running` / `succeeded` / `failed` / `rejected` / `unknown` |
| `--theme` | `dark` | `dark` or `light` |
| `--locale` | `zh` | Obsidian UI language |
| `--port` | `9333` | DevTools port |
| `--keep-open` | off | Leave Obsidian running |

Each run writes `<name>.layout.json` next to the PNG. The report contains the
card geometry, button labels/disabled state, fact readability, overflow checks,
and a `verdict.allPass` for the pending card. The lifecycle states
(`running`/`succeeded`/…) are after-only supplementary captures; their
`allPass` is not expected to be true because they deliberately have no pending
decision buttons.

The harness kills every `Obsidian.exe` process and waits for it to exit before
each run. It also deletes the throwaway vault's `workspace.json` so the workbench
leaf starts in the right sidebar rather than being restored into the editor
area from the previous run.

## Comparing a pair

```bash
node tools/approval-card-shots/compare.mjs \
  --before docs/assets/approval-card-2026-11-04-before-narrow.layout.json \
  --after  docs/assets/approval-card-2026-11-04-after-narrow.layout.json \
  --title  "approval card, 300px sidebar" \
  --out    tools/approval-card-shots/metrics/approval-card-narrow.metrics.md
```

It writes a Markdown table plus a `.json` twin, marking every row that changed.

## Limitations

Recorded in every report:

* colour, contrast, font rendering and animation are not asserted;
* the scenario is injected as data into the real view; the card renderer and
  stylesheet are the production ones;
* the screenshot is clipped to the workbench view, so Obsidian chrome outside
  it is not evidence.
