# Capture summary

Generated 2026-11-03T06:22:12.691Z by `tools/provider-settings-shots/capture-summary.mjs` from 6 layout reports.

Running app: Obsidian **1.15.0** (from window-title), theme dark, locale zh, baizer@1.1.0.
Executable FileVersion: 1.14.5 — **not** the app code that ran (see below).
Downloaded app bundles present (preferred over the exe): C:\Users\Administrator\AppData\Roaming\obsidian\obsidian-1.15.0.asar (24553884 B, 2026-11-02T16:28:14.380Z).

| capture | phase | revision | image | bytes | sha256 | viewport | type dropdown on screen | type options | Gemini option | allPass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| before-wide | before | `caf9703` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-before-wide.png) | 101628 | `728c503903a687ec…` | 1353x1053 | yes | Gemini API / OpenAI 兼容 / Anthropic Messages API | **present** | yes |
| before-narrow520 | before | `caf9703` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-before-narrow520.png) | 62673 | `ef18229515fe8f24…` | 520x900 | yes | Gemini API / OpenAI 兼容 / Anthropic Messages API | **present** | yes |
| before-typeoptions-wide | before | `caf9703` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-before-typeoptions-wide.png) | 103471 | `fadfb946a24cd7d3…` | 1353x1053 | yes (rendered as list) | Gemini API / OpenAI 兼容 / Anthropic Messages API | **present** | yes |
| after-wide | after | `c6b99e7` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-after-wide.png) | 101628 | `728c503903a687ec…` | 1353x1053 | yes | OpenAI 兼容 / Anthropic Messages API | absent | yes |
| after-narrow520 | after | `c6b99e7` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-after-narrow520.png) | 62673 | `ef18229515fe8f24…` | 520x900 | yes | OpenAI 兼容 / Anthropic Messages API | absent | yes |
| after-typeoptions-wide | after | `c6b99e7` | [png](docs/assets/provider-settings-2026-11-03-nogoogle-after-typeoptions-wide.png) | 103284 | `aaeb95f809ac8299…` | 1353x1053 | yes (rendered as list) | OpenAI 兼容 / Anthropic Messages API | absent | yes |

## Before/After pairs

| slot | viewport | before sha256 | after sha256 | identical | option list rendered |
| --- | --- | --- | --- | --- | --- |
| wide | 1353x1053 | `728c503903a687ec…` (101628 B) | `728c503903a687ec…` (101628 B) | **yes** | no |
| narrow520 | 520x900 | `ef18229515fe8f24…` (62673 B) | `ef18229515fe8f24…` (62673 B) | **yes** | no |
| typeoptions-wide | 1353x1053 | `fadfb946a24cd7d3…` (103471 B) | `aaeb95f809ac8299…` (103284 B) | no | yes |

Reading of each pair:

* **wide** — IDENTICAL, and correctly so: a closed <select> paints only its selected option, and the selected option is the same in both phases, so removing a protocol cannot appear in this bitmap. This pair documents that the surrounding layout is unchanged — it is NOT evidence that nothing changed. The option-list change is evidenced by providerTypeSelect.optionTexts in these layout reports and by the expanded (renderedAsList) pair.
* **narrow520** — IDENTICAL, and correctly so: a closed <select> paints only its selected option, and the selected option is the same in both phases, so removing a protocol cannot appear in this bitmap. This pair documents that the surrounding layout is unchanged — it is NOT evidence that nothing changed. The option-list change is evidenced by providerTypeSelect.optionTexts in these layout reports and by the expanded (renderedAsList) pair.
* **typeoptions-wide** — the two phases differ, and this pair renders the option list inline, so the removed option is visible in the bitmap

Option lists (the machine-checkable form of "the Gemini option is gone"):

* wide: before `["Gemini API","OpenAI 兼容","Anthropic Messages API"]` -> after `["OpenAI 兼容","Anthropic Messages API"]`
* narrow520: before `["Gemini API","OpenAI 兼容","Anthropic Messages API"]` -> after `["OpenAI 兼容","Anthropic Messages API"]`
* typeoptions-wide: before `["Gemini API","OpenAI 兼容","Anthropic Messages API"]` -> after `["OpenAI 兼容","Anthropic Messages API"]`

## Before/After parity

| check | result |
| --- | --- |
| sameObsidianVersionAcrossAllCaptures | PASS |
| obsidianVersionRecordedInEveryCapture | PASS |
| sameThemeAcrossAllCaptures | PASS |
| sameLocaleAcrossAllCaptures | PASS |
| sameScenarioAcrossAllCaptures | PASS |
| samePluginVersionAcrossAllCaptures | PASS |
| everyCaptureHasTypeSelectOnScreen | PASS |
| everyCaptureAllPass | PASS |
| beforeHasGeminiOption | PASS |
| afterHasNoGeminiOption | PASS |
| beforeAndAfterShareViewports | PASS |
| everySlotHasBothPhases | PASS |
| atLeastOnePairDiffersInPixels | PASS |

