// src/skills/builtin/plugin-ctrl/plugin-watcher.ts
import { App, Notice } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';
import {
  pluginSkillDirPath,
  pluginSkillFileExists,
  pluginSkillSkipMarkerPath,
  pluginSkillGeneratedFromPath,
  ensureDirectory,
  readTextIfExists,
} from '../../skill-files';
import { SkillRegistry } from '../../skill-registry';
import { PluginSkillGenerator } from './skill-generator';
import { logger } from '../../../utils/logger';

const POLL_INTERVAL_MS = 10_000;
const GENERATE_DELAY_MS = 1_000;
const MAX_RETRIES = 3;

interface GeneratedFromRecord {
  pluginVersion: string;
  generatedAt: string;
}

export class PluginWatcher {
  private snapshot: Set<string> = new Set();
  private intervalId: number | null = null;
  private failedAttempts = new Map<string, number>();
  private generatedFilesInFlight = new Set<string>();
  /** 单飞：checkChanges 重入防护，避免 10s 轮询与慢生成叠加。 */
  private scanning = false;

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

  private async readGeneratedFromVersion(pluginId: string): Promise<string | null> {
    const record = await readTextIfExists(
      this.app.vault.adapter,
      pluginSkillGeneratedFromPath(pluginId),
    );
    if (record === null) return null;
    try {
      const parsed = JSON.parse(record) as GeneratedFromRecord;
      return typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : null;
    } catch {
      return null;
    }
  }

  private async writeGeneratedFrom(pluginId: string, pluginVersion: string): Promise<void> {
    const dirPath = pluginSkillDirPath(pluginId);
    await ensureDirectory(this.app.vault.adapter, dirPath);
    const record: GeneratedFromRecord = {
      pluginVersion,
      generatedAt: new Date().toISOString(),
    };
    await this.app.vault.adapter.write(
      pluginSkillGeneratedFromPath(pluginId),
      JSON.stringify(record, null, 2),
    );
  }

  private async getGenerationCandidate(pluginId: string): Promise<string | null> {
    const version = await this.readPluginVersion(pluginId);

    // F2-2: 已有 skill 文件时仍比较插件版本——插件升级后 skill 不应永久陈旧。
    if (await this.hasSkillFile(pluginId)) {
      // 插件版本读不到（manifest 异常）时无法判断，保持现状避免反复重新生成。
      if (!version) return null;
      const generatedVersion = await this.readGeneratedFromVersion(pluginId);
      // No valid provenance marker means the file is user-authored.
      if (generatedVersion === null) return null;
      return generatedVersion === version ? null : pluginId;
    }

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
      logger.info('Disabled by settings', 'PluginWatcher');
      return;
    }
    logger.info('Starting...', 'PluginWatcher');
    await this.initialScan();
    this.intervalId = window.setInterval(() => {
      void this.checkChanges().catch((error: unknown) => {
        logger.error('Polling failed', error, 'PluginWatcher');
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Stopped', 'PluginWatcher');
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
      logger.info('All plugins have skills', 'PluginWatcher');
      return;
    }

    const candidates: string[] = [];
    for (const id of toGenerate) {
      candidates.push(id);
    }

    if (candidates.length === 0) return;

    logger.info(`Generating skills for ${candidates.length} plugins`, 'PluginWatcher');
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
    // F2-2: 单飞——生成 skill 是慢操作（LLM 调用），轮询重入会叠加请求。
    if (this.scanning) return;
    this.scanning = true;
    try {
      const currentIds = new Set(this.getEnabledPluginIds());
      const { added, removed } = this.diffPlugins(this.snapshot, currentIds);
      const candidates = new Set<string>();

      for (const id of added) {
        const candidate = await this.getGenerationCandidate(id);
        if (candidate) {
          candidates.add(candidate);
        } else if (await this.hasSkillFile(id)) {
          await this.loadAndRegister(id, false);
        }
      }

      // Plugin versions can change while the enabled-plugin ID set stays stable.
      for (const id of currentIds) {
        if (added.includes(id) || !await this.hasSkillFile(id)) continue;
        const candidate = await this.getGenerationCandidate(id);
        if (candidate) candidates.add(candidate);
      }

      for (const [id, attempts] of this.failedAttempts) {
        if (currentIds.has(id) && attempts < MAX_RETRIES) candidates.add(id);
      }

      for (const id of candidates) {
        new Notice(`Generating skill for ${id}...`);
        await this.generateAndRegister(id);
      }

      for (const id of removed) {
        const skillName = `plugin-${id}`;
        this.skillRegistry.unregisterSkill(skillName);
        this.failedAttempts.delete(id);
        this.generatedFilesInFlight.delete(id);
        logger.info(`Unregistered skill: ${skillName}`, 'PluginWatcher');
      }

      this.snapshot = currentIds;
    } finally {
      this.scanning = false;
    }
  }

  private async generateAndRegister(pluginId: string): Promise<void> {
    const attempts = this.failedAttempts.get(pluginId) || 0;
    if (attempts >= MAX_RETRIES) {
      logger.warn(`Giving up on generating skill for ${pluginId} after ${MAX_RETRIES} attempts`, 'PluginWatcher');
      return;
    }

    try {
      const info = await this.generator.collectPluginInfo(pluginId);
      const content = await this.generator.generateSkillMd(info);
      const generatedVersion = await this.readGeneratedFromVersion(pluginId);
      const replaceExisting = await this.hasSkillFile(pluginId)
        && (generatedVersion !== null || this.generatedFilesInFlight.has(pluginId));
      await this.generator.writeSkillFile(pluginId, content, { overwrite: replaceExisting });
      this.generatedFilesInFlight.add(pluginId);

      const registered = await this.loadAndRegister(pluginId, replaceExisting);
      if (!registered) {
        throw new Error(`Generated skill file could not be loaded: ${this.generator.skillFilePath(pluginId)}`);
      }
      await this.writeGeneratedFrom(pluginId, info.version || '');

      this.failedAttempts.delete(pluginId);
      this.generatedFilesInFlight.delete(pluginId);
      logger.info(`Generated skill for: ${pluginId}`, 'PluginWatcher');
    } catch (e: any) {
      this.failedAttempts.set(pluginId, attempts + 1);
      console.error(
        `[PluginWatcher] Failed to generate skill for ${pluginId} `
        + `(attempt ${attempts + 1}/${MAX_RETRIES}):`, e.message,
      );
    }
  }

  private async loadAndRegister(pluginId: string, replaceExisting: boolean): Promise<boolean> {
    const filePath = this.generator.skillFilePath(pluginId);
    const content = await readTextIfExists(this.app.vault.adapter, filePath);
    if (content === null) return false;

    // Stage 3：统一走 registry 的 parseBuiltinSkill 解析器（保留 tools/triggers sidecar），
    // 不再实例化 SkillLoader。
    return replaceExisting
      ? this.skillRegistry.replaceUserFromMd(content, filePath)
      : this.skillRegistry.registerUserFromMd(content, filePath);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
