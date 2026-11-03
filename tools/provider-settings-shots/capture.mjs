#!/usr/bin/env node
/**
 * Capture one provider-settings screenshot — plus a machine-readable layout
 * report measured from the exact same DOM state — out of a real, running
 * Obsidian.
 *
 * Nothing here is a mock-up: Obsidian is launched with
 * `--remote-debugging-port`, the renderer is driven over CDP, and the PNG comes
 * from `Page.captureScreenshot`. The layout report exists because the delivery
 * requirements are geometric (no horizontal overflow, no overlapping controls,
 * no unreachable truncated values) and a bitmap cannot be asserted against.
 *
 * Usage:
 *   node tools/provider-settings-shots/capture.mjs \
 *     --plugin-dir <dir with main.js/manifest.json/styles.css> \
 *     --out docs/assets/provider-settings-2026-11-03-before-wide.png \
 *     --width 1353 --height 1053 --label before-wide --phase before \
 *     --revision 154e483
 *
 * See README.md in this directory for the full option list.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from './lib/cdp.mjs';
import { buildProbeExpression } from './lib/probe.mjs';
import { materialiseVault, registerVaultGlobally, defaultVaultDir, PLUGIN_ID } from './lib/vault.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// --------------------------------------------------------------- helpers ----

function sanitizedEnv() {
  // This host's environment block contains both HTTPS_PROXY and https_proxy.
  // Node tolerates that, but anything that rebuilds the environment into a
  // case-insensitive map (PowerShell's Start-Process, for one) throws. Keep the
  // child environment explicit and free of undefined values.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function resolveObsidianExe(explicit) {
  const candidates = [
    explicit,
    process.env.OBSIDIAN_EXE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Obsidian', 'Obsidian.exe') : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Obsidian', 'Obsidian.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Obsidian', 'Obsidian.exe') : null,
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `Obsidian.exe not found. Pass --obsidian <path> or set OBSIDIAN_EXE. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function launchObsidian(exe, port) {
  // --remote-allow-origins is needed because a CDP WebSocket client may send an
  // Origin header, which Chromium otherwise refuses to accept.
  return spawn(exe, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    stdio: 'ignore',
    detached: false,
    env: sanitizedEnv(),
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', env: sanitizedEnv() });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

async function waitForAppReady(session, { timeoutMs = 120000 } = {}) {
  await session.waitFor(
    `(() => {
       const app = window.app;
       if (!app || !app.workspace) return false;
       if (app.workspace.layoutReady === false) return false;
       const el = document.querySelector('.workspace, .app-container');
       return !!el;
     })()`,
    { timeoutMs, label: 'Obsidian app + workspace ready' },
  );
}

/**
 * Connect to the page target that can actually be driven — the Obsidian *main*
 * window, the one where the `app` global exists.
 *
 * This matters more than it looks. Obsidian can render the settings modal in a
 * **popout window** (see `shouldUsePopout()` in `lib/vault.mjs`), and it then
 * moves the modal's DOM into that window, which is a separate renderer served
 * from `about:blank` with no `app` global. Driving the wrong target means
 * waiting forever for selectors that can never match there — which is exactly
 * how the first attempt at these captures hung. So: pick the main window
 * explicitly, and *prove* `app` is usable before doing anything else.
 */
async function connectToDrivablePage(port, { timeoutMs = 120000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostics = 'no page targets seen yet';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets(port);
    } catch (error) {
      lastDiagnostics = `could not list CDP targets: ${error.message}`;
      await delay(intervalMs);
      continue;
    }
    const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    // The main window is served from app://obsidian.md; popouts are about:blank.
    const ordered = [
      ...pages.filter((t) => /^app:\/\/obsidian\.md/i.test(t.url || '')),
      ...pages.filter((t) => !/^app:\/\/obsidian\.md/i.test(t.url || '')),
    ];
    for (const target of ordered) {
      let session = null;
      try {
        session = await CDPSession.connect(target.webSocketDebuggerUrl);
        await session.send('Page.enable');
        await session.send('Runtime.enable');
        const usable = await session.evaluate(
          `(() => { try { return typeof app !== 'undefined' && !!app.workspace; } catch (error) { return false; } })()`,
        );
        if (usable) return { session, target, pagesSeen: pages.map((t) => ({ id: t.id, url: t.url, title: t.title })) };
        lastDiagnostics = `target ${target.id} (${target.url}) exposes no usable \`app\` global`;
        session.close();
      } catch (error) {
        lastDiagnostics = `target ${target.id} (${target.url}) is not drivable: ${error.message}`;
        if (session) session.close();
      }
    }
    await delay(intervalMs);
  }
  throw new Error(
    `no drivable Obsidian window within ${timeoutMs} ms — the main window (app://obsidian.md) must expose a usable \`app\` global. Last: ${lastDiagnostics}`,
  );
}

