# approval card after clicking 检查结果, 300px sidebar (before #76 vs after)

| Metric | Before | After |
| --- | --- | --- |
| Phase | before | after |
| Revision | 8bf2eda | 9107d99 |
| Browser (CDP) | Chrome/128.0.6613.186 | Chrome/128.0.6613.186 |
| Theme / locale | dark / zh | dark / zh |
| Sidebar width | 300px | 300px |
| Rendered view width | 276px | 276px |
| Card width x height | 209 x 456.3 | 209 x 424.95 |
| Card state class | shell-approval-card is-high-risk is-unknown | shell-approval-card is-high-risk is-failed |
| Decision button text |  |  |
| Button count | 1 | 1 |
| High-risk warning | (none) | (none) |
| No card overflow | true | true |
| No view overflow | true | true |
| Buttons inside card | true | true |
| No button overlap | true | true |
| Facts readable | true | true |
| All checks pass | false | false |

Changed rows: 4.

Evidence is produced by `tools/approval-card-shots/capture.mjs`: the real plugin is loaded into a throwaway vault, the real workbench view is opened, the approval scenario is injected into the tab projection, and the PNG plus these measurements come from the same DOM state.

Limitations: colour, contrast, font rendering and animation are not asserted; the screenshot is clipped to the workbench view.
