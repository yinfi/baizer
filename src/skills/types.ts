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
  /**
   * 本次工具执行的中断信号(由 runtime 透传:pi 的软超时/用户中断)。
   * 网络类工具(save_webpage/web_search)应把它接进 fetch,使超时/中断能真正取消
   * 在途请求,而非仅让上层 race 返回错误、请求却在后台跑完(状态不一致)。
   * 本地 vault 操作通常毫秒级完成,可忽略此信号(维持原签名不变)。
   */
  signal?: AbortSignal;
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
  /** 数组元素的类型；语义上只需 type，故放宽为部分定义。 */
  items?: Partial<ParameterDef>;
  enum?: string[];
}

export type ToolExecutionMode = 'parallel' | 'sequential';
export type ToolRisk = 'read' | 'write' | 'plugin-control' | 'network' | 'unknown';

/**
 * 原子工具：无状态、可组合的最小操作单元
 * 不感知 Skill，不感知 AI，只做一件事
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
  risk?: ToolRisk;
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
  executionMode?: 'direct' | 'instructions';

  /** 物化后的 SKILL.md 路径（B 方案：系统提示 location 与 read_skill 读取用）。 */
  filePath?: string;

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
 * Level 2 激活结果：触发 Skill 后返回的完整信息。
 * 只承载实际消费字段（调用方只读 skillName/tools/instructions），
 * 不再伪装成完整 Skill 接口。
 */
export interface ActivatedSkill {
  skillName: string;
  tools: ToolDefinition[];
  instructions: string;
}

/**
 * 路由返回的轻量 skill 句柄（B 方案）：斜杠命令执行 / 意图命名用。
 * 不暴露完整 Skill，只给出调用方实际消费的字段。
 */
export interface ResolvedSkill {
  name: string;
  executionMode: 'direct' | 'instructions';
  execute(args: any, ctx: ToolContext): Promise<any>;
}
