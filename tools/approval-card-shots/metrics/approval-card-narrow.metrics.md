# approval card — 300px sidebar (276px rendered view)

| Metric | Before | After |
| --- | --- | --- |
| Phase | before | after |
| Revision | 65020a8 | 8fcadc4 |
| Browser (CDP) | Chrome/128.0.6613.186 | Chrome/128.0.6613.186 |
| Theme / locale | dark / zh | dark / zh |
| Sidebar width | 300px | 300px |
| Rendered view width | 276px | 276px |
| Card width x height | 209 x 336.59 | 209 x 453.88 |
| Card state class | shell-approval-card is-high-risk | shell-approval-card is-high-risk is-pending |
| Decision button text | (icon only) / (icon only) | 拒绝 / 批准本次删除 |
| Button count | 2 | 2 |
| High-risk warning | (none) | 高风险操作：将 删除 Projects/季度计划.md。批准后将立即执行，且可能无法撤销。 |
| No card overflow | true | true |
| No view overflow | true | true |
| Buttons inside card | true | true |
| No button overlap | true | true |
| Facts readable | true | true |
| All checks pass | false | true |

Changed rows: 7.

Evidence is produced by `tools/approval-card-shots/capture.mjs`: the real plugin is loaded into a throwaway vault, the real workbench view is opened, the approval scenario is injected into the tab projection, and the PNG plus these measurements come from the same DOM state.

Limitations: colour, contrast, font rendering and animation are not asserted; the screenshot is clipped to the workbench view.
