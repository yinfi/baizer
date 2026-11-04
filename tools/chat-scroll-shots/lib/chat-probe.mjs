/**
 * Page-side layout/scroll probe for the Baizer chat view (`ShellView`,
 * `VIEW_TYPE_SHELL`).
 *
 * `collectChatScrollReport` is stringified and evaluated inside the Obsidian
 * renderer over CDP (`Runtime.evaluate`, `returnByValue: true`). It must stay
 * self-contained: no imports, no closure over module scope. Everything it
 * needs arrives through the `cfg` argument.
 *
 * It exists because issue #64's acceptance criteria are scroll-geometry and
 * affordance-visibility claims ("the viewport is not pulled to the bottom",
 * "the entry is visible and clickable", "no horizontal overflow at 300px") —
 * none of which a PNG alone can be asserted against. Every criterion that can
 * be expressed as a DOM measurement is measured here, next to the screenshot,
 * from the same DOM state.
 */

export function buildChatProbeExpression(cfg) {
  return `(() => {
    const cfg = ${JSON.stringify(cfg)};
    ${collectChatScrollReport.toString()}
    return collectChatScrollReport(cfg);
  })()`;
}

export function collectChatScrollReport(cfg) {
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const boxOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height), right: round(r.right), bottom: round(r.bottom) };
  };
  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isClickable = (el) => {
    if (!el || !isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const atPoint = document.elementFromPoint(cx, cy);
    return !!(atPoint && (atPoint === el || el.contains(atPoint) || atPoint.contains(el)));
  };

  const app = window.app;
  const report = {
    schema: 'baizer-chat-scroll-layout/1',
    label: cfg.label ?? null,
    phase: cfg.phase ?? null,
    revision: cfg.revision ?? null,
    scenarioStep: cfg.scenarioStep ?? null,
    capturedAt: new Date().toISOString(),
    limitations: [
      'Colour, contrast, font rendering, animation smoothness and scroll-behavior easing are NOT asserted; this probe only measures geometry, scroll offsets and text reachability.',
      'The affordance ("有新输出 · 回到最新" / "back to latest") is located by data-testid/class-name heuristics with a text-content fallback; if the implementation names it something this probe does not anticipate, affordance.found will be false and that is reported as a limitation, not assumed absent in the UI.',
      'Only the geometry of the FIRST matching affordance element is reported; if more than one element matches the heuristics, affordanceCandidates lists all of them.',
    ],
  };

  report.obsidianVersionInPage = (() => {
    const candidates = [window.OBSIDIAN_VERSION, app && app.version, app && app.appVersion];
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate) return candidate;
    const fromTitle = (document.title || '').match(/Obsidian\\s+(\\d+(?:\\.\\d+)+)/);
    if (fromTitle) return fromTitle[1];
    return null;
  })();
  report.windowTitle = document.title || null;
  report.theme = document.body.classList.contains('theme-dark')
    ? 'dark'
    : document.body.classList.contains('theme-light') ? 'light' : null;

  report.plugin = (() => {
    try {
      const p = app.plugins.plugins[cfg.pluginId || 'baizer'];
      return { id: cfg.pluginId || 'baizer', loaded: !!p, version: p && p.manifest ? p.manifest.version : null };
    } catch {
      return { id: cfg.pluginId || 'baizer', loaded: false, version: null };
    }
  })();

  report.viewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };

  // ---------------------------------------------------------- leaf / view ----
  const leafContent = document.querySelector('.workspace-leaf-content:has(.baizer-shell-view)');
  const shellRoot = document.querySelector('.baizer-shell-view');
  const outputArea = document.querySelector('.shell-output-area');

  report.leaf = {
    found: !!leafContent,
    box: boxOf(leafContent),
  };
  report.shellRoot = { found: !!shellRoot, box: boxOf(shellRoot) };

  // ------------------------------------------------------ scroll container ----
  if (outputArea) {
    const scrollTop = outputArea.scrollTop;
    const scrollHeight = outputArea.scrollHeight;
    const clientHeight = outputArea.clientHeight;
    const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
    report.scroll = {
      found: true,
      box: boxOf(outputArea),
      scrollTop: round(scrollTop),
      scrollHeight: round(scrollHeight),
      clientHeight: round(clientHeight),
      distanceFromBottom: round(distanceFromBottom),
      isAtBottom: distanceFromBottom <= 2,
      scrollWidth: round(outputArea.scrollWidth),
      clientWidth: round(outputArea.clientWidth),
      noHorizontalOverflow: outputArea.scrollWidth <= outputArea.clientWidth + 1,
    };
  } else {
    report.scroll = { found: false };
  }

  // ------------------------------------------------------- document overflow ----
  report.overflow = {
    document: {
      scrollWidth: round(document.documentElement.scrollWidth),
      clientWidth: round(document.documentElement.clientWidth),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    },
  };

  // ---------------------------------------------------------------- affordance ----
  // Heuristic search: the fix has not necessarily landed (baseline phase), and even
  // once it has, this probe should not hard-code one exact selector the implementation
  // might not use. Looks for likely class/data-testid names first, then falls back to
  // scanning clickable elements inside the shell view whose text matches the issue's
  // Chinese affordance copy ("回到最新" / "有新输出") or an English equivalent
  // ("new message" / "back to latest" / "jump to latest").
  const affordanceSelectorCandidates = [
    '.shell-jump-to-latest', '.shell-scroll-affordance', '.shell-new-output',
    '.shell-resume-follow', '.shell-back-to-latest', '[data-testid="scroll-to-latest"]',
    '[data-testid="jump-to-latest"]', '[data-testid="new-output-affordance"]',
  ];
  let affordanceEls = [];
  for (const sel of affordanceSelectorCandidates) {
    try {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) affordanceEls.push(...found);
    } catch {
      // An invalid/unsupported selector for this Electron/Chromium build should not abort the
      // whole probe; just skip that one candidate and keep trying the rest.
    }
  }
  // The actual implementation (src/ui/scroll/back-to-latest-affordance.ts) renders a wrapper
  // `.shell-back-to-latest` (visibility toggled via the shared `baizer-hidden` class) containing
  // the real clickable `<button class="shell-back-to-latest-button">`. When a class-name match
  // above found the wrapper, resolve down to that inner button so box/clickable/click-target
  // describe the element a user would actually click, not its (non-interactive) container.
  affordanceEls = affordanceEls.map((el) => {
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return el;
    const innerButton = el.querySelector('button, [role="button"]');
    return innerButton || el;
  });
  if (affordanceEls.length === 0 && shellRoot) {
    // Deliberately narrow: only elements that behave like a real actionable control
    // (an actual <button> or an explicit role="button", never an <a> or a generic
    // tabindex div, which are too common in prose/markdown rendering) AND whose own
    // text — not an ancestor's — is short, like a label/pill, not a sentence of
    // streamed prose that happens to contain a matching substring.
    const textRe = /^(有新输出|回到最新|有新输出\s*[·|]\s*回到最新|new message|back to latest|jump to latest|scroll to latest|resume (auto[- ]?)?scroll)/i;
    const candidates = Array.from(shellRoot.querySelectorAll('button, [role="button"]'));
    affordanceEls = candidates.filter((el) => {
      const ownText = (el.textContent || '').trim();
      return ownText.length > 0 && ownText.length < 40 && textRe.test(ownText);
    });
  }
  affordanceEls = Array.from(new Set(affordanceEls));
  const primaryAffordance = affordanceEls[0] || null;
  // The issue's actual constraint (acceptance criterion 3) is "must not cover the
  // message area or the INPUT area" — not "must not overlap its own scroll
  // container", which it is expected to (it floats above the scroll container's
  // own bottom edge by design). The input/toolbar lives in a sibling of
  // `.shell-output-area` inside `.baizer-shell-view` (see shell-view.ts onOpen:
  // header, then `.shell-output-area`, then the input toolbar below it), so the
  // meaningful check is overlap with THAT sibling, not with the scroll container.
  const inputAreaCandidates = shellRoot
    ? Array.from(shellRoot.querySelectorAll(
        '.shell-input-area, .shell-input-toolbar, .shell-input-container, textarea, [contenteditable="true"]',
      )).filter((el) => outputArea && !outputArea.contains(el))
    : [];
  const overlapsEl = (a, b) => {
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const overlapW = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const overlapH = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    return overlapW > 0 && overlapH > 0;
  };
  report.affordance = {
    found: !!primaryAffordance,
    visible: isVisible(primaryAffordance),
    clickable: isClickable(primaryAffordance),
    box: boxOf(primaryAffordance),
    text: primaryAffordance ? (primaryAffordance.textContent || '').trim().slice(0, 80) : null,
    classes: primaryAffordance ? primaryAffordance.className : null,
    withinOutputArea: !!(outputArea && primaryAffordance && outputArea.contains(primaryAffordance)),
    overlapsInputArea: primaryAffordance && inputAreaCandidates.length
      ? inputAreaCandidates.some((el) => overlapsEl(primaryAffordance, el))
      : (inputAreaCandidates.length === 0 ? null : false),
    inputAreaCandidatesFound: inputAreaCandidates.length,
  };
  report.affordanceCandidates = affordanceEls.map((el) => ({
    classes: el.className,
    text: (el.textContent || '').trim().slice(0, 80),
    box: boxOf(el),
    visible: isVisible(el),
  }));

  // ------------------------------------------------------------- content check ----
  const streamContainers = shellRoot ? shellRoot.querySelectorAll('.shell-entry') : [];
  const timelines = shellRoot ? shellRoot.querySelectorAll('.shell-think-timeline') : [];
  report.content = {
    entryCount: streamContainers.length,
    timelineCount: timelines.length,
    timelineCollapsedCount: Array.from(timelines).filter((t) => t.classList.contains('is-collapsed')).length,
  };

  // ------------------------------------------------------ followPaused (best-effort) ----
  // Not every revision exposes follow state on the DOM; report what is observable and
  // let the harness's own scroll bookkeeping (scrollTop before/after a stream tick) be
  // the authoritative signal recorded alongside this report.
  report.followHintFromDom = (() => {
    if (!outputArea) return null;
    const attr = outputArea.getAttribute('data-follow-paused');
    if (attr !== null) return attr === 'true';
    return null;
  })();

  return report;
}
