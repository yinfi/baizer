#!/usr/bin/env node
/**
 * Build the machine-readable before/after metric table from two layout reports.
 *
 * The point of this file is that the numbers in the PR description are reproducible from the
 * committed `.layout.json` evidence instead of being retyped by hand:
 *
 *   node tools/provider-settings-shots/compare-layout.mjs \
 *     --before docs/assets/provider-settings-2026-11-03-before-wide.layout.json \
 *     --after  docs/assets/provider-settings-2026-11-03-after-wide.layout.json \
 *     --title  "wide (1353x1053, cch-opencode)" --out docs/assets/provider-settings-wide.metrics.md
 *
 * It is deliberately tolerant of a report that predates a field (an older probe emitted a single
 * `customHeadersHelp` instead of `blocks`, for instance) so a before/after pair never fails to
 * render just because the harness grew a field in between.
 */
import fs from 'node:fs';

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    if (value !== true) i += 1;
    out[key.slice(2)] = value;
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));
if (!args.before || !args.after) {
  console.error('usage: compare-layout.mjs --before <layout.json> --after <layout.json> [--title T] [--out FILE]');
  process.exit(2);
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const before = read(args.before);
const after = read(args.after);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v);
};

/** A row whose two sides are formatted for display and annotated when they differ. */
const rows = [];
const addRow = (metric, b, a, note) => {
  const bs = fmt(b);
  const as = fmt(a);
  const changed = bs !== as;
  rows.push({ metric, before: bs, after: as, changed, note: note || (changed ? 'changed' : 'unchanged') });
};

// ---- identity / provenance -------------------------------------------------
// `revision`/`phase` are top-level on the report; older runs only had them under `harness`.
const rev = (r) => r.revision ?? r.harness?.revision ?? null;
addRow('revision', rev(before), rev(after));
addRow('phase', before.phase ?? before.harness?.phase, after.phase ?? after.harness?.phase);
addRow('label', before.label, after.label);
addRow('captured at', before.capturedAt, after.capturedAt);
addRow('image size', `${before.image?.width}x${before.image?.height}`, `${after.image?.width}x${after.image?.height}`);
addRow('viewport innerWidth x innerHeight',
  `${before.viewport?.innerWidth}x${before.viewport?.innerHeight}`,
  `${after.viewport?.innerWidth}x${after.viewport?.innerHeight}`);
addRow('Obsidian version', before.harness?.obsidianVersionFromTitle, after.harness?.obsidianVersionFromTitle);
addRow('plugin', `${before.plugin?.id}@${before.plugin?.version}`, `${after.plugin?.id}@${after.plugin?.version}`);
addRow('theme', before.theme, after.theme);
addRow('settings panel location', before.harness?.settingsPanelLocation, after.harness?.settingsPanelLocation);

// ---- geometry --------------------------------------------------------------
const boxW = (r, b) => (b ? num(b.w) : null);
addRow('settings page width', boxW(before, before.settingsPageBox), boxW(after, after.settingsPageBox), 'px');
addRow('settings page x', num(before.settingsPageBox?.x), num(after.settingsPageBox?.x), 'px');
const activeCardW = (r) => {
  const card = (r.providerCards || []).find((c) => c.active) || (r.providerCards || [])[0];
  return card ? num(card.box?.w) : null;
};
addRow('active provider card width', activeCardW(before), activeCardW(after), 'px');
// Which side of the hero container query each capture landed on. Note this answers "does the hero
// subtitle span BOTH columns", not "is the viewport wide": the pre-rework hero also had
// `grid-template-areas`, but its wide row was `"title search" / "subtitle search"`, which confined
// the subtitle to the left column and clipped it. So before-wide legitimately reports false here
// while being the wide branch of the old breakpoint — that difference IS the F4 fix.
// Reports captured before this field existed render as "—".
const branch = (r) => r.alignment?.branch;
addRow('layout branch: wide (hero spans 2 cols)',
  branch(before)?.wideBranch ?? (branch(before) ? 'n/a' : null),
  branch(after)?.wideBranch ?? (branch(after) ? 'n/a' : null));
addRow('branch container width (.baizer-settings-page)',
  num(branch(before)?.containerClientWidth), num(branch(after)?.containerClientWidth), 'px');
addRow('hero grid-template-areas', branch(before)?.heroGridTemplateAreas, branch(after)?.heroGridTemplateAreas);
addRow('provider card inner columns',
  branch(before)?.providerCardInnerGridTemplateColumns, branch(after)?.providerCardInnerGridTemplateColumns);
addRow('connection container columns',
  before.alignment?.connectionGridTemplateColumns, after.alignment?.connectionGridTemplateColumns);
