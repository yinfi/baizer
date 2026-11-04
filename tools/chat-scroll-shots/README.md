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