/**
 * Clear everything Obsidian puts in front of the settings tab.
 *
 * Three distinct things, all of which the original generic modal sweep missed:
 *
 * 1. The first-open **trust dialog** ("你是否信任这个仓库的作者？",
 *    `.modal.mod-trust-folder`). Until it is accepted the community plugin is
 *    *never loaded*, so no Baizer settings node can ever appear. Its accept
 *    button ("信任仓库作者并启用插件") carries **no class at all** — only the
 *    decline button has one (`.mod-cancel`) — so a `.modal-close-button,
 *    .mod-cta` sweep clicks nothing and the run waits forever.
 * 2. The **release-notes leaf**. Obsidian opens it when the app's
 *    `most-recently-installed-version` (localStorage) is newer than the running
 *    version, and it takes over `document.title`. It is a workspace view, not a
 *    modal, so a modal sweep never sees it. Detached so the window title reads
 *    like the committed baseline's.
 * 3. Any other stray modal (vault picker, changelog dialog, ...).
 */
async function handleBlockingModals(session) {
  const trust = await session.evaluate(`(() => {
    const modal = document.querySelector('.modal.mod-trust-folder')
      || document.querySelector('.modal-container.mod-confirmation .modal');
    if (!modal) return { present: false, clicked: null };
    const buttons = Array.from(modal.querySelectorAll('button'));
    const accept = buttons.find((b) =>
      /信任|trust/i.test(b.textContent || '') && !/安全模式|restricted|safe/i.test(b.textContent || ''));
    if (!accept) {
      return { present: true, clicked: null, buttons: buttons.map((b) => (b.textContent || '').trim()) };
    }
    accept.click();
    return { present: true, clicked: (accept.textContent || '').trim() };
  })()`);

  const strayModalsClosed = await session.evaluate(`(() => {
    const closed = [];
    for (const modal of document.querySelectorAll('.modal-container .modal')) {
      if (modal.classList.contains('mod-settings')) continue;
      const button = modal.querySelector('.modal-close-button, .mod-cta');
      if (button) { button.click(); closed.push(modal.className); }
    }
    return closed;
  })()`);

  const releaseNotes = await session.evaluate(`(() => {
    try {
      const leaves = app.workspace.getLeavesOfType('release-notes');
      for (const leaf of leaves) leaf.detach();
      return { detached: leaves.length };
    } catch (error) {
      return { detached: null, error: String((error && error.message) || error) };
    }
  })()`);

  return { trust, strayModalsClosed, releaseNotes };
}

/** Wait until the community plugin is actually instantiated. */
async function waitForPluginLoaded(session, pluginId, { timeoutMs = 60000 } = {}) {
  try {
    await session.waitFor(
      `!!(window.app && app.plugins && app.plugins.plugins && app.plugins.plugins['${pluginId}'])`,
      { timeoutMs, label: `the '${pluginId}' plugin to be instantiated` },
    );
    return true;
  } catch {
    return false;
  }
}

