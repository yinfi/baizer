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
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from './lib/cdp.mjs';
import { buildProbeExpression } from './lib/probe.mjs';
import { materialiseVault, registerVaultGlobally, defaultVaultDir, PLUGIN_ID } from './lib/vault.mjs';

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

/**
 * The launched binary's own FileVersion, read from its PE version resource.
 *
 * Windows only, and deliberately best-effort: the version that actually RAN comes from the window
 * title (recorded as `obsidianVersionFromTitle` / `obsidianVersionInPage`), and this field exists to
 * show that the two can legitimately disagree.
 */
function readExeFileVersion(exe) {
  if (process.platform !== 'win32' || !exe) return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${String(exe).replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const version = String(out).trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Downloaded app bundles Obsidian will prefer over its own `resources/obsidian.asar`.
 *
 * This is the mechanism behind "the 1.14.5 executable ran 1.15.0 code", so it is recorded next to
 * the versions rather than left as folklore.
 */
function listPreferredAsarFiles() {
  const dir = process.env.APPDATA ? path.join(process.env.APPDATA, 'obsidian') : null;
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^obsidian-.*\.asar$/i.test(name))
      .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { file: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      });
  } catch {
    return [];
  }
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

  // `openTabById` returns before the tab has rendered, and in the popout case the
  // window itself is created asynchronously. Poll until the tab we asked for is
  // the active one *and* its host window exists, bounded by the caller's
  // readiness budget (`--ready-timeout`). Returning immediately here made every
  // later step race the panel's first render.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let ready = null;
  while (Date.now() < deadline) {
    ready = await session.evaluate(`(() => {
      const app = window.app;
      const tab = app.setting && app.setting.activeTab;
      return {
        tabId: (tab && tab.id) || null,
        isOpen: app.setting ? app.setting.isOpen ?? null : null,
        popoutCreated: !!(app.setting && app.setting.popout),
        settingsModalInMainDocument: !!document.querySelector('.modal.mod-settings'),
      };
    })()`);
    if (ready.tabId === PLUGIN_ID && (ready.popoutCreated || ready.settingsModalInMainDocument)) {
      return { ...opened, ...ready, readyWaitedMs: Date.now() - startedAt };
    }
    await delay(250);
  }
  return { ...opened, ...(ready || {}), readyTimedOut: true, readyWaitedMs: Date.now() - startedAt };
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

/**
 * Open the collapsed advanced sections (e.g. the reworked Custom headers block lives in a
 * `<details>`). Without this, the help text inside has clientWidth 0 and the layout probe would
 * report it as "not clipped" vacuously — a false pass. Idempotent, and a no-op on the revision
 * where those fields were always visible.
 */
async function expandAdvancedSections(session) {
  return session.evaluate(`(() => {
    const opened = [];
    for (const details of document.querySelectorAll('details.baizer-settings-advanced')) {
      const summary = details.querySelector('summary');
      const label = summary ? (summary.textContent || '').trim() : '';
      if (!details.open) {
        details.open = true;
        // A real click also updates the plugin's own open/closed bookkeeping, so a later
        // re-render keeps it open; setting .open alone can be undone by the next render.
        if (summary) summary.click();
        opened.push(label);
      }
    }
    return { opened, total: document.querySelectorAll('details.baizer-settings-advanced').length };
  })()`);
}

