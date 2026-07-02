// src/permissions/permission-service.ts — 权限决策集中层（Stage 2）
//
// 第一性原理：权限「决策」（要不要拦/要不要批）此前逐字重复在 6 个 vault 写工具
// + plugin-ctrl 的工具体内（scope/capability/approval 三步各写一遍）。本层把这些
// 「决策」收敛成纯函数，工具改为调用；而审批「载荷」(buildApprovalResponse 的
// rich ChangePreview) 仍由各工具自己构造——载荷是 tool-specific 的，不进本层。
//
// 策略来源唯一：配置页 ⚡ Permissions 的 6 个设置
// (vaultWriteScope / vaultWriteAllowedFolders / allowFileCreation /
//  allowFileModification / allowPluginControl / confirmExecutions)。
// 本层不含任何硬编码策略常量——只读设置执行。

import { PluginSettings, VaultWriteScope } from '../mcp/types';
import { ToolRisk } from '../skills/types';

export interface VaultWriteTargetCheck {
  scope: VaultWriteScope;
  target: string;
  activeNote?: string | null;
  configuredFolders?: string[];
}

/** 文件操作类别：决定读 allowFileCreation 还是 allowFileModification。 */
export type FileOperation = 'create' | 'modify';

function normalizeScopePath(path: string): string {
  // 与原 vault-ops 行为一致：反斜杠归一为正斜杠（Windows 路径），去首尾斜杠。
  // 保留 null 守卫（本层可能被工具外单独调用）。
  return (path || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isPathInsideFolder(target: string, folder: string): boolean {
  const normalizedTarget = normalizeScopePath(target);
  const normalizedFolder = normalizeScopePath(folder);
  if (!normalizedFolder) return false;
  return normalizedTarget === normalizedFolder
    || normalizedTarget.startsWith(`${normalizedFolder}/`);
}

/** 目标路径是否落在允许的写入范围内。纯函数，不碰 app/IO。 */
export function canWriteToVaultTarget(input: VaultWriteTargetCheck): boolean {
  const target = normalizeScopePath(input.target);
  const activeNote = input.activeNote ? normalizeScopePath(input.activeNote) : '';
  const configuredFolders = (input.configuredFolders || []).map(normalizeScopePath).filter(Boolean);

  switch (input.scope) {
    case 'read-only':
      return false;
    case 'current-note':
      return !!activeNote && target === activeNote;
    case 'configured-folders':
      return configuredFolders.some((folder) => isPathInsideFolder(target, folder));
    case 'all-vault':
    default:
      return true;
  }
}

// ==================== 决策方法（纯函数，只读设置） ====================

/**
 * 写入范围决策：目标不在允许范围时返回错误串，否则 null。
 * 替换 vault-ops 内联的 getWriteScopeError（6 处）。
 * activeNote 由调用方从 ctx.app 取出后传入，保持本层纯净、可单测。
 */
export function checkWriteScope(
  target: string,
  settings: PluginSettings,
  activeNote?: string | null,
): string | null {
  const allowed = canWriteToVaultTarget({
    scope: settings.vaultWriteScope || 'all-vault',
    target,
    activeNote,
    configuredFolders: Array.isArray(settings.vaultWriteAllowedFolders)
      ? settings.vaultWriteAllowedFolders
      : [],
  });
  return allowed ? null : `Write not allowed for path: ${target}`;
}

/**
 * 文件能力决策：create 读 allowFileCreation，modify 读 allowFileModification。
 * 被禁用时返回错误串，否则 null。替换散落的 allowFile* 检查。
 */
export function checkFileCapability(
  operation: FileOperation,
  settings: PluginSettings,
): string | null {
  if (operation === 'create') {
    return settings.allowFileCreation ? null : 'File creation is disabled';
  }
  return settings.allowFileModification ? null : 'File modification is disabled';
}

/**
 * 插件控制能力决策：allowPluginControl 关闭时返回错误串，否则 null。
 * 替换 plugin-ctrl 的 4 处 allowPluginControl 检查。
 */
export function checkPluginControl(settings: PluginSettings): string | null {
  return settings.allowPluginControl ? null : 'Permission denied';
}

/**
 * 审批决策：该 risk 的操作在当前设置下是否需要用户确认。
 * 逐行复刻现状——confirmExecutions 关=全自动；只读/搜索(read/network)免批；
 * write / plugin-control 在 confirmExecutions 开时需批。策略只来自设置，无硬编码。
 */
export function needsApproval(risk: ToolRisk, settings: PluginSettings): boolean {
  if (!settings.confirmExecutions) return false;
  return risk === 'write' || risk === 'plugin-control';
}