async function ensurePluginEnabled(session, pluginId) {
  return session.evaluate(`(async () => {
    const app = window.app;
    const out = { steps: [], error: null, loaded: false };
    try {
      if (app.plugins && typeof app.plugins.setEnable === 'function' && app.plugins.enabled === false) {
        app.plugins.setEnable(true);
        out.steps.push('plugins.setEnable(true)');
      }
      if (app.plugins && typeof app.plugins.loadManifests === 'function') {
        await app.plugins.loadManifests();
        out.steps.push('plugins.loadManifests()');
      }
      out.knownManifests = Object.keys((app.plugins && app.plugins.manifests) || {});
      if (app.plugins && !(app.plugins.plugins || {})['${pluginId}'] && typeof app.plugins.enablePlugin === 'function') {
        await app.plugins.enablePlugin('${pluginId}');
        out.steps.push('plugins.enablePlugin()');
      }
      out.loaded = !!((app.plugins && app.plugins.plugins) || {})['${pluginId}'];
      out.restrictedMode = app.plugins ? app.plugins.enabled === false : null;
    } catch (error) {
      out.error = String((error && error.message) || error);
    }
    return out;
  })()`);
}

/** Obsidian keeps the UI language in localStorage; a reload applies it. */
async function applyLocale(session, locale, { reload = true } = {}) {
  if (!locale) return { changed: false, skipped: true };
  const before = await session.evaluate(`(() => ({
    keys: Object.keys(window.localStorage).sort(),
    language: window.localStorage.getItem('language'),
  }))()`);
  if (before.language === locale) return { changed: false, previous: before.language, keys: before.keys };
  await session.evaluate(`window.localStorage.setItem('language', ${JSON.stringify(locale)})`);
  if (!reload) return { changed: true, previous: before.language, keys: before.keys, reloaded: false };
  await session.send('Page.reload', {}, { timeoutMs: 30000 });
  await delay(2500);
  await waitForAppReady(session);
  return { changed: true, previous: before.language, keys: before.keys, reloaded: true };
}

async function openBaizerSettings(session, { timeoutMs = 60000 } = {}) {
  const opened = await session.evaluate(`(async () => {
    const app = window.app;
    if (!app.setting) return { error: 'app.setting is unavailable' };
    app.setting.open();
    let tabId = null;
    try {
      app.setting.openTabById('${PLUGIN_ID}');
      tabId = (app.setting.activeTab && app.setting.activeTab.id) || null;
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
    return {
      tabId,
      isOpen: app.setting.isOpen ?? null,
      popoutCreated: !!app.setting.popout,
      settingsPopoutWindowConfig: (() => {
        try { return app.vault.getConfig('settingsPopoutWindow'); } catch (error) { return 'ERR ' + error.message; }
      })(),
      shouldUsePopout: (() => {
        try { return app.setting.shouldUsePopout(); } catch (error) { return 'ERR ' + error.message; }
      })(),
      settingsModalInMainDocument: !!document.querySelector('.modal.mod-settings'),
      providerCardsInMainDocument: document.querySelectorAll('.baizer-settings-provider-card').length,
    };
  })()`);
  if (opened && opened.error) throw new Error(`could not open the Baizer settings tab: ${opened.error}`);
  return opened;
}

/**
 * Find the window that actually holds the rendered Baizer settings panel.
 *
 * Obsidian renders the settings modal either in the main window or in its own
 * popout window (see `settingsPopoutWindow` in `lib/vault.mjs`). The popout is a
 * separate CDP page target served from `about:blank` and has **no `app` global**
 * — Obsidian also repoints `activeWindow`/`activeDocument` at it, after which
 * even `typeof app` is `undefined` in the main window's context. So the Obsidian
 * API calls all happen in the main window, and the *measurement* happens in
 * whichever window owns the panel.
 */
async function resolveSettingsPanel(port, mainTargetId, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostics = 'no page targets seen';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets(port);
    } catch (error) {
      lastDiagnostics = `could not list CDP targets: ${error.message}`;
      await delay(intervalMs);
      continue;
    }
    const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    lastDiagnostics = pages.map((t) => `${t.id} ${t.url}`).join('; ') || 'no page targets';
    for (const target of pages) {
      let session = null;
      try {
        session = await CDPSession.connect(target.webSocketDebuggerUrl);
        await session.send('Page.enable');
        await session.send('Runtime.enable');
        const cards = await session.evaluate(`document.querySelectorAll('.baizer-settings-provider-card').length`);
        if (cards > 0) {
          return {
            session,
            target,
            location: target.id === mainTargetId ? 'main-window' : 'popout-window',
            providerCardCount: cards,
          };
        }
        session.close();
      } catch (error) {
        lastDiagnostics = `target ${target.id} (${target.url}) not drivable: ${error.message}`;
        if (session) session.close();
      }
    }
    await delay(intervalMs);
  }
  throw new Error(
    `the Baizer provider cards never rendered in any Obsidian window within ${timeoutMs} ms. ` +
      `Page targets: ${lastDiagnostics}`,
  );
}