/**
 * Bring the provider-type `<select>` into view, and optionally render its options inline.
 *
 * The type dropdown is the control whose OPTION LIST changes when a protocol is added or removed,
 * so both phases must show it. At 520x900 it sits below the fold, so the settings pane is scrolled
 * the minimum amount needed; at 1353x1053 it is already visible and nothing is scrolled, which
 * keeps the framing identical to this harness's earlier captures.
 *
 * `--expand-type-select` sets `size`, which turns the closed dropdown into a native list box that
 * renders every option — the only way a removed option can appear in a bitmap, because a closed
 * `<select>` paints just its selected option. That is a DOM-only change: the control, its value and
 * its options are untouched, and the layout report records it (`providerTypeSelect.renderedAsList` /
 * `sizeAttribute`), so the evidence cannot be mistaken for the unmodified presentation.
 *
 * Pass a NUMBER (`--expand-type-select 3`) to pin the list box to that many rows. That matters for a
 * before/after pair: with the default `size = option count` the box is one row shorter in the phase
 * that has one option fewer, which pushes everything BELOW the control up by a row height (measured:
 * 17.66px, and 106,549 of the 131,375 differing pixels were that shift rather than the option list).
 * Pinning the same `size` in both phases keeps the geometry identical, so the only pixels that differ
 * are the option rows themselves.
 */
async function focusProviderTypeSelect(session, { expand = false, expandSize = null } = {}) {
  return session.evaluate(`(() => {
    const findSelect = () => {
      const detail = document.querySelector('.baizer-settings-provider-detail-inline') || document;
      for (const row of detail.querySelectorAll('.baizer-settings-detail-row')) {
        const label = row.querySelector('.baizer-settings-detail-label');
        const text = label ? (label.textContent || '').trim() : '';
        if (/protocol|协议|API\\s*类型|类型/i.test(text)) {
          const control = row.querySelector('select');
          if (control) return control;
        }
      }
      return detail.querySelector('select') || null;
    };
    const el = findSelect();
    if (!el) return { found: false, scrolled: false, expanded: false, inViewport: false };
    const scrollable = (() => {
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll|overlay)/.test(String(cs.overflowY)) && node.scrollHeight > node.clientHeight + 1) return node;
        node = node.parentElement;
      }
      return null;
    })();
    const container = scrollable || document.scrollingElement || document.documentElement;
    // The settings pane's scroll position is PERSISTED by Obsidian (workspace.json), so a run that
    // reuses a vault starts wherever the previous run left it — observed: 1228px on one wide run and
    // 0 on another, which moves the same control by 1200px and makes before/after frames
    // incomparable. Reset first, then scroll the minimum needed: a control that already fits is left
    // where the committed captures had it (scrollTop 0).
    const scrollTopInitial = container.scrollTop;
    container.scrollTop = 0;
    const scrollTopBefore = container.scrollTop;
    const margin = 24;
    let rect = el.getBoundingClientRect();
    let delta = 0;
    if (rect.top < margin) delta = rect.top - margin;
    else if (rect.bottom > window.innerHeight - margin) delta = rect.bottom - (window.innerHeight - margin);
    if (delta !== 0) container.scrollTop = Math.max(0, scrollTopBefore + delta);
    rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ block: 'center' });
    }
    let expanded = false;
    if (${expand ? 'true' : 'false'} && el.tagName.toLowerCase() === 'select' && el.options.length > 1) {
      const requested = ${expandSize === null ? 'null' : Number(expandSize)};
      el.size = requested === null ? el.options.length : requested;
      el.style.height = 'auto';
      expanded = true;
    }
    const finalRect = el.getBoundingClientRect();
    const name = container === document.scrollingElement
      ? 'document.scrollingElement'
      : (typeof container.className === 'string' && container.className.trim() ? container.className.trim() : container.tagName.toLowerCase());
    return {
      found: true,
      scrolled: Math.abs(container.scrollTop - scrollTopBefore) > 0.5,
      scrollTopInitial,
      scrollTopBefore,
      scrollTopAfter: container.scrollTop,
      container: name,
      expanded,
      box: { x: finalRect.left, y: finalRect.top, w: finalRect.width, h: finalRect.height, bottom: finalRect.bottom },
      inViewport: finalRect.top >= -0.5 && finalRect.bottom <= window.innerHeight + 0.5,
      optionTexts: Array.from(el.options).map((o) => (o.text || '').trim()),
    };
  })()`);
}

