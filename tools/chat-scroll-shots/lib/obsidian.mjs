/**
 * Generic Obsidian launch/drive helpers for the chat-scroll capture harness.
 *
 * These are the launch/connect/modal/viewport primitives that `capture.mjs` in
 * `tools/provider-settings-shots/` also needed, reimplemented here because that
 * script does not export them (they are private to its own `main()`). Only the
 * genuinely shared, dependency-free modules — `../../provider-settings-shots/lib/cdp.mjs`
 * and `../../provider-settings-shots/lib/vault.mjs` — are imported directly by
 * `capture.mjs` in this directory; `tools/provider-settings-shots/**` itself is
 * read-only from here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { CDPSession, listTargets } from '../../provider-settings-shots/lib/cdp.mjs';

export function sanitizedEnv() {
  // Mirrors tools/provider-settings-shots/capture.mjs: this host's environment block
  // contains both HTTPS_PROXY and https_proxy, which breaks anything that rebuilds the
  // environment into a case-insensitive map. Node's spawn tolerates it if we pass an
  // explicit plain object.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export function resolveObsidianExe(explicit) {
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

export function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function readExeFileVersion(exe) {
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

export function listPreferredAsarFiles() {
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

export function launchObsidian(exe, port) {
  return spawn(exe, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    stdio: 'ignore',
    detached: false,
    env: sanitizedEnv(),
  });
}

export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', env: sanitizedEnv() });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

export async function waitForAppReady(session, { timeoutMs = 120000 } = {}) {
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
 * Connect to the page target that can actually be driven: the Obsidian main window,
 * the one where the `app` global exists (a popout settings/chat window, if any,
 * is served from `about:blank` with no `app`).
 */
export async function connectToDrivablePage(port, { timeoutMs = 120000, intervalMs = 750 } = {}) {
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
    const ordered = [
      ...pages.filter((t) => /^app:\/\/obsidian\.md/i.test(t.url || '')),
      ...pages.filter((t) => !/^app:\/\/obsidian\.md/i.test(t.url || '')),
    ];
    for (const target of ordered) {
      let session = null;
      try {
        session = await CDPSession.connect(target.webSocketDebuggerUrl);
        await session.send('Runtime.enable');
        const hasApp = await session.evaluate(`typeof app !== 'undefined' && !!app.workspace`);
        if (hasApp) {
          return { session, target, pagesSeen: pages.map((t) => `${t.id} ${t.url}`) };
        }
        session.close();
      } catch (error) {
        lastDiagnostics = `target ${target.id} (${target.url}) not drivable yet: ${error.message}`;
        if (session) session.close();
      }
    }
    await delay(intervalMs);
  }
  throw new Error(`No drivable Obsidian page target with an \`app\` global appeared within ${timeoutMs} ms. Last: ${lastDiagnostics}`);
}

/**
 * Clear the first-open "trust this vault's author" modal and detach the
 * release-notes leaf (it steals document.title). Same pitfalls as documented
 * in tools/provider-settings-shots/README.md.
 */
export async function handleBlockingModals(session) {
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
    document.querySelectorAll('.modal-close-button, .modal-container .mod-cta').forEach((btn) => {
      const modal = btn.closest('.modal-container');
      if (modal && !modal.classList.contains('mod-trust-folder')) {
        closed.push((modal.querySelector('.modal-title')?.textContent || '').trim());
      }
    });
    return closed;
  })()`);

  const releaseNotesDetached = await session.evaluate(`(() => {
    const leaves = [];
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.getViewType && leaf.view.getViewType() === 'release-notes') leaves.push(leaf);
    });
    leaves.forEach((leaf) => leaf.detach());
    return leaves.length;
  })()`);

  return { trust, strayModalsClosed, releaseNotesDetached };
}

export async function applyLocale(session, locale, { reload = true } = {}) {
  const changed = await session.evaluate(`(() => {
    const current = window.localStorage.getItem('language');
    if (current === ${JSON.stringify(locale)}) return false;
    window.localStorage.setItem('language', ${JSON.stringify(locale)});
    return true;
  })()`);
  if (changed && reload) {
    await session.send('Page.reload', {});
    await delay(2000);
    await waitForAppReady(session, { timeoutMs: 60000 });
    await handleBlockingModals(session);
  }
  return { locale, changed };
}

export async function ensurePluginEnabled(session, pluginId) {
  return session.evaluate(`(async () => {
    try {
      if (app.plugins.isEnabled && app.plugins.isEnabled(${JSON.stringify(pluginId)})) {
        return { already: true };
      }
    } catch {}
    try { app.plugins.setEnable(true); } catch {}
    try { await app.plugins.loadManifests(); } catch {}
    try {
      await app.plugins.enablePlugin(${JSON.stringify(pluginId)});
      return { enabled: true };
    } catch (e) {
      return { enabled: false, error: String(e && e.message || e) };
    }
  })()`);
}

export async function waitForPluginLoaded(session, pluginId, { timeoutMs = 60000 } = {}) {
  return session.waitFor(
    `!!(app.plugins && app.plugins.plugins && app.plugins.plugins[${JSON.stringify(pluginId)}])`,
    { timeoutMs, label: `plugin ${pluginId} instantiated` },
  );
}

export async function applyViewport(session, { width, height }) {
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

export async function waitForStableDom(session, { quietMs = 1000, timeoutMs = 30000, selector = 'body' } = {}) {
  const expr = `(() => new Promise((resolve) => {
    const target = document.querySelector(${JSON.stringify(selector)}) || document.body;
    let timer = null;
    let settled = false;
    const finish = (stable) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve({ stable, quietMs: ${quietMs}, timeoutMs: ${timeoutMs} });
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), ${quietMs});
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(true), ${quietMs});
    setTimeout(() => finish(false), ${timeoutMs});
  }))()`;
  return session.evaluate(expr, { timeoutMs: timeoutMs + 5000 });
}
