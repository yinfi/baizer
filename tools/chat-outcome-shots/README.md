# chat-outcome-shots

Captures the Baizer chat view's terminal states (failed / cancelled / completed)
out of a real, running Obsidian — for the Before/After evidence required by
issue #65 ("聊天终态区分（成功/失败/取消）与失败保留现场").

This is not a mock-up generator. Obsidian is launched with
`--remote-debugging-port`, the renderer is driven over CDP, and the PNG comes
from `Page.captureScreenshot`. A sibling `*.chat.json` records the facts a
bitmap cannot be asserted against: which terminal card is present, whether the
retry / restore-draft buttons exist, the restored input text, the system
messages, and the preserved partial answer.

## Deterministic streams

A local OpenAI-compatible SSE server provides the streams (and answers the
CORS preflight that `app://obsidian.md` requires):

| `--scenario` | Behaviour |
| --- | --- |
| `failure` | streams a partial answer, then destroys the socket mid-stream |
| `cancel` | streams slowly so the driver can click Stop |
| `success` | streams a short answer to completion |

## Requirements

* **Windows host with Obsidian installed** (the captures in `docs/assets/` use
  Obsidian 1.15.0) and **Node >= 22** on Windows.
* A built plugin: a directory with `main.js`, `manifest.json`, `styles.css`
  (`npm run build` → `dist/`).

The script launches an **isolated** Obsidian instance (`--user-data-dir` plus a
ticket-scoped vault under `%TEMP%\baizer-chat-outcome-65`), so it does not
disturb a developer's own vault and survives other capture harnesses running
concurrently on the same machine.

## Usage

```powershell
node tools/chat-outcome-shots/capture.mjs `
  --plugin-dir dist `
  --scenario failure `
  --out docs/assets/chat-outcome-2026-11-04-failed-after.png `
  --label failed-after --phase after --revision <sha> `
  --width 1100 --height 900
```

Repeat with `--plugin-dir` pointing at the baseline build, `--phase before`,
and the baseline revision for the comparison capture. Use the same scenario,
viewport and theme for both phases.