/** Facts only the main window can answer, for the probe to reuse elsewhere. */
async function readPluginInfo(session) {
  return session.evaluate(`(() => {
    const instance = window.app && app.plugins && app.plugins.plugins && app.plugins.plugins.baizer;
    return {
      loaded: !!instance,
      id: (instance && instance.manifest && instance.manifest.id) || null,
      version: (instance && instance.manifest && instance.manifest.version) || null,
    };
  })()`);
}

/** Expand the active provider's inline detail if it is collapsed. */
async function expandActiveProviderDetail(session, { timeoutMs = 60000 } = {}) {
  await session.evaluate(`(() => {
    if (document.querySelector('.baizer-settings-provider-detail-inline')) return 'already-expanded';
    const main = document.querySelector('.baizer-settings-provider-card.is-active .baizer-settings-provider-card-main');
    if (main) { main.click(); return 'clicked'; }
    return 'no-active-card';
  })()`);
  await session.waitFor(
    `!!document.querySelector('.baizer-settings-provider-detail-inline')`,
    { timeoutMs, label: 'active provider detail to expand' },
  );
}

/** Wait until the settings DOM stops mutating (the model list loads async). */
async function waitForStableDom(session, { quietMs = 1500, timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let lastChangeAt = Date.now();
  const started = Date.now();
  while (Date.now() < deadline) {
    const signature = await session.evaluate(`(() => {
      const root = document.querySelector('.baizer-settings-provider-detail-inline');
      if (!root) return 'no-detail';
      const select = root.querySelector('select');
      return [
        root.innerHTML.length,
        root.querySelectorAll('.baizer-settings-detail-input').length,
        select ? select.value : '-',
        select ? String(select.disabled) : '-',
        root.querySelectorAll('select option').length,
      ].join('|');
    })()`);
    if (signature !== previous) {
      previous = signature;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return { stable: true, signature, settledAfterMs: Date.now() - started };
    }
    await delay(250);
  }
  return { stable: false, signature: previous, settledAfterMs: Date.now() - started };
}

async function applyViewport(session, { width, height }) {
  const attempted = [];
  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    attempted.push('Emulation.setDeviceMetricsOverride');
  } catch (error) {
    attempted.push(`Emulation.setDeviceMetricsOverride failed: ${error.message}`);
  }
  return attempted;
}

// ------------------------------------------------------------------ main ----

