/**
 * Bundle-size Before/After evidence for a revision pair, from esbuild metafiles.
 *
 * Why a script instead of typed numbers: the PR's headline claim is a byte count, and the numbers
 * have to be reproducible by whoever reviews it. `BAIZER_METAFILE=1 npm run build` writes
 * `dist/esbuild-meta.json`, which carries `outputs["dist/main.js"].inputs[<path>].bytesInOutput` —
 * i.e. how many bytes each module contributed to the single-file bundle. This tool diffs two such
 * metafiles, cross-checks the byte counts against the actual `dist/main.js` files on disk, and
 * writes a machine-readable record plus a human-readable twin.
 *
 * Usage:
 *   node tools/provider-settings-shots/bundle-size-diff.mjs \
 *     --before-meta <caf9703>/dist/esbuild-meta.json \
 *     --after-meta  <ticket>/dist/esbuild-meta.json \
 *     --before-main <caf9703>/dist/main.js \
 *     --after-main  <ticket>/dist/main.js \
 *     --before-revision caf9703 --after-revision <sha> \
 *     --out-json tools/provider-settings-shots/metrics/<name>.metrics.json \
 *     --out-md   tools/provider-settings-shots/metrics/<name>.metrics.md
 *
 * Exit code is non-zero if a metafile disagrees with the size of the main.js it is supposed to
 * describe — that means the pair is not a matched build/artifact set and the numbers must not be
 * quoted.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

const OUTPUT_KEY = 'dist/main.js';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else {
      values[key] = next;
      i += 1;
    }
  }
  return values;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bytesOfMain(file) {
  return fs.statSync(file).size;
}

function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/** `outputs["dist/main.js"].inputs` -> Map(path -> bytesInOutput). */
function contributionMap(metafile, metaPath) {
  const output = metafile.outputs && metafile.outputs[OUTPUT_KEY];
  if (!output) {
    throw new Error(`${metaPath} has no outputs["${OUTPUT_KEY}"] (keys: ${Object.keys(metafile.outputs || {}).join(', ')})`);
  }
  const map = new Map();
  let entriesWithBytesInOutput = 0;
  for (const [input, info] of Object.entries(output.inputs || {})) {
    if (typeof info.bytesInOutput === 'number') entriesWithBytesInOutput += 1;
    map.set(input, info.bytesInOutput || 0);
  }
  // `bytesInOutput` lives in outputs[…].inputs (the top-level `inputs` map only carries source
  // `bytes`). If a future esbuild stops emitting it, every contribution reads as 0 and the
  // attribution would silently come out empty — so fail loudly instead.
  if (map.size > 0 && entriesWithBytesInOutput === 0) {
    throw new Error(
      `${metaPath}: outputs["${OUTPUT_KEY}"].inputs carries no \`bytesInOutput\` for any of its ${map.size} entries, `
      + 'so per-module attribution is impossible with this metafile format',
    );
  }
  return { map, outputBytes: output.bytes, entriesWithBytesInOutput };
}

