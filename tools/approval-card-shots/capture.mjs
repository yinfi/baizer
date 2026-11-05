#!/usr/bin/env node
/**
 * Capture the Baizer approval card out of a real, running Obsidian — plus a
 * machine-readable layout report measured from the same DOM state.
 *
 * This is not a mock-up: Obsidian is launched with `--remote-debugging-port`,
 * the real plugin is loaded from `--plugin-dir`, the real workbench view is
 * opened, a scenario approval message is injected into that view's state, and
 * the PNG comes from `Page.captureScreenshot`.
 *
 * The scenario is injected as *data* (a ChatMessage in the tab's projection),
 * not as hand-written DOM: the card itself is rendered by the production
 * `renderApprovalCard()` with the production stylesheet.
 *
 * Usage (from Windows Node; paths may be \\wsl$ UNC paths):
 *   node tools/approval-card-shots/capture.mjs \
 *     --plugin-dir dist \
 *     --out docs/assets/approval-card-2026-11-04-after-narrow.png \
 *     --width 300 --phase after --revision <sha> --label after-narrow
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from '../provider-settings-shots/lib/cdp.mjs';
import { materialiseVault, registerVaultGlobally, defaultVaultDir, PLUGIN_ID } from '../provider-settings-shots/lib/vault.mjs';

const VIEW_TYPE = 'baizer-shell-view';

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
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Obsidian', 'Obsidian.exe') : null,
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Obsidian.exe not found. Pass --obsidian <path> or set OBSIDIAN_EXE. Tried:\n  ${candidates.join('\n  ')}`);
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function launchObsidian(exe, port) {
  return spawn(exe, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    stdio: 'ignore',
    detached: false,
    env: sanitizedEnv(),
  });
}

async function killAllObsidian() {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/IM', 'Obsidian.exe', '/T', '/F'], { stdio: 'ignore', env: sanitizedEnv() });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = await new Promise((resolve) => {
      const lister = spawn('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe'], { stdio: ['ignore', 'pipe', 'ignore'], env: sanitizedEnv() });
      let text = '';
      lister.stdout.on('data', (chunk) => { text += String(chunk); });
      lister.on('close', () => resolve(text));
      lister.on('error', () => resolve(''));
    });
    if (!/Obsidian\.exe/i.test(output)) return;
    await delay(500);
  }
  throw new Error('Obsidian.exe is still running after taskkill; refusing to capture against a stale plugin instance');
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
        if (usable) return { session, target };
        lastDiagnostics = `target ${target.id} (${target.url}) exposes no usable app global`;
        session.close();
      } catch (error) {
        lastDiagnostics = `target ${target.id} (${target.url}) is not drivable: ${error.message}`;
        if (session) session.close();
      }
    }
    await delay(intervalMs);
  }
  throw new Error(`no drivable Obsidian window within ${timeoutMs} ms. Last: ${lastDiagnostics}`);
}

async function handleBlockingModals(session) {
  const trust = await session.evaluate(`(() => {
    const modal = document.querySelector('.modal.mod-trust-folder')
      || document.querySelector('.modal-container.mod-confirmation .modal');
    if (!modal) return { present: false, clicked: null };
    const buttons = Array.from(modal.querySelectorAll('button'));
    const accept = buttons.find((b) =>
      /信任|trust/i.test(b.textContent || '') && !/安全模式|restricted|safe/i.test(b.textContent || ''));
    if (!accept) return { present: true, clicked: null, buttons: buttons.map((b) => (b.textContent || '').trim()) };
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

async function applyLocale(session, locale, { reload = true } = {}) {
  if (!locale) return { changed: false, skipped: true };
  const before = await session.evaluate(`(() => ({ language: window.localStorage.getItem('language') }))()`);
  if (before.language === locale) return { changed: false, previous: before.language };
  await session.evaluate(`window.localStorage.setItem('language', ${JSON.stringify(locale)})`);
  if (!reload) return { changed: true, previous: before.language, reloaded: false };
  await session.send('Page.reload', {}, { timeoutMs: 30000 });
  await delay(2500);
  await waitForAppReady(session);
  return { changed: true, previous: before.language, reloaded: true };
}

async function applyViewport(session, { width, height }) {
  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    return { applied: true };
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

/**
 * The scenario data injected into the real tab projection. The card is then
 * rendered by the production renderer; nothing below touches the card DOM.
 */