async function main() {
  const { values } = parseArgs({
    options: {
      'plugin-dir': { type: 'string' },
      out: { type: 'string' },
      'layout-out': { type: 'string' },
      width: { type: 'string', default: '1353' },
      height: { type: 'string', default: '1053' },
      theme: { type: 'string', default: 'dark' },
      label: { type: 'string' },
      phase: { type: 'string' },
      revision: { type: 'string' },
      scenario: { type: 'string' },
      vault: { type: 'string' },
      obsidian: { type: 'string' },
      port: { type: 'string', default: '9333' },
      locale: { type: 'string', default: 'zh' },
      'ready-timeout': { type: 'string', default: '180000' },
      'keep-open': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  for (const required of ['plugin-dir', 'out']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }

  const pluginDir = path.resolve(values['plugin-dir']);
  const outPath = path.resolve(values.out);
  const layoutPath = values['layout-out']
    ? path.resolve(values['layout-out'])
    : outPath.replace(/\.png$/i, '.layout.json');
  const width = Number.parseInt(values.width, 10);
  const height = Number.parseInt(values.height, 10);
  const port = Number.parseInt(values.port, 10);
  const readyTimeout = Number.parseInt(values['ready-timeout'], 10);
  const vaultDir = path.resolve(values.vault || defaultVaultDir());
  const theme = values.theme;
  const label = values.label || path.basename(outPath, '.png');

  const scenario = values.scenario
    ? JSON.parse(await fsp.readFile(path.resolve(values.scenario), 'utf8'))
    : undefined;

  const exe = resolveObsidianExe(values.obsidian);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.mkdir(path.dirname(layoutPath), { recursive: true });

  const vaultInfo = await materialiseVault({ vaultDir, pluginDir, scenario, theme });
  const registry = await registerVaultGlobally(vaultDir);

  const notes = [];
  const runInfo = {
    exe,
    pluginDir,
    vaultDir: vaultInfo.vaultDir,
    vaultKey: registry.vaultKey,
    globalConfig: { path: registry.configPath, backup: registry.backupPath, hadExisting: registry.hadExistingConfig },
    pluginManifest: vaultInfo.manifest,
    copiedPluginFiles: vaultInfo.copied,
    scenarioPath: values.scenario ? path.resolve(values.scenario) : null,
    theme,
    requestedViewport: { width, height },
    explanations: notes,
  };

  let child = null;
  let session = null;
  let panelSession = null;
  try {
    child = launchObsidian(exe, port);
    runInfo.pid = child.pid;

    const devtools = await waitForDevTools(port, { timeoutMs: readyTimeout });
    runInfo.browser = devtools.Browser ?? null;
    runInfo.protocolVersion = devtools['Protocol-Version'] ?? null;
    // The executable is what `--obsidian` names, but the renderer's UA string
    // also carries the app version Obsidian reports. Record both: the binary can
    // be older than the app code it loads (Obsidian prefers a downloaded
    // `obsidian-<version>.asar` in %APPDATA% over its own resources/obsidian.asar).
    runInfo.browserUserAgent = devtools['User-Agent'] ?? null;

    const connected = await connectToDrivablePage(port, { timeoutMs: readyTimeout });
    session = connected.session;
    const target = connected.target;
    runInfo.target = { id: target.id, type: target.type, url: target.url, title: target.title };
    runInfo.pageTargetsSeen = connected.pagesSeen;
    runInfo.mainWindowAsserted = true;

    await waitForAppReady(session, { timeoutMs: readyTimeout });

    runInfo.locale = await applyLocale(session, values.locale);
    // Order matters: the trust dialog must be accepted before the plugin can
    // load, and the release-notes leaf must go before the title is recorded.
    runInfo.blockingModals = await handleBlockingModals(session);
    runInfo.pluginActivation = await ensurePluginEnabled(session, PLUGIN_ID);
    runInfo.pluginLoaded = await waitForPluginLoaded(session, PLUGIN_ID, { timeoutMs: Math.min(readyTimeout, 90000) });
    if (!runInfo.pluginLoaded) {
      notes.push(
        'the Baizer plugin never became instantiated (app.plugins.plugins.baizer); the settings tab may still be registered',
      );
    }

    runInfo.settings = await openBaizerSettings(session, { timeoutMs: readyTimeout });
    runInfo.pluginInfoFromMainWindow = await readPluginInfo(session);

    // The panel may live in the main window (inset modal) or in Obsidian's own
    // popout settings window (the app default, and what the committed baseline
    // shows). Measure and screenshot whichever window actually owns it.
    const panel = await resolveSettingsPanel(port, target.id, { timeoutMs: readyTimeout });
    panelSession = panel.session;
    runInfo.settingsPanelLocation = panel.location;
    runInfo.captureTarget = { id: panel.target.id, type: panel.target.type, url: panel.target.url, title: panel.target.title };
    if (panel.location !== 'main-window') {
      notes.push(
        `the settings panel rendered in a separate "${panel.location}"; it was measured and captured there (it has no \`app\` global, so plugin facts come from the main window)`,
      );
    }

    await expandActiveProviderDetail(panelSession, { timeoutMs: readyTimeout });

    // Give the async model-list load a chance to settle before measuring.
    runInfo.domStability = await waitForStableDom(panelSession);
    if (!runInfo.domStability.stable) {
      notes.push('the settings DOM was still mutating when the capture went ahead; numbers may not be reproducible');
    }

    runInfo.viewportControl = await applyViewport(panelSession, { width, height });
    await delay(600);
    runInfo.domStabilityAfterViewport = await waitForStableDom(panelSession, { quietMs: 1200, timeoutMs: 30000 });

    const layout = await panelSession.evaluate(buildProbeExpression({
      label,
      phase: values.phase ?? null,
      revision: values.revision ?? null,
      pluginDir,
      obsidianVersion: null,
      expectedTheme: theme,
      pluginInfo: runInfo.pluginInfoFromMainWindow,
    }), { timeoutMs: 120000 });

    const screenshot = await panelSession.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false },
      { timeoutMs: 120000 },
    );
    const png = Buffer.from(screenshot.data, 'base64');
    const size = pngSize(png);
    await fsp.writeFile(outPath, png);

    const report = {
      ...layout,
      harness: runInfo,
      image: {
        path: path.relative(process.cwd(), outPath).replace(/\\/g, '/'),
        bytes: png.length,
        width: size ? size.width : null,
        height: size ? size.height : null,
        requestedWidth: width,
        requestedHeight: height,
        sizeMatchesRequest: size ? size.width === width && size.height === height : null,
      },
    };
    report.harness.obsidianVersionFromTitle = (() => {
      const title = report.windowTitle || '';
      const match = /Obsidian\s+([0-9][0-9.]*)/i.exec(title);
      return match ? match[1] : null;
    })();
    await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    // ------------------------------------------------------- summary ----
    const v = report.verdict ?? {};
    console.log(`image      ${outPath}  (${size ? `${size.width}x${size.height}` : 'unknown size'}, ${png.length} bytes)`);
    console.log(`layout     ${layoutPath}`);
    console.log(`title      ${report.windowTitle ?? '(n/a)'}`);
    console.log(`panel      ${report.harness.settingsPanelLocation} (${report.harness.captureTarget?.url ?? '?'})`);
    console.log(`obsidian   ${report.harness.obsidianVersionFromTitle ?? 'unknown'}`);
    console.log(`plugin     ${report.plugin?.id ?? '?'} v${report.plugin?.version ?? '?'} loaded=${report.plugin?.loaded}`);
    console.log(`theme      ${report.theme} (expected ${theme})`);
    console.log(`viewport   innerWidth=${report.viewport?.innerWidth} innerHeight=${report.viewport?.innerHeight} requested=${width}x${height}`);
    console.log(`cards      ${(report.providerCards ?? []).map((c) => `${c.title}${c.active ? '*' : ''}`).join(', ')}`);
    console.log(`overflow   document=${report.overflow?.document?.overflowPx}px offenders=${report.overflow?.offenderCount} spill=${report.overflow?.spillCount}`);
    console.log(`overlap    controls=${report.overlap?.controlCount} overlappingPairs=${report.overlap?.pairs?.length}`);
    console.log(`truncation ${(report.truncation?.fields ?? []).filter((f) => f.found && f.textOverflowsBox).map((f) => f.name).join(', ') || 'none'}`);
    console.log(`verdict    ${Object.entries(v).filter(([k]) => typeof v[k] === 'boolean').map(([k, val]) => `${val ? 'PASS' : 'FAIL'}:${k}`).join(' ')}`);

    if (size && (Math.abs(size.width - width) > 2 || Math.abs(size.height - height) > 2)) {
      console.error(
        `ERROR: captured image is ${size.width}x${size.height} but ${width}x${height} was requested — viewport control failed.`,
      );
      process.exitCode = 1;
    }
  } finally {
    if (panelSession && panelSession !== session) panelSession.close();
    if (session) session.close();
    if (child && !values['keep-open']) {
      await killTree(child.pid);
    } else if (child) {
      console.log(`obsidian   left running, pid ${child.pid}, devtools on 127.0.0.1:${port}`);
    }
  }
}

main().catch((error) => {
  console.error(`capture failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
