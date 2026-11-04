#!/usr/bin/env node
/**
 * Capture the Baizer chat-scroll-follow scenario (issue #64) out of a real,
 * running Obsidian.
 *
 * Nothing here is a mock-up: Obsidian is launched with
 * `--remote-debugging-port`, the real `ShellView` is driven over CDP by
 * calling `view.handleStatusChange`/`view.handleStreamEvent` (the actual
 * runtime methods the real stream pipeline calls), and every PNG comes from
 * `Page.captureScreenshot`. A machine-readable `*.layout.json` is written next
 * to each PNG, measured from the exact same DOM state, because the issue's
 * acceptance criteria are scroll-geometry and affordance-visibility claims
 * that a bitmap alone cannot be asserted against.
 *
 * Usage (see README.md in this directory for the full option list):
 *   node tools/chat-scroll-shots/capture.mjs \
 *     --plugin-dir dist --out-prefix docs/assets/chat-scroll-2026-11-04-before \
 *     --width 1353 --height 1053 --phase before --revision cdcccb6
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { waitForDevTools } from '../provider-settings-shots/lib/cdp.mjs';
import { materialiseVault, registerVaultGlobally, defaultVaultDir, PLUGIN_ID } from '../provider-settings-shots/lib/vault.mjs';
import {
  resolveObsidianExe, pngSize, readExeFileVersion, listPreferredAsarFiles,
  launchObsidian, killTree, waitForAppReady, connectToDrivablePage,
  handleBlockingModals, applyLocale, ensurePluginEnabled, waitForPluginLoaded,
  applyViewport, waitForStableDom,
} from './lib/obsidian.mjs';
import { buildChatProbeExpression } from './lib/chat-probe.mjs';
import { buildScenarioSteps, buildDriveEventExpression, buildOpenChatViewExpression } from './lib/scenario.mjs';
import { buildMeasureSidedockExpression, buildSetSidedockWidthExpression } from './lib/sidebar.mjs';

const VIEW_TYPE_SHELL = `${PLUGIN_ID}-shell-view`;

// --------------------------------------------------------------- helpers ----

async function captureAt(session, { outPath, layoutPath, label, phase, revision, scenarioStep, width, height, pluginDir }) {
  const layout = await session.evaluate(buildChatProbeExpression({
    label, phase, revision, scenarioStep, pluginId: PLUGIN_ID,
  }), { timeoutMs: 60000 });

  const screenshot = await session.send(
    'Page.captureScreenshot',
    { format: 'png', fromSurface: true, captureBeyondViewport: false },
    { timeoutMs: 60000 },
  );
  const png = Buffer.from(screenshot.data, 'base64');
  const size = pngSize(png);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, png);

  const report = {
    ...layout,
    image: {
      path: path.relative(process.cwd(), outPath).replace(/\\/g, '/'),
      bytes: png.length,
      width: size ? size.width : null,
      height: size ? size.height : null,
      requestedWidth: width,
      requestedHeight: height,
      sizeMatchesRequest: size ? size.width === width && size.height === height : null,
    },
    pluginDir,
  };
  await fsp.mkdir(path.dirname(layoutPath), { recursive: true });
  await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, png, size };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'plugin-dir': { type: 'string' },
      'out-prefix': { type: 'string' }, // e.g. docs/assets/chat-scroll-2026-11-04-before-wide -> writes -scrolled-up.png / -new-output.png / -resumed.png
      width: { type: 'string', default: '1353' },
      height: { type: 'string', default: '1053' },
      theme: { type: 'string', default: 'dark' },
      'sidebar-width': { type: 'string' }, // if set, resizes the right sidedock to this px width (the 300px narrow scenario)
      phase: { type: 'string' },
      revision: { type: 'string' },
      vault: { type: 'string' },
      obsidian: { type: 'string' },
      port: { type: 'string', default: '9334' },
      locale: { type: 'string', default: 'zh' },
      'ready-timeout': { type: 'string', default: '180000' },
      'keep-open': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  for (const required of ['plugin-dir', 'out-prefix', 'phase', 'revision']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }

  const pluginDir = path.resolve(values['plugin-dir']);
  const outPrefix = path.resolve(values['out-prefix']);
  const width = Number.parseInt(values.width, 10);
  const height = Number.parseInt(values.height, 10);
  const sidebarWidth = values['sidebar-width'] ? Number.parseInt(values['sidebar-width'], 10) : null;
  const port = Number.parseInt(values.port, 10);
  const readyTimeout = Number.parseInt(values['ready-timeout'], 10);
  const vaultDir = path.resolve(values.vault || defaultVaultDir());
  const theme = values.theme;
  const phase = values.phase;
  const revision = values.revision;

  const exe = resolveObsidianExe(values.obsidian);
  await fsp.mkdir(path.dirname(outPrefix), { recursive: true });

  const vaultInfo = await materialiseVault({ vaultDir, pluginDir, theme });
  const registry = await registerVaultGlobally(vaultDir);

  const notes = [];
  const harness = {
    exe,
    pluginDir,
    vaultDir: vaultInfo.vaultDir,
    vaultKey: registry.vaultKey,
    pluginManifest: vaultInfo.manifest,
    copiedPluginFiles: vaultInfo.copied,
    theme,
    requestedViewport: { width, height },
    sidebarWidthRequested: sidebarWidth,
    phase,
    revision,
    explanations: notes,
  };

  let child = null;
  let session = null;
  const captures = [];
  try {
    child = launchObsidian(exe, port);
    harness.pid = child.pid;

    const devtools = await waitForDevTools(port, { timeoutMs: readyTimeout });
    harness.browser = devtools.Browser ?? null;
    harness.browserUserAgent = devtools['User-Agent'] ?? null;
    harness.obsidianVersionFromExe = readExeFileVersion(exe);
    harness.obsidianAsarFiles = listPreferredAsarFiles();

    const connected = await connectToDrivablePage(port, { timeoutMs: readyTimeout });
    session = connected.session;
    harness.pageTargetsSeen = connected.pagesSeen;

    await waitForAppReady(session, { timeoutMs: readyTimeout });
    harness.locale = await applyLocale(session, values.locale);
    harness.blockingModals = await handleBlockingModals(session);

    const enableResult = await ensurePluginEnabled(session, PLUGIN_ID);
    harness.pluginEnableAttempt = enableResult;
    await waitForPluginLoaded(session, PLUGIN_ID, { timeoutMs: readyTimeout });

    await applyViewport(session, { width, height });
    await delay(400);

    const openResult = await session.evaluate(buildOpenChatViewExpression(VIEW_TYPE_SHELL), { timeoutMs: readyTimeout });
    harness.openChatView = openResult;
    if (!openResult || !openResult.ok) {
      throw new Error(`could not open ${VIEW_TYPE_SHELL}: ${openResult && openResult.error}`);
    }
    await session.waitFor(
      `document.querySelector('.shell-output-area') != null`,
      { timeoutMs: 30000, label: '.shell-output-area present' },
    );
    await waitForStableDom(session, { quietMs: 600, timeoutMs: 15000 });

    if (sidebarWidth) {
      const before = await session.evaluate(buildMeasureSidedockExpression());
      const setResult = await session.evaluate(buildSetSidedockWidthExpression(sidebarWidth));
      await delay(300);
      const after = await session.evaluate(buildMeasureSidedockExpression());
      harness.sidebarResize = { requestedWidthPx: sidebarWidth, before, setResult, after };
      if (!after || !after.found || Math.abs(after.rectWidth - sidebarWidth) > 3) {
        notes.push(
          `requested sidedock width ${sidebarWidth}px but measured ${after && after.rectWidth}px after resize; `
          + 'the narrow capture may not reflect the requested width exactly — see harness.sidebarResize',
        );
      }
    }

    // ---------------------------------------------------------- scenario ----
    const steps = buildScenarioSteps();
    let stepIndex = 0;
    for (const step of steps) {
      stepIndex += 1;
      if (step.type === 'status' || step.type === 'event') {
        const result = await session.evaluate(buildDriveEventExpression(step, VIEW_TYPE_SHELL), { timeoutMs: 30000 });
        if (!result || !result.ok) {
          throw new Error(`scenario step ${stepIndex} (${step.note}) failed: ${result && result.error}`);
        }
        // Let the debounced block renderer / scrollToEnd setTimeout(50ms) settle.
        await delay(90);
      } else if (step.type === 'scroll-up') {
        const scrollResult = await session.evaluate(`(() => {
          const el = document.querySelector('.shell-output-area');
          if (!el) return { ok: false, error: 'no .shell-output-area' };
          const before = el.scrollTop;
          const delta = el.clientHeight * ${step.amountScreens};
          el.scrollTop = Math.max(0, before - delta);
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          return { ok: true, before, after: el.scrollTop, requestedDelta: delta };
        })()`, { timeoutMs: 10000 });
        harness[`scenarioStep${stepIndex}_scrollUp`] = scrollResult;
        await delay(200);
      } else if (step.type === 'click-affordance') {
        const clickResult = await session.evaluate(buildChatProbeExpression({ label: 'pre-click-probe', phase, revision }), { timeoutMs: 15000 });
        const target = clickResult.affordance;
        if (target && target.found && target.clickable) {
          await session.evaluate(`(() => {
            const el = document.querySelector('${(target.classes || '').split(' ').filter(Boolean).map((c) => `.${c}`).join('')}')
              || Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(target.text || '')});
            if (!el) return { ok: false };
            el.click();
            return { ok: true };
          })()`, { timeoutMs: 10000 });
          harness.affordanceClicked = { ok: true, text: target.text, classes: target.classes };
        } else {
          harness.affordanceClicked = { ok: false, reason: 'affordance not found/clickable at click step', probe: target };
          notes.push(
            'the "back to latest" affordance could not be located/clicked at the click-affordance step; '
            + 'see harness.affordanceClicked.probe for what the probe saw at that moment',
          );
        }
        await delay(400);
      } else if (step.type === 'sync') {
        // A settle point between scenario phases that is not independently interesting evidence
        // (e.g. "stream reached the bottom the first time", before the tool-call timeline and the
        // second wave of text_delta chunks are even added) — waited on so later steps start from a
        // settled DOM, but not screenshotted, to keep the capture count proportionate.
        await waitForStableDom(session, { quietMs: 400, timeoutMs: 8000 });
      } else if (step.type === 'marker') {
        await waitForStableDom(session, { quietMs: 400, timeoutMs: 8000 });
        const suffix = stepIndex === 0 ? 'checkpoint' : `step-${stepIndex}`;
        const slug = step.note
          .replace(/\(.*?\)/g, '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48) || suffix;
        const outPath = `${outPrefix}-${slug}.png`;
        const layoutPath = `${outPrefix}-${slug}.layout.json`;
        const { report, png, size } = await captureAt(session, {
          outPath, layoutPath, label: slug, phase, revision, scenarioStep: step.note,
          width, height, pluginDir,
        });
        captures.push({ outPath, layoutPath, note: step.note, size, bytes: png.length, report });
      }
    }

    harness.obsidianVersionFromTitle = (() => {
      const title = captures.length ? captures[captures.length - 1].report.windowTitle : null;
      const match = title ? /Obsidian\s+([0-9][0-9.]*)/i.exec(title) : null;
      return match ? match[1] : null;
    })();

    const summaryPath = `${outPrefix}-run.json`;
    await fsp.writeFile(summaryPath, `${JSON.stringify({ harness, captures: captures.map((c) => ({ ...c, report: undefined })) }, null, 2)}\n`, 'utf8');

    console.log(`captures written: ${captures.length}`);
    for (const c of captures) {
      console.log(`  ${c.outPath}  (${c.size ? `${c.size.width}x${c.size.height}` : 'unknown'}, ${c.bytes} bytes) — ${c.note}`);
      console.log(`    layout: ${c.layoutPath}`);
      console.log(`    scroll: ${JSON.stringify(c.report.scroll)}`);
      console.log(`    affordance: found=${c.report.affordance.found} visible=${c.report.affordance.visible} clickable=${c.report.affordance.clickable}`);
      console.log(`    overflow: doc=${c.report.overflow.document.noHorizontalOverflow} container=${c.report.scroll.noHorizontalOverflow}`);
    }
    console.log(`run summary: ${summaryPath}`);

    const sizeMismatch = captures.find((c) => c.report.image.sizeMatchesRequest === false);
    if (sizeMismatch) {
      console.error(`ERROR: ${sizeMismatch.outPath} size mismatch — viewport control failed.`);
      process.exitCode = 1;
    }
  } finally {
    if (session) session.close();
    if (child && !values['keep-open']) {
      await killTree(child.pid);
    } else if (child) {
      console.log(`--keep-open: leaving Obsidian running (pid ${child.pid})`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
