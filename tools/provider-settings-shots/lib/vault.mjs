/**
 * Throwaway Obsidian vault management for the provider-settings capture harness.
 *
 * The harness never touches the developer's own Obsidian configuration beyond
 * the single curated exception of the global vault registry
 * (`%APPDATA%\obsidian\obsidian.json`), which Obsidian requires in order to
 * open a vault at launch. That file is backed up once, next to the original,
 * before it is rewritten.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PLUGIN_ID = 'baizer';

export function defaultVaultDir() {
  // The vault *name* is the directory name, and Obsidian puts it in the window
  // title ("<view> - <vault> - Obsidian <version>"). Naming it `obsidian` keeps
  // the title identical to the committed baseline's.
  return path.join(os.tmpdir(), 'baizer-shots', 'obsidian');
}

/** Obsidian's global config file (shared by every vault on the machine). */
export function globalConfigPath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('%APPDATA% is not set, so the Obsidian global config cannot be located');
  return path.join(appData, 'obsidian', 'obsidian.json');
}

/** Stable 16-hex-char vault id derived from the vault path (re-runnable). */
export function vaultIdFor(vaultDir) {
  return crypto.createHash('sha1').update(path.resolve(vaultDir).toLowerCase()).digest('hex').slice(0, 16);
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * (Re)create the vault on disk: plugin files, restricted mode off, dark theme
 * and the provider fixture as the plugin's `data.json`.
 */
export async function materialiseVault({ vaultDir, pluginDir, scenario, theme = 'dark' }) {
  const resolvedVault = path.resolve(vaultDir);
  const obsidianDir = path.join(resolvedVault, '.obsidian');
  const pluginTarget = path.join(obsidianDir, 'plugins', PLUGIN_ID);

  await fsp.rm(pluginTarget, { recursive: true, force: true });
  await fsp.mkdir(pluginTarget, { recursive: true });

  const copied = [];
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    const source = path.join(pluginDir, file);
    if (!fs.existsSync(source)) {
      throw new Error(`plugin build dir ${pluginDir} is missing ${file}`);
    }
    await fsp.copyFile(source, path.join(pluginTarget, file));
    copied.push({ file, bytes: (await fsp.stat(source)).size });
  }

  const manifest = JSON.parse(await fsp.readFile(path.join(pluginTarget, 'manifest.json'), 'utf8'));

  // Enabling a community plugin: list it and make sure restricted ("safe") mode
  // is off. Obsidian also exposes app.plugins.setEnable()/enablePlugin() at
  // runtime, which the capture script falls back to if this is not honoured.
  await writeJson(path.join(obsidianDir, 'community-plugins.json'), [PLUGIN_ID]);
  await writeJson(path.join(obsidianDir, 'app.json'), {
    restrictedMode: false,
    alwaysUpdateLinks: true,
    promptDelete: false,
    showLineNumber: false,
    // Which window the settings modal renders in is decided by
    // `Setting#shouldUsePopout()`, i.e. exactly this vault config key. Obsidian
    // 1.14.5/1.15.0 default it to **true**, so by default settings open in their
    // own popout window — which is the presentation the committed baseline
    // `docs/assets/provider-settings-obsidian-2026-11-03.png` shows (its title
    // reads "设置 - obsidian - Obsidian 1.14.5", the popout's own title, and its
    // settings nav starts at x≈31, i.e. the settings fill the whole window).
    //
    // Written explicitly rather than left to the default so a capture cannot
    // silently change presentation if Obsidian flips that default.
    //
    // Note for whoever drives this: the popout is a *separate* CDP page target
    // served from `about:blank`, with no `app` global. `capture.mjs` therefore
    // locates the window that actually holds `.baizer-settings-provider-card`
    // and drives that one, whichever it is.
    settingsPopoutWindow: true,
  });

  await writeJson(path.join(obsidianDir, 'appearance.json'), {
    theme: theme === 'dark' ? 'obsidian' : 'moonstone',
    cssTheme: '',
    enabledCssSnippets: [],
    baseFontSize: 16,
    interfaceFontFamily: '',
    textFontFamily: '',
    monospaceFontFamily: '',
  });

  await writeJson(path.join(obsidianDir, 'hotkeys.json'), {});
  // Note: core-plugins.json is deliberately NOT written so the vault keeps
  // Obsidian's default core-plugin set — that is part of what the committed
  // baseline screenshot shows in the settings nav.

  if (scenario) await writeJson(path.join(pluginTarget, 'data.json'), scenario);

  return { vaultDir: resolvedVault, pluginTarget, manifest, copied };
}

/**
 * Register the vault in Obsidian's global config and mark it as the one to
 * open. Backs the original file up once so the change is reversible.
 */
export async function registerVaultGlobally(vaultDir) {
  const configPath = globalConfigPath();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });

  const backupPath = `${configPath}.dsh-backup`;
  let original = null;
  if (fs.existsSync(configPath)) {
    original = await fsp.readFile(configPath, 'utf8');
    if (!fs.existsSync(backupPath)) await fsp.writeFile(backupPath, original, 'utf8');
  }

  let config = {};
  if (original) {
    try {
      config = JSON.parse(original);
    } catch {
      config = {};
    }
  }
  if (!config || typeof config !== 'object') config = {};
  if (!config.vaults || typeof config.vaults !== 'object') config.vaults = {};

  // Only the harness vault may open at launch, otherwise Obsidian may restore
  // an unrelated vault (or show the vault picker) instead.
  for (const entry of Object.values(config.vaults)) {
    if (entry && typeof entry === 'object') entry.open = false;
  }

  const key = vaultIdFor(vaultDir);
  config.vaults[key] = { path: path.resolve(vaultDir), ts: Date.now(), open: true };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { configPath, backupPath, vaultKey: key, hadExistingConfig: original !== null };
}

/** Restore the global config from the one-time backup (manual recovery aid). */
export async function restoreGlobalConfig() {
  const configPath = globalConfigPath();
  const backupPath = `${configPath}.dsh-backup`;
  if (!fs.existsSync(backupPath)) return { restored: false, reason: `no backup at ${backupPath}` };
  await fsp.copyFile(backupPath, configPath);
  return { restored: true, configPath, backupPath };
}