const SCENARIO = {
  user: {
    id: 'capture-user',
    role: 'user',
    content: '删除「Projects/季度计划.md」',
    timestamp: 1,
  },
  approval: {
    id: 'capture-approval-request',
    conversationId: 'capture-conversation',
    action: 'delete_note',
    target: 'Projects/季度计划.md',
    args: { path: 'Projects/季度计划.md' },
    message: 'Approval required to delete note: Projects/季度计划.md',
    preview: {
      kind: 'note-delete',
      target: 'Projects/季度计划.md',
      summary: 'Delete note',
      oldContent: '# 季度计划\n\n- 目标一\n- 目标二',
      risk: 'high',
      preconditions: ['The target file must still exist.'],
      supportsPartialApply: false,
      undoable: false,
    },
  },
};

function approvalStateFor(state) {
  if (!state || state === 'pending') return undefined;
  if (state === 'running') return { status: 'running' };
  if (state === 'succeeded') {
    return {
      status: 'succeeded',
      outcome: {
        status: 'succeeded',
        detail: 'Deleted successfully.',
        target: SCENARIO.approval.target,
        completedAt: 3,
        retryable: false,
      },
    };
  }
  if (state === 'failed') {
    return {
      status: 'failed',
      outcome: {
        status: 'failed',
        detail: 'File is locked by another application.',
        error: 'File is locked by another application.',
        completedAt: 3,
        retryable: true,
      },
    };
  }
  if (state === 'rejected') {
    return {
      status: 'rejected',
      outcome: {
        status: 'rejected',
        detail: 'No write was performed.',
        target: SCENARIO.approval.target,
        completedAt: 3,
      },
    };
  }
  return {
    status: 'unknown',
    outcome: {
      status: 'unknown',
      detail: 'The action was interrupted before its result was recorded. Check the target before retrying.',
      completedAt: 3,
      retryable: false,
    },
  };
}

function scenarioMessage(state) {
  const approvalState = approvalStateFor(state);
  return {
    id: 'capture-approval-message',
    role: 'system',
    content: SCENARIO.approval.message,
    timestamp: 2,
    approval: SCENARIO.approval,
    ...(approvalState ? { approvalState } : {}),
  };
}

async function openWorkbench(session, { timeoutMs = 60000 } = {}) {
  await session.evaluate(`(async () => {
    const app = window.app;
    await app.commands.executeCommandById('${PLUGIN_ID}:open-shell');
    return true;
  })()`);
  await session.waitFor(
    `!!document.querySelector('.baizer-shell-view') && !!app.workspace.getLeavesOfType('${VIEW_TYPE}').length`,
    { timeoutMs, label: 'the Baizer workbench view to open' },
  );
}

async function sizeSidebar(session, width) {
  const result = await session.evaluate(`(() => {
    const app = window.app;
    const split = document.querySelector('.workspace-split.mod-right-split');
    let via = 'none';
    try {
      if (app.workspace.rightSplit && typeof app.workspace.rightSplit.setSize === 'function') {
        app.workspace.rightSplit.setSize(${width});
        via = 'rightSplit.setSize';
      }
    } catch (error) { via = 'rightSplit.setSize failed: ' + error.message; }
    if (split) {
      split.style.width = '${width}px';
      split.style.flex = '0 0 ${width}px';
      if (via === 'none') via = 'style';
    }
    const view = document.querySelector('.baizer-shell-view');
    return {
      via,
      splitWidth: split ? split.getBoundingClientRect().width : null,
      viewWidth: view ? view.getBoundingClientRect().width : null,
      windowWidth: window.innerWidth,
    };
  })()`);
  await delay(400);
  return result;
}

/**
 * Optional interaction flows, applied after the scenario is injected.
 *
 * `recheck` reproduces the in-session "unknown" dead end from issue #76:
 * the execution registry caches an `unknown` outcome (in production this happens
 * when the write path throws after the tool ran), then the user clicks
 * 「检查结果」. The button, reconcile call, state projection and in-place repaint
 * are all production code; only the cached registry entry is seeded here because
 * the harness cannot make a real vault write throw.
 */
async function seedUnknownCache(session) {
  return session.evaluate(`(() => {
    const app = window.app;
    const leaf = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0];
    const view = leaf && leaf.view;
    const tab = view && view.tabManager && view.tabManager.getActiveTab();
    const tabSession = tab && view.tabSessions && view.tabSessions.get(tab.id);
    const api = tabSession && tabSession.chatController && tabSession.chatController.api;
    const registry = api && api.approvalExecutionRegistry;
    if (!registry || !registry.records) return { seeded: false, error: 'execution registry unavailable' };
    registry.records.set(${JSON.stringify(SCENARIO.approval.id)}, {
      state: 'done',
      outcome: {
        kind: 'approval-execution',
        status: 'unknown',
        error: 'vault adapter crashed',
        detail: 'The action was interrupted before its result was recorded. Check the target before retrying.',
        target: ${JSON.stringify(SCENARIO.approval.target)},
        completedAt: Date.now(),
        retryable: false,
      },
    });
    return { seeded: true };
  })()`);
}