/** Group a bundle path into a coarse owner so the report answers "who got smaller". */
function ownerOf(input) {
  if (input.startsWith('pi-api-stub:') || input.startsWith('pi-provider-stub:') || input.startsWith('pi-model-catalog-stub:')) {
    return `esbuild-plugin stub (${input.split(':')[0]})`;
  }
  const nodeModules = input.indexOf('node_modules/');
  if (nodeModules >= 0) {
    const rest = input.slice(nodeModules + 'node_modules/'.length);
    const parts = rest.split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (input === 'main.ts' || input.startsWith('src/')) return 'plugin source';
  return input;
}

const values = parseArgs(process.argv.slice(2));
const required = ['before-meta', 'after-meta', 'before-main', 'after-main', 'out-json'];
for (const key of required) {
  if (!values[key]) throw new Error(`--${key} is required`);
}

const beforeMetaPath = path.resolve(values['before-meta']);
const afterMetaPath = path.resolve(values['after-meta']);
const beforeMainPath = path.resolve(values['before-main']);
const afterMainPath = path.resolve(values['after-main']);

const beforeMeta = readJson(beforeMetaPath);
const afterMeta = readJson(afterMetaPath);
const before = contributionMap(beforeMeta, beforeMetaPath);
const after = contributionMap(afterMeta, afterMetaPath);
const beforeBytes = bytesOfMain(beforeMainPath);
const afterBytes = bytesOfMain(afterMainPath);

const problems = [];
if (before.outputBytes !== beforeBytes) {
  problems.push(`before metafile says ${before.outputBytes} B but ${beforeMainPath} is ${beforeBytes} B`);
}
if (after.outputBytes !== afterBytes) {
  problems.push(`after metafile says ${after.outputBytes} B but ${afterMainPath} is ${afterBytes} B`);
}

const allInputs = new Set([...before.map.keys(), ...after.map.keys()]);
const deltas = [];
for (const input of allInputs) {
  const b = before.map.get(input) ?? 0;
  const a = after.map.get(input) ?? 0;
  if (b === a) continue;
  deltas.push({ input, before: b, after: a, delta: a - b });
}
deltas.sort((x, y) => x.delta - y.delta);

const removed = deltas.filter((d) => d.after === 0);
const added = deltas.filter((d) => d.before === 0);
const shrunk = deltas.filter((d) => d.before > 0 && d.after > 0 && d.delta < 0);
const grown = deltas.filter((d) => d.delta > 0);

const byOwner = new Map();
for (const d of deltas) {
  const owner = ownerOf(d.input);
  const entry = byOwner.get(owner) || { owner, before: 0, after: 0, delta: 0, inputs: 0 };
  entry.before += d.before;
  entry.after += d.after;
  entry.delta += d.delta;
  entry.inputs += 1;
  byOwner.set(owner, entry);
}
const owners = [...byOwner.values()].sort((x, y) => x.delta - y.delta);

// The sum of per-input deltas is NOT the whole-file delta: the file also carries the banner,
// esbuild's own runtime helpers and inter-module plumbing that no input claims.
const attributedDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
const totalDelta = afterBytes - beforeBytes;

const report = {
  schema: 'baizer-bundle-size-evidence/1',
  generatedAt: new Date().toISOString(),
  artifact: OUTPUT_KEY,
  before: {
    revision: values['before-revision'] ?? null,
    label: values['before-label'] ?? null,
    mainJs: beforeMainPath,
    bytes: beforeBytes,
    sha256: sha256Of(beforeMainPath),
    metafile: beforeMetaPath,
    metafileOutputBytes: before.outputBytes,
    metafileMatchesArtifact: before.outputBytes === beforeBytes,
    inputCount: before.map.size,
    inputsWithBytesInOutput: before.entriesWithBytesInOutput,
  },
  after: {
    revision: values['after-revision'] ?? null,
    label: values['after-label'] ?? null,
    mainJs: afterMainPath,
    bytes: afterBytes,
    sha256: sha256Of(afterMainPath),
    metafile: afterMetaPath,
    metafileOutputBytes: after.outputBytes,
    metafileMatchesArtifact: after.outputBytes === afterBytes,
    inputCount: after.map.size,
    inputsWithBytesInOutput: after.entriesWithBytesInOutput,
  },
  delta: {
    bytes: totalDelta,
    kib: Math.round((totalDelta / 1024) * 100) / 100,
    mib: Math.round((totalDelta / (1024 * 1024)) * 10000) / 10000,
    percent: Math.round((totalDelta / beforeBytes) * 1000000) / 10000,
    attributedByInputsBytes: attributedDelta,
    unattributedBytes: totalDelta - attributedDelta,
  },
  removedModules: removed,
  addedModules: added,
  shrunkModules: shrunk,
  grownModules: grown,
  owners,
  problems,
};

fs.mkdirSync(path.dirname(path.resolve(values['out-json'])), { recursive: true });
fs.writeFileSync(path.resolve(values['out-json']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (values['out-md']) {
  const fmt = (n) => n.toLocaleString('en-US');
  const row = (d) => `| \`${d.input}\` | ${fmt(d.before)} | ${fmt(d.after)} | ${d.delta > 0 ? '+' : ''}${fmt(d.delta)} |`;
  const lines = [
    '# Bundle size: Before/After',
    '',
    `Generated ${report.generatedAt} by \`tools/provider-settings-shots/bundle-size-diff.mjs\` from the`,
    'two esbuild metafiles (`BAIZER_METAFILE=1 npm run build`).',
    '',
    '| | revision | `dist/main.js` | sha256 | inputs | metafile matches artifact |',
    '| --- | --- | --- | --- | --- | --- |',
    `| Before | \`${report.before.revision ?? '?'}\`${report.before.label ? ` — ${report.before.label}` : ''} | **${fmt(beforeBytes)} B** (${(beforeBytes / 1024 / 1024).toFixed(4)} MiB) | \`${report.before.sha256.slice(0, 16)}…\` | ${before.map.size} | ${report.before.metafileMatchesArtifact ? 'yes' : 'NO'} |`,
    `| After | \`${report.after.revision ?? '?'}\`${report.after.label ? ` — ${report.after.label}` : ''} | **${fmt(afterBytes)} B** (${(afterBytes / 1024 / 1024).toFixed(4)} MiB) | \`${report.after.sha256.slice(0, 16)}…\` | ${after.map.size} | ${report.after.metafileMatchesArtifact ? 'yes' : 'NO'} |`,
    `| **Delta** | | **${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)} B** (${report.delta.kib} KiB, ${report.delta.percent}%) | | | |`,
    '',
    'Per-module contributions come from `outputs["dist/main.js"].inputs[].bytesInOutput` — the bytes each',
    'module actually occupies in the single-file bundle (the top-level `inputs` map only carries the',
    'module\'s own source size, which is a different number).',
    '',
    'Per-input attribution (sum of module deltas): '
      + `${attributedDelta > 0 ? '+' : ''}${fmt(attributedDelta)} B; `
      + `the remaining ${fmt(totalDelta - attributedDelta)} B is bundle-level (banner, esbuild runtime helpers, module plumbing).`,
    '',
  ];
  if (removed.length) {
    lines.push('## Modules that disappeared entirely', '', '| input | before | after | delta |', '| --- | --- | --- | --- |', ...removed.map(row), '');
  }
  if (added.length) {
    lines.push('## Modules that appeared', '', '| input | before | after | delta |', '| --- | --- | --- | --- |', ...added.map(row), '');
  }
  if (shrunk.length) {
    lines.push('## Modules that shrank but survived', '', '| input | before | after | delta |', '| --- | --- | --- | --- |', ...shrunk.slice(0, 40).map(row), '');
  }
  if (grown.length) {
    lines.push('## Modules that grew', '', '| input | before | after | delta |', '| --- | --- | --- | --- |', ...grown.slice(-40).reverse().map(row), '');
  }
  lines.push(
    '## By owner',
    '',
    '| owner | before | after | delta | inputs changed |',
    '| --- | --- | --- | --- | --- |',
    ...owners.map((o) => `| ${o.owner} | ${fmt(o.before)} | ${fmt(o.after)} | ${o.delta > 0 ? '+' : ''}${fmt(o.delta)} | ${o.inputs} |`),
    '',
  );
  if (problems.length) {
    lines.push('## Problems', '', ...problems.map((p) => `- ${p}`), '');
  }
  fs.writeFileSync(path.resolve(values['out-md']), `${lines.join('\n')}\n`, 'utf8');
}

console.log(`before  ${beforeBytes} B  (${report.before.revision ?? '?'})  metafile matches: ${report.before.metafileMatchesArtifact}`);
console.log(`after   ${afterBytes} B  (${report.after.revision ?? '?'})  metafile matches: ${report.after.metafileMatchesArtifact}`);
console.log(`delta   ${totalDelta} B (${report.delta.kib} KiB, ${report.delta.percent}%)`);
console.log(`removed ${removed.length} modules, added ${added.length}, shrunk ${shrunk.length}, grown ${grown.length}`);
for (const p of problems) console.error(`PROBLEM: ${p}`);
if (problems.length) process.exitCode = 1;
