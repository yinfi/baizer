// src/skills/skill-registry.ts — Skill 注册表（B 方案：pi 原生激活机制）
//
// 职责：
// - 管理内置 / 用户 Skill，内部统一存 pi 原生 Skill + Baizer sidecar
// - 物化内置 Skill 到隐藏目录，使所有 skill 都是真实文件（read_skill 可读）
// - 发现：formatSkillsForSystemPrompt 生成系统提示清单（真实 location）
// - 激活：formatSkillInvocation 包装完整正文（斜杠命令 / 强制激活）
// - 路由：斜杠命令 / 关键词意图 → 匹配 Skill

import { ToolDefinition } from '../models/interfaces';
import { PluginSettings } from '../mcp/types';
import type { Skill as PiSkill } from '@earendil-works/pi-agent-core';
import {
  Skill,
  SkillSummary,
  SkillCommandEntry,
  ActivatedSkill,
  ResolvedSkill,
  ISkillRegistry,
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

export class SkillRegistry implements ISkillRegistry {
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
    const mod: any = await import('@earendil-works/pi-agent-core');
    this.formatters = {
      formatSkillsForSystemPrompt: mod.formatSkillsForSystemPrompt,
      formatSkillInvocation: mod.formatSkillInvocation,
    };
  }

  /** 注册一个内置 Skill（从 bundled SKILL.md 字符串 + executor）。 */
  registerBuiltinFromMd(skillMd: string, executor: BuiltinExecutor): void {
    const filePath = ''; // 物化时回填真实路径
    const loaded = parseBuiltinSkill(skillMd, filePath);
    if (!loaded) {
      console.error('[SkillRegistry] Invalid builtin SKILL.md: missing name/description');
      return;
    }
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
        entry.loaded.skill.filePath = path;
      } catch (e) {
        // 物化失败：回退到确定性路径，read_skill 仍可尝试读；记录告警不阻断。
        entry.loaded.skill.filePath = builtinSkillFilePath(name, skillsDir);
        console.warn(`[SkillRegistry] Failed to materialize builtin skill "${name}"`);
      }
    }
  }

  /** 兼容旧接口：注册已构造的 Skill 对象（内置路径基本不再用，保留以防调用方）。 */
  registerBuiltin(skill: Skill): void {
    const loaded = this.skillToLoaded(skill);
    this.entries.set(skill.name, { loaded, isBuiltin: true, executor: skill });
    this.indexTriggers(loaded);
    logger.info(`Registered builtin skill: ${skill.name}`, 'SkillRegistry');
  }

  /** 注册用户 / 插件 Skill（兼容旧接口：接收已构造的 Skill 对象）。 */
  registerUser(skill: Skill): void {
    if (this.entries.has(skill.name)) {
      console.warn(`[SkillRegistry] Skill "${skill.name}" already exists, user skill skipped.`);
      return;
    }
    const loaded = this.skillToLoaded(skill);
    this.entries.set(skill.name, { loaded, isBuiltin: false, executor: skill });
    this.indexTriggers(loaded);
    logger.info(`Registered user skill: ${skill.name}`, 'SkillRegistry');
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
    if (this.entries.has(loaded.skill.name)) {
      console.warn(`[SkillRegistry] Skill "${loaded.skill.name}" already exists, user skill skipped.`);
      return false;
    }
    this.entries.set(loaded.skill.name, { loaded, isBuiltin: false });
    this.indexTriggers(loaded);
    logger.info(`Registered user skill: ${loaded.skill.name}`, 'SkillRegistry');
    return true;
  }

  /** 注销 skill（插件禁用时）。 */
  unregisterSkill(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    for (const cmd of entry.loaded.sidecar.triggers?.commands ?? []) {
      this.commandIndex.delete(cmd);
    }
    this.entries.delete(name);
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
    const name = this.commandIndex.get(command);
    if (!name) return null;
    const entry = this.entries.get(name);
    return entry && this.isEnabled(entry) ? this.toResolved(entry) : null;
  }

  resolveByIntent(message: string): ResolvedSkill | null {
    const normalized = message.trim().toLowerCase();
    if (!normalized) return null;
    let best: RegistryEntry | null = null;
    let bestScore = 0;
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue;
      const keywords = entry.loaded.sidecar.triggers?.keywords ?? [];
      let score = 0;
      for (const kw of keywords) {
        const k = kw.trim().toLowerCase();
        if (k && normalized.includes(k)) score += 1;
      }
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    return bestScore > 0 && best ? this.toResolved(best) : null;
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
    return { skill: this.toResolved(entry) as any, tools, instructions };
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

  /** 把外部 Skill 接口对象转成内部 LoadedSkill（用户 / 插件 skill 路径）。 */
  private skillToLoaded(skill: Skill): LoadedSkill {
    return {
      skill: {
        name: skill.name,
        description: skill.description,
        content: skill.getInstructions(),
        filePath: skill.filePath ?? '',
        disableModelInvocation: false,
      },
      sidecar: {
        tools: skill.getTools().map(t => t.name),
        triggers: skill.triggers,
        executionMode: skill.executionMode ?? 'instructions',
      },
    };
  }

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
      this.commandIndex.set(cmd, loaded.skill.name);
    }
  }

  /** 是否启用：唯一来源是 settings.disabledSkills（与权限设置正交）。 */
  private isEnabled(entry: RegistryEntry): boolean {
    const disabled = this.toolRegistry.getSettings().disabledSkills ?? [];
    return !disabled.includes(entry.loaded.skill.name);
  }
}
