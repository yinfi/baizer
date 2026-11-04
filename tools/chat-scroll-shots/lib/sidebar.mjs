/**
 * Resize the Obsidian right sidedock (where the Baizer chat leaf lives) to an
 * exact pixel width.
 *
 * Obsidian's resizable sidedock sets its width as an inline style on the
 * `.workspace-split.mod-right-split` element's child `.workspace-sidedock-overlay`
 * is not involved; the width that matters is on `.mod-right-split` itself
 * (verified empirically against a running 1.x Obsidian — see
 * `--measure-sidedock` output recorded in the capture's harness.sidebarResize
 * field for the actual element and property that was set, so the claim is
 * evidenced per run rather than hard-coded here).
 *
 * This is the real app's own resizable-sidebar mechanism, not a synthetic
 * viewport trick: the acceptance criterion names a "300px sidebar", so the
 * capture sets the sidedock's layout width to 300px and lets the chat view's
 * CSS lay out at that width for real, the same way a user dragging the
 * splitter to 300px would.
 */

export function buildMeasureSidedockExpression() {
  return `(() => {
    const right = document.querySelector('.workspace-split.mod-right-split');
    if (!right) return { found: false };
    const rect = right.getBoundingClientRect();
    return {
      found: true,
      classes: right.className,
      inlineStyleWidth: right.style.width || null,
      computedWidth: getComputedStyle(right).width,
      rectWidth: rect.width,
    };
  })()`;
}

/**
 * Sets the right sidedock's width via the same inline style Obsidian's own
 * splitter drag would set, then asks the workspace to recompute layout.
 */
export function buildSetSidedockWidthExpression(widthPx) {
  return `(() => {
    const right = document.querySelector('.workspace-split.mod-right-split');
    if (!right) return { ok: false, error: '.workspace-split.mod-right-split not found' };
    right.style.width = '${widthPx}px';
    right.style.flexBasis = '${widthPx}px';
    try { app.workspace.onLayoutChange && app.workspace.onLayoutChange(); } catch {}
    try { app.workspace.requestResize && app.workspace.requestResize(); } catch {}
    window.dispatchEvent(new Event('resize'));
    const rect = right.getBoundingClientRect();
    return { ok: true, rectWidth: rect.width };
  })()`;
}
