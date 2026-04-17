// src/skills/builtin/plugin-ctrl/plugin-watcher.ts
import { App, Notice, TFile } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';
import { SkillRegistry } from '../../skill-registry';
import { SkillLoader } from '../../skill-loader';
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

  hasSkillFile(pluginId: string): boolean {
    const path = this.generator.skillFilePath(pluginId);
    // getAbstractFileByPath 对 .obsidian 目录可能不可靠，双重检查
    if (this.app.vault.getAbstractFileByPath(path)) return true;
    // 回退：检查目录是否存在（目录存在说明之前生成过）
    const dirPath = this.generator.skillDirPath(pluginId);
    return !!this.app.vault.getAbstractFileByPath(dirPath);
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

    const toGenerate = pluginIds.filter(id => !this.hasSkillFile(id));
    if (toGenerate.length === 0) {
      console.log('[PluginWatcher] All plugins have skills');
      return;
    }

    const candidates: string[] = [];
    for (const id of toGenerate) {
      const info = this.generator.collectPluginInfo(id);
      if (!this.generator.shouldSkipPlugin(info)) {
        candidates.push(id);
      }
    }

    if (candidates.length === 0) return;

    console.log(`[PluginWatcher] Generating skills for ${candidates.length} plugins`);
    new Notice(`🔌 正在为 ${candidates.length} 个插件生成 Skill...`);

    for (let i = 0; i < candidates.length; i++) {
      await this.generateAndRegister(candidates[i]);
      if (i < candidates.length - 1) {
        await this.delay(GENERATE_DELAY_MS);
      }
    }

    new Notice(`✅ 插件 Skill 生成完成（${candidates.length} 个）`);
  }

  private async checkChanges(): Promise<void> {
    if (!this.settings.autoGeneratePluginSkills) return;

    const currentIds = new Set(this.getEnabledPluginIds());
    const { added, removed } = this.diffPlugins(this.snapshot, currentIds);

    for (const id of added) {
      if (this.hasSkillFile(id)) {
        await this.loadAndRegister(id);
      } else {
        const info = this.generator.collectPluginInfo(id);
        if (!this.generator.shouldSkipPlugin(info)) {
          new Notice(`🔌 正在为 ${info.name} 生成 Skill...`);
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
      const info = this.generator.collectPluginInfo(pluginId);
      const content = await this.generator.generateSkillMd(info);
      await this.generator.writeSkillFile(pluginId, content);
      await this.loadAndRegister(pluginId);
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

  private async loadAndRegister(pluginId: string): Promise<void> {
    const filePath = this.generator.skillFilePath(pluginId);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const loader = new SkillLoader(
      this.app,
      this.skillRegistry.getToolRegistry(),
    );
    const skill = loader.parseSkillMd(content);
    if (skill) {
      this.skillRegistry.registerUser(skill);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
