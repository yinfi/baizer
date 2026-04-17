// src/skills/skill-registry.ts — Skill 注册表

import { ToolDefinition } from '../models/interfaces';
import { PluginSettings } from '../mcp/types';
import {
  Skill,
  SkillSummary,
  SkillTriggers,
  ActivatedSkill,
  ISkillRegistry,
  ToolContext,
} from './types';
import { ToolRegistry } from './tool-registry';
import { SkillLoader } from './skill-loader';

/**
 * 内置 Skill 的 executor 接口
 * executor.ts 导出此类型，提供执行逻辑
 */
export interface BuiltinExecutor {
  execute(args: any, ctx: ToolContext): Promise<any>;
}

/**
 * 从 SKILL.md 解析出的 frontmatter
 */
interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: SkillTriggers;
  tools?: string[];
  enabled?: boolean;
}

/**
 * 内置 Skill：SKILL.md（metadata + instructions）+ executor（执行逻辑）
 */
class BuiltinSkill implements Skill {
  name: string;
  description: string;
  triggers?: SkillTriggers;
  enabled?: boolean | ((settings: PluginSettings) => boolean);

  private instructions: string;
  private toolNames: string[];
  private toolRegistry: ToolRegistry;
  private executor: BuiltinExecutor;

  constructor(
    fm: SkillFrontmatter,
    instructions: string,
    toolRegistry: ToolRegistry,
    executor: BuiltinExecutor,
    enabledFn?: (settings: PluginSettings) => boolean,
  ) {
    this.name = fm.name;
    this.description = fm.description;
    this.triggers = fm.triggers;
    this.enabled = enabledFn ?? (fm.enabled ?? true);
    this.instructions = instructions;
    this.toolNames = fm.tools ?? [];
    this.toolRegistry = toolRegistry;
    this.executor = executor;
  }

  getInstructions(): string { return this.instructions; }
  getTools(): ToolDefinition[] { return this.toolRegistry.getDefinitions(this.toolNames); }
  async execute(args: any, ctx: ToolContext): Promise<any> { return this.executor.execute(args, ctx); }
}

/**
 * Skill 注册表：发现、注册、路由、激活
 *
 * 职责：
 * - 管理内置 Skill 和用户 Skill 的注册
 * - 生成 Level 1 摘要（注入 system prompt）
 * - 路由：斜杠命令 / AI 意图 → 匹配 Skill
 * - 激活：加载 Level 2 instructions + tools
 */
export class SkillRegistry implements ISkillRegistry {
  private skills = new Map<string, Skill>();
  /** 斜杠命令 → skill name 的快速索引 */
  private commandIndex = new Map<string, string>();

  constructor(private toolRegistry: ToolRegistry) {}

  registerBuiltin(skill: Skill): void {
    this.skills.set(skill.name, skill);
    this.indexTriggers(skill);
    console.log(`[SkillRegistry] Registered builtin skill: ${skill.name}`);
  }

  /**
   * 从 SKILL.md 字符串 + executor 注册内置 Skill
   * SKILL.md 在编译时通过 esbuild text loader 导入
   */
  registerBuiltinFromMd(
    skillMd: string,
    executor: BuiltinExecutor,
    enabledFn?: (settings: PluginSettings) => boolean,
  ): void {
    const { frontmatter, body } = this.parseFrontmatter(skillMd);
    if (!frontmatter || !frontmatter.name) {
      console.error('[SkillRegistry] Invalid SKILL.md: missing name');
      return;
    }
    const skill = new BuiltinSkill(frontmatter, body.trim(), this.toolRegistry, executor, enabledFn);
    this.registerBuiltin(skill);
  }

  /** 解析 YAML frontmatter（简易解析，复用 SkillLoader 的逻辑） */
  private parseFrontmatter(content: string): { frontmatter: SkillFrontmatter | null; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { frontmatter: null, body: content };

    try {
      const yaml = this.parseSimpleYaml(match[1]);
      return {
        frontmatter: {
          name: yaml.name ?? '',
          description: yaml.description ?? '',
          triggers: yaml.triggers,
          tools: yaml.tools,
          enabled: yaml.enabled,
        },
        body: match[2],
      };
    } catch (e) {
      console.error('[SkillRegistry] YAML parse error:', e);
      return { frontmatter: null, body: content };
    }
  }

