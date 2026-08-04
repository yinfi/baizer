// src/skills/skill-registry.ts — Skill 注册表（B 方案：pi 原生激活机制）
//
// 职责：
// - 管理内置 / 用户 Skill，内部统一存 pi 原生 Skill + Baizer sidecar
// - 物化内置 Skill 到隐藏目录，使所有 skill 都是真实文件（read_skill 可读）
// - 发现：formatSkillsForSystemPrompt 生成系统提示清单（真实 location）
// - 激活：formatSkillInvocation 包装完整正文（斜杠命令 / 强制激活）
// - 路由：斜杠命令 / 关键词意图 → 匹配 Skill

import type { Skill as PiSkill } from '@earendil-works/pi-agent-core';
import {
  SkillSummary,
  SkillCommandEntry,
  ActivatedSkill,
  ResolvedSkill,
  ToolContext,
} from './types';
import { ToolRegistry } from './tool-registry';
import { logger } from '../utils/logger';
import { LoadedSkill, parseBuiltinSkill } from './pi-skill-source';
import {
  SkillFilesAdapter,
  USER_SKILLS_DIR,
  builtinSkillFilePath,
  materializeBuiltinSkill,
  listSkillFilePaths,
} from './skill-files';

/** 内置 Skill 的 executor：direct 模式（斜杠命令）时执行逻辑。 */
export interface BuiltinExecutor {
  execute(args: any, ctx: ToolContext): Promise<any>;
}

/** pi 格式化器引用（动态 import 缓存，规避 ESM-only 在 CJS 下的静态导入问题）。 */
interface PiFormatters {
  formatSkillsForSystemPrompt(skills: PiSkill[]): string;
  formatSkillInvocation(skill: PiSkill, additionalInstructions?: string): string;
}

/** 注册表内部条目：pi Skill + sidecar + 可选 executor + 来源标记。 */
interface RegistryEntry {
  loaded: LoadedSkill;
  executor?: BuiltinExecutor;
  isBuiltin: boolean;
  /** 内置 skill 的 bundled 原文（供物化写盘）。用户 skill 无此值。 */
  builtinMd?: string;
}

/** 路由返回的轻量 skill 句柄由 ./types 导出（ResolvedSkill）。 */

export class SkillRegistry {
  private entries = new Map<string, RegistryEntry>();
  /** 斜杠命令 → skill name 快速索引。 */
  private commandIndex = new Map<string, string>();
  /** 动态 import 缓存的 pi 格式化器；init() 后可用。 */
  private formatters: PiFormatters | null = null;

  constructor(private toolRegistry: ToolRegistry) {}

  /**
   * 动态 import 并缓存 pi 格式化器。onload 中 await 一次；此后 getSkillSummaryText /
   * activateSkill 可同步调用。pi 是 ESM-only，故用动态 import（CJS 测试环境亦可跑通）。
   */
  async init(): Promise<void> {
    if (this.formatters) return;
    try {
      const mod: any = await import('@earendil-works/pi-agent-core');
      this.formatters = {
        formatSkillsForSystemPrompt: mod.formatSkillsForSystemPrompt,
        formatSkillInvocation: mod.formatSkillInvocation,
      };
    } catch (error) {
      logger.error('Failed to load pi skill formatters', error, 'SkillRegistry');
      throw error;
    }
  }

  /** 注册一个内置 Skill（从 bundled SKILL.md 字符串 + executor）。 */
  registerBuiltinFromMd(skillMd: string, executor: BuiltinExecutor): void {
    const filePath = ''; // 物化时回填真实路径
    const loaded = parseBuiltinSkill(skillMd, filePath);
    if (!loaded) {
      console.error('[SkillRegistry] Invalid builtin SKILL.md: missing name/description');
      return;
    }
    this.warnUnknownTools(loaded);
    // 内置 executor 提供 direct 执行能力：无 executor 或空壳则视为 instructions 模式。
    this.entries.set(loaded.skill.name, {
      loaded,
      executor,
      isBuiltin: true,
      builtinMd: skillMd,
    });
    this.indexTriggers(loaded);
    logger.info(`Registered builtin skill: ${loaded.skill.name}`, 'SkillRegistry');
  }

