#!/usr/bin/env node
/**
 * Before/after capture for the "no !important / no :has()" styles.css cleanup (#93).
 *
 * Obsidian is not required: the script renders the real `styles.css` (any revision,
 * passed with --css) in headless Chrome against a small mock of Obsidian's own base
 * styles (theme variables, workspace-leaf/view-content, .modal, textarea:focus, CM6
 * rules). It writes one PNG per scenario/theme and a metrics JSON of computed styles
 * taken from the same DOM, so the two revisions can be diffed numerically.
 *
 *   node tools/css-important-shots/capture.mjs --css styles.css --label after --out out/
 *
 * The mock is an approximation of Obsidian, not Obsidian itself.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { CDPSession, waitForDevTools, listTargets } from '../provider-settings-shots/lib/cdp.mjs';

const { values: args } = parseArgs({
  options: {
    css: { type: 'string' },
    label: { type: 'string' },
    out: { type: 'string' },
    chrome: { type: 'string' },
    port: { type: 'string', default: '9333' },
  },
});
if (!args.css || !args.label || !args.out) {
  console.error('usage: capture.mjs --css <styles.css> --label <before|after> --out <dir> [--chrome <exe>]');
  process.exit(2);
}

const CHROME = [args.chrome, process.env.CHROME_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('No Chrome/Edge found; pass --chrome or set CHROME_EXE');

const pluginCss = fs.readFileSync(args.css, 'utf8');

const THEMES = {
  light: `--background-primary:#fff;--background-secondary:#f5f6f8;--background-modifier-border:#dcdde0;--background-modifier-border-hover:#c8c9cc;--background-modifier-hover:rgba(0,0,0,.06);--background-modifier-border-focus:#7b6cd9;--text-normal:#222;--text-muted:#5c5c5c;--text-faint:#999;--text-error:#c0392b;--text-on-accent:#fff;--interactive-accent:#7b6cd9;--color-green:#2a9d4a;--color-yellow:#d9a400;`,
  dark: `--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#3a3a3a;--background-modifier-border-hover:#4a4a4a;--background-modifier-hover:rgba(255,255,255,.08);--background-modifier-border-focus:#8a7cf0;--text-normal:#dadada;--text-muted:#a3a3a3;--text-faint:#707070;--text-error:#fb464c;--text-on-accent:#fff;--interactive-accent:#8a7cf0;--color-green:#44cf6e;--color-yellow:#e0ac00;`,
};

/** Approximation of the Obsidian rules the plugin CSS has to coexist with. */
const OBSIDIAN_MOCK = `
  :root{--font-interface:system-ui,sans-serif;--font-monospace:Consolas,monospace;--font-ui-small:13px;--font-smaller:12px;--font-smallest:11px;
    --size-2-1:2px;--size-4-1:4px;--size-4-2:8px;--size-4-4:16px;--radius-s:4px;--radius-m:8px;--line-height-normal:1.5;--line-height-tight:1.3;
    --shadow-s:0 1px 3px rgba(0,0,0,.2);--font-text-size:16px;}
  body{margin:0;background:var(--background-primary);color:var(--text-normal);font-family:var(--font-interface);font-size:14px}
  .workspace-leaf-content{display:block;height:100%;overflow:hidden}
  .workspace-leaf-content .view-content{display:block;padding:0;height:100%;overflow:auto}
  .modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:10px;padding:20px;width:var(--dialog-width,700px);max-width:var(--dialog-max-width,80vw);max-height:var(--dialog-max-height,85vh);position:relative}
  .modal-content{width:auto;height:auto}
  button{font:inherit}
  textarea{font:inherit;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border)}
  textarea:hover,textarea:focus,textarea:active{box-shadow:0 0 0 2px var(--background-modifier-border-focus)}
  .cm-editor{font-family:var(--font-monospace);font-size:14px}
  .cm-editor .cm-content{color:var(--text-normal);caret-color:var(--text-normal)}
  .cm-editor .cm-line span{color:var(--text-normal)}
  .cm-editor .cm-gutterElement{background:#8884}
  .cm-editor .cm-activeLineGutter{background:#8886}
`;

