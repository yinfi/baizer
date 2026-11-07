#!/usr/bin/env node
/**
 * Capture the declarative Baizer settings pages out of a real, running Obsidian
 * (>= 1.13) and write a machine-readable report next to each PNG.
 *
 * This is the "after" harness for the declarative settings migration: the
 * pre-migration accordion UI is captured by ../provider-settings-shots/capture.mjs,
 * which waits for `.baizer-settings-provider-card`. The declarative UI has no such
 * node, so this script locates the settings panel by its Obsidian container and
 * navigates through the declarative page entries by their visible text.
 *
 * Nothing here is a mock-up: Obsidian is launched with `--remote-debugging-port`,
 * the renderer is driven over CDP, and the PNG comes from `Page.captureScreenshot`.
 *
 * Usage:
 *   node tools/declarative-settings-shots/capture.mjs \
 *     --plugin-dir dist \
 *     --scenario tools/provider-settings-shots/scenarios/cch-opencode.json \
 *     --out docs/assets/declarative-settings-2026-11-06-after-wide.png \
 *     --width 1353 --height 1053 --theme dark --locale zh \
 *     --page "连接" --subpage "opencode" \
 *     --label after-wide --phase after --revision <sha>
 *
 * See README.md in this directory for the options and the report fields.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from '../provider-settings-shots/lib/cdp.mjs';
import { materialiseVault, registerVaultGlobally, defaultVaultDir, PLUGIN_ID } from '../provider-settings-shots/lib/vault.mjs';

// --------------------------------------------------------------- helpers ----

function sanitizedEnv() {
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
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Obsidian.exe not found. Pass --obsidian <path> or set OBSIDIAN_EXE.`);
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// A host path is not always the whole value: it can sit inside a DOM text node, an error message
// or a `--eval` result. Match the path wherever it appears, not only at the start of the string.
// The trailing character class keeps a match from swallowing the prose or markup around it.
const HOST_PATH_PATTERNS = [
  // \\?\C:\dir (extended-length form)
  /\\\\\?\\[A-Za-z]:[\\/][^\s"'`;,)\]}>，。；：、（）【】]*/g,
  // file:///C:/dir and file:///home/user
  /file:\/\/\/[^\s"'`;,)\]}>，。；：、（）【】]+/g,
  // \\server\share
  /\\\\[^\s"'`;,)\]}>，。；：、（）【】]+/g,
  // C:\dir and C:/dir; the lookbehind stops "https://" matching "s://"
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`;,)\]}>，。；：、（）【】]*/g,
  // C:dir (drive-relative), which Node error messages can also contain
  /(?<![A-Za-z0-9])[A-Za-z]:[A-Za-z0-9_.-]+\\[^\s"'`;,)\]}>，。；：、（）【】]*/g,
  // POSIX paths under a root that names a user, a mount or a system directory - not every "/".
  /\/(?:home|Users|mnt|media|opt|srv|var|tmp|private|Volumes)\/[^\s"'`;,)\]}>，。；：、（）【】]*/g,
];

/** Turn one matched capture-machine path into a repo-relative path or a neutral placeholder. */
function redactHostPath(match) {
  // Only an absolute match can be repo-relative: a drive-relative match ("C:dir") resolves against
  // the current directory, so path.relative() would turn it into a path that only looks in-repo.
  if (path.isAbsolute(match)) {
    const relative = path.relative(process.cwd(), match);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return `<local-path>/${path.basename(match)}`;
}

/**
 * Turn a capture-machine absolute path into a repo-relative path or a neutral
 * placeholder. Committed layout reports must not leak the local environment, so
 * the default is to redact rather than keep the real path.
 */
function sanitizeHostPath(value) {
  if (typeof value !== 'string' || !value) return value;
  return HOST_PATH_PATTERNS.reduce((text, pattern) => text.replace(pattern, redactHostPath), value);
}

/** Redact host paths anywhere in a plain-JSON value, including inside longer strings. */
function scrubHostPaths(value) {
  if (typeof value === 'string') return sanitizeHostPath(value);
  if (Array.isArray(value)) return value.map(scrubHostPaths);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = scrubHostPaths(value[key]);
  }
  return value;
}

