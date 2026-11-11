# thinking-shots

Captures the Baizer **thinking timeline** out of a real, running Obsidian — for
the Before/After evidence on issue #178 ("美化 think 展示内容和动效").

This is not a mock-up generator. Obsidian is launched with
`--remote-debugging-port`, the shell view is driven over CDP through the real
`StreamController`, and the PNG comes from `Page.captureScreenshot`. A sibling
`*.layout.json` records the facts a bitmap cannot be asserted against.

## Why the layout report exists

A PNG cannot be asserted against, and the agent that produced these captures
cannot judge them by eye. So every criterion that can be expressed as a DOM
measurement is measured in the page, next to the screenshot, from the same DOM
state:

| assertion | what it holds |
| --- | --- |
| `collapsedBodiesAreZeroHeight` | a finished segment's body really is 0 px tall, not just invisible |
| `collapsedBodiesLeaveA11yTree` | that body is `visibility: hidden`, so a screen reader does not read a collapsed step |
| `expandedBodiesAreVisible` | the live segment's body is visible and has height |
| `contentKeepsLineBreaks` | thinking text is `white-space: pre-wrap` — the model's line breaks survive |
| `expandedBodiesHavePadding` | the body card has real inner padding, text does not touch the border |
| `expandedCaretPointsDown` / `collapsedCaretPointsRight` | the caret points the way the fold actually goes |
| `activeSegmentHasBlinkingCursor` | the live segment's `::after` is running `cursor-blink` |
| `summaryShowsLiveDot` | the summary row's `::before` is running `think-pulse` while streaming |
| `timelineLiveMarkCleared` / `summaryHasNoLiveDot` | after the turn settles, neither is left lit |
| `noOutputHorizontalOverflow` | the timeline does not push a horizontal scrollbar onto the output area |

Anything that genuinely cannot be asserted programmatically belongs in
`report.limitations`, not in a guess.

## Scenarios

Both scenarios feed the same three paragraphs through
`view.handleStreamEvent({ type: 'thinking', ... })`. The first two end on a blank
line, so the renderer commits them as finished (collapsed) segments; the third
has no trailing blank line, so it stays the live, expanding segment.

| `--scenario` | Behaviour |
| --- | --- |
| `streaming` | measured and captured mid-turn: two folded steps + one live step |
| `settled` | the same turn finalised as `completed` (timeline folded, summary settled) |

## Requirements

* **Windows host with Obsidian installed** (the captures use 1.14.5, detected at
  `--obsidian <path>`, else `$env:OBSIDIAN_EXE`, else the standard install
  locations) and **Node >= 22**.
* A built plugin: a directory with `main.js`, `manifest.json`, `styles.css`
  (`npm run build` → `dist/`).

The script launches an **isolated** Obsidian instance (`--user-data-dir` plus a
ticket-scoped vault under `%TEMP%\baizer-shots`), so it does not disturb a
developer's own vault.

## Usage

```powershell
node tools/thinking-shots/capture.mjs `
  --plugin-dir dist --scenario streaming `
  --out docs/assets/thinking-2026-11-11-streaming-after.png `
  --label streaming-after --phase after --revision <sha> `
  --obsidian "C:\obs-1.14.5-installed\Obsidian\Obsidian.exe"
```

Repeat with `--plugin-dir` pointing at the baseline build, `--phase before` and
the baseline revision for the comparison capture. Use the same scenario,
viewport and theme for both phases.
