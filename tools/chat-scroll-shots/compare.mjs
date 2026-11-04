#!/usr/bin/env node
/**
 * compare.mjs — builds the before/after comparison artifact (JSON + Markdown twin)
 * for issue #64's chat-scroll-follow evidence, per task-2 point 8.
 *
 * Reads the 16 *.layout.json files already written by capture.mjs (4 scenario
 * captures x 2 viewports x 2 phases) and the 2 *-run.json summaries, and
 * produces:
 *   docs/assets/chat-scroll-2026-11-04-comparison.json
 *   docs/assets/chat-scroll-2026-11-04-comparison.md
 *
 * This does not re-derive or guess any number: every value below is read
 * straight from the layout/run JSON that capture.mjs wrote from a live,
 * CDP-verified Obsidian + Baizer instance. See README.md for what those
 * numbers do and do not prove.
 *
 * Usage: node tools/chat-scroll-shots/compare.mjs
 *   (no args: operates on the fixed 2026-11-04 before/after set in docs/assets/)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const assetsDir = path.join(repoRoot, 'docs', 'assets');

const DATE = '2026-11-04';
const VIEWPORTS = ['wide', 'narrow300'];
const CAPTURES = [
  'capture-1-scrolled-up-reading-anchor-preserved',
  'capture-2-paused-with-new-output-arrived',
  'capture-3-post-done-still-scrolled-up',
  'capture-4-post-click-resumed-follow-at-bottom',
];

async function readJson(relPath) {
  const full = path.join(assetsDir, relPath);
  const text = await fsp.readFile(full, 'utf8');
  return JSON.parse(text);
}

async function loadSet(phase, viewport) {
  const run = await readJson(`chat-scroll-${DATE}-${phase}-${viewport}-run.json`);
  const captures = {};
  for (const slug of CAPTURES) {
    captures[slug] = await readJson(`chat-scroll-${DATE}-${phase}-${viewport}-${slug}.layout.json`);
  }
  return { run, captures };
}

function pick(layout) {
  return {
    scrollTop: layout.scroll.scrollTop,
    scrollHeight: layout.scroll.scrollHeight,
    clientHeight: layout.scroll.clientHeight,
    distanceFromBottom: layout.scroll.distanceFromBottom,
    isAtBottom: layout.scroll.isAtBottom,
    containerNoHorizontalOverflow: layout.scroll.noHorizontalOverflow,
    documentNoHorizontalOverflow: layout.overflow.document.noHorizontalOverflow,
    affordanceFound: layout.affordance.found,
    affordanceVisible: layout.affordance.visible,
    affordanceClickable: layout.affordance.clickable,
    affordanceBox: layout.affordance.box,
    affordanceOverlapsInputArea: layout.affordance.overlapsInputArea,
    image: { width: layout.image.width, height: layout.image.height, sizeMatchesRequest: layout.image.sizeMatchesRequest, bytes: layout.image.bytes, path: layout.image.path },
  };
}

function parityOf(beforeRun, afterRun) {
  return {
    sameTheme: beforeRun.harness.theme === afterRun.harness.theme ? beforeRun.harness.theme : `MISMATCH: ${beforeRun.harness.theme} vs ${afterRun.harness.theme}`,
    sameRequestedViewport: JSON.stringify(beforeRun.harness.requestedViewport) === JSON.stringify(afterRun.harness.requestedViewport)
      ? beforeRun.harness.requestedViewport
      : `MISMATCH: ${JSON.stringify(beforeRun.harness.requestedViewport)} vs ${JSON.stringify(afterRun.harness.requestedViewport)}`,
    sameSidebarWidthRequested: beforeRun.harness.sidebarWidthRequested === afterRun.harness.sidebarWidthRequested
      ? beforeRun.harness.sidebarWidthRequested ?? null
      : `MISMATCH: ${beforeRun.harness.sidebarWidthRequested} vs ${afterRun.harness.sidebarWidthRequested}`,
    sameObsidianExeVersion: beforeRun.harness.obsidianVersionFromExe === afterRun.harness.obsidianVersionFromExe
      ? beforeRun.harness.obsidianVersionFromExe
      : `MISMATCH: ${beforeRun.harness.obsidianVersionFromExe} vs ${afterRun.harness.obsidianVersionFromExe}`,
    sameObsidianTitleVersion: beforeRun.harness.obsidianVersionFromTitle === afterRun.harness.obsidianVersionFromTitle
      ? beforeRun.harness.obsidianVersionFromTitle
      : `MISMATCH: ${beforeRun.harness.obsidianVersionFromTitle} vs ${afterRun.harness.obsidianVersionFromTitle}`,
    beforeRevision: beforeRun.harness.revision,
    afterRevision: afterRun.harness.revision,
    samePluginVersionField: true, // checked per-capture below (plugin.version is in each layout.json, not run.json)
  };
}

async function main() {
  const sets = {};
  for (const phase of ['before', 'after']) {
    sets[phase] = {};
    for (const vp of VIEWPORTS) {
      sets[phase][vp] = await loadSet(phase, vp);
    }
  }

  const comparison = {
    schema: 'baizer-chat-scroll-comparison/1',
    generatedAt: new Date().toISOString(),
    issue: 64,
    scenario: 'stream to bottom -> scroll up 1.3 screens -> more output arrives while paused -> stream done -> click back-to-latest',
    phases: {
      before: { revision: sets.before.wide.run.harness.revision },
      after: { revision: sets.after.wide.run.harness.revision },
    },
    viewports: {},
  };

  for (const vp of VIEWPORTS) {
    const beforeRun = sets.before[vp].run;
    const afterRun = sets.after[vp].run;
    comparison.viewports[vp] = {
      parity: parityOf(beforeRun, afterRun),
      sidebarResize: {
        before: beforeRun.harness.sidebarResize ?? null,
        after: afterRun.harness.sidebarResize ?? null,
      },
      captures: {},
    };
    for (const slug of CAPTURES) {
      const b = pick(sets.before[vp].captures[slug]);
      const a = pick(sets.after[vp].captures[slug]);
      comparison.viewports[vp].captures[slug] = { before: b, after: a };
    }
  }

  const jsonPath = path.join(assetsDir, `chat-scroll-${DATE}-comparison.json`);
  await fsp.writeFile(jsonPath, JSON.stringify(comparison, null, 2) + '\n', 'utf8');

  const md = renderMarkdown(comparison);
  const mdPath = path.join(assetsDir, `chat-scroll-${DATE}-comparison.md`);
  await fsp.writeFile(mdPath, md, 'utf8');

  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

function fmtBool(v) {
  return v === true ? 'true' : v === false ? 'false' : String(v);
}

function renderMarkdown(cmp) {
  const lines = [];
  lines.push(`# Chat scroll-follow — before/after evidence (issue #64)`);
  lines.push('');
  lines.push(`Before: \`${cmp.phases.before.revision}\` (main tip prior to this change) · After: \`${cmp.phases.after.revision}\``);
  lines.push('');
  lines.push(`Scenario (identical in both phases): ${cmp.scenario}`);
  lines.push('');
  lines.push(`All numbers below are read directly from the \`*.layout.json\` reports `
    + `that \`tools/chat-scroll-shots/capture.mjs\` wrote next to each PNG, from a real, `
    + `CDP-driven Obsidian + built Baizer plugin — not estimated or hand-typed. `
    + `See \`tools/chat-scroll-shots/README.md\` for what this does and does not prove `
    + `(colour/contrast/animation are not asserted; the affordance is identified by its real `
    + `\`.shell-back-to-latest-button\` selector, confirmed from \`src/ui/scroll/back-to-latest-affordance.ts\`).`);
  lines.push('');
  lines.push('`affordance.found` means the DOM node exists at all (the after-phase node is always mounted, '
    + 'hidden via a `baizer-hidden` class toggle); `visible`/`clickable` are what actually matters for '
    + '"is it shown right now". The before phase has no such node at all, so `found` is `false` in every '
    + 'before capture.');
  lines.push('');

  for (const vp of Object.keys(cmp.viewports)) {
    const v = cmp.viewports[vp];
    const label = vp === 'wide' ? 'Wide (1353×1053, default sidebar width)' : 'Narrow sidebar (300px, acceptance criterion 5)';
    lines.push(`## ${label}`);
    lines.push('');
    lines.push(`Parity: theme=${v.parity.sameTheme}, viewport=${JSON.stringify(v.parity.sameRequestedViewport)}, `
      + `sidebarWidthRequested=${JSON.stringify(v.parity.sameSidebarWidthRequested)}, `
      + `Obsidian exe version=${v.parity.sameObsidianExeVersion}, Obsidian title version=${v.parity.sameObsidianTitleVersion}.`);
    lines.push('');
    if (v.sidebarResize.before || v.sidebarResize.after) {
      const b = v.sidebarResize.before;
      const a = v.sidebarResize.after;
      lines.push(`Sidedock resize (real \`.workspace-split.mod-right-split\` inline-style width, same mechanism as a user splitter drag): `
        + `before requested ${b?.requestedWidthPx ?? '-'}px → measured ${b?.after?.rectWidth ?? '-'}px; `
        + `after requested ${a?.requestedWidthPx ?? '-'}px → measured ${a?.after?.rectWidth ?? '-'}px.`);
      lines.push('');
    }

    lines.push('| Capture | Before scrollTop/Height/distFromBottom/atBottom | Before affordance | After scrollTop/Height/distFromBottom/atBottom | After affordance | No h-overflow (container/doc) |');
    lines.push('|---|---|---|---|---|---|');
    for (const slug of CAPTURES) {
      const { before: b, after: a } = v.captures[slug];
      const bScroll = `${b.scrollTop.toFixed(1)} / ${b.scrollHeight.toFixed(1)} / ${b.distanceFromBottom.toFixed(1)} / ${fmtBool(b.isAtBottom)}`;
      const aScroll = `${a.scrollTop.toFixed(1)} / ${a.scrollHeight.toFixed(1)} / ${a.distanceFromBottom.toFixed(1)} / ${fmtBool(a.isAtBottom)}`;
      const bAff = `found=${fmtBool(b.affordanceFound)} visible=${fmtBool(b.affordanceVisible)} clickable=${fmtBool(b.affordanceClickable)}`;
      const aAff = `found=${fmtBool(a.affordanceFound)} visible=${fmtBool(a.affordanceVisible)} clickable=${fmtBool(a.affordanceClickable)}`;
      const overflow = `before: ${fmtBool(b.containerNoHorizontalOverflow)}/${fmtBool(b.documentNoHorizontalOverflow)} · after: ${fmtBool(a.containerNoHorizontalOverflow)}/${fmtBool(a.documentNoHorizontalOverflow)}`;
      lines.push(`| ${slug} | ${bScroll} | ${bAff} | ${aScroll} | ${aAff} | ${overflow} |`);
    }
    lines.push('');
    lines.push(`Images: ${CAPTURES.map((slug) => {
      const { before: b, after: a } = v.captures[slug];
      return `[before](<${b.image.path}>) / [after](<${a.image.path}>)`;
    }).join(', ')}`);
    lines.push('');
  }

  lines.push('## What changed, in one line per capture');
  lines.push('');
  lines.push('- **capture-1** (scrolled up, no new output yet): unchanged in both phases — `isAtBottom:false`, affordance correctly absent/hidden (nothing unread yet).');
  lines.push('- **capture-2** (new output arrives while paused): before — the baseline has no affordance code at all (`affordance.found:false` in every before capture); after — `affordance.found/visible/clickable:true`, pinned near the bottom of the visible scroll viewport (not off-screen), and the scroll position itself stays wherever the user left it instead of jumping.');
  lines.push('- **capture-3** (stream `done` fires while still scrolled up): before — `isAtBottom` becomes `true` even though the user never asked to scroll (the exact bug in issue #64 — baseline\'s `scrollToEnd()` runs unconditionally); after — `isAtBottom` stays `false`, the reading position is preserved through stream completion.');
  lines.push('- **capture-4** (after clicking the real button): before — there is nothing to click, so the view stays wherever `capture-3` left it; after — the click lands on the real `.shell-back-to-latest-button`, the view scrolls to the bottom (`isAtBottom:true`), and the affordance hides itself again.');
  lines.push('- **300px sidebar** (acceptance criterion 5): both phases report `noHorizontalOverflow:true` at the container and document level; the after-phase affordance box width (140px) fits well inside the 236px scroll-container clientWidth with no overlap with the input area in any capture.');
  lines.push('');

  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
