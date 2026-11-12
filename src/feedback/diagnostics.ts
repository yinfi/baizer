// src/feedback/diagnostics.ts — 诊断快照与错误摘要
//
// 诊断快照是反馈正文里唯一来自运行环境的输入，所以它的字段边界就是隐私边界：
// 字段集合封闭（BR7.1，由工具签名强制），且不含笔记内容、文件路径、vault 名称、
// API Key、内置 token、对话历史、环境上下文（FR6.3）。

import { ERROR_DIGEST_MAX_CHARS, stripFeedbackToken } from './config';
import { resolveProvider } from './issue-template';
import type { DiagnosticsSnapshot, DiagnosticsProvider } from './types';
import type { ProviderType } from '../mcp/types';

/** 会话内错误环形缓冲容量。只留最近若干条，够取「最新一条」即可。 */
const ERROR_BUFFER_LIMIT = 20;

interface FeedbackErrorRecord {
  at: number;
  surface: string;
  message: string;
}

/**
 * 进程内错误环形缓冲。**不落盘**——插件重载即清空。
 *
 * 另起一条为「公开」而设计的通路，而不是从 logger 的日志环里捞：日志是给开发者写的，
 * 里面有绝对路径与 provider 端点，且 logger 没有任何脱敏层。把日志内容搬进一个会被
 * 公开发布的字段，等于把「日志里恰好有什么」变成对外暴露面。
 */
const errorBuffer: FeedbackErrorRecord[] = [];

export function recordFeedbackError(input: { surface: string; message: string }): void {
  const message = typeof input.message === 'string' ? input.message : '';
  if (!message.trim()) return;
  errorBuffer.push({ at: Date.now(), surface: input.surface, message });
  if (errorBuffer.length > ERROR_BUFFER_LIMIT) errorBuffer.splice(0, errorBuffer.length - ERROR_BUFFER_LIMIT);
}

/** 仅测试用：清空缓冲。 */
export function clearFeedbackErrors(): void {
  errorBuffer.length = 0;
}

/**
 * 路径片段脱敏。
 *
 * 原始错误文本里最常见的是本地绝对路径（含用户名），而 issue 是公开的。
 * 只做确定性替换，不试图做语义理解。
 */
function redactPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"'`|<>]+/g, '[path]')
    .replace(/(?:\/Users|\/home|\/var|\/tmp|\/private|\/Volumes|\/mnt)\/[^\s"'`|<>]*/g, '[path]');
}

/**
 * 把一条原始错误文本压成可公开发布的一行摘要。
 *
 * 单行化 → 脱敏（凭据 + 路径）→ 截断 300 字符；脱敏后为空则返回 undefined，
 * 由调用方整项省略（不得用「无」以外的任何东西填充）。
 */
export function buildErrorDigest(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const single = raw.replace(/\s+/g, ' ').trim();
  const safe = redactPaths(stripFeedbackToken(single));
  if (!safe.trim()) return undefined;
  return safe.length > ERROR_DIGEST_MAX_CHARS ? safe.slice(0, ERROR_DIGEST_MAX_CHARS) : safe;
}

/** 取缓冲里最新一条错误，压成摘要。缓冲为空时返回 undefined。 */
export function latestErrorDigest(): string | undefined {
  const latest = errorBuffer[errorBuffer.length - 1];
  return latest ? buildErrorDigest(latest.message) : undefined;
}

export interface DiagnosticsInput {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  providerType?: ProviderType;
  providerLabel?: string;
  /** 注入时钟，便于测试确定性。 */
  now?: () => Date;
}

/**
 * 组装诊断快照。
 *
 * provider 在工具内部完成到模板下拉域的映射——快照携带的是**已落到模板域的取值**，
 * 不携带原始 provider label（它可能是用户自建的端点名，写进公开 issue 属于超范围暴露）。
 */
export function buildDiagnosticsSnapshot(input: DiagnosticsInput): DiagnosticsSnapshot {
  const provider: DiagnosticsProvider = resolveProvider(input.providerType, input.providerLabel);
  const snapshot: DiagnosticsSnapshot = {
    pluginVersion: input.pluginVersion,
    obsidianVersion: input.obsidianVersion,
    platform: input.platform,
    provider,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const digest = latestErrorDigest();
  if (digest) snapshot.lastErrorDigest = digest;
  return snapshot;
}

/**
 * 诊断快照 → 模板字段值。
 *
 * privacyMode 开启时默认**不带**诊断字段，用户在预览中逐项勾选才带入（BR7.3）；
 * 关闭时默认全部附带。`include` 即用户勾选的字段 id 集合。
 */
export function diagnosticFields(
  snapshot: DiagnosticsSnapshot,
  options: { privacyMode: boolean; include?: string[] },
): Record<string, string> {
  const all: Record<string, string> = {
    'plugin-version': snapshot.pluginVersion,
    'obsidian-version': snapshot.obsidianVersion,
    platform: snapshot.platform,
    provider: snapshot.provider,
    console: snapshot.lastErrorDigest ?? '',
  };
  if (!options.privacyMode) return all;

  const selected = new Set(options.include ?? []);
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (selected.has(key)) picked[key] = value;
  }
  return picked;
}
