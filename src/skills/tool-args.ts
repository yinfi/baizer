// src/skills/tool-args.ts — 工具参数窄化辅助
//
// 模型给出的工具参数来自外部,字段类型未知(ToolArgs = Record<string, unknown>)。
// 工具读取参数时一律经这里窄化:类型不符等同于缺失,而不是被强转后继续往下传。

import type { ToolArgs } from './types';

/** 运行时 args 可能是 null / 原始值(模型或调用方给错),读取前先判定是否为对象。 */
function field(args: ToolArgs | null | undefined, key: string): unknown {
  return typeof args === 'object' && args !== null ? args[key] : undefined;
}

/** 取字符串参数;缺失或类型不符时返回 undefined。 */
export function strArg(args: ToolArgs | null | undefined, key: string): string | undefined {
  const value = field(args, key);
  return typeof value === 'string' ? value : undefined;
}

/** 取有限数字参数;接受数字或数字字符串,其余返回 undefined。 */
export function numArg(args: ToolArgs | null | undefined, key: string): number | undefined {
  const value = field(args, key);
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 取字符串数组参数;非数组返回 undefined,数组中的非字符串元素被丢弃。 */
export function strArrayArg(args: ToolArgs | null | undefined, key: string): string[] | undefined {
  const value = field(args, key);
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[]).filter((item): item is string => typeof item === 'string');
}

/** 缺少必填参数时统一的失败结果。 */
export function missingParam(name: string): { success: false; error: string } {
  return { success: false, error: `Missing ${name} parameter` };
}