addRow('connection container width', num(before.alignment?.connectionGridBox?.w), num(after.alignment?.connectionGridBox?.w), 'px');
addRow('connection card widths', (before.connectionCards || []).map((c) => Math.round(c.box?.w)), (after.connectionCards || []).map((c) => Math.round(c.box?.w)), 'px');
addRow('connection card titles', (before.connectionCards || []).map((c) => c.title), (after.connectionCards || []).map((c) => c.title));
addRow('detail-row grid template(s)', before.alignment?.distinctGridTemplates, after.alignment?.distinctGridTemplates);
addRow('detail label column width(s)', before.alignment?.distinctLabelWidths, after.alignment?.distinctLabelWidths, 'px');
addRow('detail value column width(s)', before.alignment?.distinctValueWidths, after.alignment?.distinctValueWidths, 'px');
addRow('min value column width', num(before.alignment?.minValueColumnWidth), num(after.alignment?.minValueColumnWidth), 'px');
addRow('detail row count', before.alignment?.rowCount, after.alignment?.rowCount);

// ---- the page subtitle (the one hard wide failure before) -------------------
const sub = (r) => {
  const hit = (r.truncation?.ellipsizedStaticText || []).find((e) => /subtitle/.test(e.classes || ''));
  return hit || null;
};
const subBefore = sub(before);
const subAfter = sub(after);
addRow('subtitle clientWidth (ellipsized)',
  subBefore ? num(subBefore.clientWidth) : 'not clipped',
  subAfter ? num(subAfter.clientWidth) : 'not clipped', 'px');
addRow('subtitle scrollWidth (needs)',
  subBefore ? num(subBefore.scrollWidth) : 'not clipped',
  subAfter ? num(subAfter.scrollWidth) : 'not clipped', 'px');
addRow('ellipsized static text count', (before.truncation?.ellipsizedStaticText || []).length, (after.truncation?.ellipsizedStaticText || []).length);

// ---- per-field needed vs available ----------------------------------------
const fieldOf = (r, name) => (r.truncation?.fields || []).find((f) => f.name === name) || null;
for (const name of ['apiEndpoint', 'apiKey', 'model', 'protocol', 'providerName', 'customHeaders']) {
  const b = fieldOf(before, name);
  const a = fieldOf(after, name);
  addRow(`${name}: label`, b?.label, a?.label);
  addRow(`${name}: found`, b?.found, a?.found);
  addRow(`${name}: needed text width`,
    b ? (b.found ? num(b.renderedTextWidth) : 'n/a') : null,
    a ? (a.found ? num(a.renderedTextWidth) : 'n/a') : null, 'px');
  addRow(`${name}: available text width`,
    b ? (b.found ? num(b.availableTextWidth) : 'n/a') : null,
    a ? (a.found ? num(a.availableTextWidth) : 'n/a') : null, 'px');
  addRow(`${name}: overflows box`, b?.found ? !!b.textOverflowsBox : null, a?.found ? !!a.textOverflowsBox : null);
  addRow(`${name}: editable / enabled`, b?.found ? !b.disabled : null, a?.found ? !a.disabled : null);
  addRow(`${name}: title tooltip`, b?.found ? b.titleAttribute : null, a?.found ? a.titleAttribute : null);
  addRow(`${name}: value scrolls`, b?.found ? !!b.contentScrolls : null, a?.found ? !!a.contentScrolls : null);
}

// ---- custom-headers help text ---------------------------------------------
const helpBlocks = (r) => {
  const help = r.wrapping?.customHeadersHelp;
  if (!help || !help.found) return [];
  return Array.isArray(help.blocks) && help.blocks.length ? help.blocks : [help];
};
const bh = helpBlocks(before);
const ah = helpBlocks(after);
addRow('help block count', bh.length, ah.length);
addRow('help block widths', bh.map((b) => num(b.clientWidth)), ah.map((b) => num(b.clientWidth)), 'px');
addRow('help block line counts', bh.map((b) => num(b.lineCount)), ah.map((b) => num(b.lineCount)));
addRow('help block overflow-x', bh.map((b) => !!b.overflowsHorizontally), ah.map((b) => !!b.overflowsHorizontally));
addRow('help block clipped-y', bh.map((b) => !!b.clippedVertically), ah.map((b) => !!b.clippedVertically));
addRow('help block laid out (not collapsed)', bh.map((b) => (b.visible === undefined ? true : !!b.visible)), ah.map((b) => (b.visible === undefined ? true : !!b.visible)));
addRow('help block total height', bh.reduce((s, b) => s + (num(b.box?.h) || 0), 0), ah.reduce((s, b) => s + (num(b.box?.h) || 0), 0), 'px');

// ---- secret (API key) action buttons --------------------------------------
addRow('secret action buttons found', before.wrapping?.secretActionButtons?.found, after.wrapping?.secretActionButtons?.found);
addRow('secret action button rows', before.wrapping?.secretActionButtons?.distinctRows, after.wrapping?.secretActionButtons?.distinctRows);
addRow('secret action buttons wrapped', before.wrapping?.secretActionButtons?.wrappedOntoSeparateRows, after.wrapping?.secretActionButtons?.wrappedOntoSeparateRows);
addRow('secret action container overflow', before.wrapping?.secretActionButtons?.overflowsContainer, after.wrapping?.secretActionButtons?.overflowsContainer);

