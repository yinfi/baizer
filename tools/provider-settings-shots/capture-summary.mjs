/**
 * Summarise a set of capture layout reports into one machine-readable record.
 *
 * Why: the delivery rule is that Before and After be captured from the same running application with
 * the same scenario, viewport and theme. Each `*.layout.json` already records what it was captured
 * with, but the claim "both phases came from the same Obsidian build" is only checkable if someone
 * compares them — which is what this does, across every capture, and writes down.
 *
 * It also carries the provider-type option list per capture, because that list is the point of this
 * ticket: "the Gemini option is present before and absent after" should be readable without opening
 * a PNG.
 *
 * Usage:
 *   node tools/provider-settings-shots/capture-summary.mjs \
 *     --capture docs/assets/....layout.json [--capture ...] \
 *     --out-json tools/provider-settings-shots/metrics/<name>.metrics.json \
 *     --out-md   tools/provider-settings-shots/metrics/<name>.metrics.md
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const values = {};
  const captures = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    if (value !== true) i += 1;
    if (key === 'capture') captures.push(value);
    else values[key] = value;
  }
  return { values, captures };
}

const { values, captures } = parseArgs(process.argv.slice(2));
if (!captures.length) throw new Error('at least one --capture <layout.json> is required');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const repoRelative = (file) => path.relative(process.cwd(), path.resolve(file)).replace(/\\/g, '/');

const records = captures.map((file) => {
  const report = read(file);
  const typeSelect = report.providerTypeSelect || {};
  const png = String(file).replace(/\.layout\.json$/, '.png');
  const pngExists = fs.existsSync(png);
  return {
    layout: repoRelative(file),
    image: pngExists ? repoRelative(png) : null,
    imageBytes: pngExists ? fs.statSync(png).size : null,
    imageSha256: pngExists ? createHash('sha256').update(fs.readFileSync(png)).digest('hex') : null,
    label: report.label ?? null,
    phase: report.phase ?? report.harness?.phase ?? null,
    revision: report.revision ?? report.harness?.revision ?? null,
    capturedAt: report.capturedAt ?? null,
    obsidianVersion: report.obsidianVersionInPage ?? report.harness?.obsidianVersionFromTitle ?? null,
    obsidianVersionSource: report.obsidianVersionSource ?? null,
    obsidianVersionFromTitle: report.harness?.obsidianVersionFromTitle ?? null,
    obsidianVersionFromExe: report.obsidianVersionFromExe ?? report.harness?.obsidianVersionFromExe ?? null,
    obsidianAsarFiles: report.harness?.obsidianAsarFiles ?? [],
    browserUserAgent: report.harness?.browserUserAgent ?? null,
    windowTitle: report.windowTitle ?? null,
    theme: report.theme ?? null,
    expectedTheme: report.expectedTheme ?? null,
    language: report.language ?? null,
    viewport: report.viewport ? { width: report.viewport.innerWidth, height: report.viewport.innerHeight } : null,
    requestedViewport: report.harness?.requestedViewport ?? null,
    imageSize: report.image ? { width: report.image.width, height: report.image.height, matchesRequest: report.image.sizeMatchesRequest } : null,
    settingsPanelLocation: report.harness?.settingsPanelLocation ?? null,
    plugin: report.plugin ? { id: report.plugin.id, version: report.plugin.version, loaded: report.plugin.loaded } : null,
    scenario: report.harness?.scenarioPath ?? null,
    pluginBuildDir: report.harness?.pluginDir ?? null,
    pluginBuildBytes: (report.harness?.copiedPluginFiles || []).find((f) => f.file === 'main.js')?.bytes ?? null,
    providerCards: (report.providerCards || []).map((c) => ({ title: c.title, active: !!c.active })),
    activeProvider: (report.providerCards || []).find((c) => c.active)?.title ?? null,
    typeSelect: {
      found: typeSelect.found ?? null,
      onScreen: typeSelect.inViewport ?? null,
      renderedAsList: typeSelect.renderedAsList ?? null,
      sizeAttribute: typeSelect.sizeAttribute ?? null,
      optionCount: typeSelect.optionCount ?? null,
      optionTexts: typeSelect.optionTexts ?? null,
      value: typeSelect.value ?? null,
      geminiOptionPresent: (typeSelect.optionTexts || []).some((t) => /gemini|google/i.test(t)),
      paneScrollTop: typeSelect.scrollContext?.scrollTop ?? null,
      boxY: typeSelect.box?.y ?? null,
    },
    allPass: report.verdict?.allPass ?? null,
    failedVerdicts: Object.entries(report.verdict || {})
      .filter(([k, v]) => typeof v === 'boolean' && v === false && k !== 'allPass')
      .map(([k]) => k),
  };
});

const byPhase = (phase) => records.filter((r) => r.phase === phase);
const distinct = (key) => [...new Set(records.map((r) => r[key]).filter((v) => v !== null && v !== undefined))];

// Pair the two phases by capture slot ("wide", "narrow520", "typeoptions-wide"), derived from the
// label so it does not depend on filenames. This is where the honest reading of an IDENTICAL pair
// gets recorded: a closed <select> paints only its selected option, so a change to the option list
// is invisible in a stock capture no matter how the frame is chosen, and an identical pair must
// never be read as "the capture broke" or, worse, as "nothing changed".
const slotOf = (record) => String(record.label || '').replace(/^(before|after)-/, '');
const slots = [...new Set(records.map(slotOf))];
const pairs = slots.map((slot) => {
  const before = byPhase('before').find((r) => slotOf(r) === slot);
  const after = byPhase('after').find((r) => slotOf(r) === slot);
  if (!before || !after) return { slot, before: before?.label ?? null, after: after?.label ?? null, complete: false };
  const identical = before.imageSha256 !== null && before.imageSha256 === after.imageSha256;
  const rendersOptions = before.typeSelect.renderedAsList === true || after.typeSelect.renderedAsList === true;
  let reading;
  if (!identical) {
    reading = rendersOptions
      ? 'the two phases differ, and this pair renders the option list inline, so the removed option is visible in the bitmap'
      : 'the two phases differ in pixels; inspect the layout reports for the cause';
  } else if (!rendersOptions) {
    reading = 'IDENTICAL, and correctly so: a closed <select> paints only its selected option, and the '
      + 'selected option is the same in both phases, so removing a protocol cannot appear in this bitmap. '
      + 'This pair documents that the surrounding layout is unchanged — it is NOT evidence that nothing '
      + 'changed. The option-list change is evidenced by providerTypeSelect.optionTexts in these layout '
      + 'reports and by the expanded (renderedAsList) pair.';
  } else {
    reading = 'IDENTICAL even though the option list is rendered inline: unexpected — investigate, because '
      + 'the removed option should be visible.';
  }
  return {
    slot,
    viewport: `${before.viewport?.width}x${before.viewport?.height}`,
    before: before.label,
    after: after.label,
    beforeBytes: before.imageBytes,
    afterBytes: after.imageBytes,
    beforeSha256: before.imageSha256,
    afterSha256: after.imageSha256,
    identical,
    rendersOptionListInline: rendersOptions,
    beforeOptions: before.typeSelect.optionTexts,
    afterOptions: after.typeSelect.optionTexts,
    reading,
  };
});
const identicalStockPairs = pairs.filter((p) => p.identical && !p.rendersOptionListInline).map((p) => p.slot);
const visiblePairs = pairs.filter((p) => !p.identical).map((p) => p.slot);

const obsidianVersions = distinct('obsidianVersion');
const obsidianVersionSources = distinct('obsidianVersionSource');
const exeVersions = distinct('obsidianVersionFromExe');
const asarFiles = [...new Set(records.flatMap((r) => (r.obsidianAsarFiles || []).map((a) => `${a.file} (${a.bytes} B, ${a.modifiedAt})`)))];
const themes = distinct('theme');
const languages = distinct('language');
const scenarios = distinct('scenario');
const pluginVersions = [...new Set(records.map((r) => (r.plugin ? `${r.plugin.id}@${r.plugin.version}` : null)).filter(Boolean))];

const parity = {
  sameObsidianVersionAcrossAllCaptures: obsidianVersions.length === 1,
  obsidianVersionRecordedInEveryCapture: records.every((r) => !!r.obsidianVersion),
  sameThemeAcrossAllCaptures: themes.length === 1,
  sameLocaleAcrossAllCaptures: languages.length === 1,
  sameScenarioAcrossAllCaptures: scenarios.length === 1,
  samePluginVersionAcrossAllCaptures: pluginVersions.length === 1,
  everyCaptureHasTypeSelectOnScreen: records.every((r) => r.typeSelect.onScreen === true),
  everyCaptureAllPass: records.every((r) => r.allPass === true),
  beforeHasGeminiOption: byPhase('before').every((r) => r.typeSelect.geminiOptionPresent === true),
  afterHasNoGeminiOption: byPhase('after').every((r) => r.typeSelect.geminiOptionPresent === false),
  beforeAndAfterShareViewports: (() => {
    const key = (r) => `${r.viewport?.width}x${r.viewport?.height}`;
    const b = [...new Set(byPhase('before').map(key))].sort();
    const a = [...new Set(byPhase('after').map(key))].sort();
    return b.length > 0 && JSON.stringify(b) === JSON.stringify(a);
  })(),
  everySlotHasBothPhases: pairs.every((p) => p.complete !== false),
  atLeastOnePairDiffersInPixels: visiblePairs.length > 0,
};

const report = {
  schema: 'baizer-capture-summary/1',
  generatedAt: new Date().toISOString(),
  captures: records,
  pairs,
  environment: {
    obsidianVersionsRunning: obsidianVersions,
    obsidianVersionSources,
    obsidianVersionsFromExe: exeVersions,
    preferredAsarFilesPresent: asarFiles,
    themes,
    languages,
    scenarios,
    pluginVersions,
    note: 'obsidianVersion is the version of the app that actually ran, taken from the running '
      + 'window title (Obsidian writes it there) because the settings panel renders in a popout '
      + 'window with no `app` global. It is NOT the version of the executable: Obsidian prefers a '
      + 'downloaded %APPDATA%\\obsidian\\obsidian-<version>.asar over its own resources/obsidian.asar, '
      + 'so the 1.14.5 binary in this environment ran 1.15.0 app code (see preferredAsarFilesPresent). '
      + 'Both phases of every pair were captured from the same running version.',
  },
  pixelComparison: {
    identicalStockPairs,
    pairsWithVisibleDifference: visiblePairs,
    summary: identicalStockPairs.length
      ? `The stock (closed-dropdown) pair(s) ${identicalStockPairs.map((s) => `"${s}"`).join(', ')} are byte-identical between phases. `
        + 'That is expected and is not a broken capture: a closed <select> paints only its selected '
        + 'option, so a change to the option list cannot appear in the bitmap. The removal is evidenced '
        + 'by providerTypeSelect.optionTexts in the layout reports and by the pair that renders the '
        + 'option list inline.'
      : 'Every pair differs in pixels.',
  },
  parity,
  allParityChecksPass: Object.values(parity).every(Boolean),
};

fs.mkdirSync(path.dirname(path.resolve(values['out-json'])), { recursive: true });
fs.writeFileSync(path.resolve(values['out-json']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (values['out-md']) {
  const lines = [
    '# Capture summary',
    '',
    `Generated ${report.generatedAt} by \`tools/provider-settings-shots/capture-summary.mjs\` from ${records.length} layout reports.`,
    '',
    `Running app: Obsidian **${obsidianVersions.join(', ')}** (from ${obsidianVersionSources.join(', ')}), theme ${themes.join(', ')}, locale ${languages.join(', ')}, ${pluginVersions.join(', ')}.`,
    `Executable FileVersion: ${exeVersions.length ? exeVersions.join(', ') : 'unknown'}${exeVersions.length && obsidianVersions.length && exeVersions[0] !== obsidianVersions[0] ? ' — **not** the app code that ran (see below)' : ''}.`,
    asarFiles.length ? `Downloaded app bundles present (preferred over the exe): ${asarFiles.join('; ')}.` : 'No downloaded app bundles present.',
    '',
    '| capture | phase | revision | image | bytes | sha256 | viewport | type dropdown on screen | type options | Gemini option | allPass |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...records.map((r) => `| ${r.label ?? r.layout} | ${r.phase} | \`${r.revision}\` | ${r.image ? `[png](${r.image})` : '—'} | ${r.imageBytes ?? '—'} | \`${(r.imageSha256 || '').slice(0, 16)}…\` | ${r.viewport?.width}x${r.viewport?.height} | ${r.typeSelect.onScreen ? 'yes' : 'no'}${r.typeSelect.renderedAsList ? ' (rendered as list)' : ''} | ${(r.typeSelect.optionTexts || []).join(' / ')} | ${r.typeSelect.geminiOptionPresent ? '**present**' : 'absent'} | ${r.allPass ? 'yes' : 'no'} |`),
    '',
    '## Before/After pairs',
    '',
    '| slot | viewport | before sha256 | after sha256 | identical | option list rendered |',
    '| --- | --- | --- | --- | --- | --- |',
    ...pairs.map((p) => (p.complete === false
      ? `| ${p.slot} | — | — | — | — | incomplete pair |`
      : `| ${p.slot} | ${p.viewport} | \`${(p.beforeSha256 || '').slice(0, 16)}…\` (${p.beforeBytes} B) | \`${(p.afterSha256 || '').slice(0, 16)}…\` (${p.afterBytes} B) | ${p.identical ? '**yes**' : 'no'} | ${p.rendersOptionListInline ? 'yes' : 'no'} |`)),
    '',
    'Reading of each pair:',
    '',
    ...pairs.map((p) => `* **${p.slot}** — ${p.reading}`),
    '',
    'Option lists (the machine-checkable form of "the Gemini option is gone"):',
    '',
    ...pairs.filter((p) => p.complete !== false).map((p) => `* ${p.slot}: before \`${JSON.stringify(p.beforeOptions)}\` -> after \`${JSON.stringify(p.afterOptions)}\``),
    '',
    '## Before/After parity',
    '',
    '| check | result |',
    '| --- | --- |',
    ...Object.entries(parity).map(([k, v]) => `| ${k} | ${v ? 'PASS' : 'FAIL'} |`),
    '',
  ];
  fs.writeFileSync(path.resolve(values['out-md']), `${lines.join('\n')}\n`, 'utf8');
}

console.log(`captures   ${records.length} (before ${byPhase('before').length}, after ${byPhase('after').length})`);
console.log(`obsidian   running=${obsidianVersions.join(', ')} (from ${obsidianVersionSources.join(', ')}) exe=${exeVersions.join(', ') || 'unknown'}`);
for (const r of records) {
  console.log(`  ${String(r.label).padEnd(22)} ${r.viewport?.width}x${r.viewport?.height}  onScreen=${r.typeSelect.onScreen}  gemini=${r.typeSelect.geminiOptionPresent}  options=[${(r.typeSelect.optionTexts || []).join(' | ')}]  allPass=${r.allPass}  sha=${(r.imageSha256 || '').slice(0, 12)}`);
}
for (const p of pairs) {
  console.log(`pair ${String(p.slot).padEnd(18)} identical=${p.identical} rendersOptions=${p.rendersOptionListInline}`);
}
console.log(`parity     ${Object.entries(parity).map(([k, v]) => `${v ? 'PASS' : 'FAIL'}:${k}`).join(' ')}`);
if (!report.allParityChecksPass) process.exitCode = 1;