function page(css, theme, body, extraClass = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${THEMES[theme]}}${OBSIDIAN_MOCK}</style><style>${css}</style></head>
  <body class="theme-${theme} ${extraClass}">${body}</body></html>`;
}

/* Real class names, mirroring the DOM built by ShellView.onOpen / DiffModal.onOpen / ghost-text.ts. */
const SHELL = `
<div class="workspace-leaf-content" data-type="baizer-shell-view" style="width:420px;height:640px;border:1px solid var(--background-modifier-border)">
 <div class="view-content"><div class="baizer-shell-view">
  <div class="shell-header"><div class="shell-header-title"><div class="shell-header-identity"><div class="shell-brand-mark">BZ</div><div class="shell-header-copy"><h1 class="shell-title">Baizer</h1></div></div></div>
   <div class="baizer-history-menu baizer-hidden" id="hist">history</div></div>
  <div class="shell-output-area">
    <div class="shell-tab-messages" id="tabA"><div class="shell-entry ai">Visible conversation tab.</div></div>
    <div class="shell-tab-messages baizer-hidden" id="tabB"><div class="shell-entry ai">HIDDEN conversation tab.</div></div>
    <div class="shell-think-timeline baizer-hidden" id="tl">hidden timeline</div>
  </div>
  <div class="shell-unread-bar baizer-hidden" id="unreadHidden">hidden unread bar</div>
  <div class="shell-unread-bar" id="unreadShown">shown unread bar</div>
  <div class="shell-input-container"><div class="shell-suggestions baizer-hidden" id="sug">hidden suggestions</div>
   <div class="shell-input-wrapper"><textarea class="shell-input" id="ta" rows="1" placeholder="Ask AI..."></textarea></div>
   <div class="shell-input-controls"></div></div>
 </div></div></div>`;

const DIFF = `
<div style="display:flex;justify-content:center;padding-top:16px">
 <div class="modal baizer-diff-modal-window" id="modal"><div class="modal-content baizer-diff-modal" id="mc">
  <div class="baizer-diff-modal-header"><h2>Review Changes</h2></div>
  <div class="baizer-diff-panes">
   <div class="baizer-diff-pane baizer-diff-pane-old"><div class="baizer-diff-pane-title">Current</div><pre class="baizer-diff-pane-code" id="pc">alpha\nbeta\ngamma</pre></div>
   <div class="baizer-diff-pane baizer-diff-pane-new"><div class="baizer-diff-pane-title">Proposed</div><pre class="baizer-diff-pane-code">alpha\nbeta2\ngamma\ndelta</pre></div>
  </div></div></div></div>`;

const EDITOR = `
<div class="cm-editor" style="width:520px;margin:20px"><div class="cm-scroller" style="display:flex">
 <div class="cm-gutters"><div class="cm-gutter guardian-gutter"><div class="cm-gutterElement cm-activeLineGutter" id="ag">
   <div class="guardian-gutter-marker guardian-idle"></div></div><div class="cm-gutterElement" id="g">&nbsp;</div></div></div>
 <div class="cm-content"><div class="cm-line">Some note text <span>and a span </span><span class="cm-line-span"><span class="guardian-ghost-text" id="gh">suggested completion</span></span></div></div></div></div>`;

async function launch() {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'css-shots-'));
  const proc = spawn(CHROME, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profile}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  await waitForDevTools(Number(args.port), { timeoutMs: 30000 });
  const target = (await listTargets(Number(args.port))).find((t) => t.type === 'page');
  const cdp = await CDPSession.connect(target.webSocketDebuggerUrl);
  return { proc, cdp, profile };
}

const metrics = {};
const outDir = path.resolve(args.out);
await fsp.mkdir(outDir, { recursive: true });
const { proc, cdp, profile } = await launch();

async function render(name, html, { width, height, reducedMotion = false, probe }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
  const file = path.join(profile, `${name}.html`);
  await fsp.writeFile(file, html);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
  await delay(400);
  if (probe?.pre) await cdp.evaluate(probe.pre);
  await delay(150);
  const data = probe ? await cdp.evaluate(probe.expr) : null;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fsp.writeFile(path.join(outDir, `${args.label}-${name}.png`), Buffer.from(shot.data, 'base64'));
  if (data) metrics[name] = data;
}

const cs = (sel, props) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const s=getComputedStyle(e);return Object.fromEntries(${JSON.stringify(props)}.map(p=>[p,s.getPropertyValue(p)]))})()`;
const rect = (sel) => `(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}})()`;