async function clickRecheck(session) {
  const clicked = await session.evaluate(`(() => {
    const button = document.querySelector('.shell-approval-recheck');
    if (!button) return { clicked: false, error: 'no recheck button on the card' };
    button.click();
    return { clicked: true };
  })()`);
  const deadline = Date.now() + 5000;
  let retryVisible = false;
  while (Date.now() < deadline) {
    retryVisible = await session.evaluate(`!!document.querySelector('.shell-approval-retry')`);
    if (retryVisible) break;
    await delay(200);
  }
  const after = await session.evaluate(`(() => {
    const textOf = (el) => el ? (el.textContent || '').trim() : '';
    return {
      cardState: (() => {
        const card = document.querySelector('.shell-approval-card');
        return card ? Array.from(card.classList).find((name) => name.startsWith('is-') && !name.endsWith('-risk')) || null : null;
      })(),
      outcome: textOf(document.querySelector('.shell-approval-outcome')),
      buttons: Array.from(document.querySelectorAll('.shell-approval-card button'))
        .map((button) => textOf(button))
        .filter(Boolean),
    };
  })()`);
  return { clicked, retryVisible, after };
}

async function runFlow(session, flow) {
  if (flow !== 'recheck') return null;
  const seed = await seedUnknownCache(session);
  await delay(300);
  const interaction = await clickRecheck(session);
  await delay(400);
  return { flow, seed, interaction };
}

async function injectScenario(session, { width, state }) {
  const result = await session.evaluate(`(() => {
    const app = window.app;
    const leaf = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0];
    const view = leaf && leaf.view;
    if (!view) return { error: 'workbench view not found' };
    if (!view.tabManager) return { error: 'workbench tabManager not available' };
    const tab = view.tabManager.getActiveTab();
    if (!tab) return { error: 'no active tab' };
    tab.state.clearMessages();
    tab.state.addMessage(${JSON.stringify(SCENARIO.user)});
    tab.state.addMessage(${JSON.stringify(scenarioMessage(state))});
    view.renderActiveTabMessages();
    const output = document.querySelector('.shell-output-area');
    if (output) output.scrollTop = 0;
    return {
      ok: true,
      messages: tab.state.getMessages().length,
      viewWidth: document.querySelector('.baizer-shell-view').getBoundingClientRect().width,
      requestedWidth: ${width},
    };
  })()`);
  if (result && result.error) throw new Error(`could not inject the approval scenario: ${result.error}`);
  await session.waitFor(
    `!!document.querySelector('.shell-approval-card')`,
    { timeoutMs: 30000, label: 'the approval card to render' },
  );
  await delay(500);
  return result;
}

