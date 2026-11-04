#!/usr/bin/env node
/**
 * Compare two approval-card layout reports (before/after) and write the
 * machine-readable half of the PR's visual evidence.
 *
 * Usage:
 *   node tools/approval-card-shots/compare.mjs \
 *     --before docs/assets/approval-card-2026-11-04-before-narrow.layout.json \
 *     --after  docs/assets/approval-card-2026-11-04-after-narrow.layout.json \
 *     --title  "approval card, 300px sidebar" \
 *     --out    docs/assets/approval-card-2026-11-04-narrow.metrics.md
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    title: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: false,
});

for (const required of ['before', 'after', 'out']) {
  if (!values[required]) throw new Error(`--${required} is required`);
}

const before = JSON.parse(await fsp.readFile(path.resolve(values.before), 'utf8'));
const after = JSON.parse(await fsp.readFile(path.resolve(values.after), 'utf8'));
const title = values.title || `${before.label} -> ${after.label}`;

function metric(report, pick) {
  try {
    return pick(report);
  } catch {
    return null;
  }
}

function text(value) {
  if (value === null || value === undefined) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const rows = [
  ['Phase', metric(before, (r) => r.phase), metric(after, (r) => r.phase)],
  ['Revision', metric(before, (r) => r.revision), metric(after, (r) => r.revision)],
  ['Browser (CDP)', metric(before, (r) => r.obsidian), metric(after, (r) => r.obsidian)],
  ['Theme / locale', metric(before, (r) => `${r.theme} / ${r.locale}`), metric(after, (r) => `${r.theme} / ${r.locale}`)],
  ['Sidebar width', metric(before, (r) => `${r.requestedSidebarWidth}px`), metric(after, (r) => `${r.requestedSidebarWidth}px`)],
  ['Rendered view width', metric(before, (r) => `${r.viewport.viewRect.width}px`), metric(after, (r) => `${r.viewport.viewRect.width}px`)],
  ['Card width x height', metric(before, (r) => `${r.card.rect.width} x ${r.card.rect.height}`), metric(after, (r) => `${r.card.rect.width} x ${r.card.rect.height}`)],
  ['Card state class', metric(before, (r) => r.card.className), metric(after, (r) => r.card.className)],
  ['Decision button text', metric(before, (r) => r.buttons.filter((b) => b.className.includes('confirm') || b.className.includes('cancel')).map((b) => b.label || '(icon only)').join(' / ')), metric(after, (r) => r.buttons.filter((b) => b.className.includes('confirm') || b.className.includes('cancel')).map((b) => b.label || '(icon only)').join(' / '))],
  ['Button count', metric(before, (r) => r.buttons.length), metric(after, (r) => r.buttons.length)],
  ['High-risk warning', metric(before, (r) => r.card.warning || '(none)'), metric(after, (r) => r.card.warning || '(none)')],
  ['No card overflow', metric(before, (r) => r.checks.noCardHorizontalOverflow), metric(after, (r) => r.checks.noCardHorizontalOverflow)],
  ['No view overflow', metric(before, (r) => r.checks.noViewHorizontalOverflow), metric(after, (r) => r.checks.noViewHorizontalOverflow)],
  ['Buttons inside card', metric(before, (r) => r.checks.buttonsInsideCard), metric(after, (r) => r.checks.buttonsInsideCard)],
  ['No button overlap', metric(before, (r) => r.checks.noButtonOverlap), metric(after, (r) => r.checks.noButtonOverlap)],
  ['Facts readable', metric(before, (r) => r.checks.factsReadable), metric(after, (r) => r.checks.factsReadable)],
  ['All checks pass', metric(before, (r) => r.verdict.allPass), metric(after, (r) => r.verdict.allPass)],
];

const changed = rows.filter(([, b, a]) => text(b) !== text(a));
const lines = [
  `# ${title}`,
  '',
  `| Metric | Before | After |`,
  `| --- | --- | --- |`,
  ...rows.map(([label, b, a]) => `| ${label} | ${text(b)} | ${text(a)} |`),
  '',
  `Changed rows: ${changed.length}.`,
  '',
  'Evidence is produced by `tools/approval-card-shots/capture.mjs`: the real plugin is loaded into a throwaway vault, the real workbench view is opened, the approval scenario is injected into the tab projection, and the PNG plus these measurements come from the same DOM state.',
  '',
  'Limitations: colour, contrast, font rendering and animation are not asserted; the screenshot is clipped to the workbench view.',
];

await fsp.mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
await fsp.writeFile(path.resolve(values.out), `${lines.join('\n')}\n`, 'utf8');
const jsonPath = path.resolve(values.out).replace(/\.md$/i, '.json');
await fsp.writeFile(jsonPath, `${JSON.stringify({ title, rows, changedCount: changed.length }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out: path.resolve(values.out), json: jsonPath, changedCount: changed.length }, null, 2));
