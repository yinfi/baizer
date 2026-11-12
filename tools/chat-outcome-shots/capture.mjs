#!/usr/bin/env node
/**
 * Capture the Baizer chat view's terminal states (failed / cancelled / completed)
 * out of a real, running Obsidian, for Before/After evidence on issue #65.
 *
 * This is not a mock-up generator. Obsidian is launched with
 * `--remote-debugging-port`, the renderer is driven over CDP, and the PNG comes
 * from `Page.captureScreenshot`. A sibling `*.chat.json` records the facts the
 * bitmap cannot be asserted against (terminal card present, retry/restore
 * buttons, restored input text, system messages, partial answer text).
 *
 * A local OpenAI-compatible SSE server provides deterministic streams:
 * - `failure`: stream a partial answer, then destroy the socket mid-stream;
 * - `cancel`: stream slowly enough for the driver to click Stop;
 * - `success`: stream a short answer to completion.
 *
 * Usage (Windows host, Node >= 22):
 *   node tools/chat-outcome-shots/capture.mjs \
 *     --plugin-dir dist --scenario failure --out docs/assets/chat-outcome-failed-after.png \
 *     --label failed-after --phase after --revision <sha> --width 1100 --height 900
 *
 * See tools/provider-settings-shots/README.md for the shared vault/CDP notes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, listTargets, waitForDevTools } from '../provider-settings-shots/lib/cdp.mjs';
import { materialiseVault, PLUGIN_ID } from '../provider-settings-shots/lib/vault.mjs';

const LOG_PATH = path.join(process.env.TEMP || os.tmpdir(), `chat-outcome-shot-${process.pid}.log`);
function logStep(name, data) {
  const line = `[${new Date().toISOString()}] ${name}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`;
  try { fs.appendFileSync(LOG_PATH, `${line}\n`); } catch { /* best effort */ }
  console.log(line);
}

const SHELL_VIEW_TYPE = `${PLUGIN_ID}-shell-view`;

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

/**
 * Launch an *isolated* Obsidian instance.
 *
 * A shared host may have other agents driving Obsidian at the same time. A
 * separate `--user-data-dir` gives this run its own single-instance lock and
 * Chromium profile, so another harness killing its own Obsidian cannot take
 * this window down. Passing the vault path directly avoids rewriting the
 * machine-global vault registry.
 */
function launchObsidian(exe, vaultDir, userDataDir, port) {
  return spawn(exe, [
    vaultDir,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
  ], {
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

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ------------------------------------------------------- fake LLM server ----

/**
 * Minimal OpenAI-compatible streaming endpoint. The plugin talks to
 * `<baseUrl>/chat/completions`, so this serves `/v1/chat/completions`.
 */
function startFakeServer(mode, port) {
  const log = [];
  const server = http.createServer((req, res) => {
    logStep('http request', { method: req.method, url: req.url, mode });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      // Obsidian's renderer is served from app://obsidian.md, so a request to
      // 127.0.0.1 is cross-origin: the fixture must answer CORS/preflight or the
      // provider request never leaves the browser.
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      if (req.url.includes('/models')) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'fixture' }],
        }));
        return;
      }
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404, cors).end();
        return;
      }
      let model = 'fake-model';
      try {
        model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model || model;
      } catch {
        /* fixture only */
      }
      log.push({ mode, url: req.url, model, at: new Date().toISOString() });
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let closed = false;
      let sent = 0;
      const send = (delta, finish = null) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      };

      const failureWords = [
        'Here is the partial answer that was already streamed. ',
        'The provider will drop the connection before finishing.',
      ];
      const cancelWords = [
        'Here is a slow answer ', 'that keeps streaming ', 'until the user stops it. ',
      ];
      const successWords = [
        'Here is a completed answer. ', 'It streams normally and finishes cleanly.',
      ];

      send({ role: 'assistant' });
      const timer = setInterval(() => {
        if (mode === 'failure') {
          if (sent < failureWords.length) {
            send({ content: failureWords[sent++] });
            return;
          }
          clearInterval(timer);
          // Abrupt close mid-stream: the client sees a broken connection, not a
          // clean `[DONE]`; this is the failure scenario under test.
          closed = true;
          res.destroy();
          return;
        }
        if (mode === 'cancel') {
          if (sent < 60) {
            send({ content: cancelWords[sent % cancelWords.length] });
            sent++;
            return;
          }
        } else {
          if (sent < successWords.length) {
            send({ content: successWords[sent++] });
            return;
          }
        }
        clearInterval(timer);
        send({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      }, mode === 'cancel' ? 320 : 140);
      // `req` emits 'close' as soon as the request body is consumed; the
      // response lifetime is what matters here (client abort / our own destroy).
      res.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, log }));
  });
}

