// src/skills/builtin/plugin-ctrl/executor.ts

import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import { pluginSkillFilePath } from '../../skill-files';

export function getPluginCommandPreconditions(): string[] {
  return [
    'Open the target note before execution.',
    'Confirm the relevant editor pane or selection is focused before execution.',
  ];
}

const listPlugins: Tool = {
  name: 'list_plugins',
  description: 'List all installed plugins and their status, including whether they have an AI skill.',
  executionMode: 'parallel',
  risk: 'plugin-control',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    if (!ctx.settings.allowPluginControl) return { error: 'Permission denied' };
    const manifests = (ctx.app as any).plugins.manifests;
    const enabled = (ctx.app as any).plugins.enabledPlugins;
    const list = await Promise.all(Object.values(manifests).map(async (m: any) => ({
      id: m.id, name: m.name, version: m.version,
      enabled: enabled.has(m.id), description: m.description,
      hasSkill: await ctx.app.vault.adapter.exists(pluginSkillFilePath(m.id)),
    })));
    return { plugins: list, total: list.length };
  },
};

const getPluginCommands: Tool = {
  name: 'get_plugin_commands',
  description: 'Get available commands for a specific plugin.',
  executionMode: 'parallel',
  risk: 'plugin-control',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: 'The ID of the plugin' },
    },
    required: ['pluginId'],
  },
  async execute(args, ctx) {
    if (!ctx.settings.allowPluginControl) return { error: 'Permission denied' };
    const cmds = (ctx.app as any).commands.listCommands()
      .filter((c: any) => c.id.startsWith(args.pluginId + ':'))
      .map((c: any) => ({ id: c.id, name: c.name }));
    return { pluginId: args.pluginId, commands: cmds, count: cmds.length };
  },
};

const getPluginSettings: Tool = {
  name: 'get_plugin_settings',
  description: 'Get settings for a specific plugin.',
  executionMode: 'parallel',
  risk: 'plugin-control',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: 'The ID of the plugin' },
    },
    required: ['pluginId'],
  },
  async execute(args, ctx) {
    if (!ctx.settings.allowPluginControl) return { error: 'Permission denied' };
    const plugin = (ctx.app as any).plugins.getPlugin(args.pluginId);
    if (!plugin) return { error: 'Plugin not found or not enabled' };
    return { pluginId: args.pluginId, settings: plugin.settings || plugin.data || {} };
  },
};

const executePluginCommand: Tool = {
  name: 'execute_plugin_command',
  description: 'Execute a plugin command by its ID. Use get_plugin_commands first to find the command ID.',
  executionMode: 'sequential',
  risk: 'plugin-control',
  parameters: {
    type: 'object',
    properties: {
      commandId: { type: 'string', description: 'The full command ID (e.g., "obsidian-tasks-plugin:add-task")' },
    },
    required: ['commandId'],
  },
  async execute(args, ctx) {
    if (!ctx.settings.allowPluginControl) return { error: 'Permission denied' };
    if (ctx.settings.confirmExecutions && !args.approved) {
      return {
        approval_required: true,
        action: 'execute_plugin_command',
        target: args.commandId,
        args: {
          commandId: args.commandId,
        },
        message: `Approval required to execute plugin command: ${args.commandId}`,
        preview: {
          kind: 'plugin-command',
          target: args.commandId,
          summary: 'Execute plugin command',
          commandId: args.commandId,
          preconditions: getPluginCommandPreconditions(),
          risk: 'medium',
          supportsPartialApply: false,
          undoable: false,
        },
      };
    }

    const success = (ctx.app as any).commands.executeCommandById(args.commandId);
    return success
      ? { success: true, message: `✅ Executed: ${args.commandId}` }
      : { success: false, error: `Command not found: ${args.commandId}` };
  },
};

export const executor: BuiltinExecutor = {
  async execute(args: any, ctx: ToolContext) {
    return { message: 'Plugin control: use args.action (list/commands/settings/execute) with pluginId.' };
  },
};

export function registerTools(registry: ToolRegistry): void {
  registry.register(listPlugins);
  registry.register(getPluginCommands);
  registry.register(getPluginSettings);
  registry.register(executePluginCommand);
}