// ---- provider type dropdown -------------------------------------------------
// The control this change is about. Its OPTION LIST is the claim ("the Gemini option is gone"), so
// the option texts are compared as a row of their own rather than leaving the reader to infer it
// from the selected value — a closed <select> only ever paints the selected option.
const typeSelect = (report) => report.providerTypeSelect || {};
const geminiOption = (report) => {
  const texts = typeSelect(report).optionTexts || [];
  return texts.some((text) => /gemini|google/i.test(text));
};
addRow('provider type select found', typeSelect(before).found, typeSelect(after).found);
addRow('provider type select on screen', typeSelect(before).inViewport, typeSelect(after).inViewport);
addRow('provider type select rendered as list', typeSelect(before).renderedAsList, typeSelect(after).renderedAsList);
addRow('provider type option count', typeSelect(before).optionCount, typeSelect(after).optionCount);
addRow('provider type options', typeSelect(before).optionTexts, typeSelect(after).optionTexts);
addRow('provider type selected value', typeSelect(before).value, typeSelect(after).value);
addRow('Gemini/Google option present', geminiOption(before), geminiOption(after));
addRow('pane scrollTop after focus', num(typeSelect(before).scrollContext?.scrollTop), num(typeSelect(after).scrollContext?.scrollTop), 'px');

// ---- overflow / overlap ----------------------------------------------------
addRow('document horizontal overflow', num(before.overflow?.document?.overflowPx), num(after.overflow?.document?.overflowPx), 'px');
addRow('containers checked', (before.overflow?.containers || []).filter((c) => c.found).length, (after.overflow?.containers || []).filter((c) => c.found).length);
const badContainers = (r) => (r.overflow?.containers || []).filter((c) => c.found && !c.ok).map((c) => `${c.selector} (+${c.overflowPx}px)`);
addRow('containers overflowing', badContainers(before), badContainers(after));
addRow('max container overflow', Math.max(0, ...(before.overflow?.containers || []).filter((c) => c.found).map((c) => num(c.overflowPx) || 0)), Math.max(0, ...(after.overflow?.containers || []).filter((c) => c.found).map((c) => num(c.overflowPx) || 0)), 'px');
addRow('overflow offenders', before.overflow?.offenderCount, after.overflow?.offenderCount);
addRow('elements spilling outside panel', before.overflow?.spillCount, after.overflow?.spillCount);
addRow('interactive control count', before.overlap?.controlCount, after.overlap?.controlCount);
addRow('overlapping control pairs', (before.overlap?.pairs || []).length, (after.overlap?.pairs || []).length);

// ---- verdicts --------------------------------------------------------------
const VERDICT_KEYS = [
  'allRequiredNodesPresent', 'pluginLoaded', 'themeMatchesExpectation',
  'noDocumentHorizontalOverflow', 'noContainerHorizontalOverflow', 'noInteractiveOverlap',
  'noUnreachableTruncatedValues', 'noEllipsizedStaticText', 'customHeadersHelpNotClipped',
  'secretActionsOnOneRow', 'labelColumnConsistent',
  'providerTypeSelectFound', 'providerTypeSelectOnScreen', 'allPass',
];
const verdictRows = VERDICT_KEYS.map((k) => ({
  key: k,
  before: before.verdict?.[k],
  after: after.verdict?.[k],
  changed: before.verdict?.[k] !== after.verdict?.[k],
}));

// ---- render ----------------------------------------------------------------
const title = args.title ? String(args.title) : 'before vs after';
const lines = [];
lines.push(`### ${title}`);
lines.push('');
lines.push(`- before: \`${args.before}\` (revision \`${rev(before) ?? '?'}\`)`);
lines.push(`- after:  \`${args.after}\` (revision \`${rev(after) ?? '?'}\`)`);
lines.push('');
lines.push('| Metric | Before | After | |');
lines.push('| --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(`| ${r.metric} | ${r.before} | ${r.after} | ${r.changed ? '**changed**' : ''} |`);
}
lines.push('');
lines.push('| Verdict key | Before | After | |');
lines.push('| --- | --- | --- | --- |');
for (const v of verdictRows) {
  lines.push(`| \`${v.key}\` | ${fmt(v.before)} | ${fmt(v.after)} | ${v.changed ? '**changed**' : ''} |`);
}
lines.push('');
const changedVerdicts = verdictRows.filter((v) => v.changed && v.key !== 'allPass');
lines.push(
  changedVerdicts.length
    ? `Verdicts that changed: ${changedVerdicts.map((v) => `\`${v.key}\` (${fmt(v.before)} -> ${fmt(v.after)})`).join(', ')}.`
    : 'No verdict changed.',
);
lines.push('');
lines.push(`Fields still reporting text overflow: before = ${fmt(before.verdict?.fieldsWithTextOverflow)}, after = ${fmt(after.verdict?.fieldsWithTextOverflow)}.`);
lines.push('');

const md = lines.join('\n');
if (args.out && args.out !== true) {
  fs.writeFileSync(args.out, md);
  console.log(`wrote ${args.out}`);
  const jsonOut = String(args.out).replace(/\.md$/, '.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ title, before: args.before, after: args.after, rows, verdicts: verdictRows }, null, 2));
  console.log(`wrote ${jsonOut}`);
} else {
  process.stdout.write(md);
}