function probeExpression() {
  return `(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
    };
    const textOf = (el) => el ? (el.textContent || '').trim() : '';
    const view = document.querySelector('.baizer-shell-view');
    const card = document.querySelector('.shell-approval-card');
    const viewRect = rectOf(view);
    const cardRect = rectOf(card);
    const buttons = Array.from(document.querySelectorAll('.shell-approval-card button')).map((button) => ({
      label: textOf(button),
      ariaLabel: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      className: button.className,
      disabled: !!button.disabled,
      rect: rectOf(button),
      visible: !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
    }));
    const actionPairs = [];
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        const a = buttons[i].rect;
        const b = buttons[j].rect;
        if (!a || !b) continue;
        const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
        if (overlapX * overlapY > 0.5) actionPairs.push([buttons[i].label || buttons[i].className, buttons[j].label || buttons[j].className]);
      }
    }
    const facts = Array.from(document.querySelectorAll('.shell-approval-fact')).map((row) => {
      const label = row.querySelector('.shell-approval-fact-label');
      const value = row.querySelector('.shell-approval-fact-value');
      return {
        label: textOf(label),
        value: textOf(value),
        rect: rectOf(row),
        valueRect: rectOf(value),
        valueOverflow: value ? value.scrollWidth > value.clientWidth + 1 : null,
        valueWrapped: value ? value.getBoundingClientRect().height > (parseFloat(getComputedStyle(value).lineHeight) || 0) * 1.6 : null,
      };
    });
    const outcome = document.querySelector('.shell-approval-outcome');
    const processing = document.querySelector('.shell-approval-processing');
    const warning = document.querySelector('.shell-approval-warning');
    const buttonsInsideCard = cardRect ? buttons.every((button) => button.rect
      && button.rect.x >= cardRect.x - 0.5
      && button.rect.right <= cardRect.right + 0.5
      && button.rect.y >= cardRect.y - 0.5
      && button.rect.bottom <= cardRect.bottom + 0.5) : false;
    const approve = buttons.find((button) => button.className.includes('shell-approval-confirm'));
    const reject = buttons.find((button) => button.className.includes('shell-approval-cancel'));
    const checks = {
      cardVisible: !!card && !!cardRect && cardRect.width > 0 && cardRect.height > 0,
      noCardHorizontalOverflow: !!card && card.scrollWidth <= card.clientWidth + 1,
      noViewHorizontalOverflow: !!view && view.scrollWidth <= view.clientWidth + 1,
      noDocumentHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      buttonsInsideCard,
      noButtonOverlap: actionPairs.length === 0,
      visibleTextActions: !!approve && !!reject && approve.label.length > 0 && reject.label.length > 0,
      hasHighRiskWarning: !!warning && textOf(warning).length > 0,
      factsReadable: facts.every((fact) => fact.valueOverflow !== true || fact.valueWrapped === true),
      cardFitsViewport: !!viewRect && !!cardRect && cardRect.width <= viewRect.width + 1,
    };
    return {
      viewport: {
        windowInnerWidth: window.innerWidth,
        windowInnerHeight: window.innerHeight,
        viewRect,
        documentScroll: { x: window.scrollX, y: window.scrollY },
      },
      card: {
        found: !!card,
        rect: cardRect,
        className: card ? card.className : null,
        scrollWidth: card ? card.scrollWidth : null,
        clientWidth: card ? card.clientWidth : null,
        title: textOf(document.querySelector('.shell-approval-title')),
        risk: textOf(document.querySelector('.shell-approval-risk')),
        warning: textOf(warning),
        state: card ? Array.from(card.classList).find((name) => name.startsWith('is-') && !name.endsWith('-risk')) || null : null,
        outcome: outcome ? textOf(outcome) : null,
        processing: processing ? textOf(processing) : null,
      },
      facts,
      buttons,
      actionOverlaps: actionPairs,
      checks,
      verdict: {
        allPass: Object.values(checks).every(Boolean),
      },
      limitations: [
        'Colour, contrast, font rendering and animation are not asserted.',
        'The approval scenario is injected into the real view projection; the card itself is the production renderer.',
        'The screenshot is clipped to the Baizer workbench view; Obsidian chrome outside it is not part of the evidence.',
      ],
    };
  })()`;
}

