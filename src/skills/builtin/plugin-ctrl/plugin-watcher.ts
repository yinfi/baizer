// src/skills/builtin/plugin-ctrl/plugin-watcher.ts
import { App, Notice } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';
import {
  pluginSkillDirPath,
  pluginSkillFileExists,
  pluginSkillSkipMarkerPath,
  ensureDirectory,
  readTextIfExists,
} from '../../skill-files';
import { SkillLoader } from '../../skill-loader';
import { SkillRegistry } from '../../skill-registry';
import { PluginSkillGenerator } from './skill-generator';

const POLL_INTERVAL_MS = 10_000;
const GENERATE_DELAY_MS = 1_000;
const MAX_RETRIES = 3;

export class PluginWatcher {
  private snapshot: Set<string> = new Set();
  private intervalId: number | null = null;
  private failedRetries = new Map<string, number>();

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private generator: PluginSkillGenerator,
    private settings: PluginSettings,
  ) {}

  getEnabledPluginIds(): string[] {
    const enabled = (this.app as any).plugins.enabledPlugins as Set<string>;
    return [...enabled].filter(id =>
      id !== PLUGIN_ID
      && !this.settings.pluginSkillExcludeList.includes(id)
    );
  }

  diffPlugins(
    oldSet: Set<string>, newSet: Set<string>,
  ): { added: string[]; removed: string[] } {
    const added = [...newSet].filter(id => !oldSet.has(id));
    const removed = [...oldSet].filter(id => !newSet.has(id));
    return { added, removed };
  }

  async hasSkillFile(pluginId: string): Promise<boolean> {
    return pluginSkillFileExists(this.app.vault.adapter, pluginId);
  }

  private async readPluginVersion(pluginId: string): Promise<string> {
    const path = `.obsidian/plugins/${pluginId}/manifest.json`;
    try {
      const raw = await this.app.vault.adapter.read(path);
      const manifest = JSON.parse(raw);
      return manifest.version || '';
    } catch {
      const fallback = (this.app as any).plugins?.manifests?.[pluginId];
      return fallback?.version || '';
    }
  }

  private async readSkipMarkerVersion(pluginId: string): Promise<string> {
    const marker = await readTextIfExists(
      this.app.vault.adapter,
      pluginSkillSkipMarkerPath(pluginId),
    );
    if (marker === null) return '';
    try {
      const parsed = JSON.parse(marker);
      return parsed.version || '';
    } catch {
      return '';
    }
  }

  private async writeSkipMarker(pluginId: string, version: string): Promise<void> {
    const dirPath = pluginSkillDirPath(pluginId);
    await ensureDirectory(this.app.vault.adapter, dirPath);
    await this.app.vault.adapter.write(
      pluginSkillSkipMarkerPath(pluginId),
      JSON.stringify({ version, skippedAt: new Date().toISOString() }, null, 2),
    );
  }

  private async getGenerationCandidate(pluginId: string): Promise<string | null> {
    if (await this.hasSkillFile(pluginId)) return null;

    const version = await this.readPluginVersion(pluginId);
    const cachedVersion = await this.readSkipMarkerVersion(pluginId);
    if (version && cachedVersion && cachedVersion === version) {
      return null;
    }

    const info = await this.generator.collectBasicPluginInfo(pluginId);
    if (this.generator.shouldSkipPlugin(info)) {
      await this.writeSkipMarker(pluginId, info.version || version);
      return null;
    }

    return pluginId;
  }

  async start(): Promise<void> {
    if (!this.settings.autoGeneratePluginSkills) {
      console.log('[PluginWatcher] Disabled by settings');
      return;
    }
    console.log('[PluginWatcher] Starting...');
    await this.initialScan();
    this.intervalId = window.setInterval(
      () => this.checkChanges(),
      POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[PluginWatcher] Stopped');
  }

  private async initialScan(): Promise<void> {
    const pluginIds = this.getEnabledPluginIds();
    this.snapshot = new Set(pluginIds);

    const toGenerate: string[] = [];
    for (const id of pluginIds) {
      const candidate = await this.getGenerationCandidate(id);
      if (candidate) {
        toGenerate.push(id);
      }
    }

    if (toGenerate.length === 0) {
      console.log('[PluginWatcher] All plugins have skills');
      return;
    }

    const candidates: string[] = [];
    for (const id of toGenerate) {
      candidates.push(id);
    }

    if (candidates.length === 0) return;

    console.log(`[PluginWatcher] Generating skills for ${candidates.length} plugins`);
    new Notice(`Generating skills for ${candidates.length} plugins...`);

    for (let i = 0; i < candidates.length; i++) {
      await this.generateAndRegister(candidates[i]);
      if (i < candidates.length - 1) {
        await this.delay(GENERATE_DELAY_MS);
      }
    }

    new Notice(`Plugin skill generation finished (${candidates.length})`);
  }

  private async checkChanges(): Promise<void> {
    if (!this.settings.autoGeneratePluginSkills) return;

    const currentIds = new Set(this.getEnabledPluginIds());
    const { added, removed } = this.diffPlugins(this.snapshot, currentIds);

    for (const id of added) {
      if (await this.hasSkillFile(id)) {
        await this.loadAndRegister(id);
      } else {
        const candidate = await this.getGenerationCandidate(id);
        if (candidate) {
          new Notice(`Generating skill for ${id}...`);
          await this.generateAndRegister(id);
        }
      }
    }

    for (const id of removed) {
      const skillName = `plugin-${id}`;
      this.skillRegistry.unregisterSkill(skillName);
      console.log(`[PluginWatcher] Unregistered skill: ${skillName}`);
    }

    this.snapshot = currentIds;
  }

  private async generateAndRegister(pluginId: string): Promise<void> {
    const retries = this.failedRetries.get(pluginId) || 0;
    if (retries >= MAX_RETRIES) return;

    try {
      const info = await this.generator.collectPluginInfo(pluginId);
      const content = await this.generator.generateSkillMd(info);
      await this.generator.writeSkillFile(pluginId, content);

      const registered = await this.loadAndRegister(pluginId);
      if (!registered) {
        throw new Error(`Generated skill file could not be loaded: ${this.generator.skillFilePath(pluginId)}`);
      }

      this.failedRetries.delete(pluginId);
      console.log(`[PluginWatcher] Generated skill for: ${pluginId}`);
    } catch (e: any) {
      this.failedRetries.set(pluginId, retries + 1);
      console.error(
        `[PluginWatcher] Failed to generate skill for ${pluginId} `
        + `(attempt ${retries + 1}/${MAX_RETRIES}):`, e.message,
      );
    }
  }

  private async loadAndRegister(pluginId: string): Promise<boolean> {
    const filePath = this.generator.skillFilePath(pluginId);
    const content = await readTextIfExists(this.app.vault.adapter, filePath);
    if (content === null) return false;

    const loader = new SkillLoader(
      this.app,
      this.skillRegistry.getToolRegistry(),
    );
    const skill = loader.parseSkillMd(content);
    if (!skill) return false;

    this.skillRegistry.registerUser(skill);
    return true;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
