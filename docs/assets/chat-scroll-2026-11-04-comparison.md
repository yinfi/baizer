# Chat scroll-follow — before/after evidence (issue #64)

Before: `cdcccb6` (main tip prior to this change) · After: `d07c182`

Scenario (identical in both phases): stream to bottom -> scroll up 1.3 screens -> more output arrives while paused -> stream done -> click back-to-latest

All numbers below are read directly from the `*.layout.json` reports that `tools/chat-scroll-shots/capture.mjs` wrote next to each PNG, from a real, CDP-driven Obsidian + built Baizer plugin — not estimated or hand-typed. See `tools/chat-scroll-shots/README.md` for what this does and does not prove (colour/contrast/animation are not asserted; the affordance is identified by its real `.shell-back-to-latest-button` selector, confirmed from `src/ui/scroll/back-to-latest-affordance.ts`).

`affordance.found` means the DOM node exists at all (the after-phase node is always mounted, hidden via a `baizer-hidden` class toggle); `visible`/`clickable` are what actually matters for "is it shown right now". The before phase has no such node at all, so `found` is `false` in every before capture.

## Wide (1353×1053, default sidebar width)

Parity: theme=dark, viewport={"width":1353,"height":1053}, sidebarWidthRequested=null, Obsidian exe version=1.14.5, Obsidian title version=1.15.0.

| Capture | Before scrollTop/Height/distFromBottom/atBottom | Before affordance | After scrollTop/Height/distFromBottom/atBottom | After affordance | No h-overflow (container/doc) |
|---|---|---|---|---|---|
| capture-1-scrolled-up-reading-anchor-preserved | 470.0 / 2023.0 / 878.0 / false | found=false visible=false clickable=false | 470.0 / 2023.0 / 878.0 / false | found=true visible=false clickable=false | before: true/true · after: true/true |
| capture-2-paused-with-new-output-arrived | 2167.3 / 2843.0 / 0.7 / true | found=false visible=false clickable=false | 1348.7 / 2885.0 / 861.3 / false | found=true visible=true clickable=true | before: true/true · after: true/true |
| capture-3-post-done-still-scrolled-up | 1539.3 / 2214.0 / -0.3 / true | found=false visible=false clickable=false | 721.3 / 2256.0 / 859.7 / false | found=true visible=true clickable=true | before: true/true · after: true/true |
| capture-4-post-click-resumed-follow-at-bottom | 1539.3 / 2214.0 / -0.3 / true | found=false visible=false clickable=false | 1538.7 / 2214.0 / 0.3 / true | found=true visible=false clickable=false | before: true/true · after: true/true |

Images: [before](<docs/assets/chat-scroll-2026-11-04-before-wide-capture-1-scrolled-up-reading-anchor-preserved.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-wide-capture-1-scrolled-up-reading-anchor-preserved.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-wide-capture-2-paused-with-new-output-arrived.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-wide-capture-2-paused-with-new-output-arrived.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-wide-capture-3-post-done-still-scrolled-up.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-wide-capture-3-post-done-still-scrolled-up.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-wide-capture-4-post-click-resumed-follow-at-bottom.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-wide-capture-4-post-click-resumed-follow-at-bottom.png>)

## Narrow sidebar (300px, acceptance criterion 5)

Parity: theme=dark, viewport={"width":1353,"height":1053}, sidebarWidthRequested=300, Obsidian exe version=1.14.5, Obsidian title version=1.15.0.

Sidedock resize (real `.workspace-split.mod-right-split` inline-style width, same mechanism as a user splitter drag): before requested 300px → measured 300px; after requested 300px → measured 300px.

| Capture | Before scrollTop/Height/distFromBottom/atBottom | Before affordance | After scrollTop/Height/distFromBottom/atBottom | After affordance | No h-overflow (container/doc) |
|---|---|---|---|---|---|
| capture-1-scrolled-up-reading-anchor-preserved | 1453.3 / 3006.0 / 877.7 / false | found=false visible=false clickable=false | 1453.3 / 3006.0 / 877.7 / false | found=true visible=false clickable=false | before: true/true · after: true/true |
| capture-2-paused-with-new-output-arrived | 3731.3 / 4411.0 / 4.7 / false | found=false visible=false clickable=false | 2330.7 / 4453.0 / 1447.3 / false | found=true visible=true clickable=true | before: true/true · after: true/true |
| capture-3-post-done-still-scrolled-up | 3060.0 / 3735.0 / 0.0 / true | found=false visible=false clickable=false | 1655.3 / 3777.0 / 1446.7 / false | found=true visible=true clickable=true | before: true/true · after: true/true |
| capture-4-post-click-resumed-follow-at-bottom | 3060.0 / 3735.0 / 0.0 / true | found=false visible=false clickable=false | 3060.0 / 3735.0 / 0.0 / true | found=true visible=false clickable=false | before: true/true · after: true/true |

Images: [before](<docs/assets/chat-scroll-2026-11-04-before-narrow300-capture-1-scrolled-up-reading-anchor-preserved.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-narrow300-capture-1-scrolled-up-reading-anchor-preserved.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-narrow300-capture-2-paused-with-new-output-arrived.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-narrow300-capture-2-paused-with-new-output-arrived.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-narrow300-capture-3-post-done-still-scrolled-up.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-narrow300-capture-3-post-done-still-scrolled-up.png>), [before](<docs/assets/chat-scroll-2026-11-04-before-narrow300-capture-4-post-click-resumed-follow-at-bottom.png>) / [after](<docs/assets/chat-scroll-2026-11-04-after-narrow300-capture-4-post-click-resumed-follow-at-bottom.png>)

## What changed, in one line per capture

- **capture-1** (scrolled up, no new output yet): unchanged in both phases — `isAtBottom:false`, affordance correctly absent/hidden (nothing unread yet).
- **capture-2** (new output arrives while paused): before — the baseline has no affordance code at all (`affordance.found:false` in every before capture); after — `affordance.found/visible/clickable:true`, pinned near the bottom of the visible scroll viewport (not off-screen), and the scroll position itself stays wherever the user left it instead of jumping.
- **capture-3** (stream `done` fires while still scrolled up): before — `isAtBottom` becomes `true` even though the user never asked to scroll (the exact bug in issue #64 — baseline's `scrollToEnd()` runs unconditionally); after — `isAtBottom` stays `false`, the reading position is preserved through stream completion.
- **capture-4** (after clicking the real button): before — there is nothing to click, so the view stays wherever `capture-3` left it; after — the click lands on the real `.shell-back-to-latest-button`, the view scrolls to the bottom (`isAtBottom:true`), and the affordance hides itself again.
- **300px sidebar** (acceptance criterion 5): both phases report `noHorizontalOverflow:true` at the container and document level; the after-phase affordance box width (140px) fits well inside the 236px scroll-container clientWidth with no overlap with the input area in any capture.