async function capture(session, { outPath, viewRect, windowSize }) {
  const x = Math.max(0, Math.round(viewRect.x + (windowSize.scrollX || 0)));
  const y = Math.max(0, Math.round(viewRect.y + (windowSize.scrollY || 0)));
  const width = Math.max(1, Math.round(viewRect.width));
  const height = Math.max(1, Math.round(Math.min(viewRect.height, windowSize.innerHeight - viewRect.y)));
  const result = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 },
  });
  const buffer = Buffer.from(result.data, 'base64');
  await fsp.writeFile(outPath, buffer);
  return { clip: { x, y, width, height }, png: pngSize(buffer), bytes: buffer.length };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'plugin-dir': { type: 'string' },
      out: { type: 'string' },
      'layout-out': { type: 'string' },
      width: { type: 'string', default: '300' },
      height: { type: 'string', default: '1000' },
      theme: { type: 'string', default: 'dark' },
      label: { type: 'string' },
      phase: { type: 'string' },
      revision: { type: 'string' },
      vault: { type: 'string' },
      obsidian: { type: 'string' },
      port: { type: 'string', default: '9333' },
      locale: { type: 'string', default: 'zh' },
      'ready-timeout': { type: 'string', default: '180000' },
      state: { type: 'string', default: 'pending' },
      flow: { type: 'string' },
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
  const sidebarWidth = Number.parseInt(values.width, 10);
  const windowHeight = Number.parseInt(values.height, 10);
  const port = Number.parseInt(values.port, 10);
  const readyTimeout = Number.parseInt(values['ready-timeout'], 10);
  const vaultDir = path.resolve(values.vault || defaultVaultDir());
  const theme = values.theme;
  const label = values.label || path.basename(outPath, '.png');

  const exe = resolveObsidianExe(values.obsidian);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.mkdir(path.dirname(layoutPath), { recursive: true });

  // A second Obsidian instance hands the vault off to the first and exits, so
  // make sure no orphan from an earlier run is holding the vault — otherwise the
  // capture can silently use the previous run's plugin bundle.
  await killAllObsidian();

  const vaultInfo = await materialiseVault({ vaultDir, pluginDir, theme });
  // Obsidian persists the previous run's layout in workspace.json. Without a
  // reset, the workbench leaf can be restored into the main editor area and the
  // sidebar-width scenario silently captures the wrong region.
  await fsp.rm(path.join(vaultInfo.vaultDir, '.obsidian', 'workspace.json'), { force: true });
  await fsp.rm(path.join(vaultInfo.vaultDir, '.obsidian', 'workspace-mobile.json'), { force: true });
  const registry = await registerVaultGlobally(vaultDir);

  let child = null;
  let session = null;
  const runInfo = {
    exe,
    pluginDir,
    vaultDir: vaultInfo.vaultDir,
    vaultKey: registry.vaultKey,
    pluginManifest: vaultInfo.manifest,
    copiedPluginFiles: vaultInfo.copied,
    theme,
    requestedSidebarWidth: sidebarWidth,
    windowHeight,
    phase: values.phase || null,
    revision: values.revision || null,
    label,
    state: values.state || 'pending',
  };

  try {
    child = launchObsidian(exe, port);
    runInfo.pid = child.pid;
    const devtools = await waitForDevTools(port, { timeoutMs: readyTimeout });
    runInfo.browser = devtools.Browser ?? null;

    const connected = await connectToDrivablePage(port, { timeoutMs: readyTimeout });
    session = connected.session;
    runInfo.target = { id: connected.target.id, url: connected.target.url };
    await waitForAppReady(session, { timeoutMs: readyTimeout });
    await handleBlockingModals(session);
    await applyLocale(session, values.locale);
    await waitForAppReady(session, { timeoutMs: readyTimeout });
    const pluginEnabled = await ensurePluginEnabled(session, PLUGIN_ID);
    const pluginLoaded = await waitForPluginLoaded(session, PLUGIN_ID);
    runInfo.plugin = {
      enabled: pluginEnabled,
      loaded: pluginLoaded,
      version: vaultInfo.manifest.version,
    };

    const viewport = await applyViewport(session, { width: Math.max(sidebarWidth + 900, 1280), height: windowHeight });
    runInfo.viewportOverride = viewport;

    await openWorkbench(session);
    const sidebar = await sizeSidebar(session, sidebarWidth);
    runInfo.sidebar = sidebar;
    const injected = await injectScenario(session, { width: sidebarWidth, state: values.state });
    runInfo.injection = injected;

    const flowResult = await runFlow(session, values.flow);
    runInfo.flow = flowResult;

    const metrics = await session.evaluate(probeExpression());
    runInfo.metrics = metrics;

    const shot = await capture(session, {
      outPath,
      viewRect: metrics.viewport.viewRect,
      windowSize: {
        innerHeight: metrics.viewport.windowInnerHeight,
        scrollX: metrics.viewport.documentScroll.x,
        scrollY: metrics.viewport.documentScroll.y,
      },
    });
    runInfo.capture = shot;

    const report = {
      harness: 'tools/approval-card-shots/capture.mjs',
      label,
      phase: values.phase || null,
      revision: values.revision || null,
      state: values.state || 'pending',
      flow: values.flow || null,
      obsidian: runInfo.browser,
      theme,
      locale: values.locale,
      requestedSidebarWidth: sidebarWidth,
      plugin: runInfo.plugin,
      sidebar: runInfo.sidebar,
      injection: runInfo.injection,
      flow: flowResult,
      viewport: metrics.viewport,
      card: metrics.card,
      facts: metrics.facts,
      buttons: metrics.buttons,
      actionOverlaps: metrics.actionOverlaps,
      checks: metrics.checks,
      verdict: metrics.verdict,
      capture: shot,
      limitations: metrics.limitations,
      harnessInfo: runInfo,
    };
    await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
      out: outPath,
      layout: layoutPath,
      png: shot.png,
      sidebarWidth: runInfo.sidebar,
      checks: metrics.checks,
      verdict: metrics.verdict,
    }, null, 2));

    if (!metrics.verdict.allPass) process.exitCode = 2;
  } finally {
    if (session) session.close();
    if (child && !values['keep-open']) await killTree(child.pid);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