  /** 简易 YAML 解析 */
  private parseSimpleYaml(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    let currentKey = '';
    let currentObj: Record<string, any> | null = null;

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (line.startsWith('  ') && currentKey && currentObj !== null) {
        const subMatch = trimmed.match(/^(\w+):\s*(.*)$/);
        if (subMatch) {
          currentObj[subMatch[1]] = this.parseYamlValue(subMatch[2]);
          result[currentKey] = currentObj;
          continue;
        }
      }

      const topMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (topMatch) {
        const key = topMatch[1];
        const rawValue = topMatch[2];
        if (rawValue === '' || rawValue === undefined) {
          currentKey = key;
          currentObj = {};
        } else {
          result[key] = this.parseYamlValue(rawValue);
          currentKey = '';
          currentObj = null;
        }
      }
    }
    return result;
  }

  private parseYamlValue(raw: string): any {
    if (!raw) return '';
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1);
      if (!inner.trim()) return [];
      return inner.split(',').map(s => {
        const v = s.trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          return v.slice(1, -1);
        return v;
      });
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      return raw.slice(1, -1);
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
  }

  /** 注册用户 Skill（由 SkillLoader 调用） */
  registerUser(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      console.warn(
        `[SkillRegistry] Skill "${skill.name}" already exists, user skill skipped.`
      );
      return;
    }
    this.skills.set(skill.name, skill);
    this.indexTriggers(skill);
    console.log(`[SkillRegistry] Registered user skill: ${skill.name}`);
  }

  /** 注销 skill（插件禁用时调用） */
  unregisterSkill(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;
    if (skill.triggers?.commands) {
      for (const cmd of skill.triggers.commands) {
        this.commandIndex.delete(cmd);
      }
    }
    this.skills.delete(name);
    console.log(`[SkillRegistry] Unregistered skill: ${name}`);
  }

  /** 暴露 toolRegistry 供 PluginWatcher 使用 */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /** 从 vault 目录加载用户自定义 Skill */
  async loadUserSkills(skillsDir: string, app: import('obsidian').App): Promise<void> {
    const loader = new SkillLoader(app, this.toolRegistry);
    const skills = await loader.loadFromDirectory(skillsDir);
    for (const skill of skills) {
      this.registerUser(skill);
    }
    if (skills.length > 0) {
      console.log(`[SkillRegistry] Loaded ${skills.length} user skills from ${skillsDir}`);
    }
  }

  // ==================== Level 1: 发现 ====================

  /** 生成所有 Skill 的摘要列表 */
  getSkillSummaries(): SkillSummary[] {
    const summaries: SkillSummary[] = [];
    for (const skill of this.skills.values()) {
      if (!this.isEnabled(skill)) continue;
      summaries.push({
        name: skill.name,
        description: skill.description,
        commands: skill.triggers?.commands,
      });
    }
    return summaries;
  }

  /** 生成注入 system prompt 的摘要文本（只列清单，不做行为引导） */
  getSkillSummaryText(): string {
    const summaries = this.getSkillSummaries();
    if (summaries.length === 0) return '';

    const lines = summaries.map(s => {
      const cmdHint = s.commands?.length ? ` (${s.commands.join(', ')})` : '';
      return `- ${s.name}: ${s.description}${cmdHint}`;
    });

    return `可用 Skill（调用 use_skill 获取该场景的详细工作指引）：\n${lines.join('\n')}`;
  }

  // ==================== 路由 ====================

  /** 斜杠命令路由 */
  resolveByCommand(command: string): Skill | null {
    const skillName = this.commandIndex.get(command);
    if (!skillName) return null;
    const skill = this.skills.get(skillName);
    return skill && this.isEnabled(skill) ? skill : null;
  }

  /** AI 意图路由（Phase 3 实现，先返回 null） */
  resolveByIntent(message: string): Skill | null {
    // Phase 3: 基于 keywords 做简单匹配
    return null;
  }

  // ==================== Level 2: 激活 ====================

  /** 激活 Skill，返回完整的 instructions + tools */
  activateSkill(name: string): ActivatedSkill | null {
    const skill = this.skills.get(name);
    if (!skill || !this.isEnabled(skill)) {
      console.warn(`[SkillRegistry] Skill "${name}" not found or disabled.`);
      return null;
    }

    return {
      skill,
      tools: skill.getTools(),
      instructions: skill.getInstructions(),
    };
  }

  /** 列出所有 Skill */
  listSkills(): SkillSummary[] {
    return this.getSkillSummaries();
  }

  // ==================== 内部方法 ====================

  /** 索引 Skill 的触发条件 */
  private indexTriggers(skill: Skill): void {
    if (skill.triggers?.commands) {
      for (const cmd of skill.triggers.commands) {
        this.commandIndex.set(cmd, skill.name);
      }
    }
  }

  /** 检查 Skill 是否启用 */
  private isEnabled(skill: Skill): boolean {
    if (skill.enabled === undefined) return true;
    if (typeof skill.enabled === 'function') {
      return skill.enabled(this.toolRegistry.getSettings());
    }
    return skill.enabled;
  }
}