try {
  for (const theme of ['light', 'dark']) {
    await render(`shell-${theme}`, page(pluginCss, theme, SHELL), {
      width: 460, height: 680,
      probe: {
        pre: `document.getElementById('ta').focus()`,
        expr: `({
          leaf:${cs('.workspace-leaf-content', ['display', 'flex-direction'])},
          viewContent:${cs('.view-content', ['display', 'flex-direction', 'flex-grow'])},
          shellView:${cs('.baizer-shell-view', ['display', 'flex-direction', 'height', 'width'])},
          shellViewRect:${rect('.baizer-shell-view')},
          historyMenu:${cs('#hist', ['display'])}, tabHidden:${cs('#tabB', ['display'])}, tabVisible:${cs('#tabA', ['display'])},
          timeline:${cs('#tl', ['display'])}, suggestions:${cs('#sug', ['display'])},
          unreadHidden:${cs('#unreadHidden', ['display'])}, unreadShown:${cs('#unreadShown', ['display'])},
          textareaFocusShadow:${cs('#ta', ['box-shadow'])}
        })`,
      },
    });
    for (const [tag, w] of [['wide', 1000], ['narrow', 480]]) {
      await render(`diff-${tag}-${theme}`, page(pluginCss, theme, DIFF), {
        width: w, height: 520,
        probe: { expr: `({ modal:${rect('#modal')}, modalCss:${cs('#modal', ['width', 'max-width'])}, content:${cs('#mc', ['width', 'height'])}, contentRect:${rect('#mc')}, paneCode:${cs('#pc', ['min-height', 'max-height'])} })` },
      });
    }
    await render(`editor-${theme}`, page(pluginCss, theme, EDITOR), {
      width: 600, height: 120,
      probe: { expr: `({ ghost:${cs('#gh', ['color', 'background-color', 'font-style'])}, activeGutter:${cs('#ag', ['background-color'])}, gutter:${cs('#g', ['background-color'])} })` },
    });
  }
  // prefers-reduced-motion: computed animation/transition/scroll values, same DOM as the shell scenario.
  const RM = SHELL.replace('<div class="shell-input-controls"></div>',
    '<div class="shell-input-controls"></div><button class="shell-run-btn" id="btn">send</button><span class="shell-stream-cursor" id="cur"></span><div class="shell-knowledge-status-strip is-processing" id="ks">processing</div>');
  for (const rm of [false, true]) {
    await render(`motion-${rm ? 'reduce' : 'normal'}`, page(pluginCss, 'light', RM), {
      width: 460, height: 680, reducedMotion: rm,
      probe: { expr: `({ cursor:${cs('#cur', ['animation-name', 'animation-duration'])}, strip:${cs('#ks', ['animation-name', 'animation-duration'])}, output:${cs('.shell-output-area', ['scroll-behavior'])}, shellVars:${cs('.baizer-shell-view', ['--baizer-transition-fast', '--baizer-transition-base'])}, applyBtnTransition:${cs('.shell-input-top-action', ['transition-duration'])} })` },
    });
  }
  await fsp.writeFile(path.join(outDir, `${args.label}.metrics.json`), JSON.stringify(metrics, null, 2));
  console.log(`wrote ${Object.keys(metrics).length} metric groups and screenshots to ${outDir}`);
} finally {
  cdp.close();
  proc.kill();
  await delay(300);
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}