// ------------------------------------------------------------ CDP driving ----

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
    const pages = (targets || []).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    const ordered = [
      ...pages.filter((target) => /^app:\/\/obsidian\.md/i.test(target.url || '')),
      ...pages.filter((target) => !/^app:\/\/obsidian\.md/i.test(target.url || '')),
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
    const accept = buttons.find((button) =>
      /trust|信任/i.test(button.textContent || '') && !/restricted|safe|安全/i.test(button.textContent || ''));
    if (!accept) return { present: true, clicked: null, buttons: buttons.map((b) => (b.textContent || '').trim()) };
    accept.click();
    return { present: true, clicked: (accept.textContent || '').trim() };
  })()`);

  const releaseNotes = await session.evaluate(`(() => {
    try {
      const leaves = app.workspace.getLeavesOfType('release-notes');
      for (const leaf of leaves) leaf.detach();
      return leaves.length;
    } catch (error) {
      return null;
    }
  })()`);
  return { trust, releaseNotesDetached: releaseNotes };
}

async function ensurePluginEnabled(session) {
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

async function closeSettings(session) {
  return session.evaluate(`(async () => {
    try { if (app.setting && typeof app.setting.close === 'function') app.setting.close(); } catch (error) { /* ignore */ }
    for (const modal of document.querySelectorAll('.modal-container .modal.mod-settings')) {
      const close = modal.querySelector('.modal-close-button');
      if (close) close.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return !document.querySelector('.modal-container .modal.mod-settings');
  })()`);
}

async function openShell(session) {
  return session.evaluate(`(async () => {
    // Reuse the leaf the plugin restored (if any) and detach duplicates, so
    // document selectors cannot hit an inactive/hidden copy of the view.
    const leaves = app.workspace.getLeavesOfType('${SHELL_VIEW_TYPE}');
    for (const extra of leaves.slice(1)) extra.detach();
    let leaf = leaves[0];
    if (!leaf) {
      leaf = app.workspace.getLeaf(true);
      await leaf.setViewState({ type: '${SHELL_VIEW_TYPE}', active: true });
    }
    app.workspace.revealLeaf(leaf);
    // Capture-side instrumentation: log every StreamEvent the controller forwards,
    // so a missing terminal event is visible in the run log.
    const controller = app.workspace.activeLeaf && app.workspace.activeLeaf.view
      ? app.workspace.activeLeaf.view.chatController : null;
    if (controller && !controller.__capturePatched) {
      controller.__capturePatched = true;
      const original = controller.onStreamEvent && controller.onStreamEvent.bind(controller);
      controller.onStreamEvent = (event) => {
        console.log('[CAPTURE STREAM EVENT]', JSON.stringify(event));
        return original ? original(event) : undefined;
      };
    }
    return {
      leaves: app.workspace.getLeavesOfType('${SHELL_VIEW_TYPE}').length,
      active: app.workspace.activeLeaf && app.workspace.activeLeaf.view
        ? app.workspace.activeLeaf.view.getViewType() : null,
    };
  })()`);
}

const CHAT_FACTS_EXPRESSION = `(() => {
  const text = (node) => (node && node.textContent || '').replace(/\\s+/g, ' ').trim();
  const root = app.workspace.activeLeaf && app.workspace.activeLeaf.view
    && app.workspace.activeLeaf.view.getViewType() === '${SHELL_VIEW_TYPE}'
    ? app.workspace.activeLeaf.view.containerEl
    : document.querySelector('.baizer-shell-view');
  if (!root) return { error: 'no active Baizer view' };
  const input = root.querySelector('.shell-input');
  const timeline = root.querySelector('.shell-stream-container .shell-think-timeline');
  return {
    hasFailureCard: !!root.querySelector('.shell-turn-failed'),
    hasCancelledCard: !!root.querySelector('.shell-turn-cancelled'),
    outcomeTitle: text(root.querySelector('.shell-turn-outcome-title')),
    outcomeReason: text(root.querySelector('.shell-turn-outcome-reason')),
    hasRetryButton: !!root.querySelector('.shell-turn-retry'),
    hasRestoreDraftButton: !!root.querySelector('.shell-turn-restore'),
    inputValue: input ? input.value : null,
    systemMessages: Array.from(root.querySelectorAll('.shell-entry.system')).map(text),
    answerText: text(root.querySelector('.shell-response-content')),
    timelineCollapsed: timeline ? timeline.classList.contains('is-collapsed') : null,
    timelineSummary: text(root.querySelector('.think-summary-text')),
    aiEntries: root.querySelectorAll('.shell-entry.ai').length,
  };
})()`;

async function runScenario(session, mode, facts) {
  await session.waitFor(
    `!!(app.workspace.activeLeaf && app.workspace.activeLeaf.view && app.workspace.activeLeaf.view.getViewType() === '${SHELL_VIEW_TYPE}' && app.workspace.activeLeaf.view.containerEl.querySelector('.shell-input'))`,
    { timeoutMs: 30000, label: 'active Baizer shell view' },
  );
  logStep('active shell input found');
  // Let provider/model resolution settle before sending.
  await delay(1500);

  const prompt = 'Explain the terminal-state handling in one short paragraph.';
  await session.evaluate(`(() => {
    const root = app.workspace.activeLeaf.view.containerEl;
    const input = root.querySelector('.shell-input');
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  logStep('prompt typed');
  await delay(300);
  await session.evaluate(`(() => {
    const root = app.workspace.activeLeaf.view.containerEl;
    const button = root.querySelector('.shell-run-btn');
    if (!button) throw new Error('send button missing');
    button.click();
    return true;
  })()`);
  logStep('send clicked');

  if (mode === 'failure') {
    // After: a terminal card appears. Before: only a system error pill does.
    await session.waitFor(
      `(() => { const root = app.workspace.activeLeaf.view.containerEl; return !!root.querySelector('.shell-turn-failed') || Array.from(root.querySelectorAll('.shell-entry.system')).some((node) => /error|failed|api key/i.test(node.textContent || '')); })()`,
      { timeoutMs: 45000, label: 'failure terminal state' },
    );
  } else if (mode === 'cancel') {
    await session.waitFor(
      `(() => { const root = app.workspace.activeLeaf.view.containerEl; const node = root.querySelector('.shell-response-content'); return !!node && (node.textContent || '').trim().length > 0; })()`,
      { timeoutMs: 30000, label: 'first streamed text before cancel' },
    );
    logStep('first streamed text observed');
    await delay(400);
    await session.evaluate(`(() => {
      const root = app.workspace.activeLeaf.view.containerEl;
      const button = root.querySelector('.shell-run-btn');
      if (!button) throw new Error('stop button missing');
      button.click();
      return true;
    })()`);
    logStep('stop clicked');
    logStep('after stop', await session.evaluate(`(() => {
      const view = app.workspace.activeLeaf.view;
      return {
        runActive: typeof view.chatController?.isRunActive === 'function' ? view.chatController.isRunActive() : null,
        runButtonLabel: view.containerEl.querySelector('.shell-run-btn')?.getAttribute('aria-label') ?? null,
        hasCancelledCard: !!view.containerEl.querySelector('.shell-turn-cancelled'),
        system: Array.from(view.containerEl.querySelectorAll('.shell-entry.system')).map((node) => (node.textContent || '').trim()),
      };
    })()`));
    // After: a cancelled card appears. Before: the turn is wrongly allowed to
    // finish as a normal answer, so wait for either terminal signal or the run
    // button returning to Send — the capture then documents whichever happened.
    await session.waitFor(
      `(() => {
        const root = app.workspace.activeLeaf.view.containerEl;
        if (root.querySelector('.shell-turn-cancelled')) return true;
        if (Array.from(root.querySelectorAll('.shell-entry.system')).some((node) => /stopped|stopping/i.test(node.textContent || ''))) return true;
        const button = root.querySelector('.shell-run-btn');
        return !!button && button.getAttribute('aria-label') === 'Send message';
      })()`,
      { timeoutMs: 30000, label: 'cancelled terminal state' },
    );
  } else {
    await session.waitFor(
      `(() => { const root = app.workspace.activeLeaf.view.containerEl; const node = root.querySelector('.shell-response-content'); return !!node && (node.textContent || '').includes('completed answer'); })()`,
      { timeoutMs: 30000, label: 'completed answer' },
    );
  }

  // Let the terminal card/restored draft settle before measuring.
  await delay(1200);
  facts.push(await session.evaluate(CHAT_FACTS_EXPRESSION));
}

// ------------------------------------------------------------------ main ----

async function main() {
  const { values } = parseArgs({
    options: {
      'plugin-dir': { type: 'string' },
      out: { type: 'string' },
      'facts-out': { type: 'string' },
      scenario: { type: 'string', default: 'failure' },
      label: { type: 'string' },
      phase: { type: 'string' },
      revision: { type: 'string' },
      width: { type: 'string', default: '1100' },
      height: { type: 'string', default: '900' },
      theme: { type: 'string', default: 'dark' },
      vault: { type: 'string' },
      obsidian: { type: 'string' },
      port: { type: 'string', default: '9371' },
      'server-port': { type: 'string', default: '8788' },
      'user-data-dir': { type: 'string' },
      'keep-open': { type: 'boolean', default: false },
      'ready-timeout': { type: 'string', default: '180000' },
    },
  });

  if (!values['plugin-dir'] || !values.out) {
    throw new Error('--plugin-dir and --out are required');
  }
  const mode = values.scenario;
  if (!['failure', 'cancel', 'success'].includes(mode)) {
    throw new Error(`unknown scenario: ${mode}`);
  }
  const width = Number(values.width);
  const height = Number(values.height);
  const port = Number(values.port);
  const serverPort = Number(values['server-port']);
  // Ticket-scoped default paths: the host may be running other capture harnesses
  // concurrently, and materialiseVault() wipes its target plugin directory.
  const vaultDir = values.vault || path.join(os.tmpdir(), 'baizer-chat-outcome-65', 'vault');
  const userDataDir = values['user-data-dir'] || path.join(path.dirname(vaultDir), 'userdata');
  const outPath = path.resolve(values.out);
  const factsPath = values['facts-out'] ? path.resolve(values['facts-out']) : outPath.replace(/\.png$/i, '.chat.json');

  const scenario = {
    language: 'en',
    activeProvider: 'fake',
    deletedProviderIds: ['openai', 'deepseek', 'qwen', 'gemini'],
    providers: {
      fake: {
        type: 'openai-compatible',
        label: 'Fake fixture',
        // For `failure` we still want the stream to start and then break, so a
        // key is present; the failure comes from the broken SSE connection.
        apiKey: 'sk-fixture-not-a-real-key',
        baseUrl: `http://127.0.0.1:${serverPort}/v1`,
        model: 'fake-model',
      },
    },
  };

  const { server, log } = await startFakeServer(mode, serverPort);
  logStep('fake server listening', { serverPort, mode });
  const vault = await materialiseVault({ vaultDir, pluginDir: values['plugin-dir'], scenario, theme: values.theme });
  // Drop the previous run's workspace layout: it may contain leaves whose plugin
  // was unloaded, which Obsidian renders as blocking "Plugin no longer active" views.
  for (const layoutFile of ['workspace.json', 'workspace-mobile.json']) {
    await fsp.rm(path.join(vault.vaultDir, '.obsidian', layoutFile), { force: true });
  }
  logStep('vault materialised', { vaultDir: vault.vaultDir, pluginDir: path.resolve(values['plugin-dir']) });

  // The isolated profile needs its own vault registry; otherwise Obsidian shows
  // the starter window instead of opening the fixture vault.
  await fsp.rm(userDataDir, { recursive: true, force: true });
  await fsp.mkdir(userDataDir, { recursive: true });
  const vaultKey = crypto.createHash('sha1').update(path.resolve(vault.vaultDir).toLowerCase()).digest('hex').slice(0, 16);
  await fsp.writeFile(
    path.join(userDataDir, 'obsidian.json'),
    `${JSON.stringify({ vaults: { [vaultKey]: { path: vault.vaultDir, ts: Date.now(), open: true } } }, null, 2)}\n`,
    'utf8',
  );
  logStep('isolated profile prepared', { userDataDir, vaultKey });

  const exe = resolveObsidianExe(values.obsidian);
  const child = launchObsidian(exe, vault.vaultDir, userDataDir, port);
  logStep('obsidian launched', { exe, port, userDataDir, pid: child.pid });
  const facts = [];
  let session = null;
  let capture = null;
  let failure = null;
  try {
    await waitForDevTools(port, { timeoutMs: Number(values['ready-timeout']) });
    logStep('devtools endpoint ready');
    const connected = await connectToDrivablePage(port, { timeoutMs: Number(values['ready-timeout']) });
    session = connected.session;
    logStep('connected to drivable page', { url: connected.target.url });
    session.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ')
        .slice(0, 600);
      if (/baizer|chat|stream|provider|error|fail|abort/i.test(text)) {
        logStep('console', { type: params.type, text });
      }
    });
    session.on('Runtime.exceptionThrown', (params) => {
      logStep('page exception', {
        text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'unknown',
      });
    });
    const modals = await handleBlockingModals(session);
    logStep('blocking modals handled', modals);
    await session.waitFor(`!!(window.app && app.workspace && app.workspace.layoutReady !== false)`, {
      timeoutMs: 120000,
      label: 'Obsidian workspace ready',
    });
    // The first-open trust dialog can appear after (or alongside) the first
    // enable attempt, so retry the modal sweep + enable until the plugin exists.
    let plugin = { loaded: false };
    let modalState = null;
    for (let attempt = 0; attempt < 6 && !plugin.loaded; attempt++) {
      modalState = await handleBlockingModals(session);
      plugin = await ensurePluginEnabled(session);
      logStep('plugin enable attempt', { attempt, plugin, modalState });
      if (!plugin.loaded) await delay(1500);
    }
    await session.waitFor(
      `!!(window.app && app.plugins && app.plugins.plugins && app.plugins.plugins['${PLUGIN_ID}'])`,
      { timeoutMs: 60000, label: 'Baizer plugin instantiated' },
    );
    logStep('plugin instantiated');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Hide Obsidian notice popups (e.g. the plugin's unrelated "Knowledge Wiki
    // needs Bases" notice) so both phases show the same chrome.
    await session.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'capture-hide-notices';
      style.textContent = '.notice-container{display:none!important}';
      document.head.appendChild(style);
      return true;
    })()`);
    await delay(500);
    // A settings modal can be left open by the trust/enable flow; it would cover
    // the chat view in the screenshot while DOM facts still come from the view.
    logStep('settings closed', await closeSettings(session));
    await openShell(session);
    logStep('shell view opened');
    logStep('settings closed after open', await closeSettings(session));
    await runScenario(session, mode, facts);
    logStep('scenario finished', facts[0]);

    // Plugin-load notices (e.g. "Knowledge Wiki needs Bases") are unrelated to
    // the terminal-state evidence; drop them so both phases show the same chrome.
    await session.evaluate(`(() => {
      document.querySelectorAll('.notice').forEach((node) => node.remove());
      return true;
    })()`);
    await delay(250);

    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    capture = Buffer.from(shot.data, 'base64');
    const size = pngSize(capture);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, capture);
    const report = {
      label: values.label || path.basename(outPath),
      phase: values.phase || null,
      revision: values.revision || null,
      scenario: mode,
      viewport: { requested: { width, height }, actual: size },
      theme: values.theme,
      plugin: { dir: path.resolve(values['plugin-dir']), files: vault.copied, manifest: vault.manifest },
      userDataDir,
      vaultDir: vault.vaultDir,
      logPath: LOG_PATH,
      modals,
      pluginEnable: plugin,
      serverLog: log,
      facts,
      capturedAt: new Date().toISOString(),
    };
    await fsp.writeFile(factsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ out: outPath, factsPath, actual: size, facts: facts[0] }, null, 2));
  } catch (error) {
    failure = error;
    logStep('CAPTURE FAILED', { message: error && error.message, stack: error && error.stack });
    try {
      if (session) {
        const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeoutMs: 10000 });
        capture = Buffer.from(shot.data, 'base64');
      }
    } catch (shotError) {
      logStep('diagnostic screenshot failed', { message: shotError && shotError.message });
    }
    process.exitCode = 1;
  } finally {
    try { session?.close(); } catch { /* best effort */ }
    if (!values['keep-open']) {
      await killTree(child.pid);
    }
    server.close();
    if (failure && capture) {
      // Keep a failed-run screenshot for diagnosis, but mark the run failed.
      await fsp.writeFile(outPath.replace(/\.png$/i, '.failed.png'), capture);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
