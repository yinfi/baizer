#!/usr/bin/env node
/**
 * Capture a chat-scroll before/after pair out of a real Obsidian window.
 *
 * The scenario is deliberately identical for both phases:
 *   1. seed a tall conversation through the real ShellView renderer;
 *   2. put the viewport at ~35% of the scroll range and dispatch a `scroll`
 *      event (a user who has scrolled up to read);
 *   3. feed new streaming thinking + text through the real StreamController.
 *
 * Before the fix the viewport is pulled to the bottom by the forced scroll and
 * no return entry exists. After the fix it must stay at the reading anchor and
 * show the "有新输出 · 回到最新" entry. The layout report records the numbers
 * from the same DOM state as the PNG.
 *
 * Run it with Windows Node (the Obsidian process is a Windows process):
 *   "C:\Program Files\nodejs\node.exe" tools/chat-scroll-shots/capture.mjs \
 *     --plugin-dir dist --out docs/assets/chat-scroll-...-after-wide.png \
 *     --phase after --revision <sha> --label after-wide --sidebar-width 520
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from '../provider-settings-shots/lib/cdp.mjs';
import {
    materialiseVault,
    vaultIdFor,
    defaultVaultDir,
    PLUGIN_ID,
} from '../provider-settings-shots/lib/vault.mjs';

const VIEW_TYPE = `${PLUGIN_ID}-shell-view`;

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

/** Remove chat history/workspace state left by an earlier run so phases are comparable. */
async function cleanVaultState(vaultDir) {
    const obsidianDir = path.join(vaultDir, '.obsidian');
    for (const rel of ['baizer', 'baizer-memory', 'workspace.json', 'workspace-mobile.json']) {
        await fsp.rm(path.join(obsidianDir, rel), { recursive: true, force: true });
    }
}

async function prepareIsolatedProfile(userDataDir, vaultDir) {
    const resolved = path.resolve(userDataDir);
    await fsp.mkdir(resolved, { recursive: true });
    const configPath = path.join(resolved, 'obsidian.json');
    const config = {
        vaults: {
            [vaultIdFor(vaultDir)]: { path: path.resolve(vaultDir), ts: Date.now(), open: true },
        },
        frame: 'custom',
    };
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { userDataDir: resolved, configPath, vaultKey: vaultIdFor(vaultDir) };
}

function launchObsidian(exe, port, userDataDir) {
    const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    return spawn(exe, args, { stdio: 'ignore', detached: false, env: sanitizedEnv() });
}

function killTree(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', env: sanitizedEnv() });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
    });
}