/**
 * Wait until the plugin has actually LOADED the scenario's settings.
 *
 * On a vault Obsidian has never seen, the first-open trust dialog is what enables the plugin — and
 * the settings tab can then be rendered before `loadSettings()` has replaced the defaults. Observed
 * symptom (fresh `--vault`, scenario `activeProvider: "opencode"`): the panel showed the first
 * provider (`cch`) as active and the plugin even persisted that back to `data.json`, so the
 * "before" capture silently documented the wrong provider. Waiting here removes the race instead of
 * hiding it, and `--expect-active` / `--expect-providers` make the expectation explicit.
 */
async function waitForPluginSettings(session, { expectActive = null, expectProviders = null, timeoutMs = 30000 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.evaluate(`(() => {
      const app = window.app;
      const plugin = app && app.plugins && app.plugins.plugins && app.plugins.plugins.baizer;
      const settings = plugin && plugin.settings;
      return {
        instance: !!plugin,
        settingsLoaded: !!settings,
        activeProvider: (settings && settings.activeProvider) || null,
        providers: settings && settings.providers ? Object.keys(settings.providers) : null,
      };
    })()`);
    if (last && last.settingsLoaded) {
      const activeOk = !expectActive || last.activeProvider === expectActive;
      const providersOk = !expectProviders || expectProviders.every((id) => (last.providers || []).includes(id));
      if (activeOk && providersOk) return { ...last, matched: true, waitedMs: Date.now() - started };
    }
    await delay(200);
  }
  return {
    ...(last || {}),
    matched: false,
    waitedMs: Date.now() - started,
    expected: { activeProvider: expectActive, providers: expectProviders },
  };
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

/**
 * Track the plugin's model-list request on one CDP session.
 *
 * `waitForStableDom` cannot make the Model row reproducible on its own. The panel
 * renders that row twice: once from the built-in candidate list while the
 * endpoint call is still in flight, and again when the call resolves and the note
 * under the select is filled in. **The pre-resolution render is the SHORTER one**
 * — the note div stays 0 px tall until the first `applyState`, so the row is
 * 18 px shorter at 1353 and 36 px shorter at 600 before the call resolves.
 * `alignment.rows[4].valueBox.h` measures 104 (pre) / 122 (post) at 1353 and
 * 162 / 198 at 600. The pre-resolution render is also perfectly *stable* — it is
 * simply not final — so a quiet-window wait can and did capture it, and the same
 * revision produced both values.
 *
 * **KNOWN DEFECT — this tracker can never fire for this plugin.** Baizer lists
 * models through Obsidian's `requestUrl` (`src/services/model-catalog-service.ts`),
 * which performs the HTTP call in the Electron *main* process and hands the
 * renderer a buffered body over IPC. No renderer-level network request is ever
 * emitted, so CDP's `Network` domain sees nothing: every artifact records
 * `via: 'no-request'` with `seen: 0`. Do **not** cite `modelListRequest` as
 * evidence that the row settled — it says the opposite.
 *
 * What actually keeps captures deterministic today is the incidental `graceMs`
 * sleep in `waitForModelListRequest` below, which happens to sit before
 * `waitForStableDom`. That is a timing band-aid, not a signal: an endpoint slower
 * than the grace window reintroduces the flake silently, with no warning.
 * A correct fix has to key on a DOM signal — the model select leaves its loading
 * state (`disabled` with a single `__loading__` option) once the list resolves —
 * because `waitForStableDom`'s signature hashes the *first* select in the detail
 * (the protocol select) and is therefore blind to this re-render.
 */
function createModelListTracker() {
  return { seen: 0, completed: 0, pending: new Set(), lastUrl: null, lastCompletedAt: 0 };
}

function attachModelListListeners(session, tracker) {
  const offRequest = session.on('Network.requestWillBeSent', (params) => {
    const url = (params && params.request && params.request.url) || '';
    // Both listers hit `.../models`: openai-compatible `{base}/models`, anthropic
    // `{base}/v1/models`. Nothing else in the settings panel calls that path.
    if (!/\/models(?:[?#]|$)/.test(url)) return;
    tracker.pending.add(params.requestId);
    tracker.seen += 1;
    tracker.lastUrl = url;
  });
  const settle = (params) => {
    if (!tracker.pending.delete(params.requestId)) return;
    tracker.completed += 1;
    tracker.lastCompletedAt = Date.now();
  };
  const offFinished = session.on('Network.loadingFinished', settle);
  const offFailed = session.on('Network.loadingFailed', settle);
  return () => {
    offRequest();
    offFinished();
    offFailed();
  };
}

async function installModelListTracker(session, into) {
  const tracker = createModelListTracker();
  try {
    await session.send('Network.enable', {}, { timeoutMs: 10000 });
  } catch (error) {
    tracker.error = String((error && error.message) || error);
    return tracker;
  }
  tracker.detach = attachModelListListeners(session, tracker);
  into.push(tracker);
  return tracker;
}

/**
 * Wait until the model-list request has been seen *and* finished — which, per the
 * defect documented above, never happens in practice for this plugin. The only
 * observable effect is therefore the `graceMs` sleep before it gives up; the
 * `via: 'no-request'` it returns is the truthful report that no request was
 * observed, not a signal that the row settled.
 *
 * Bounded, and honest when it cannot tell: if the panel never issues an
 * observable request (always, today) we fall back to the DOM stability wait.
 */
async function waitForModelListRequest(trackers, { timeoutMs = 45000, graceMs = 8000, idleMs = 400 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // Load-bearing for reproducibility, but only by accident: the `no-request`
  // branch below returns as soon as this elapses, so in practice this is a plain
  // 8 s sleep before the stability wait. It is a bet that 8 s outlasts the
  // endpoint, not a signal that the model list has arrived.
  const graceDeadline = startedAt + graceMs;
  while (Date.now() < deadline) {
    const seen = trackers.filter((t) => t.seen > 0);
    if (seen.length > 0) {
      const pending = seen.reduce((n, t) => n + t.pending.size, 0);
      const lastCompletedAt = Math.max(...seen.map((t) => t.lastCompletedAt || 0));
      if (pending === 0 && Date.now() - lastCompletedAt >= idleMs) {
        return {
          settled: true,
          via: 'network',
          requests: seen.reduce((n, t) => n + t.seen, 0),
          completed: seen.reduce((n, t) => n + t.completed, 0),
          url: seen[seen.length - 1].lastUrl,
          waitedMs: Date.now() - startedAt,
        };
      }
    } else if (Date.now() >= graceDeadline) {
      return {
        settled: false,
        via: 'no-request',
        note: 'no /models request seen; relying on the DOM stability wait',
        waitedMs: Date.now() - startedAt,
      };
    }
    await delay(100);
  }
  const seen = trackers.filter((t) => t.seen > 0);
  return {
    settled: false,
    via: 'timeout',
    requests: seen.reduce((n, t) => n + t.seen, 0),
    pending: seen.reduce((n, t) => n + t.pending.size, 0),
    url: seen.length > 0 ? seen[seen.length - 1].lastUrl : null,
    waitedMs: Date.now() - startedAt,
  };
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
  // `--expand-type-select` is a string option so it can carry an optional row count, but Node's
  // parseArgs throws on a bare string option. Normalise the bare form to an empty value so
  // `--expand-type-select` (meaning "size = option count") keeps working as documented.
  const argv = process.argv.slice(2).map((arg, i, all) => (
    arg === '--expand-type-select' && (all[i + 1] === undefined || all[i + 1].startsWith('--'))
      ? '--expand-type-select='
      : arg
  ));
  const { values } = parseArgs({
    args: argv,
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
      'focus-type-select': { type: 'boolean', default: false },
      // string, not boolean: an optional row count (`--expand-type-select 3`) lets a before/after
      // pair pin the same list-box height, so the phase with one option fewer does not also shift
      // everything below the control. A bare `--expand-type-select` means size = option count.
      'expand-type-select': { type: 'string' },
      'expect-active': { type: 'string' },
      'expect-providers': { type: 'string' },
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
    // The binary named by `--obsidian` is NOT necessarily the app code that runs: Obsidian prefers a
    // downloaded `%APPDATA%\obsidian\obsidian-<version>.asar` over its own resources/obsidian.asar.
    // Record the launched binary's own FileVersion and which downloaded asars were present, so the
    // "exe says 1.14.5, the app reports 1.15.0" discrepancy is evidenced in the artifact rather than
    // living in someone's memory. Both are best-effort: a null here is a fact, not a failure.
    runInfo.obsidianVersionFromExe = readExeFileVersion(exe);
    runInfo.obsidianAsarFiles = listPreferredAsarFiles();

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

    // The plugin instance existing is not the same as its settings being loaded — see
    // waitForPluginSettings. Only then is it safe to open the settings tab, which renders from
    // `plugin.settings` once and does not re-read it.
    runInfo.pluginSettingsWait = await waitForPluginSettings(session, {
      expectActive: values['expect-active'] ?? null,
      expectProviders: values['expect-providers']
        ? String(values['expect-providers']).split(',').map((s) => s.trim()).filter(Boolean)
        : null,
      timeoutMs: Math.min(readyTimeout, 45000),
    });
    if (!runInfo.pluginSettingsWait.matched) {
      notes.push(
        `the plugin's loaded settings never matched the expectation before the settings tab opened `
        + `(activeProvider=${runInfo.pluginSettingsWait.activeProvider}, providers=${(runInfo.pluginSettingsWait.providers || []).join('/')}, `
        + `expected activeProvider=${runInfo.pluginSettingsWait.expected.activeProvider}, providers=${(runInfo.pluginSettingsWait.expected.providers || []).join('/')}); `
        + 'the capture may document a different provider than the scenario asked for',
      );
    }

    // Start watching for the model-list request before the settings tab opens, so
    // the request cannot slip past us.
    const modelListTrackers = [];
    await installModelListTracker(session, modelListTrackers);
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

    // The panel's own window may be the one that issues the model-list request.
    await installModelListTracker(panelSession, modelListTrackers);

    await expandActiveProviderDetail(panelSession, { timeoutMs: readyTimeout });

    // Open collapsed advanced blocks (Custom headers) so their help text is laid out and the
    // probe measures real geometry rather than a hidden 0-width box.
    runInfo.advancedSections = await expandAdvancedSections(panelSession);

    // The model list loads asynchronously and the Model row renders twice. Wait for
    // the request to actually finish first; the DOM stability wait below then
    // covers the re-render that finishing triggers.
    runInfo.modelListRequest = await waitForModelListRequest(modelListTrackers, {
      timeoutMs: Math.min(readyTimeout, 45000),
    });
    runInfo.modelListTrackers = modelListTrackers.map((t) => ({
      seen: t.seen,
      completed: t.completed,
      pending: t.pending.size,
      lastUrl: t.lastUrl,
      error: t.error || null,
    }));

    // Give the async model-list load a chance to settle before measuring.
    runInfo.domStability = await waitForStableDom(panelSession);
    if (!runInfo.domStability.stable) {
      notes.push('the settings DOM was still mutating when the capture went ahead; numbers may not be reproducible');
    }

    runInfo.viewportControl = await applyViewport(panelSession, { width, height });
    await delay(600);
    runInfo.domStabilityAfterViewport = await waitForStableDom(panelSession, { quietMs: 1200, timeoutMs: 30000 });

    // Re-assert: a viewport change can trigger a re-render that closes the <details> again.
    const reopened = await expandAdvancedSections(panelSession);
    if (reopened.opened.length) {
      runInfo.advancedSectionsReopened = reopened;
      await waitForStableDom(panelSession, { quietMs: 800, timeoutMs: 15000 });
    }

    // The provider-type dropdown is the control whose option list changes when a protocol is
    // removed. Put it on screen (and optionally render its options inline) before measuring, so
    // the screenshot and the report describe the same DOM state.
    // `--expand-type-select` is a string option, so test for presence rather than truthiness: a bare
    // flag parses to '' (which is falsy) and would otherwise silently skip the expansion.
    const expandTypeSelectRaw = values['expand-type-select'];
    const wantsExpand = expandTypeSelectRaw !== undefined;
    const expandSize = wantsExpand && String(expandTypeSelectRaw).trim() !== ''
      ? Number.parseInt(String(expandTypeSelectRaw), 10)
      : null;
    if (wantsExpand && expandSize !== null && (!Number.isFinite(expandSize) || expandSize < 2)) {
      throw new Error(`--expand-type-select expects a row count of 2 or more, got "${expandTypeSelectRaw}"`);
    }
    if (values['focus-type-select'] || wantsExpand) {
      runInfo.typeSelectFocus = await focusProviderTypeSelect(panelSession, {
        expand: wantsExpand,
        expandSize,
      });
      if (!runInfo.typeSelectFocus.found) {
        notes.push('the provider-type <select> could not be located, so --focus-type-select had nothing to scroll to');
      } else if (!runInfo.typeSelectFocus.inViewport) {
        notes.push('the provider-type <select> is still outside the viewport after scrolling; the capture cannot show it');
      }
      if (runInfo.typeSelectFocus.expanded) {
        notes.push(
          `--expand-type-select was used: the provider-type <select> was given size=${expandSize === null ? '<option count>' : expandSize} so every option renders inline in the bitmap (a DOM-only change; the control, its value and its options are unmodified)`,
        );
      }
      await delay(300);
    }

    const layout = await panelSession.evaluate(buildProbeExpression({
      label,
      phase: values.phase ?? null,
      revision: values.revision ?? null,
      pluginDir,
      obsidianVersion: runInfo.obsidianVersionFromExe ?? null,
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
    console.log(`obsidian   running=${report.obsidianVersionInPage ?? 'unknown'} (from ${report.obsidianVersionSource ?? 'n/a'}) exe=${report.obsidianVersionFromExe ?? 'unknown'}${report.obsidianVersionFromExe && report.obsidianVersionInPage && report.obsidianVersionFromExe !== report.obsidianVersionInPage ? '  <-- exe is NOT the app code that ran (see harness.obsidianAsarFiles)' : ''}`);
    console.log(`plugin     ${report.plugin?.id ?? '?'} v${report.plugin?.version ?? '?'} loaded=${report.plugin?.loaded}`);
    console.log(`theme      ${report.theme} (expected ${theme})`);
    console.log(`viewport   innerWidth=${report.viewport?.innerWidth} innerHeight=${report.viewport?.innerHeight} requested=${width}x${height}`);
    console.log(`cards      ${(report.providerCards ?? []).map((c) => `${c.title}${c.active ? '*' : ''}`).join(', ')}`);
    console.log(`overflow   document=${report.overflow?.document?.overflowPx}px offenders=${report.overflow?.offenderCount} spill=${report.overflow?.spillCount}`);
    console.log(`overlap    controls=${report.overlap?.controlCount} overlappingPairs=${report.overlap?.pairs?.length}`);
    console.log(`truncation ${(report.truncation?.fields ?? []).filter((f) => f.found && f.textOverflowsBox).map((f) => f.name).join(', ') || 'none'}`);
    console.log(
      `typeselect ${report.providerTypeSelect?.found
        ? `value="${report.providerTypeSelect.value}" onScreen=${report.providerTypeSelect.inViewport} options=[${(report.providerTypeSelect.optionTexts ?? []).join(' | ')}]`
        : 'NOT FOUND'}`,
    );
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
