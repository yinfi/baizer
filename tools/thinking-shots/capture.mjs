#!/usr/bin/env node
/**
 * Capture the Baizer **thinking timeline** out of a real, running Obsidian.
 *
 * This is not a mock-up generator. Obsidian is launched with
 * `--remote-debugging-port`, the shell view is driven over CDP, and the PNG
 * comes from `Page.captureScreenshot`. A sibling `*.layout.json` records the
 * facts a bitmap cannot be asserted against: which segment is live, whether the
 * streaming cursor / live summary dot are animating, how tall a collapsed
 * segment's body actually is, and whether the thinking text kept its line
 * breaks.
 *
 * Two scenarios, both driven through the real `StreamController`:
 * - `streaming` — two finished paragraphs plus one still-growing paragraph;
 * - `settled`   — the same turn finalised as completed (timeline folded).
 *
 * Usage (Windows host, Node >= 22):
 *   node tools/thinking-shots/capture.mjs \
 *     --plugin-dir dist --scenario streaming \
 *     --out docs/assets/thinking-2026-11-11-streaming-after.png \
 *     --label streaming-after --phase after --revision <sha> \
 *     --obsidian "C:\obs-1.14.5-installed\Obsidian\Obsidian.exe"
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { CDPSession, waitForDevTools, listTargets } from '../provider-settings-shots/lib/cdp.mjs';
import { materialiseVault, vaultIdFor, defaultVaultDir, PLUGIN_ID } from '../provider-settings-shots/lib/vault.mjs';

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
    return { trust, closed };
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

// ==================== the scenario ====================
//
// Three paragraphs, each fed as one `thinking` chunk through the real
// StreamController. The first two end on a blank line, so the renderer commits
// them as finished (collapsed) segments; the third has no trailing blank line,
// so it stays the live, expanding segment.

const THINKING_CHUNKS = [
    '先看清现状：这条时间线把思考正文原样铺出来，文字贴着描边，换行也被吞掉了。\n\n',
    '再定改法：正文补内边距与行高、保留模型输出的换行，活动段落用主题强调色挑出来。\n\n',
    '最后补动效：活动段落尾部挂闪烁光标，摘要行加呼吸圆点，段落展开/收起走高度过渡。',
];

const DRIVE_SCRIPT = `(() => {
  const view = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view;
  for (const content of ${JSON.stringify(THINKING_CHUNKS)}) {
    view.handleStreamEvent({ type: 'thinking', content });
  }
  return true;
})()`;

const SETTLE_SCRIPT = `(() => {
  const view = app.workspace.getLeavesOfType('${VIEW_TYPE}')[0].view;
  view.finalizeStream('completed');
  return true;
})()`;

const MEASURE_SCRIPT = `(() => {
  const viewEl = document.querySelector('.baizer-shell-view');
  const timeline = viewEl.querySelector('.shell-think-timeline');
  const summary = timeline ? timeline.querySelector('.shell-think-summary') : null;
  const summaryText = timeline ? timeline.querySelector('.think-summary-text') : null;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const px = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const pseudo = (el, which) => {
    if (!el) return null;
    const s = getComputedStyle(el, which);
    return {
      content: s.content,
      animationName: s.animationName,
      animationDuration: s.animationDuration,
      backgroundColor: s.backgroundColor,
      width: px(s.width),
      height: px(s.height),
    };
  };
  const blocks = timeline ? Array.from(timeline.querySelectorAll('.baizer-thinking-block')) : [];
  const segments = blocks.map((block, index) => {
    const header = block.querySelector('.baizer-thinking-header');
    const label = block.querySelector('.baizer-thinking-label');
    const timer = block.querySelector('.baizer-thinking-timer');
    const caret = block.querySelector('.baizer-thinking-caret');
    const content = block.querySelector('.baizer-thinking-content');
    const contentStyle = content ? getComputedStyle(content) : null;
    const headerStyle = header ? getComputedStyle(header) : null;
    return {
      index,
      isThinking: block.classList.contains('is-thinking'),
      isComplete: block.classList.contains('is-complete'),
      isCollapsed: block.classList.contains('is-collapsed'),
      label: label ? (label.textContent || '').trim() : null,
      timer: timer ? (timer.textContent || '').trim() : null,
      caretTransform: caret ? getComputedStyle(caret).transform : null,
      headerRect: rect(header),
      headerBorderColor: headerStyle ? headerStyle.borderTopColor : null,
      headerBackground: headerStyle ? headerStyle.backgroundColor : null,
      headerColor: headerStyle ? headerStyle.color : null,
      gridTemplateRows: getComputedStyle(block).gridTemplateRows,
      contentRect: rect(content),
      contentVisibility: contentStyle ? contentStyle.visibility : null,
      contentDisplay: contentStyle ? contentStyle.display : null,
      contentWhiteSpace: contentStyle ? contentStyle.whiteSpace : null,
      contentOverflowWrap: contentStyle ? contentStyle.overflowWrap : null,
      contentLineHeight: contentStyle ? px(contentStyle.lineHeight) : null,
      contentFontSize: contentStyle ? px(contentStyle.fontSize) : null,
      labelFontSize: label ? px(getComputedStyle(label).fontSize) : null,
      contentPaddingTop: contentStyle ? px(contentStyle.paddingTop) : null,
      contentPaddingLeft: contentStyle ? px(contentStyle.paddingLeft) : null,
      contentText: content ? (content.textContent || '').trim().slice(0, 40) : null,
      cursor: content ? pseudo(content, '::after') : null,
    };
  });
  const output = viewEl.querySelector('.shell-output-area');
  return {
    appVersion: (app.manifest && app.manifest.version) || null,
    pluginVersion: (() => { try { return app.plugins.plugins['${PLUGIN_ID}'].manifest.version; } catch (e) { return null; } })(),
    theme: document.body.classList.contains('theme-dark') ? 'dark' : 'light',
    timelinePresent: !!timeline,
    timelineIsThinkingActive: timeline ? timeline.classList.contains('is-thinking-active') : null,
    timelineIsCollapsed: timeline ? timeline.classList.contains('is-collapsed') : null,
    summaryText: summaryText ? (summaryText.textContent || '').trim() : null,
    summaryAriaExpanded: summary ? summary.getAttribute('aria-expanded') : null,
    summaryRect: rect(summary),
    summaryDot: pseudo(summary, '::before'),
    viewRect: rect(viewEl),
    timelineRect: rect(timeline),
    segments,
    horizontalOverflow: viewEl.scrollWidth > viewEl.clientWidth + 1,
    outputHorizontalOverflow: output ? output.scrollWidth > output.clientWidth + 1 : null,
  };
})()`;

function assertFrom(measure, scenario) {
    const live = measure.segments.filter((s) => s.isThinking);
    const settled = measure.segments.filter((s) => s.isCollapsed);
    const active = live[0] ?? null;
    const base = {
        segmentCount: measure.segments.length,
        liveSegments: live.length,
        collapsedSegments: settled.length,
        contentKeepsLineBreaks: measure.segments.every((s) => s.contentWhiteSpace === 'pre-wrap'),
        // 卡片内边距只对展开的段落有意义:折叠段落的内边距必须收成 0(见 collapsedBodiesAreZeroHeight)。
        expandedBodiesHavePadding: live.every((s) => (s.contentPaddingTop ?? 0) >= 6 && (s.contentPaddingLeft ?? 0) >= 6),
        collapsedBodiesAreZeroHeight: settled.every((s) => (s.contentRect?.height ?? 99) < 1),
        // 「不进无障碍树」是 display:none 与 visibility:hidden 共同的结论;
        // 这一条只断言结论,不绑定实现(改动前后恰好各用一种)。
        collapsedBodiesLeaveA11yTree: settled.every((s) => s.contentVisibility === 'hidden' || s.contentDisplay === 'none'),
        expandedBodiesAreVisible: live.every((s) => s.contentVisibility === 'visible' && (s.contentRect?.height ?? 0) > 0),
        collapsedCaretPointsRight: settled.every((s) => s.caretTransform === 'none' || s.caretTransform === 'matrix(1, 0, 0, 1, 0, 0)'),
        expandedCaretPointsDown: live.every((s) => s.caretTransform === 'matrix(0, 1, -1, 0, 0, 0)'),
        activeSegmentHasBlinkingCursor: active ? active.cursor?.animationName === 'cursor-blink' : null,
        activeHeaderAccentDiffersFromSettled: active && settled.length
            ? active.headerBorderColor !== settled[0].headerBorderColor
            : null,
        noHorizontalOverflow: measure.horizontalOverflow === false,
        noOutputHorizontalOverflow: measure.outputHorizontalOverflow === false,
    };
    if (scenario === 'streaming') {
        return {
            ...base,
            timelineMarkedLive: measure.timelineIsThinkingActive === true,
            summaryShowsLiveDot: measure.summaryDot?.animationName === 'think-pulse',
            timelineStillExpanded: measure.timelineIsCollapsed === false,
        };
    }
    return {
        ...base,
        timelineLiveMarkCleared: measure.timelineIsThinkingActive === false,
        summaryHasNoLiveDot: measure.summaryDot?.animationName === 'none',
        timelineFolded: measure.timelineIsCollapsed === true,
        summaryReadsAsSettled: /^Thought through \d+ steps$/.test(measure.summaryText || ''),
    };
}

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
            theme: { type: 'string', default: 'dark' },
            phase: { type: 'string', default: 'after' },
            scenario: { type: 'string', default: 'streaming' },
            revision: { type: 'string', default: '' },
            label: { type: 'string', default: 'thinking' },
            port: { type: 'string', default: '9343' },
            'ready-timeout': { type: 'string', default: '180000' },
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
    if (values.scenario !== 'streaming' && values.scenario !== 'settled') {
        throw new Error(`Unknown --scenario ${values.scenario}; expected streaming or settled`);
    }

    const scenario = values.scenario;
    const pluginDir = path.resolve(values['plugin-dir']);
    const outPath = path.resolve(values.out);
    const layoutPath = values['layout-out']
        ? path.resolve(values['layout-out'])
        : outPath.replace(/\.png$/i, '') + '.layout.json';
    const viewWidth = Number(values['view-width']);
    const viewportWidth = Number(values['viewport-width']);
    const viewportHeight = Number(values['viewport-height']);
    const port = Number(values.port);
    const readyTimeout = Number(values['ready-timeout']);
    const theme = values.theme;
    const exe = resolveObsidianExe(values.obsidian);
    const vaultDir = values.vault ? path.resolve(values.vault) : defaultVaultDir();
    const userDataDir = values['user-data-dir']
        ? path.resolve(values['user-data-dir'])
        : path.join(os.tmpdir(), 'baizer-shots', `thinking-${scenario}-profile`);

    const report = {
        label: values.label,
        phase: values.phase,
        revision: values.revision,
        capturedAt: new Date().toISOString(),
        out: outPath,
        scenario: { name: scenario, paragraphs: THINKING_CHUNKS.length, viewport: { width: viewportWidth, height: viewportHeight }, viewWidth, theme },
        host: { platform: process.platform, node: process.version, exe, exeFileVersion: readWindowsFileVersion(exe) },
        steps: [],
        limitations: [],
    };

    let child = null;
    let session = null;
    try {
        const vaultInfo = await materialiseVault({ vaultDir, pluginDir, scenario: null, theme });
        await cleanVaultState(vaultInfo.vaultDir);
        const profile = await prepareIsolatedProfile(userDataDir, vaultInfo.vaultDir);
        report.vault = { dir: vaultInfo.vaultDir, pluginManifest: vaultInfo.manifest, profile };

        child = launchObsidian(exe, port, userDataDir);
        report.pid = child.pid;
        await waitForDevTools(port, { timeoutMs: readyTimeout });
        const connected = await connectToMainPage(port, { timeoutMs: readyTimeout });
        session = connected.session;
        report.target = { id: connected.target.id, url: connected.target.url, title: connected.target.title };
        await waitForAppReady(session, { timeoutMs: readyTimeout });

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

        await session.evaluate(DRIVE_SCRIPT);
        await delay(900);
        if (scenario === 'settled') {
            await session.evaluate(SETTLE_SCRIPT);
            // 折叠过渡是 200ms;等它走完再量,免得把动画中间态当成终态。
            await delay(900);
        }

        const measure = await session.evaluate(MEASURE_SCRIPT);
        report.measure = measure;
        report.assertions = assertFrom(measure, scenario);

        const failed = Object.entries(report.assertions)
            .filter(([, value]) => value === false)
            .map(([key]) => key);
        if (failed.length > 0) {
            report.limitations.push(`failed assertions: ${failed.join(', ')}`);
        }

        const shot = await screenshot(session, outPath, {
            x: measure.viewRect.x,
            y: measure.viewRect.y,
            width: measure.viewRect.width,
            height: measure.viewRect.height,
        });
        report.screenshot = { path: outPath, ...shot };

        await fsp.mkdir(path.dirname(layoutPath), { recursive: true });
        await fsp.writeFile(layoutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(JSON.stringify({
            out: outPath,
            layout: layoutPath,
            scenario,
            assertions: report.assertions,
            summary: measure.summaryText,
            segments: measure.segments.map((s) => ({
                label: s.label,
                thinking: s.isThinking,
                collapsed: s.isCollapsed,
                bodyHeight: s.contentRect?.height ?? null,
                caret: s.caretTransform,
            })),
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
