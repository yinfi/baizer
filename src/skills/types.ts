// src/skills/types.ts — Skill 架构核心类型定义

import { App } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import { ToolDefinition } from '../models/interfaces';

// ==================== 工具层 ====================

/**
 * 原子工具执行上下文
 */
export interface ToolContext {
  app: App;
  settings: PluginSettings;
}

/**
 * 工具参数定义（兼容 Gemini/OpenAI function calling schema）
 */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, ParameterDef>;
  required?: string[];
}

export interface ParameterDef {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  items?: ParameterDef;
  enum?: string[];
}

/**
 * 原子工具：无状态、可组合的最小操作单元
 * 不感知 Skill，不感知 AI，只做一件事
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(args: any, ctx: ToolContext): Promise<any>;
}

// ==================== Skill 层 ====================

/**
 * Skill 触发条件
 */
export interface SkillTriggers {
  /** 斜杠命令，如 ["/save", "/clip"] */
  commands?: string[];
  /** 事件触发，如 ["file:modified", "timer:daily:21:00"] */
  events?: string[];
  /** AI 意图路由辅助词（不进 context，仅用于路由匹配） */
  keywords?: string[];
}

/**
 * Skill：编排层，组合原子工具完成复杂任务
 * 支持渐进式披露的三级加载
 * 所有 Skill 均为 simple mode：execute() 直接返回结果
 */
export interface Skill {
  // === Level 1: Metadata（始终加载，~100 tokens） ===
  name: string;
  description: string;

  // === Level 2: Instructions（触发时加载） ===
  /** 完整的 prompt 模板 / 工作流指引 */
  getInstructions(): string;
  /** 该 Skill 暴露给 AI 的工具定义子集 */
  getTools(): ToolDefinition[];

  // === Level 3: Execution（按需执行） ===
  /** simple mode: 直接执行并返回结果 */
  execute(args: any, ctx: ToolContext): Promise<any>;

  // === 触发条件 ===
  triggers?: SkillTriggers;

  // === 生命周期 ===
  /** 是否启用，支持静态值或动态函数 */
  enabled?: boolean | ((settings: PluginSettings) => boolean);
}

// ==================== 注册表接口 ====================

/**
 * Level 1 摘要：注入 system prompt 的轻量信息
 */
export interface SkillSummary {
  name: string;
  description: string;
  commands?: string[];
}

export interface SkillCommandEntry {
  command: string;
  skillName: string;
  description: string;
}

/**
 * Level 2 激活结果：触发 Skill 后返回的完整信息
 */
export interface ActivatedSkill {
  skill: Skill;
  tools: ToolDefinition[];
  instructions: string;
}

/**
 * 原子工具注册表接口
 */
export interface IToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getDefinition(name: string): ToolDefinition | undefined;
  getDefinitions(names: string[]): ToolDefinition[];
  execute(name: string, args: any): Promise<any>;
  listAll(): Tool[];
}

/**
 * Skill 注册表接口
 */
export interface ISkillRegistry {
  registerBuiltin(skill: Skill): void;
  loadUserSkills(skillsDir: string, app: import('obsidian').App): Promise<void>;
  getSkillSummaries(): SkillSummary[];
  listCommandEntries(): SkillCommandEntry[];
  getSkillSummaryText(): string;
  resolveByCommand(command: string): Skill | null;
  resolveByIntent(message: string): Skill | null;
  activateSkill(name: string, args?: any): ActivatedSkill | null;
  listSkills(): SkillSummary[];
}
