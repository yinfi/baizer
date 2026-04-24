// src/skills/tool-registry.ts — 原子工具注册表

import { App } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import { ToolDefinition } from '../models/interfaces';
import { Tool, ToolContext, IToolRegistry } from './types';

/**
 * 原子工具注册表
 * 管理所有底层工具的注册、查找和执行
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, Tool>();
  private ctx: ToolContext;

  constructor(app: App, settings: PluginSettings) {
    this.ctx = { app, settings };
  }

  /** 更新上下文（settings 变更时调用） */
  updateContext(settings: PluginSettings): void {
    this.ctx = { app: this.ctx.app, settings };
  }

  /** 获取当前 settings */
  getSettings(): PluginSettings {
    return this.ctx.settings;
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 将 Tool 转为 function calling 用的 ToolDefinition */
  getDefinition(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  /** 批量获取 ToolDefinition */
  getDefinitions(names: string[]): ToolDefinition[] {
    return names
      .map(n => this.getDefinition(n))
      .filter((d): d is ToolDefinition => d !== undefined);
  }

  /** 获取所有工具的 ToolDefinition */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** 执行工具 */
  async execute(name: string, args: any): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}` };
    }
    try {
      return await tool.execute(args, this.ctx);
    } catch (e: any) {
      console.error(`[ToolRegistry] Tool "${name}" execution error:`, e);
      return { error: e.message };
    }
  }

  /** 列出所有已注册工具 */
  listAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 已注册工具数量 */
  get size(): number {
    return this.tools.size;
  }
}
