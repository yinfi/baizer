#!/usr/bin/env node
/**
 * Compare two screenshots by the text the Windows OCR engine can read in them.
 *
 * This is the check that backs the "same scenario, viewport and theme" claim
 * when nobody can look at the images: if two captures were taken from the same
 * UI state at the same size, their OCR text lines land at the same coordinates.
 *
 *   node tools/provider-settings-shots/compare-text.mjs \
 *     --baseline docs/assets/provider-settings-obsidian-2026-11-03.png \
 *     --candidate docs/assets/provider-settings-2026-11-03-before-wide.png \
 *     --out docs/assets/provider-settings-2026-11-03-before-wide.textdiff.json
 *
 * It deliberately reports *both* directions: text present only in the baseline
 * and text present only in the candidate. Differences are evidence, not
 * automatically failures — but they must be explained.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
}

async function ocr(imagePath) {
  const script = path.join(HERE, 'lib', 'ocr.ps1');
  const shell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const stdout = await run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', imagePath]);
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`OCR produced no JSON for ${imagePath}: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start));
}

/** OCR inserts spaces between CJK glyphs; strip all whitespace before matching. */
const normalize = (text) => (text || '').replace(/\s+/g, '').toLowerCase();

function indexLines(ocrResult) {
  const index = new Map();
  for (const line of ocrResult.lines || []) {
    const key = normalize(line.text);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ x: line.x, y: line.y, text: line.text });
  }
  return index;
}

async function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      'tolerance-px': { type: 'string', default: '4' },
    },
  });
  for (const required of ['baseline', 'candidate']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  const tolerance = Number.parseInt(values['tolerance-px'], 10);

  const baselineOcr = await ocr(path.resolve(values.baseline));
  const candidateOcr = await ocr(path.resolve(values.candidate));
  const baseline = indexLines(baselineOcr);
  const candidate = indexLines(candidateOcr);

  const matched = [];
  const onlyBaseline = [];
  const onlyCandidate = [];

  for (const [key, positions] of baseline) {
    const other = candidate.get(key);
    if (!other) {
      onlyBaseline.push({ text: positions[0].text, at: { x: positions[0].x, y: positions[0].y } });
      continue;
    }
    // Pair up occurrences in reading order (top-to-bottom, then left-to-right).
    const sortFn = (a, b) => a.y - b.y || a.x - b.x;
    const left = [...positions].sort(sortFn);
    const right = [...other].sort(sortFn);
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      const dx = right[i].x - left[i].x;
      const dy = right[i].y - left[i].y;
      matched.push({
        text: left[i].text,
        baseline: { x: left[i].x, y: left[i].y },
        candidate: { x: right[i].x, y: right[i].y },
        dx,
        dy,
        withinTolerance: Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance,
      });
    }
    for (let i = right.length; i < left.length; i += 1) {
      onlyBaseline.push({ text: left[i].text, at: { x: left[i].x, y: left[i].y } });
    }
    for (let i = left.length; i < right.length; i += 1) {
      onlyCandidate.push({ text: right[i].text, at: { x: right[i].x, y: right[i].y } });
    }
  }
  for (const [key, positions] of candidate) {
    if (!baseline.has(key)) {
      for (const position of positions) {
        onlyCandidate.push({ text: position.text, at: { x: position.x, y: position.y } });
      }
    }
  }

  const outside = matched.filter((m) => !m.withinTolerance);
  const summary = {
    baseline: {
      path: path.relative(process.cwd(), path.resolve(values.baseline)).replace(/\\/g, '/'),
      size: `${baselineOcr.image.width}x${baselineOcr.image.height}`,
      lineCount: baselineOcr.lineCount,
    },
    candidate: {
      path: path.relative(process.cwd(), path.resolve(values.candidate)).replace(/\\/g, '/'),
      size: `${candidateOcr.image.width}x${candidateOcr.image.height}`,
      lineCount: candidateOcr.lineCount,
    },
    sameImageSize:
      baselineOcr.image.width === candidateOcr.image.width && baselineOcr.image.height === candidateOcr.image.height,
    tolerancePx: tolerance,
    matchedLines: matched.length,
    matchedWithinTolerance: matched.length - outside.length,
    matchedOutsideTolerance: outside.length,
    onlyInBaseline: onlyBaseline.length,
    onlyInCandidate: onlyCandidate.length,
    verdict: {
      sameImageSize:
        baselineOcr.image.width === candidateOcr.image.width && baselineOcr.image.height === candidateOcr.image.height,
      everyMatchedLineWithinTolerance: outside.length === 0,
      identicalTextSets: onlyBaseline.length === 0 && onlyCandidate.length === 0,
    },
  };

  const report = { summary, matchedOutsideTolerance: outside, onlyInBaseline: onlyBaseline, onlyInCandidate: onlyCandidate };

  console.log(JSON.stringify(summary, null, 2));
  if (onlyBaseline.length) {
    console.log('\n-- only in baseline --');
    for (const line of onlyBaseline) console.log(`  [${line.at.x},${line.at.y}] ${line.text}`);
  }
  if (onlyCandidate.length) {
    console.log('\n-- only in candidate --');
    for (const line of onlyCandidate) console.log(`  [${line.at.x},${line.at.y}] ${line.text}`);
  }
  if (outside.length) {
    console.log('\n-- matched but shifted --');
    for (const line of outside) console.log(`  d=(${line.dx},${line.dy}) ${line.text}`);
  }

  if (values.out) {
    const outPath = path.resolve(values.out);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nwrote ${outPath}`);
  }

  if (!summary.verdict.sameImageSize) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`compare-text failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
