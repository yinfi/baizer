/**
 * Page-side layout probe.
 *
 * `collectLayoutReport` is stringified and evaluated inside the Obsidian
 * renderer over CDP (`Runtime.evaluate`, `returnByValue: true`). It must
 * therefore be completely self-contained: no imports, no closure over module
 * scope. Everything it needs arrives through the `cfg` argument.
 *
 * It exists because the delivery requirements for the provider-settings work
 * are about *measurable* layout properties (no horizontal overflow, no
 * overlapping controls, no unreachable truncated values, aligned label/value
 * columns). A PNG alone cannot be asserted against, so every criterion that can
 * be expressed as a DOM measurement is measured here, next to the screenshot,
 * from the same DOM state.
 */

/**
 * @param {object} cfg
 * @param {string} [cfg.label]            e.g. "before-wide"
 * @param {string} [cfg.phase]            "before" | "after"
 * @param {string} [cfg.revision]         git revision the built plugin came from
 * @param {string} [cfg.pluginDir]        directory the plugin was installed from
 * @param {string} [cfg.obsidianVersion]  version resolved from the executable metadata
 * @param {string} [cfg.expectedTheme]    "dark" | "light"
 */
export function collectLayoutReport(cfg) {
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const classOf = (el) => (el && typeof el.className === 'string' ? el.className : null);
  const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height), right: round(r.right), bottom: round(r.bottom) };
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: classOf(el),
    text: textOf(el).slice(0, 120) || null,
  });
  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d');
  const textWidth = (el, value) => {
    const cs = getComputedStyle(el);
    ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return round(ctx2d.measureText(value).width);
  };

  const app = window.app;
  const report = {
    schema: 'baizer-provider-settings-layout/1',
    label: cfg.label ?? null,
    phase: cfg.phase ?? null,
    revision: cfg.revision ?? null,
    pluginDir: cfg.pluginDir ?? null,
    capturedAt: new Date().toISOString(),
    limitations: [
      'Colour, contrast, font rendering, iconography and animation are NOT asserted; this probe only measures geometry and text reachability.',
      'Overlap is checked only between interactive controls (input/select/textarea/button) inside the active provider detail area, as agreed.',
      'Horizontal overflow is asserted at the document level, per named settings container, and as element-vs-panel spill; an element clipped by an ancestor is detected by the offender scan but not attributed to that ancestor.',
      'A truncated <input>/<textarea>/<select> value counts as reachable because the user can focus, scroll and edit it; only truncated values with no reachable form (disabled and no title) are treated as failures.',
    ],
  };

  // ---------------------------------------------------------------- meta ----
  report.obsidianVersionInPage = (() => {
    const candidates = [window.OBSIDIAN_VERSION, app && app.version, app && app.appVersion];
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate) return candidate;
    return null;
  })();
  report.obsidianVersionFromExe = cfg.obsidianVersion ?? null;
  report.theme = document.body.classList.contains('theme-dark')
    ? 'dark'
    : document.body.classList.contains('theme-light')
      ? 'light'
      : 'unknown';
  report.expectedTheme = cfg.expectedTheme ?? null;
  report.themeMatchesExpectation = cfg.expectedTheme ? report.theme === cfg.expectedTheme : null;
  report.language = document.documentElement.lang || null;
  report.momentLocale = (window.moment && typeof window.moment.locale === 'function' && window.moment.locale()) || null;
  report.viewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    documentClientWidth: document.documentElement.clientWidth,
    documentClientHeight: document.documentElement.clientHeight,
  };
  report.plugin = (() => {
    const instance = app && app.plugins && app.plugins.plugins && app.plugins.plugins.baizer;
    if (instance) {
      return {
        loaded: true,
        id: (instance && instance.manifest && instance.manifest.id) || null,
        version: (instance && instance.manifest && instance.manifest.version) || null,
        source: 'app global (this window)',
      };
    }
    // No `app` here (popped-out settings window): the caller read the plugin
    // facts off the main window and passed them in.
    if (cfg.pluginInfo) return { ...cfg.pluginInfo, source: cfg.pluginInfo.source || 'cfg.pluginInfo' };
    return { loaded: false, id: null, version: null, source: 'unavailable' };
  })();

  report.windowTitle = document.title;
  // A popped-out settings window is a *separate* renderer: it has the settings
  // DOM but no `app` global, so `app`-derived facts have to be supplied by the
  // caller from the main window (see cfg.pluginInfo / cfg.obsidianVersion).
  report.appGlobalAvailable = !!app;

  // ------------------------------------------------------------ presence ----
  const SEL = {
    settingsModal: '.modal.mod-settings',
    settingsPage: '.baizer-settings-page',
    providerShell: '.baizer-settings-provider-shell',
    providerList: '.baizer-settings-provider-list',
    activeProviderCard: '.baizer-settings-provider-card.is-active',
    activeProviderDetail: '.baizer-settings-provider-detail-inline',
    // The rework renamed this container (connection-detail-grid -> connection-flow).
    // Match either so the same probe can measure the before and the after revision.
    connectionGrid: '.baizer-settings-connection-flow, .baizer-settings-connection-detail-grid',
  };
  const nodes = {};
  report.presence = {};
  for (const key of Object.keys(SEL)) {
    nodes[key] = document.querySelector(SEL[key]);
    report.presence[key] = !!nodes[key];
  }
  report.settingsModalBox = nodes.settingsModal ? boxOf(nodes.settingsModal) : null;
  report.settingsPageBox = nodes.settingsPage ? boxOf(nodes.settingsPage) : null;

  report.providerCards = Array.from(document.querySelectorAll('.baizer-settings-provider-card')).map((card) => ({
    active: card.classList.contains('is-active'),
    title: textOf(card.querySelector('.baizer-settings-provider-card-title')),
    meta: textOf(card.querySelector('.baizer-settings-provider-card-meta')),
    box: boxOf(card),
  }));
  report.connectionCards = Array.from(document.querySelectorAll('.baizer-settings-connection-card')).map((card) => ({
    title: textOf(card.querySelector('.baizer-settings-connection-card-title')),
    box: boxOf(card),
  }));

  // ------------------------------------------------------------ overflow ----
  const de = document.documentElement;
  report.overflow = {
    document: {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowPx: round(de.scrollWidth - de.clientWidth),
      ok: de.scrollWidth <= de.clientWidth,
    },
    containers: [],
    offenders: [],
    offenderCount: 0,
    spill: [],
    spillCount: 0,
  };

  const containerSelectors = [
    '.modal.mod-settings',
    '.modal.mod-settings .vertical-tab-content',
    '.baizer-settings-page',
    '.baizer-settings-provider-shell',
    '.baizer-settings-provider-list',
    '.baizer-settings-provider-card.is-active',
    '.baizer-settings-provider-detail-inline',
    '.baizer-settings-connection-flow, .baizer-settings-connection-detail-grid',
  ];
  for (const selector of containerSelectors) {
    const el = document.querySelector(selector);
    if (!el) {
      report.overflow.containers.push({ selector, found: false });
      continue;
    }
    const cs = getComputedStyle(el);
    report.overflow.containers.push({
      selector,
      found: true,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowPx: round(el.scrollWidth - el.clientWidth),
      overflowX: cs.overflowX,
      box: boxOf(el),
      ok: el.scrollWidth <= el.clientWidth + 1,
    });
  }
  for (const [index, card] of Array.from(document.querySelectorAll('.baizer-settings-connection-card')).entries()) {
    report.overflow.containers.push({
      selector: `.baizer-settings-connection-card[${index}] ${textOf(card.querySelector('.baizer-settings-connection-card-title'))}`,
      found: true,
      clientWidth: card.clientWidth,
      scrollWidth: card.scrollWidth,
      overflowPx: round(card.scrollWidth - card.clientWidth),
      overflowX: getComputedStyle(card).overflowX,
      box: boxOf(card),
      ok: card.scrollWidth <= card.clientWidth + 1,
    });
  }

  const scope = nodes.settingsPage || nodes.settingsModal || document.body;
  for (const el of scope.querySelectorAll('*')) {
    if (!isVisible(el)) continue;
    const delta = el.scrollWidth - el.clientWidth;
    if (delta <= 1) continue;
    const cs = getComputedStyle(el);
    report.overflow.offenders.push({
      ...describe(el),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowPx: round(delta),
      overflowX: cs.overflowX,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      clipsContent: ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowX),
    });
  }
  report.overflow.offenderCount = report.overflow.offenders.length;
  report.overflow.offenders = report.overflow.offenders.slice(0, 60);

  const panelRect = scope.getBoundingClientRect();
  for (const el of scope.querySelectorAll('*')) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const overRight = r.right - panelRect.right;
    const overLeft = panelRect.left - r.left;
    if (overRight > 1 || overLeft > 1) {
      report.overflow.spill.push({
        ...describe(el),
        overRight: round(overRight),
        overLeft: round(overLeft),
        box: boxOf(el),
      });
    }
  }
  report.overflow.spillCount = report.overflow.spill.length;
  report.overflow.spill = report.overflow.spill.slice(0, 60);

  // ------------------------------------------------------------- overlap ----
  const detailRoot = nodes.activeProviderDetail || nodes.providerShell || scope;
  const controls = Array.from(detailRoot.querySelectorAll('input, select, textarea, button')).filter(isVisible);
  report.overlap = { root: describe(detailRoot), controlCount: controls.length, pairs: [] };
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i].getBoundingClientRect();
      const b = controls[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 0.5 && oy > 0.5) {
        report.overlap.pairs.push({
          a: describe(controls[i]),
          b: describe(controls[j]),
          overlapW: round(ox),
          overlapH: round(oy),
          overlapArea: round(ox * oy),
        });
      }
    }
  }

  // ---------------------------------------------------------- truncation ----
  const cardByTitle = (re) =>
    Array.from(document.querySelectorAll('.baizer-settings-connection-card')).find((card) =>
      re.test(textOf(card.querySelector('.baizer-settings-connection-card-title'))),
    ) || null;
  // The rework regrouped the two old cards (基本 / 凭据) into four
  // (服务商身份与协议 / 连接地址与凭证 / 模型 / 测试结果). Match either wording, and fall back to
  // positional cards, so the SAME probe measures before and after. Otherwise a pure rename
  // shows up as "field not found", which reads like a regression that never happened.
  const allCards = Array.from(document.querySelectorAll('.baizer-settings-connection-card'));
  const identityCard = cardByTitle(/identity|身份|basic|基本/i) || allCards[0] || null;
  const credentialsCard = cardByTitle(/credential|凭据|凭证|address|地址/i) || allCards[1] || null;
  const modelCard = cardByTitle(/^(model|模型)$/i) || null;

  const findField = (root, re) => {
    if (!root) return null;
    for (const row of root.querySelectorAll('.baizer-settings-detail-row')) {
      const label = textOf(row.querySelector('.baizer-settings-detail-label'));
      if (re.test(label)) return { row, label, control: row.querySelector('input, select, textarea') };
    }
    
    return null;
  };
  // The rework moved Custom headers out of a detail row and into a collapsible
  // `<details class="baizer-settings-advanced">` whose `<summary>` carries the label, so a
  // detail-row search alone would report the field as "not found" (i.e. a phantom regression).
  const findAdvancedField = (re) => {
    for (const details of document.querySelectorAll('details.baizer-settings-advanced')) {
      const summary = details.querySelector('summary');
      const label = textOf(summary);
      if (re.test(label)) {
        return { row: details, label, control: details.querySelector('textarea, input, select') };
      }
    }
    return null;
  };
  const controlValue = (el) =>
    el.tagName.toLowerCase() === 'select' ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value) : el.value;

  const measureField = (name, field) => {
    if (!field || !field.control) return { name, found: false, label: field ? field.label : null };
    const el = field.control;
    const cs = getComputedStyle(el);
    const value = controlValue(el) ?? '';
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const available = round(el.clientWidth - padL - padR);
    const rendered = textWidth(el, value);
    const tag = el.tagName.toLowerCase();
    const multiline = tag === 'textarea';
    const textOverflowsBox = !multiline && rendered != null && available != null && rendered > available + 0.5;
    const disabled = !!el.disabled;
    const title = el.getAttribute('title');
    return {
      name,
      found: true,
      label: field.label,
      tag,
      type: el.type ?? null,
      value,
      valueLength: value.length,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      paddingLeft: padL,
      paddingRight: padR,
      availableTextWidth: available,
      renderedTextWidth: rendered,
      textOverflowsBox,
      contentScrolls: el.scrollWidth > el.clientWidth + 1,
      disabled,
      readOnly: !!el.readOnly,
      titleAttribute: title,
      multiline,
      // Reachable = the user can still read the whole value: editable field,
      // scrollable field, dropdown, or an explicit tooltip.
      fullValueReachable: !!title || !disabled || ['input', 'textarea', 'select'].includes(tag),
      box: boxOf(el),
    };
  };

  report.truncation = {
    fields: [
      measureField('apiEndpoint', findField(credentialsCard, /endpoint|端点|服务地址|base\s*url|地址/i)),
      measureField('apiKey', findField(credentialsCard, /api\s*key/i)),
      measureField('customHeaders', findField(credentialsCard, /header|请求头/i) || findAdvancedField(/header|请求头/i)),
      measureField('providerName', findField(identityCard, /name|名称/i)),
      measureField('protocol', findField(identityCard, /protocol|协议|api\s*类型|类型/i)),
      // 模型 moved out of the basic card into its own group; fall back for the old revision.
      measureField('model', findField(modelCard || identityCard, /^(model|模型)$/i)),
    ],
    ellipsizedStaticText: [],
  };
  for (const el of scope.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' || cs.whiteSpace !== 'nowrap') continue;
    if (!isVisible(el)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    report.truncation.ellipsizedStaticText.push({
      ...describe(el),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      value: textOf(el),
    });
  }
  report.truncation.ellipsizedStaticText = report.truncation.ellipsizedStaticText.slice(0, 30);

  // ------------------------------------------------------------ wrapping ----
  // The custom-headers help used to be one `.baizer-settings-inline-note`; the rework moved it
  // into the collapsible advanced body as two `.baizer-settings-field-hint` blocks plus a `<pre>`
  // example. Collect every equivalent block so before/after are measured the same way.
  const measureHelpBlock = (el) => {
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || null;
    // `line-height: normal` is not a number, so count real line boxes instead.
    const lineBoxes = (() => {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const count = range.getClientRects().length;
        if (typeof range.detach === 'function') range.detach();
        return count || null;
      } catch {
        return null;
      }
    })();
    return {
      ...describe(el),
      text: textOf(el),
      box: boxOf(el),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      lineHeight,
      lineCount: lineBoxes ?? (lineHeight ? Math.round(el.scrollHeight / lineHeight) : null),
      overflowsHorizontally: el.scrollWidth > el.clientWidth + 1,
      clippedVertically: el.scrollHeight > el.clientHeight + 1,
      // A closed <details> hides its body: clientWidth 0 would make the clipping checks below
      // pass vacuously, so visibility is asserted explicitly.
      visible: isVisible(el) && el.clientWidth > 0,
      parentBox: el.parentElement ? boxOf(el.parentElement) : null,
      siblingRows: el.parentElement
        ? new Set(Array.from(el.parentElement.children).filter(isVisible).map((c) => Math.round(c.getBoundingClientRect().top))).size
        : null,
    };
  };
  const helpBlocks = Array.from(
    document.querySelectorAll('.baizer-settings-field-hint, .baizer-settings-header-example, .baizer-settings-inline-note'),
  )
    .filter((el) => /conversationId|Header-Name|每行一条/i.test(textOf(el)))
    .map(measureHelpBlock);
  if (helpBlocks.length) {
    report.wrapping = {
      // Kept as the "primary" block for continuity with the pre-rework reports; the rework
      // splits the same content across `blocks`.
      customHeadersHelp: { found: true, ...helpBlocks[0], blockCount: helpBlocks.length, blocks: helpBlocks },
    };
  } else {
    report.wrapping = { customHeadersHelp: { found: false, blockCount: 0, blocks: [] } };
  }

  // Renamed in the rework (detail-secret-actions -> field-actions); match either.
  const secretActions = document.querySelector('.baizer-settings-field-actions, .baizer-settings-detail-secret-actions');
  if (secretActions) {
    const buttons = Array.from(secretActions.querySelectorAll('button')).filter(isVisible);
    const boxes = buttons.map(boxOf);
    report.wrapping.secretActionButtons = {
      found: true,
      count: buttons.length,
      buttons: buttons.map((b, i) => ({ text: textOf(b), box: boxes[i] })),
      containerBox: boxOf(secretActions),
      containerClientWidth: secretActions.clientWidth,
      containerScrollWidth: secretActions.scrollWidth,
      distinctRows: new Set(boxes.map((b) => Math.round(b.y))).size,
      wrappedOntoSeparateRows: new Set(boxes.map((b) => Math.round(b.y))).size > 1,
      overflowsContainer: secretActions.scrollWidth > secretActions.clientWidth + 1,
    };
  } else {
    report.wrapping.secretActionButtons = { found: false };
  }

  // The old revision had a dedicated `.baizer-settings-detail-secret` row; the rework puts the
  // input and its actions inside an ordinary detail row. Derive the row from the input either way.
  const secretInput = document.querySelector('.baizer-settings-secret-input');
  const secretRow =
    (secretInput && secretInput.closest('.baizer-settings-detail-row')) ||
    document.querySelector('.baizer-settings-detail-secret');
  if (secretRow) {
    const children = Array.from(secretRow.children).filter(isVisible);
    report.wrapping.secretRow = {
      found: true,
      box: boxOf(secretRow),
      clientWidth: secretRow.clientWidth,
      scrollWidth: secretRow.scrollWidth,
      distinctRows: new Set(children.map((c) => Math.round(c.getBoundingClientRect().top))).size,
      wrapped: new Set(children.map((c) => Math.round(c.getBoundingClientRect().top))).size > 1,
      children: children.map((c) => ({ ...describe(c), box: boxOf(c) })),
    };
  } else {
    report.wrapping.secretRow = { found: false };
  }

  // ----------------------------------------------------------- alignment ----
  const detailRows = Array.from(document.querySelectorAll('.baizer-settings-provider-detail-inline .baizer-settings-detail-row'));
  report.alignment = {
    rowCount: detailRows.length,
    rows: detailRows.map((row) => {
      const label = row.querySelector('.baizer-settings-detail-label');
      const value = row.querySelector('.baizer-settings-detail-value');
      const cs = getComputedStyle(row);
      return {
        label: textOf(label),
        gridTemplateColumns: cs.gridTemplateColumns,
        rowBox: boxOf(row),
        labelBox: label ? boxOf(label) : null,
        valueBox: value ? boxOf(value) : null,
      };
    }),
  };
  const widths = (key) =>
    Array.from(new Set(report.alignment.rows.map((r) => (r[key] ? r[key].w : null)).filter((w) => w !== null)));
  report.alignment.distinctLabelWidths = widths('labelBox');
  report.alignment.distinctValueWidths = widths('valueBox');
  report.alignment.distinctGridTemplates = Array.from(new Set(report.alignment.rows.map((r) => r.gridTemplateColumns)));
  report.alignment.labelColumnConsistent = report.alignment.distinctGridTemplates.length <= 1;
  report.alignment.minValueColumnWidth = report.alignment.distinctValueWidths.length
    ? Math.min(...report.alignment.distinctValueWidths)
    : null;
  const grid = nodes.connectionGrid;
  report.alignment.connectionGridTemplateColumns = grid ? getComputedStyle(grid).gridTemplateColumns : null;
  report.alignment.connectionGridBox = grid ? boxOf(grid) : null;

  // ------------------------------------------------------------ layout branch ----
  // The hero-collapsing rule is a `@container` query on the settings PAGE width, not on the
  // viewport, so "which branch am I in" is a question about the page box. Record the resolved
  // values so the branch is auditable from the report instead of inferred from the window width.
  // (In the reworked layout the connection grid is a single-column flow at EVERY width, so its
  // column count can no longer be used to tell the two branches apart.)
  const heroEl = document.querySelector('.baizer-settings-hero');
  const cardInnerEl = document.querySelector('.baizer-settings-provider-card-main-inner');
  const pageEl = document.querySelector('.baizer-settings-page');
  const heroStyle = heroEl ? getComputedStyle(heroEl) : null;
  const heroAreas = heroStyle ? heroStyle.gridTemplateAreas : null;
  report.alignment.branch = {
    containerSelector: '.baizer-settings-page',
    containerClientWidth: pageEl ? pageEl.clientWidth : null,
    breakpointPx: 640,
    heroFound: !!heroEl,
    heroGridTemplateColumns: heroStyle ? heroStyle.gridTemplateColumns : null,
    heroGridTemplateAreas: heroAreas,
    // Wide branch keeps `"title search" / "subtitle subtitle"`; the narrow branch collapses to
    // `"title" "subtitle" "search"`. Matching the two-token subtitle row is the direct read.
    // `gridTemplateAreas` computes to the string "none" when no areas are declared — which is the
    // case for the PRE-rework layout — so that must report null ("no areas, branch not expressed
    // this way") rather than false ("narrow branch"), which would be a wrong answer.
    wideBranch:
      heroAreas && heroAreas !== 'none' ? /subtitle\s+subtitle/.test(heroAreas) : null,
    providerCardInnerFound: !!cardInnerEl,
    providerCardInnerGridTemplateColumns: cardInnerEl
      ? getComputedStyle(cardInnerEl).gridTemplateColumns
      : null,
  };

  // ------------------------------------------------------------- verdict ----
  const truncationFields = report.truncation.fields.filter((f) => f.found);
  const unreachableTruncated = truncationFields.filter((f) => f.textOverflowsBox && f.disabled && !f.titleAttribute);
  report.verdict = {
    allRequiredNodesPresent: Object.values(report.presence).every(Boolean),
    pluginLoaded: report.plugin.loaded,
    themeMatchesExpectation: report.themeMatchesExpectation,
    noDocumentHorizontalOverflow: report.overflow.document.ok,
    noContainerHorizontalOverflow:
      report.overflow.containers.filter((c) => c.found).every((c) => c.ok) && report.overflow.spillCount === 0,
    noInteractiveOverlap: report.overlap.pairs.length === 0,
    noUnreachableTruncatedValues: unreachableTruncated.length === 0,
    noEllipsizedStaticText: report.truncation.ellipsizedStaticText.length === 0,
    customHeadersHelpNotClipped: (() => {
      const help = report.wrapping.customHeadersHelp;
      if (!help.found) return false;
      // Every block must be laid out (a block hidden inside a collapsed <details> has
      // clientWidth 0 and would otherwise pass vacuously) and must not clip its text.
      return help.blocks.every((b) => b.visible && !b.overflowsHorizontally && !b.clippedVertically);
    })(),
    secretActionsOnOneRow: !!report.wrapping.secretActionButtons.found && !report.wrapping.secretActionButtons.wrappedOntoSeparateRows,
    labelColumnConsistent: report.alignment.labelColumnConsistent,
  };
  report.verdict.fieldsWithTextOverflow = truncationFields.filter((f) => f.textOverflowsBox).map((f) => f.name);
  report.verdict.unreachableTruncatedFields = unreachableTruncated.map((f) => f.name);
  report.verdict.allPass = Object.entries(report.verdict)
    .filter(([key]) => key.startsWith('no') || key === 'allRequiredNodesPresent' || key === 'pluginLoaded' || key === 'themeMatchesExpectation' || key === 'customHeadersHelpNotClipped' || key === 'secretActionsOnOneRow' || key === 'labelColumnConsistent')
    .every(([, value]) => value === true);

  return report;
}

/** Build the CDP expression that runs the probe in the page. */
export function buildProbeExpression(cfg) {
  return `(${collectLayoutReport.toString()})(${JSON.stringify(cfg)})`;
}
