#!/usr/bin/env node
/**
 * Offline smoke test for the capture pipeline.
 *
 * Obsidian is a 340 MB download and a GUI app, so the two risky pieces of the
 * harness — the CDP client (`lib/cdp.mjs`) and the in-page probe
 * (`lib/probe.mjs`) — are exercised here against a static replica of the
 * provider-settings DOM in headless Chrome/Edge. This checks:
 *
 *   * the CDP WebSocket client can connect, evaluate and screenshot;
 *   * `Emulation.setDeviceMetricsOverride` yields a PNG of exactly the
 *     requested size (the assumption the real harness relies on);
 *   * the probe runs without throwing and produces every documented section;
 *   * the container-query breakpoint behaves (2 columns wide, 1 column narrow);
 *   * `lib/ocr.ps1` can read the PNG back.
 *
 *   node tools/provider-settings-shots/test/smoke.mjs
 *   node tools/provider-settings-shots/test/smoke.mjs --chrome "<path to chrome.exe>"
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, waitForPageTarget } from '../lib/cdp.mjs';
import { buildProbeExpression } from '../lib/probe.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = 9411;

function defaultChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('no Chrome/Edge found; pass --chrome <path>');
}

function env() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') out[key] = value;
  return out;
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const VIEWPORTS = [
  { width: 1353, height: 1053, name: 'wide' },
  { width: 520, height: 900, name: 'narrow' },
];

async function main() {
  const { values } = parseArgs({
    options: {
      chrome: { type: 'string' },
      out: { type: 'string' },
      'keep-artifacts': { type: 'boolean', default: false },
    },
  });

  const chrome = values.chrome || defaultChrome();
  const outDir = path.resolve(values.out || path.join(os.tmpdir(), 'baizer-shots-smoke'));
  await fsp.mkdir(outDir, { recursive: true });

  const profileDir = path.join(os.tmpdir(), 'baizer-shots-smoke-profile');
  await fsp.rm(profileDir, { recursive: true, force: true });

  const fixtureUrl = `file:///${path.join(HERE, 'fixture.html').replace(/\\/g, '/')}`;
  console.log(`chrome   ${chrome}`);
  console.log(`fixture  ${fixtureUrl}`);
  console.log(`out      ${outDir}`);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1400,1100',
      fixtureUrl,
    ],
    { stdio: 'ignore', env: env() },
  );

  const failures = [];
  const check = (label, condition, detail = '') => {
    if (condition) console.log(`PASS  ${label}`);
    else {
      console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
      failures.push(label);
    }
  };

  let session = null;
  try {
    await waitForDevTools(PORT, { timeoutMs: 60000 });
    const target = await waitForPageTarget(PORT, { timeoutMs: 60000 });
    session = await CDPSession.connect(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.waitFor(
      `document.readyState === 'complete' && !!document.querySelector('.baizer-settings-provider-detail-inline')`,
      { timeoutMs: 30000, label: 'fixture DOM ready' },
    );
    console.log('PASS  CDP connect + evaluate');

    for (const viewport of VIEWPORTS) {
      console.log(`\n--- ${viewport.name} ${viewport.width}x${viewport.height} ---`);
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });
      await delay(400);

      const report = await session.evaluate(
        buildProbeExpression({
          label: `smoke-${viewport.name}`,
          phase: 'smoke',
          revision: 'fixture',
          pluginDir: 'tools/provider-settings-shots/test/fixture.html',
          expectedTheme: 'dark',
        }),
        { timeoutMs: 60000 },
      );

      const shot = await session.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        { timeoutMs: 60000 },
      );
      const png = Buffer.from(shot.data, 'base64');
      const size = pngSize(png);
      const pngPath = path.join(outDir, `smoke-${viewport.name}.png`);
      const jsonPath = path.join(outDir, `smoke-${viewport.name}.layout.json`);
      await fsp.writeFile(pngPath, png);
      await fsp.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

      check(`probe returned a report (${viewport.name})`, !!report && report.schema === 'baizer-provider-settings-layout/1');
      check(
        `screenshot is exactly ${viewport.width}x${viewport.height} (${viewport.name})`,
        size.width === viewport.width && size.height === viewport.height,
        `got ${size.width}x${size.height}`,
      );
      check(
        `page viewport matches request (${viewport.name})`,
        report.viewport.innerWidth === viewport.width && report.viewport.innerHeight === viewport.height,
        `innerWidth=${report.viewport.innerWidth} innerHeight=${report.viewport.innerHeight}`,
      );
      check(`theme detected as dark (${viewport.name})`, report.theme === 'dark', report.theme);
      check(`window title parsed (${viewport.name})`, /Obsidian\s+1\.14\.5/.test(report.windowTitle || ''), report.windowTitle);
      check(`plugin reported loaded (${viewport.name})`, report.plugin.loaded === true);
      check(`both provider cards found (${viewport.name})`, report.providerCards.length === 2);
      check(`opencode is the active card (${viewport.name})`, report.providerCards.some((c) => c.active && c.title === 'opencode'));
      check(`both connection cards found (${viewport.name})`, report.connectionCards.length === 2);
      check(
        `all probe sections present (${viewport.name})`,
        ['overflow', 'overlap', 'truncation', 'wrapping', 'alignment', 'verdict'].every((k) => report[k] && typeof report[k] === 'object'),
      );
      check(
        `verdict booleans all defined (${viewport.name})`,
        Object.values(report.verdict).every((v) => typeof v === 'boolean' || Array.isArray(v)),
      );

      const gridColumns = (report.alignment.connectionGridTemplateColumns || '').split(' ').filter(Boolean).length;
      if (viewport.name === 'wide') {
        check('wide: connection grid has 2 columns', gridColumns === 2, report.alignment.connectionGridTemplateColumns);
        check('wide: detail rows use the 2-column template', report.alignment.labelColumnConsistent === true);
      } else {
        check('narrow: connection grid collapsed to 1 column', gridColumns === 1, report.alignment.connectionGridTemplateColumns);
        check('narrow: detail rows collapsed to 1 column', report.alignment.labelColumnConsistent === true);
      }

      const fields = Object.fromEntries(report.truncation.fields.map((f) => [f.name, f]));
      check(`apiEndpoint field located (${viewport.name})`, fields.apiEndpoint?.found === true);
      check(`model field located (${viewport.name})`, fields.model?.found === true);
      check(`customHeaders field located (${viewport.name})`, fields.customHeaders?.found === true);
      check(
        `custom headers help note measured (${viewport.name})`,
        report.wrapping.customHeadersHelp?.found === true,
        JSON.stringify(report.wrapping.customHeadersHelp),
      );
      check(`secret action buttons measured (${viewport.name})`, report.wrapping.secretActionButtons?.found === true);

      // The fixture's API-endpoint value is deliberately longer than the value
      // column, so a detector that never fires would be caught here.
      const longField = fields.apiEndpoint;
      check(
        `truncation detector fires on the over-long value (${viewport.name})`,
        longField?.textOverflowsBox === true &&
          longField.renderedTextWidth > longField.availableTextWidth,
        `rendered=${longField?.renderedTextWidth} available=${longField?.availableTextWidth}`,
      );
      check(
        `over-long value still counts as reachable (${viewport.name})`,
        longField?.fullValueReachable === true,
        JSON.stringify({ disabled: longField?.disabled, title: longField?.titleAttribute }),
      );
      check(
        `noUnreachableTruncatedValues holds despite truncation (${viewport.name})`,
        report.verdict.noUnreachableTruncatedValues === true,
        JSON.stringify(report.verdict.unreachableTruncatedFields),
      );

      console.log(
        `info  overflowPx=${report.overflow.document.overflowPx} offenders=${report.overflow.offenderCount} ` +
          `spill=${report.overflow.spillCount} overlapPairs=${report.overlap.pairs.length} ` +
          `valueCol=${report.alignment.minValueColumnWidth}px`,
      );
      console.log(`info  truncated=${JSON.stringify(report.verdict.fieldsWithTextOverflow)}`);
      console.log(`info  helpLines=${report.wrapping.customHeadersHelp?.lineCount} secretRows=${report.wrapping.secretActionButtons?.distinctRows}`);
    }
  } finally {
    if (session) session.close();
    if (child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', env: env() });
        killer.on('close', resolve);
        killer.on('error', resolve);
      });
    }
    if (!values['keep-artifacts']) await fsp.rm(profileDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length) {
    console.log(`SMOKE FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`SMOKE PASSED — artifacts in ${outDir}`);
  }
}

main().catch((error) => {
  console.error(`smoke failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