/**
 * The layout report is committed as evidence, so strip the capture machine's
 * host paths and identifiers (see README: "Committed layout reports"). The PNG
 * and the measurements do not depend on these fields.
 */
function sanitizeLayoutReport(report) {
  const clean = JSON.parse(JSON.stringify(report));
  if (clean.image) clean.image.path = sanitizeHostPath(clean.image.path);
  const harness = clean.harness || {};
  if (harness.exe) harness.exe = path.basename(harness.exe);
  if (harness.pluginDir) harness.pluginDir = '<plugin-dir>';
  if (harness.vaultDir) harness.vaultDir = '<vault-dir>';
  if (harness.vaultKey !== undefined) harness.vaultKey = '<vault-key>';
  if (harness.scenarioPath) harness.scenarioPath = sanitizeHostPath(harness.scenarioPath);
  delete harness.pid;
  if (harness.target) delete harness.target.id;
  return scrubHostPaths(clean);
}

function launchObsidian(exe, port) {
  return spawn(exe, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    stdio: 'ignore',
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

async function connectMainWindow(port, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let targets = [];
    try { targets = await listTargets(port); } catch { await delay(750); continue; }
    for (const target of (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)) {
      let session = null;
      try {
        session = await CDPSession.connect(target.webSocketDebuggerUrl);
        await session.send('Page.enable');
        await session.send('Runtime.enable');
        const usable = await session.evaluate(
          `(() => { try { return typeof app !== 'undefined' && !!app.workspace; } catch (error) { return false; } })()`,
        );
        if (usable) return { session, target };
        session.close();
      } catch {
        if (session) session.close();
      }
    }
    await delay(750);
  }
  throw new Error(`no drivable Obsidian main window on port ${port} within ${timeoutMs} ms`);
}

async function waitForAppReady(session, { timeoutMs = 120000 } = {}) {
  await session.waitFor(
    `(() => {
       const app = window.app;
       if (!app || !app.workspace) return false;
       if (app.workspace.layoutReady === false) return false;
       return !!document.querySelector('.workspace, .app-container');
     })()`,
    { timeoutMs, label: 'Obsidian app + workspace ready' },
  );
}

async function handleBlockingModals(session) {
  const trust = await session.evaluate(`(() => {
    const modal = document.querySelector('.modal.mod-trust-folder')
      || document.querySelector('.modal-container.mod-confirmation .modal');
    if (!modal) return { present: false, clicked: null };
    const buttons = Array.from(modal.querySelectorAll('button'));
    const accept = buttons.find((b) =>
      /信任|trust/i.test(b.textContent || '') && !/安全模式|restricted|safe/i.test(b.textContent || ''));
    if (!accept) return { present: true, clicked: null };
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

async function ensurePluginEnabled(session) {
  return session.evaluate(`(async () => {
    const app = window.app;
    const out = { steps: [], error: null, loaded: false };
    try {
      if (app.plugins && typeof app.plugins.loadManifests === 'function') {
        await app.plugins.loadManifests();
        out.steps.push('plugins.loadManifests()');
      }
      if (app.plugins && !(app.plugins.plugins || {})['${PLUGIN_ID}'] && typeof app.plugins.enablePlugin === 'function') {
        await app.plugins.enablePlugin('${PLUGIN_ID}');
        out.steps.push('plugins.enablePlugin()');
      }
      out.loaded = !!((app.plugins && app.plugins.plugins) || {})['${PLUGIN_ID}'];
    } catch (error) {
      out.error = String((error && error.message) || error);
    }
    return out;
  })()`);
}

async function waitForPluginSettings(session, { activeProvider = null, providers = null, timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.evaluate(`(() => {
      const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins['${PLUGIN_ID}'];
      const settings = plugin && plugin.settings;
      return {
        settingsLoaded: !!settings,
        activeProvider: (settings && settings.activeProvider) || null,
        providers: settings && settings.providers ? Object.keys(settings.providers) : null,
      };
    })()`);
    if (last && last.settingsLoaded
      && (!activeProvider || last.activeProvider === activeProvider)
      && (!providers || providers.every((id) => (last.providers || []).includes(id)))) {
      return { ...last, matched: true };
    }
    await delay(250);
  }
  return { ...(last || {}), matched: false };
}

async function openBaizerSettings(session, { timeoutMs = 60000 } = {}) {
  const opened = await session.evaluate(`(() => {
    const app = window.app;
    if (!app.setting) return { error: 'app.setting is unavailable' };
    app.setting.open();
    app.setting.openTabById('${PLUGIN_ID}');
    return {
      tabId: (app.setting.activeTab && app.setting.activeTab.id) || null,
      isOpen: app.setting.isOpen ?? null,
      popoutCreated: !!app.setting.popout,
    };
  })()`);
  if (opened && opened.error) throw new Error(`could not open the Baizer settings tab: ${opened.error}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await session.evaluate(`(() => {
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
      return { ...opened, ...ready };
    }
    await delay(250);
  }
  return { ...opened, readyTimedOut: true };
}

/**
 * The settings modal renders either in the main window or in Obsidian's own
 * popout settings window (`settingsPopoutWindow` defaults to true). Find the
 * page target that actually owns the rendered tab content.
 */
async function resolveSettingsPanel(port, mainTargetId, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostics = 'no page targets seen';
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    for (const target of targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.id !== mainTargetId)) {
      let session = null;
      try {
        session = await CDPSession.connect(target.webSocketDebuggerUrl);
        const found = await session.evaluate(`(() => {
          const content = document.querySelector('.vertical-tab-content');
          if (!content) return null;
          const text = (content.innerText || '').trim();
          return { textLength: text.length, hasBaizerPage: !!document.querySelector('.vertical-tab-content [data-section-id], .vertical-tab-content .setting-item') };
        })()`).catch(() => null);
        if (found && found.textLength > 0) {
          return { session, target, location: 'popout-window', diagnostics: found };
        }
        session.close();
      } catch (error) {
        lastDiagnostics = `target ${target.id} not readable: ${error.message}`;
        if (session) session.close();
      }
    }
    // Fall back to the main window: an inset settings modal can also host the tab.
    let session = null;
    try {
      const targets = await listTargets(port);
      const main = targets.find((t) => t.id === mainTargetId);
      session = await CDPSession.connect(main.webSocketDebuggerUrl);
      const found = await session.evaluate(`(() => {
        const content = document.querySelector('.modal.mod-settings .vertical-tab-content');
        if (!content) return null;
        return { textLength: (content.innerText || '').trim().length };
      })()`);
      if (found && found.textLength > 0) return { session, target: main, location: 'main-window', diagnostics: found };
      session.close();
    } catch (error) {
      lastDiagnostics = `main window not readable: ${error.message}`;
      if (session) session.close();
    }
    await delay(500);
  }
  throw new Error(`could not locate the rendered settings panel within ${timeoutMs} ms (last: ${lastDiagnostics})`);
}

async function applyViewport(session, { width, height }) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function readPanelFacts(session) {
  return session.evaluate(`(() => {
    const content = document.querySelector('.vertical-tab-content') || document.body;
    return {
      documentTitle: document.title,
      theme: document.body.classList.contains('theme-dark') ? 'dark' : (document.body.classList.contains('theme-light') ? 'light' : null),
      language: window.localStorage.getItem('language'),
      windowTitle: document.title,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
      contentText: (content.innerText || '').slice(0, 4000),
      pageRowTexts: Array.from(content.querySelectorAll('.setting-item')).slice(0, 80).map((row) => ({
        name: (row.querySelector('.setting-item-name')?.textContent || '').trim(),
        desc: (row.querySelector('.setting-item-description')?.textContent || '').trim().slice(0, 160),
        cls: String(row.className || ''),
        clickable: !!row.querySelector('.setting-item-name'),
      })),
    };
  })()`);
}

/** Click the visible page/row whose name (or whole text) matches `text`. */
async function clickRowByText(session, text, { timeoutMs = 30000 } = {}) {
  const expression = `(() => {
    const want = ${JSON.stringify(text)};
    const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('.vertical-tab-content .setting-item'));
    const scored = rows
      .map((row) => {
        const name = norm(row.querySelector('.setting-item-name')?.textContent);
        const all = norm(row.innerText);
        let score = -1;
        if (name === want) score = 100;
        else if (name.startsWith(want)) score = 80;
        else if (name.includes(want)) score = 60;
        else if (all === want || all.startsWith(want)) score = 40;
        else if (all.includes(want)) score = 20;
        return { row, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) {
      return { found: false, candidates: rows.slice(0, 20).map((r) => norm(r.innerText).slice(0, 80)) };
    }
    const row = scored[0].row;
    row.scrollIntoView({ block: 'center' });
    const clickTarget = row.querySelector('.setting-item-name') || row;
    clickTarget.click();
    return { found: true, score: scored[0].score, clicked: norm(row.innerText).slice(0, 120), cls: String(row.className || '') };
  })()`;
  return session.waitFor(expression, { timeoutMs, intervalMs: 300, label: `settings row "${text}"` });
}

async function waitForRowContaining(session, text, { timeoutMs = 30000 } = {}) {
  return session.waitFor(
    `(() => {
       const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
       return Array.from(document.querySelectorAll('.vertical-tab-content .setting-item'))
         .some((row) => norm(row.innerText).includes(${JSON.stringify(text)}));
     })()`,
    { timeoutMs, intervalMs: 300, label: `row containing "${text}"` },
  );
}

async function waitForStableContent(session, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const signature = await session.evaluate(`(() => {
      const content = document.querySelector('.vertical-tab-content');
      if (!content) return 'missing';
      return String(content.innerHTML.length) + '|' + content.innerText.length;
    })()`);
    if (signature !== last) {
      last = signature;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 900) {
      return { stable: true, signature, settledAfterMs: Date.now() - lastChange };
    }
    await delay(250);
  }
  return { stable: false, signature: last };
}

function buildLayoutReport({ sessionFacts, harness, image, options }) {
  const viewport = sessionFacts.viewport || {};
  return {
    schema: 'baizer-declarative-settings-layout/1',
    label: options.label,
    phase: options.phase,
    revision: options.revision,
    capturedAt: new Date().toISOString(),
    theme: sessionFacts.theme,
    language: sessionFacts.language,
    windowTitle: sessionFacts.windowTitle,
    viewport: {
      requested: { width: options.width, height: options.height },
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight,
      devicePixelRatio: viewport.dpr,
    },
    page: {
      requestedPages: options.pages,
      rows: sessionFacts.pageRowTexts,
      contentText: sessionFacts.contentText,
    },
    image: {
      path: options.out,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      requestedWidth: options.width,
      requestedHeight: options.height,
      sizeMatchesRequest: image.width === options.width && image.height === options.height,
    },
    harness,
    limitations: [
      'Colour, contrast, font rendering, iconography and animation are NOT asserted.',
      'This harness navigates by visible row text; a renamed row breaks navigation instead of silently measuring another row.',
      'The pre-migration accordion UI has no declarative page entries; use ../provider-settings-shots/capture.mjs for Before evidence.',
    ],
  };
}

// ------------------------------------------------------------------ main ----

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'plugin-dir': { type: 'string' },
      out: { type: 'string' },
      'layout-out': { type: 'string' },
      width: { type: 'string', default: '1353' },
      height: { type: 'string', default: '1053' },
      theme: { type: 'string', default: 'dark' },
      locale: { type: 'string', default: 'zh' },
      scenario: { type: 'string' },
      vault: { type: 'string' },
      obsidian: { type: 'string' },
      port: { type: 'string', default: '9334' },
      'ready-timeout': { type: 'string', default: '180000' },
      page: { type: 'string' },
      subpage: { type: 'string' },
      label: { type: 'string' },
      phase: { type: 'string' },
      revision: { type: 'string' },
      'expect-active': { type: 'string' },
      'expect-providers': { type: 'string' },
      'dump-dom': { type: 'boolean', default: false },
      // 导航后先等一段时间，让 /models 这类异步行（模型列表、本体状态）落到最终状态再截图。
      'settle-ms': { type: 'string', default: '1500' },
      // 可选：等待页面上某段文字消失（例如模型列表的「加载模型列表中…」）。
      'wait-text-gone': { type: 'string' },
      // 诊断用：导航完成后在面板窗口里求值一段 JS 并把结果写进报告（不参与截图判定）。
      eval: { type: 'string' },
      // 诊断用：随后在主窗口（有 app 全局的那个）求值，用来读 plugin.settings 验证控件真的写入了。
      'eval-main': { type: 'string' },
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
  const pages = values.page ? String(values.page).split('>').map((s) => s.trim()).filter(Boolean) : [];
  const options = {
    out: outPath, width, height, theme, label,
    phase: values.phase || null, revision: values.revision || null, pages,
  };

  const scenario = values.scenario
    ? JSON.parse(await fsp.readFile(path.resolve(values.scenario), 'utf8'))
    : undefined;
  const exe = resolveObsidianExe(values.obsidian);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.mkdir(path.dirname(layoutPath), { recursive: true });

  const vaultInfo = await materialiseVault({ vaultDir, pluginDir, scenario, theme });
  const registry = await registerVaultGlobally(vaultDir);

  const harness = {
    exe,
    pluginDir,
    vaultDir: vaultInfo.vaultDir,
    vaultKey: registry.vaultKey,
    pluginManifest: vaultInfo.manifest,
    copiedPluginFiles: vaultInfo.copied,
    scenarioPath: values.scenario ? path.resolve(values.scenario) : null,
    target: null,
    settingsPanelLocation: null,
    navigation: null,
    domDump: null,
  };

  let child = null;
  let mainSession = null;
  let panelSession = null;
  try {
    child = launchObsidian(exe, port);
    harness.pid = child.pid;
    const devtools = await waitForDevTools(port, { timeoutMs: readyTimeout });
    harness.browser = devtools.Browser ?? null;
    harness.browserUserAgent = devtools['User-Agent'] ?? null;

    const connected = await connectMainWindow(port, { timeoutMs: readyTimeout });
    mainSession = connected.session;
    harness.target = { id: connected.target.id, url: connected.target.url, title: connected.target.title };
    await waitForAppReady(mainSession, { timeoutMs: readyTimeout });

    // UI language: Obsidian keeps it in localStorage and needs one reload.
    const locale = values.locale;
    if (locale) {
      const before = await mainSession.evaluate(`window.localStorage.getItem('language')`);
      if (before !== locale) {
        await mainSession.evaluate(`window.localStorage.setItem('language', ${JSON.stringify(locale)})`);
        await mainSession.send('Page.reload', {}, { timeoutMs: 30000 });
        await delay(2500);
        await waitForAppReady(mainSession, { timeoutMs: readyTimeout });
      }
    }

    harness.blockingModals = await handleBlockingModals(mainSession);
    harness.pluginActivation = await ensurePluginEnabled(mainSession);
    await mainSession.waitFor(
      `!!(app.plugins && app.plugins.plugins && app.plugins.plugins['${PLUGIN_ID}'])`,
      { timeoutMs: 60000, label: 'plugin instance' },
    );
    harness.pluginSettings = await waitForPluginSettings(mainSession, {
      activeProvider: values['expect-active'] || null,
      providers: values['expect-providers']
        ? String(values['expect-providers']).split(',').map((s) => s.trim()).filter(Boolean)
        : null,
      timeoutMs: Math.min(readyTimeout, 45000),
    });

    harness.settings = await openBaizerSettings(mainSession, { timeoutMs: readyTimeout });
    const panel = await resolveSettingsPanel(port, connected.target.id, { timeoutMs: readyTimeout });
    panelSession = panel.session;
    harness.settingsPanelLocation = panel.location;

    await applyViewport(panelSession, { width, height });
    await delay(600);

    // Navigation: page entries are clicked by visible text; `--page a>b` walks a path.
    harness.navigation = [];
    for (const entry of pages) {
      await waitForStableContent(panelSession);
      const clicked = await clickRowByText(panelSession, entry, { timeoutMs: readyTimeout });
      harness.navigation.push({ text: entry, ...clicked });
      await delay(500);
    }
    if (values.subpage) {
      const clicked = await clickRowByText(panelSession, String(values.subpage), { timeoutMs: readyTimeout });
      harness.navigation.push({ text: String(values.subpage), ...clicked });
      await delay(700);
    }

    const settleMs = Number.parseInt(values['settle-ms'], 10);
    if (Number.isFinite(settleMs) && settleMs > 0) await delay(settleMs);
    if (values['wait-text-gone']) {
      await panelSession.waitFor(
        `!((document.querySelector('.vertical-tab-content') || document.body).innerText || '')
           .includes(${JSON.stringify(String(values['wait-text-gone']))})`,
        { timeoutMs: 15000, intervalMs: 300, label: `text "${values['wait-text-gone']}" to disappear` },
      ).catch(() => { harness.waitTextGoneTimedOut = true; });
    }

    await waitForRowContaining(panelSession, values.subpage ? String(values.subpage) : (pages[pages.length - 1] || '')).catch(() => null);
    harness.domStability = await waitForStableContent(panelSession);
    const facts = await readPanelFacts(panelSession);

    if (values.eval) {
      harness.eval = await panelSession.evaluate(String(values.eval));
    }
    if (values['eval-main']) {
      harness.evalMain = await mainSession.evaluate(String(values['eval-main']));
    }

    if (values['dump-dom']) {
      harness.domDump = await panelSession.evaluate(`(() => {
        const walk = (el, depth = 0) => {
          if (!el || depth > 4) return null;
          return {
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 160),
            text: el.children.length === 0 ? (el.textContent || '').trim().slice(0, 120) : '',
            children: Array.from(el.children).slice(0, 40).map((child) => walk(child, depth + 1)).filter(Boolean),
          };
        };
        return walk(document.querySelector('.vertical-tab-content') || document.body);
      })()`);
    }

    const shot = await panelSession.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buffer = Buffer.from(shot.data, 'base64');
    await fsp.writeFile(outPath, buffer);
    const size = pngSize(buffer);
    if (!size || size.width !== width || size.height !== height) {
      throw new Error(
        `screenshot is ${size ? `${size.width}x${size.height}` : 'unreadable'}, requested ${width}x${height}: viewport control failed`,
      );
    }

    const report = sanitizeLayoutReport(buildLayoutReport({
      sessionFacts: { ...facts, viewport: { ...facts.viewport, innerWidth: width, innerHeight: height } },
      harness,
      image: { bytes: buffer.length, width: size.width, height: size.height },
      options,
    }));
    await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`image      ${outPath}  (${size.width}x${size.height}, ${buffer.length} bytes)`);
    console.log(`layout     ${layoutPath}`);
    console.log(`title      ${facts.windowTitle}`);
    console.log(`panel      ${panel.location}`);
    console.log(`theme      ${facts.theme} (expected ${theme})`);
    console.log(`viewport   ${width}x${height}`);
    for (const step of harness.navigation) {
      console.log(`nav        "${step.text}" -> ${step.found ? `clicked: ${step.clicked}` : 'NOT FOUND'}`);
    }
    console.log('rows');
    for (const row of facts.pageRowTexts.slice(0, 20)) {
      console.log(`  - ${row.name}${row.desc ? ` — ${row.desc.slice(0, 80)}` : ''}`);
    }
    if (!harness.navigation.every((step) => step.found)) process.exitCode = 3;
  } catch (error) {
    console.error(String((error && error.stack) || error));
    process.exitCode = 1;
  } finally {
    if (panelSession) panelSession.close();
    if (mainSession) mainSession.close();
    if (!values['keep-open']) await killTree(child?.pid);
  }
}

await main();