async function connectToMainPage(port, { timeoutMs = 120000, intervalMs = 750 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = 'no page targets';
    while (Date.now() < deadline) {
        let targets = [];
        try {
            targets = await listTargets(port);
        } catch (error) {
            last = String(error?.message || error);
            await delay(intervalMs);
            continue;
        }
        for (const target of targets) {
            if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
            let session = null;
            try {
                session = await CDPSession.connect(target.webSocketDebuggerUrl);
                const drivable = await session.evaluate(
                    `typeof app !== 'undefined' && !!app.workspace && app.workspace.layoutReady !== false`,
                );
                if (drivable) return { session, target };
            } catch (error) {
                last = String(error?.message || error);
            }
            session?.close();
        }
        await delay(intervalMs);
    }
    throw new Error(`no drivable Obsidian window within ${timeoutMs} ms (last=${last})`);
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

async function applyChineseLocale(session) {
    const before = await session.evaluate(`window.localStorage.getItem('language')`);
    if (before === 'zh') return { changed: false, previous: before };
    await session.evaluate(`window.localStorage.setItem('language', 'zh')`);
    await session.send('Page.reload', {}, { timeoutMs: 30000 });
    await delay(2500);
    await waitForAppReady(session);
    return { changed: true, previous: before };
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
    const closed = await session.evaluate(`(() => {
      const out = [];
      for (const modal of document.querySelectorAll('.modal-container .modal')) {
        if (modal.classList.contains('mod-settings')) continue;
        const button = modal.querySelector('.modal-close-button, .mod-cta');
        if (button) { button.click(); out.push(modal.className); }
      }
      return out;
    })()`);
    const releaseNotes = await session.evaluate(`(() => {
      try {
        const leaves = app.workspace.getLeavesOfType('release-notes');
        for (const leaf of leaves) leaf.detach();
        return leaves.length;
      } catch (error) { return null; }
    })()`);
    return { trust, closed, releaseNotes };
}

async function ensurePluginEnabled(session) {
    return session.evaluate(`(async () => {
      const app = window.app;
      const out = { steps: [], error: null, loaded: false };
      try {
        if (app.plugins && typeof app.plugins.setEnable === 'function' && app.plugins.enabled === false) {
          app.plugins.setEnable(true); out.steps.push('setEnable');
        }
        if (app.plugins && typeof app.plugins.loadManifests === 'function') {
          await app.plugins.loadManifests(); out.steps.push('loadManifests');
        }
        if (app.plugins && !(app.plugins.plugins || {})['${PLUGIN_ID}'] && typeof app.plugins.enablePlugin === 'function') {
          await app.plugins.enablePlugin('${PLUGIN_ID}'); out.steps.push('enablePlugin');
        }
        out.loaded = !!((app.plugins && app.plugins.plugins) || {})['${PLUGIN_ID}'];
      } catch (error) { out.error = String((error && error.message) || error); }
      return out;
    })()`);
}

async function openShellView(session, splitWidth) {
    return session.evaluate(`(async () => {
      const plugin = app.plugins.plugins['${PLUGIN_ID}'];
      if (!plugin) throw new Error('baizer plugin is not instantiated');
      await plugin.activateView();
      const pluginView = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0]?.view;
      if (!pluginView) throw new Error('baizer shell view did not open');
      const viewEl = document.querySelector('.baizer-shell-view');
      if (!viewEl) throw new Error('shell view DOM missing');
      const split = viewEl.closest('.workspace-split.mod-right-split') || viewEl.parentElement;
      if (split) {
        split.style.width = '${splitWidth}px';
        split.style.flex = '0 0 ${splitWidth}px';
        split.style.maxWidth = '${splitWidth}px';
      }
      return { viewType: pluginView.getViewType?.() ?? null };
    })()`);
}

/** Fit the right split so the shell view's own content box is the requested width. */
async function fitViewWidth(session, viewWidth) {
    return session.evaluate(`(() => {
      const viewEl = document.querySelector('.baizer-shell-view');
      const split = viewEl.closest('.workspace-split.mod-right-split');
      if (!split) return { error: 'right split not found' };
      let splitW = split.getBoundingClientRect().width;
      for (let i = 0; i < 6; i++) {
        const vw = viewEl.getBoundingClientRect().width;
        const diff = ${viewWidth} - vw;
        if (Math.abs(diff) <= 1) break;
        splitW += diff;
        split.style.width = splitW + 'px';
        split.style.flex = '0 0 ' + splitW + 'px';
        split.style.maxWidth = splitW + 'px';
        split.getBoundingClientRect();
      }
      return {
        splitWidth: Math.round(split.getBoundingClientRect().width),
        viewWidth: Math.round(viewEl.getBoundingClientRect().width),
      };
    })()`);
}

const SEED_SCRIPT = (seedCount) => `(async () => {
  const view = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view;
  const out = view.outputContainer;
  const pad = (label) => [
    '### ' + label,
    '',
    '聊天滚动应在读者上翻后保持阅读锚点，不得因为新的 token、Markdown 定型、过程块折叠展开或图片加载被拉回底部。',
    '',
    '- 仅当更新前处于接近底部（距底 < 80px）且允许跟随时才跟随；',
    '- 用户主动上翻立即暂停自动跟随；',
    '- 暂停后确有新输出时才显示“有新输出 · 回到最新”；',
    '- 跟随/未读/阅读位置按会话隔离。',
    '',
    '滚动行为不应改变推理内容或工具调用结果，只调整视口交互。这里用一段足够高的正文把输出区撑满，',
    '以便在同一个阅读位置比较修复前后的视口。',
    '',
    '> 这是截图夹具文本，不代表真实的模型输出。',
    ''
  ].join('\\n');
  for (let i = 0; i < ${seedCount}; i++) {
    const isUser = i % 3 === 2;
    view.appendMessage({
      id: 'capture-' + i,
      role: isUser ? 'user' : 'ai',
      content: isUser ? ('请继续说明第 ' + (i + 1) + ' 点。') : pad('第 ' + (i + 1) + ' 段说明'),
      timestamp: Date.now() + i,
    });
  }
  await new Promise((r) => setTimeout(r, 900));
  return {
    messagesSeen: out.querySelectorAll('.shell-entry').length,
    scrollHeight: out.scrollHeight,
    clientHeight: out.clientHeight,
  };
})()`;

const SCROLL_UP_SCRIPT = `(() => {
  const out = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view.outputContainer;
  const max = Math.max(0, out.scrollHeight - out.clientHeight);
  const anchor = Math.round(max * 0.35);
  out.scrollTo({ top: anchor, behavior: 'instant' });
  out.dispatchEvent(new Event('scroll'));
  return { anchor, max, scrollTop: out.scrollTop };
})()`;

const STREAM_CHUNK_SCRIPT = (chunkIndex) => `(() => {
  const view = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view;
  if (${chunkIndex} === 0) {
    view.handleStreamEvent({ type: 'thinking', content: '正在核对滚动位置与未读状态，确保上翻阅读时不会被新输出拉回底部。' });
  }
  view.handleStreamEvent({
    type: 'text_delta',
    content: '新的流式输出第 ' + (${chunkIndex} + 1) + ' 段：读者已经上翻，这段内容应当留在下方，'
      + '只点亮返回入口，而不是把视口拉到底部。\\n\\n'
      + '延续的正文继续增长，用来验证后续 token 同样不会重置阅读锚点。\\n\\n',
  });
  return true;
})()`;

const MEASURE_SCRIPT = `(() => {
  const viewEl = document.querySelector('.baizer-shell-view');
  const out = viewEl.querySelector('.shell-output-area');
  const bar = viewEl.querySelector('.shell-unread-bar');
  const barButton = viewEl.querySelector('.shell-unread-button');
  const view = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const max = Math.max(0, out.scrollHeight - out.clientHeight);
  const barRect = rect(bar);
  const viewRect = rect(viewEl);
  const split = viewEl.closest('.workspace-split.mod-right-split');
  const splitRect = rect(split);
  const barVisible = !!bar && !bar.classList.contains('baizer-hidden') && barRect.width > 0 && barRect.height > 0;
  return {
    appVersion: (app.manifest && app.manifest.version) || null,
    pluginVersion: (() => { try { return app.plugins.plugins['${PLUGIN_ID}'].manifest.version; } catch (e) { return null; } })(),
    locale: window.localStorage.getItem('language'),
    viewRect,
    splitRect,
    outputRect: rect(out),
    scrollTop: Math.round(out.scrollTop),
    maxScrollTop: Math.round(max),
    distanceFromBottom: Math.round(max - out.scrollTop),
    scrollHeight: Math.round(out.scrollHeight),
    clientHeight: Math.round(out.clientHeight),
    unreadBar: {
      present: !!bar,
      visible: barVisible,
      text: barButton ? (barButton.textContent || '').trim() : null,
      rect: barRect,
      buttonRect: rect(barButton),
      withinViewport: barRect && viewRect
        ? barRect.x >= viewRect.x && barRect.x + barRect.width <= viewRect.x + viewRect.width
        : null,
    },
    follow: (() => {
      const controller = view.scrollFollow;
      if (!controller || typeof controller.isFollowing !== 'function') return null;
      return { following: controller.isFollowing(), unread: controller.hasUnread() };
    })(),
    horizontalOverflow: viewEl.scrollWidth > viewEl.clientWidth + 1,
    documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`;

async function screenshot(session, outPath, clip) {
    const result = await session.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
        captureBeyondViewport: false,
        fromSurface: true,
    }, { timeoutMs: 60000 });
    const buffer = Buffer.from(result.data, 'base64');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, buffer);
    return { bytes: buffer.length, ...pngSize(buffer) };
}

