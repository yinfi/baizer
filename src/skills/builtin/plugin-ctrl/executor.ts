// src/skills/builtin/plugin-ctrl/executor.ts

import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import { pluginSkillFilePath } from '../../skill-files';
import { checkPluginControl, needsApproval } from '../../../permissions/permission-service';

export function getPluginCommandPreconditions(): string[] {
  return [
    'Open the target note before execution.',
    'Confirm the relevant editor pane or selection is focused before execution.',
  ];
}

const listPlugins: Tool = {
  name: 'list_plugins',
  description: 'List all installed plugins and their status, including whether they have an AI skill.',
  executionMode: 'sequential',
  risk: 'plugin-control',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    const pcErr = checkPluginControl(ctx.settings); if (pcErr) return { error: pcErr };
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
  executionMode: 'sequential',
  risk: 'plugin-control',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: 'The ID of the plugin' },
    },
    required: ['pluginId'],
  },
  async execute(args, ctx) {
    const pcErr = checkPluginControl(ctx.settings); if (pcErr) return { error: pcErr };
    const cmds = (ctx.app as any).commands.listCommands()
      .filter((c: any) => c.id.startsWith(args.pluginId + ':'))
      .map((c: any) => ({ id: c.id, name: c.name }));
    return { pluginId: args.pluginId, commands: cmds, count: cmds.length };
  },
};

const getPluginSettings: Tool = {
  name: 'get_plugin_settings',
  description: 'Get settings for a specific plugin. Sensitive fields (API keys, tokens, secrets) are always redacted and returned as key names with types only.',
  executionMode: 'sequential',
  risk: 'plugin-control',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: 'The ID of the plugin' },
    },
    required: ['pluginId'],
  },
  async execute(args, ctx) {
    const pcErr = checkPluginControl(ctx.settings); if (pcErr) return { error: pcErr };
    const plugin = (ctx.app as any).plugins.getPlugin(args.pluginId);
    if (!plugin) return { error: 'Plugin not found or not enabled' };
    const raw = plugin.settings || plugin.data || {};
    const allowValues = ctx.settings.allowPluginConfigValues === true;
    return {
      pluginId: args.pluginId,
      settings: redactPluginSettings(raw, { allowValues, depth: 0 }),
      redactionNote: allowValues
        ? 'Values returned per user setting; sensitive keys still redacted.'
        : 'Sensitive keys and values are redacted; only key names and types are returned.',
    };
  },
};

// ==================== 配置脱敏 ====================

/** 命中即视为敏感字段：不返回原值。 */
const SENSITIVE_KEY_TOKENS = new Set([
  'api', 'apikey', 'auth', 'authorization', 'cookie', 'credential', 'credentials',
  'key', 'passwd', 'password', 'secret', 'session', 'token',
]);

const REDACT_MAX_DEPTH = 3;
const REDACT_MAX_ARRAY_ITEMS = 20;
const REDACT_MAX_STRING_CHARS = 500;

/**
 * 递归脱敏插件配置：敏感键只给 { redacted, type, length }；
 * 长字符串 / 深嵌套 / 大数组截断，避免把第三方插件配置原样灌给模型。
 */
function redactPluginSettings(
  raw: unknown,
  opts: { allowValues: boolean; depth: number },
): unknown {
  const { allowValues, depth } = opts;
  if (depth > REDACT_MAX_DEPTH) return { redacted: true, reason: 'depth-limit' };

  if (Array.isArray(raw)) {
    if (!allowValues) {
      const itemTypes = [...new Set(raw.map(describeValueType))].sort();
      return { type: 'array', itemTypes };
    }
    const arr = raw.slice(0, REDACT_MAX_ARRAY_ITEMS);
    return arr.map(item => redactPluginSettings(item, { allowValues, depth: depth + 1 }));
  }

  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        const serialized = safeStringify(value);
        out[key] = { redacted: true, type: describeValueType(value), length: serialized.length };
      } else {
        out[key] = redactPluginSettings(value, { allowValues, depth: depth + 1 });
      }
    }
    return out;
  }

  // 标量
  if (!allowValues) return { type: describeValueType(raw) };
  if (typeof raw === 'string') {
    return raw.length > REDACT_MAX_STRING_CHARS
      ? { redacted: true, type: 'string', length: raw.length }
      : raw;
  }
  return raw;
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isSensitiveKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some(token => SENSITIVE_KEY_TOKENS.has(token));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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
    const pcErr = checkPluginControl(ctx.settings); if (pcErr) return { error: pcErr };
    if (needsApproval('plugin-control', ctx.settings) && !args.approved) {
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