  /** 物化所有内置 Skill 到隐藏目录，并回填各自的真实文件路径。onload 中 await。 */
  async materializeBuiltins(adapter: SkillFilesAdapter, skillsDir = USER_SKILLS_DIR): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.isBuiltin || !entry.builtinMd) continue;
      const name = entry.loaded.skill.name;
      try {
        const path = await materializeBuiltinSkill(adapter, name, entry.builtinMd, skillsDir);
        const diskMd = await adapter.read(path);
        const diskLoaded = parseBuiltinSkill(diskMd, path);
        if (diskLoaded?.skill.name === name && this.hasKnownTools(diskLoaded)) {
          this.unindexTriggers(entry.loaded);
          entry.loaded = diskLoaded;
          this.indexTriggers(diskLoaded);
        } else {
          entry.loaded.skill.filePath = path;
          console.warn(`[SkillRegistry] Ignoring invalid materialized builtin skill "${name}".`);
        }
      } catch (e) {
        // 物化失败：回退到确定性路径，read_skill 仍可尝试读；记录告警不阻断。
        entry.loaded.skill.filePath = builtinSkillFilePath(name, skillsDir);
        console.warn(`[SkillRegistry] Failed to materialize builtin skill "${name}"`);
      }
    }
  }

  /**
   * 从 SKILL.md 字符串注册用户 / 插件 Skill（Stage 3：统一走 parseBuiltinSkill）。
   * 与内置 skill 共用同一个 pi-Skill-model + yaml 解析器，替代 SkillLoader 的自研 YAML。
   * 保留 sidecar(tools/triggers)——pi loadSkills 会丢弃，故不用它。
   * 返回是否成功（供 PluginWatcher 判断）。
   */
  registerUserFromMd(skillMd: string, filePath: string): boolean {
    const loaded = parseBuiltinSkill(skillMd, filePath);
    if (!loaded) return false;
    this.warnUnknownTools(loaded);
    if (this.entries.has(loaded.skill.name)) {
      console.warn(`[SkillRegistry] Skill "${loaded.skill.name}" already exists, user skill skipped.`);
      return false;
    }
    this.entries.set(loaded.skill.name, { loaded, isBuiltin: false });
    this.indexTriggers(loaded);
    logger.info(`Registered user skill: ${loaded.skill.name}`, 'SkillRegistry');
    return true;
  }

  /** Replace an existing user/generated skill after parsing the new file successfully. */
  replaceUserFromMd(skillMd: string, filePath: string): boolean {
    const loaded = parseBuiltinSkill(skillMd, filePath);
    if (!loaded) return false;
    this.warnUnknownTools(loaded);

    const existing = this.entries.get(loaded.skill.name);
    if (existing?.isBuiltin) {
      console.warn(`[SkillRegistry] Builtin skill "${loaded.skill.name}" cannot be replaced.`);
      return false;
    }
    if (existing) this.unregisterSkill(loaded.skill.name);

    this.entries.set(loaded.skill.name, { loaded, isBuiltin: false });
    this.indexTriggers(loaded);
    logger.info(`Replaced user skill: ${loaded.skill.name}`, 'SkillRegistry');
    return true;
  }

  /** 注销 skill（插件禁用时）。 */
  unregisterSkill(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.unindexTriggers(entry.loaded);
    this.entries.delete(name);
    this.rebuildCommandIndex();
    logger.info(`Unregistered skill: ${name}`, 'SkillRegistry');
  }

  /**
   * 从 vault 目录加载用户自定义 Skill（Stage 3：不再用 SkillLoader）。
   * 走 adapter 列目录 + 读文件 + registerUserFromMd（统一解析器）。
   */
  async loadUserSkills(skillsDir: string, app: import('obsidian').App): Promise<void> {
    const adapter = app.vault.adapter as unknown as SkillFilesAdapter;
    const filePaths = await listSkillFilePaths(adapter, skillsDir);
    let count = 0;
    for (const filePath of filePaths) {
      try {
        const content = await adapter.read(filePath);
        if (this.registerUserFromMd(content, filePath)) count++;
      } catch (e) {
        console.warn(`[SkillRegistry] Failed to load user skill: ${filePath}`);
      }
    }
    if (count > 0) {
      logger.info(`Loaded ${count} user skills from ${skillsDir}`, 'SkillRegistry');
    }
  }

  // ==================== Level 1: 发现 ====================

  getSkillSummaries(): SkillSummary[] {
    const summaries: SkillSummary[] = [];
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue;
      summaries.push({
        name: entry.loaded.skill.name,
        description: entry.loaded.skill.description,
        commands: entry.loaded.sidecar.triggers?.commands,
      });
    }
    return summaries;
  }

  /** 返回全部 skill 摘要（含被禁用的）。供设置页 🧩 Skills 区块列出并逐个开关。 */
  getAllSkillSummaries(): SkillSummary[] {
    return [...this.entries.values()].map(entry => ({
      name: entry.loaded.skill.name,
      description: entry.loaded.skill.description,
      commands: entry.loaded.sidecar.triggers?.commands,
    }));
  }

  listCommandEntries(): SkillCommandEntry[] {
    const entries: SkillCommandEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue;
      for (const command of entry.loaded.sidecar.triggers?.commands ?? []) {
        if (this.findCommandOwner(command) !== entry) continue;
        entries.push({ command, skillName: entry.loaded.skill.name, description: entry.loaded.skill.description });
      }
    }
    return entries.sort((a, b) => a.command.localeCompare(b.command));
  }

  /**
   * B 方案：系统提示的 skill 清单用 pi 原生 formatSkillsForSystemPrompt 生成，
   * location 指向物化后的真实文件（模型经 read_skill 读取完整正文）。
   * init() 未跑（理论上不会）时回退空串。
   */
  getSkillSummaryText(): string {
    if (!this.formatters) return '';
    const skills = [...this.entries.values()]
      .filter(e => this.isEnabled(e))
      .map(e => e.loaded.skill);
    return this.formatters.formatSkillsForSystemPrompt(skills);
  }

  // ==================== 路由 ====================

  resolveByCommand(command: string): ResolvedSkill | null {
    const entry = this.findCommandOwner(command);
    return entry ? this.toResolved(entry) : null;
  }

  resolveByIntent(message: string): ResolvedSkill | null {
    const normalized = message.trim().toLowerCase();
    if (!normalized) return null;
    let best: RegistryEntry | null = null;
    let bestScore = 0;
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry) || entry.loaded.skill.disableModelInvocation) continue;
      const keywords = entry.loaded.sidecar.triggers?.keywords ?? [];
      let score = 0;
      for (const kw of keywords) {
        const k = kw.trim().toLowerCase();
        if (!k || !normalized.includes(k)) continue;
        // 权重：含空格的英文短语 / 4 字以上中文短语语义明确 → 2 分；
        // 单英文词或短中文词 → 1 分。防 "knowledge"/"clip" 泛词单命中即误路由。
        const isStrongPhrase = k.includes(' ') || (/\p{Script=Han}/u.test(k) && k.length >= 4);
        score += isStrongPhrase ? 2 : 1;
      }
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    // 阈值：至少命中 2 个普通词，或 1 个短语（加权 2 分）才视为意图命中。
    return bestScore >= 2 && best ? this.toResolved(best) : null;
  }

  // ==================== Level 2: 激活 ====================

  /** 激活 skill：instructions 用 pi formatSkillInvocation 包装完整正文。 */
  activateSkill(name: string): ActivatedSkill | null {
    const entry = this.entries.get(name);
    if (!entry || !this.isEnabled(entry)) {
      console.warn(`[SkillRegistry] Skill "${name}" not found or disabled.`);
      return null;
    }
    const tools = this.toolRegistry.getDefinitions(entry.loaded.sidecar.tools);
    const instructions = this.formatters
      ? this.formatters.formatSkillInvocation(entry.loaded.skill)
      : entry.loaded.skill.content;
    return { skillName: entry.loaded.skill.name, tools, instructions };
  }

  /** read_skill 用：按名返回物化路径 + pi 包装后的完整指令。 */
  resolveForRead(name: string): { filePath: string; instructions: string } | null {
    const entry = this.entries.get(name);
    if (!entry || !this.isEnabled(entry)) return null;
    const instructions = this.formatters
      ? this.formatters.formatSkillInvocation(entry.loaded.skill)
      : entry.loaded.skill.content;
    return { filePath: entry.loaded.skill.filePath ?? '', instructions };
  }

  listSkills(): SkillSummary[] {
    return this.getSkillSummaries();
  }

  // ==================== 内部 ====================

  /** 内部条目 → 路由句柄。execute 委托给 executor（无则返回激活指令）。 */
  private toResolved(entry: RegistryEntry): ResolvedSkill {
    const { skill, sidecar } = entry.loaded;
    return {
      name: skill.name,
      executionMode: sidecar.executionMode,
      execute: (args, ctx) => entry.executor
        ? entry.executor.execute(args, ctx)
        : Promise.resolve({ instructions: skill.content, message: `Skill "${skill.name}" activated.` }),
    };
  }

  private indexTriggers(loaded: LoadedSkill): void {
    for (const cmd of loaded.sidecar.triggers?.commands ?? []) {
      const owner = this.commandIndex.get(cmd);
      if (owner && owner !== loaded.skill.name) {
        console.warn(
          `[SkillRegistry] Command "${cmd}" already belongs to "${owner}"; `
          + `ignoring collision from "${loaded.skill.name}".`,
        );
        continue;
      }
      this.commandIndex.set(cmd, loaded.skill.name);
    }
  }

  private unindexTriggers(loaded: LoadedSkill): void {
    for (const cmd of loaded.sidecar.triggers?.commands ?? []) {
      if (this.commandIndex.get(cmd) === loaded.skill.name) {
        this.commandIndex.delete(cmd);
      }
    }
  }

  private rebuildCommandIndex(): void {
    this.commandIndex.clear();
    for (const entry of this.entries.values()) {
      this.indexTriggers(entry.loaded);
    }
  }

  private findCommandOwner(command: string): RegistryEntry | null {
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue;
      if (entry.loaded.sidecar.triggers?.commands?.includes(command)) return entry;
    }
    return null;
  }

  private hasKnownTools(loaded: LoadedSkill): boolean {
    const unknown = loaded.sidecar.tools.filter(name => !this.toolRegistry.get(name));
    if (unknown.length === 0) return true;
    this.warnUnknownTools(loaded);
    return false;
  }

  private warnUnknownTools(loaded: LoadedSkill): void {
    const unknown = loaded.sidecar.tools.filter(name => !this.toolRegistry.get(name));
    if (unknown.length === 0) return;
    console.warn(`[SkillRegistry] Skill "${loaded.skill.name}" references unknown tools: ${unknown.join(', ')}.`);
  }

  /** 是否启用：唯一来源是 settings.disabledSkills（与权限设置正交）。 */
  private isEnabled(entry: RegistryEntry): boolean {
    const disabled = this.toolRegistry.getSettings().disabledSkills ?? [];
    return !disabled.includes(entry.loaded.skill.name);
  }
}