function pngSize(buffer) {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return {};
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readWindowsFileVersion(exe) {
    if (process.platform !== 'win32') return null;
    try {
        return String(execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-Item -LiteralPath '${String(exe).replace(/'/g, "''")}').VersionInfo.FileVersion`,
        ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
    } catch { return null; }
}

async function main() {
    const { values } = parseArgs({
        options: {
            'plugin-dir': { type: 'string' },
            out: { type: 'string' },
            'layout-out': { type: 'string' },
            'view-width': { type: 'string', default: '520' },
            'viewport-width': { type: 'string', default: '1440' },
            'viewport-height': { type: 'string', default: '960' },
            'sidebar-height': { type: 'string', default: '900' },
            theme: { type: 'string', default: 'dark' },
            phase: { type: 'string', default: 'after' },
            revision: { type: 'string', default: '' },
            label: { type: 'string', default: 'chat-scroll' },
            port: { type: 'string', default: '9341' },
            'ready-timeout': { type: 'string', default: '180000' },
            'seed-count': { type: 'string', default: '12' },
            'stream-chunks': { type: 'string', default: '3' },
            obsidian: { type: 'string' },
            vault: { type: 'string' },
            'user-data-dir': { type: 'string' },
            'keep-open': { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });

    if (!values['plugin-dir'] || !values.out) {
        throw new Error('--plugin-dir and --out are required');
    }

    const pluginDir = path.resolve(values['plugin-dir']);
    const outPath = path.resolve(values.out);
    const layoutPath = values['layout-out']
        ? path.resolve(values['layout-out'])
        : outPath.replace(/\.png$/i, '') + '.layout.json';
    const viewWidth = Number(values['view-width']);
    const viewportWidth = Number(values['viewport-width']);
    const viewportHeight = Number(values['viewport-height']);
    const sidebarHeight = Number(values['sidebar-height']);
    const seedCount = Number(values['seed-count']);
    const streamChunks = Number(values['stream-chunks']);
    const port = Number(values.port);
    const readyTimeout = Number(values['ready-timeout']);
    const theme = values.theme;
    const locale = 'zh';
    const exe = resolveObsidianExe(values.obsidian);
    const vaultDir = values.vault ? path.resolve(values.vault) : defaultVaultDir();
    const userDataDir = values['user-data-dir']
        ? path.resolve(values['user-data-dir'])
        : path.join(os.tmpdir(), 'baizer-shots', 'chat-profile');

    const report = {
        label: values.label,
        phase: values.phase,
        revision: values.revision,
        capturedAt: new Date().toISOString(),
        out: outPath,
        scenario: {
            seedCount,
            streamChunks,
            scrollAnchorFraction: 0.35,
            viewport: { width: viewportWidth, height: viewportHeight },
            viewWidth,
            sidebarHeight,
            theme,
            locale,
        },
        host: { platform: process.platform, node: process.version, exe, exeFileVersion: readWindowsFileVersion(exe) },
        steps: [],
        limitations: [],
    };

    let child = null;
    let session = null;
    try {
        const vaultInfo = await materialiseVault({ vaultDir, pluginDir, scenario: null, theme });
        await cleanVaultState(vaultInfo.vaultDir);
        // Isolated Chromium profile: Obsidian reads its vault registry from the
        // userData dir, so writing it there opens the harness vault without
        // touching the real %APPDATA%\obsidian\obsidian.json or the vault the
        // user already has running.
        const profile = await prepareIsolatedProfile(userDataDir, vaultInfo.vaultDir);
        report.vault = { dir: vaultInfo.vaultDir, pluginManifest: vaultInfo.manifest, profile };

        child = launchObsidian(exe, port, userDataDir);
        report.pid = child.pid;
        await waitForDevTools(port, { timeoutMs: readyTimeout });
        const connected = await connectToMainPage(port, { timeoutMs: readyTimeout });
        session = connected.session;
        report.target = { id: connected.target.id, url: connected.target.url, title: connected.target.title };
        await waitForAppReady(session, { timeoutMs: readyTimeout });

        report.steps.push({ locale: await applyChineseLocale(session) });
        report.steps.push({ modals: await handleBlockingModals(session) });
        report.steps.push({ plugin: await ensurePluginEnabled(session) });
        const loaded = await session.waitFor(`!!(app.plugins && app.plugins.plugins && app.plugins.plugins['${PLUGIN_ID}'])`, {
            timeoutMs: Math.min(readyTimeout, 90000),
            label: 'baizer plugin instantiation',
        });
        report.steps.push({ pluginLoaded: !!loaded });

        await session.send('Emulation.setDeviceMetricsOverride', {
            width: viewportWidth,
            height: viewportHeight,
            deviceScaleFactor: 1,
            mobile: false,
        }, { timeoutMs: 30000 });
        await delay(500);

        report.steps.push({ openView: await openShellView(session, viewWidth + 24) });
        await session.waitFor(`!!document.querySelector('.baizer-shell-view .shell-output-area')`, {
            timeoutMs: 60000,
            label: 'shell output area',
        });
        await delay(800);
        report.steps.push({ fitViewWidth: await fitViewWidth(session, viewWidth) });
        await delay(300);

        report.steps.push({ seed: await session.evaluate(SEED_SCRIPT(seedCount)) });
        report.steps.push({ scrollUp: await session.evaluate(SCROLL_UP_SCRIPT) });

        const beforeStream = await session.evaluate(MEASURE_SCRIPT);
        report.beforeStream = beforeStream;

        for (let i = 0; i < streamChunks; i++) {
            await session.evaluate(STREAM_CHUNK_SCRIPT(i));
            await delay(260);
        }
        await delay(700);

        const afterStream = await session.evaluate(MEASURE_SCRIPT);
        report.afterStream = afterStream;

        const targetTop = Number(report.steps.find((s) => s.scrollUp)?.scrollUp.anchor ?? 0);
        report.assertions = {
            viewportStayedAtReadingAnchor: Math.abs(afterStream.scrollTop - targetTop) <= 2,
            unreadEntryVisible: afterStream.unreadBar.visible === true,
            unreadEntryText: afterStream.unreadBar.text,
            unreadEntryWithinViewport: afterStream.unreadBar.withinViewport !== false,
            noHorizontalOverflow: afterStream.horizontalOverflow === false && afterStream.documentOverflow === false,
            viewWidthMatchesRequested: Math.abs((afterStream.viewRect?.width ?? 0) - viewWidth) <= 2,
        };

        if (values.phase === 'before') {
            report.limitations.push(
                'baseline phase has no scroll-follow controller or return entry, so follow/unread fields are null and the entry is absent by design',
            );
        }
        if (!report.assertions.viewportStayedAtReadingAnchor) {
            report.limitations.push('the viewport did not stay at the requested reading anchor; see scrollTop fields');
        }

        const clip = {
            x: afterStream.outputRect.x - (afterStream.viewRect.x - afterStream.outputRect.x),
            y: afterStream.viewRect.y,
            width: Math.min(viewWidth, afterStream.viewRect.width),
            height: Math.min(sidebarHeight, afterStream.viewRect.height || sidebarHeight),
        };
        // Include the header and the return entry: clip the whole shell view.
        const shot = await screenshot(session, outPath, {
            x: afterStream.viewRect.x,
            y: afterStream.viewRect.y,
            width: afterStream.viewRect.width,
            height: afterStream.viewRect.height,
        });
        report.screenshot = { path: outPath, ...shot, clip };
        void clip;

        await fsp.mkdir(path.dirname(layoutPath), { recursive: true });
        await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(JSON.stringify({
            out: outPath,
            layout: layoutPath,
            assertions: report.assertions,
            scroll: {
                before: { scrollTop: beforeStream.scrollTop, distance: beforeStream.distanceFromBottom },
                after: { scrollTop: afterStream.scrollTop, distance: afterStream.distanceFromBottom },
            },
            unreadBar: afterStream.unreadBar,
            screenshot: report.screenshot,
        }, null, 2));
    } finally {
        if (session) session.close();
        if (child && !values['keep-open']) {
            await killTree(child.pid);
            await delay(1500);
        }

    }
}

main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
});
