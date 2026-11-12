// src/feedback/payload.ts — 载荷构造、渲染与审批响应的组装
//
// 与 tools.ts 的分工：本模块只管「一次提交的字节从哪来、长什么样」，不关心工具
// 何时被调用、批准与否。渲染只发生一次——审批通过后的执行路径**不得**重新渲染，
// 否则会覆盖用户在卡片上的编辑（见 readApprovedPayload）。

import { apiVersion, Platform } from 'obsidian';
import type { ToolArgs, ToolContext, ToolResult } from '../skills/types';
import { numArg, strArg } from '../skills/tool-args';
import { PLUGIN_ID } from '../mcp/types';
import type { ProviderConfig, ProviderType } from '../mcp/types';
import { FEEDBACK_REPO } from './config';
import { buildDiagnosticsSnapshot, diagnosticFields } from './diagnostics';
import { computeDedupKey, type FeedbackDraftStore } from './drafts';
import type { GithubClient } from './github';
import {
  renderIssueBody,
  singleLine,
  TEMPLATE_LABELS,
  templateFields,
  type TemplateField,
} from './issue-template';
import type { DiagnosticsSnapshot, FeedbackDraft, FeedbackIssueType, IssuePayload } from './types';

export type FeedbackDraftKindArg = 'new_issue' | 'issue_comment';

export interface FeedbackToolDeps {
  client: GithubClient;
  drafts: FeedbackDraftStore;
  /** 凭据是否已内置。缺省读构建期注入值；测试可注入。 */
  isConfigured?: () => boolean;
  /** 缺省实现读 Obsidian 的 Platform / apiVersion；测试可注入。 */
  detectPlatform?: () => string;
  detectObsidianVersion?: () => string;
  detectPluginVersion?: (ctx: ToolContext) => string;
  now?: () => Date;
}

/** 依赖全部解析完毕后的形态（可选项已填默认值）。 */
export interface ResolvedDeps extends FeedbackToolDeps {
  isConfigured: () => boolean;
  detectPlatform: () => string;
  detectObsidianVersion: () => string;
  detectPluginVersion: (ctx: ToolContext) => string;
  now: () => Date;
}

/** 未配置凭据时的统一提示——不呈现一个必然失败的确认流程。 */
export const NOT_CONFIGURED =
  'Feedback is not configured in this build. The feedback feature needs a credential that is injected at build time; use the GitHub web form instead.';

export function detectPlatformDefault(): string {
  const platform = Platform as (typeof Platform) | undefined;
  if (!platform) return 'unknown';
  if (platform.isWin) return 'Windows';
  if (platform.isMacOS) return 'macOS';
  if (platform.isLinux) return 'Linux';
  if (platform.isIosApp) return 'iOS';
  if (platform.isAndroidApp) return 'Android';
  return 'unknown';
}

export function detectObsidianVersionDefault(): string {
  // Obsidian 把 apiVersion 作为模块级导出暴露；取不到时如实写 unknown，
  // 而不是编一个看起来合理的版本号。
  return typeof apiVersion === 'string' && apiVersion ? apiVersion : 'unknown';
}

export function detectPluginVersionDefault(ctx: ToolContext): string {
  const manifest = ctx.app.plugins?.manifests?.[PLUGIN_ID];
  return typeof manifest?.version === 'string' && manifest.version ? manifest.version : 'unknown';
}

/** 当前 active provider 的 type 与 label。label 只用于内部映射，不进快照。 */
function activeProvider(settings: ToolContext['settings']): { type?: ProviderType; label?: string } {
  const config = settings.providers?.[settings.activeProvider] as ProviderConfig | undefined;
  return { type: config?.type, label: config?.label };
}

export function buildSnapshot(ctx: ToolContext, deps: ResolvedDeps): DiagnosticsSnapshot {
  const provider = activeProvider(ctx.settings);
  return buildDiagnosticsSnapshot({
    pluginVersion: deps.detectPluginVersion(ctx),
    obsidianVersion: deps.detectObsidianVersion(),
    platform: deps.detectPlatform(),
    providerType: provider.type,
    providerLabel: provider.label,
    now: deps.now,
  });
}

/**
 * 执行期兜底（BR1.6）：ctx.conversationId 缺失时拒绝。它识别不了「首次调用」
 * （此时还没有草稿），所以定位是重放/串台防护，可见性由 visibility 声明负责。
 */
export function resolveConversationId(ctx: ToolContext): string | undefined {
  const id = typeof ctx.conversationId === 'string' ? ctx.conversationId.trim() : '';
  return id || undefined;
}

// ==================== 字段收集 ====================

const FIELD_ALIASES: Record<string, string> = {
  'what-happened': 'whatHappened',
  repro: 'repro',
  problem: 'problem',
  proposal: 'proposal',
  workaround: 'workaround',
  surface: 'surface',
};

/**
 * 把模型给的字段值收集成模板字段表。
 *
 * dropdown 类字段（surface）必须落在模板的选项集合内——写一个模板没有的取值会让
 * issue 结构与仓库模板漂移，而同源测试锁不住运行时数据。给模型一个可纠正的错误，
 * 比静默改写它给的取值诚实。
 */
export function collectFields(
  type: FeedbackIssueType,
  args: ToolArgs,
): { ok: true; fields: Record<string, string | undefined> } | { ok: false; error: string } {
  const fields: Record<string, string | undefined> = {};
  for (const field of templateFields(type)) {
    const key = FIELD_ALIASES[field.id];
    if (!key) continue;
    const value = strArg(args, key);
    if (value === undefined) continue;
    if (field.options && !field.options.includes(value)) {
      return { ok: false, error: invalidFieldValue(field, value) };
    }
    fields[field.id] = value;
  }
  return { ok: true, fields };
}

function invalidFieldValue(field: TemplateField, provided: string): string {
  return `"${provided}" is not a valid value for ${field.label}. Valid values: ${(field.options ?? []).join(' | ')}`;
}

// ==================== 载荷 ====================

export type BuildPayloadResult =
  | { ok: true; payload: IssuePayload; title?: string; type?: FeedbackIssueType }
  | { ok: false; error: string };

export function buildPayload(
  deps: ResolvedDeps,
  ctx: ToolContext,
  args: ToolArgs,
  kind: FeedbackDraftKindArg,
): BuildPayloadResult {
  return kind === 'issue_comment'
    ? buildCommentPayload(args)
    : buildIssuePayload(deps, ctx, args);
}

function buildCommentPayload(args: ToolArgs): BuildPayloadResult {
  const issueNumber = numArg(args, 'issueNumber');
  const body = strArg(args, 'body');
  if (!Number.isInteger(issueNumber) || (issueNumber ?? 0) <= 0) {
    return { ok: false, error: 'Missing or invalid issueNumber parameter' };
  }
  if (body === undefined || !body.trim()) return { ok: false, error: 'Missing body parameter' };
  return {
    ok: true,
    payload: {
      kind: 'issue_comment',
      repo: FEEDBACK_REPO,
      body,
      issueNumber,
      draftId: '',
      dedupKey: computeDedupKey({ kind: 'issue_comment', targetIssueNumber: issueNumber, body }),
    },
  };
}

function buildIssuePayload(deps: ResolvedDeps, ctx: ToolContext, args: ToolArgs): BuildPayloadResult {
  const rawType = strArg(args, 'type');
  if (rawType !== 'bug' && rawType !== 'enhancement') {
    return { ok: false, error: '"type" must be "bug" or "enhancement".' };
  }
  const rawTitle = strArg(args, 'title');
  if (rawTitle === undefined || !rawTitle.trim()) return { ok: false, error: 'Missing title parameter' };

  const collected = collectFields(rawType, args);
  if (!collected.ok) return collected;

  const snapshot = buildSnapshot(ctx, deps);
  const fields = {
    ...diagnosticFields(snapshot, { privacyMode: ctx.settings.privacyMode === true }),
    ...collected.fields,
  };
  const rendered = renderIssueBody({ type: rawType, fields, diagnostics: snapshot });
  if (!rendered.ok) return { ok: false, error: rendered.error };

  const title = singleLine(rawTitle);
  return {
    ok: true,
    type: rawType,
    title,
    payload: {
      kind: 'new_issue',
      repo: FEEDBACK_REPO,
      title,
      body: rendered.body,
      labels: TEMPLATE_LABELS[rawType],
      draftId: '',
      dedupKey: computeDedupKey({ kind: 'new_issue', title, body: rendered.body }),
    },
  };
}

export type ReadPayloadResult = { ok: true; value: IssuePayload } | { ok: false; error: string };

/**
 * 批准后的执行以 `request.args` 为唯一来源——**绝不重新渲染**（那会覆盖用户在卡片上的
 * 编辑，而这是一个不可撤销的公开写操作）。
 */
export function readApprovedPayload(args: ToolArgs, kind: FeedbackDraftKindArg): ReadPayloadResult {
  const draftId = strArg(args, 'draftId');
  const body = strArg(args, 'body');
  if (!draftId) return { ok: false, error: 'Missing draftId in the approved payload' };
  if (body === undefined || !body.trim()) return { ok: false, error: 'Missing body in the approved payload' };

  const issueNumber = numArg(args, 'issueNumber');
  if (kind === 'issue_comment' && (!Number.isInteger(issueNumber) || (issueNumber ?? 0) <= 0)) {
    return { ok: false, error: 'Missing issueNumber in the approved payload' };
  }

  const labels = Array.isArray(args.labels)
    ? (args.labels as unknown[]).filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    ok: true,
    value: {
      kind,
      repo: strArg(args, 'repo') || FEEDBACK_REPO,
      title: strArg(args, 'title'),
      body,
      labels,
      issueNumber: kind === 'issue_comment' ? issueNumber : undefined,
      draftId,
      dedupKey: strArg(args, 'dedupKey') ?? '',
    },
  };
}

// ==================== 审批响应 ====================

/**
 * 审批响应。
 *
 * `args` 就是 IssuePayload，也就是可编辑字节的唯一权威：卡片从它渲染、编辑写回它、
 * 执行提交它。preview 只承载**不可编辑**的元信息——它也会被持久化，一旦持有字节，
 * 重挂载后卡片就会显示旧正文而提交走 args 里的新正文。
 */
export function approvalResponse(payload: IssuePayload, message: string): ToolResult {
  const isComment = payload.kind === 'issue_comment';
  return {
    approval_required: true,
    action: isComment ? 'add_issue_comment' : 'create_github_issue',
    target: payload.repo,
    args: payload,
    message,
    preview: {
      kind: 'external-publish',
      target: isComment
        ? `https://github.com/${payload.repo}/issues/${payload.issueNumber}`
        : `https://github.com/${payload.repo}/issues`,
      summary: isComment ? `Comment on #${payload.issueNumber}` : `New issue in ${payload.repo}`,
      risk: 'high',
      supportsPartialApply: false,
      undoable: false,
      externalPublish: {
        repo: payload.repo,
        kind: payload.kind,
        issueNumber: payload.issueNumber,
        labels: payload.labels ?? [],
      },
    },
  };
}

/** 已提交过的草稿：直接回显既有结果，不进入确认流程、不新建。 */
export function alreadySubmittedResult(draft: FeedbackDraft): ToolResult {
  return {
    success: true,
    alreadySubmitted: true,
    issueNumber: draft.submittedIssueNumber,
    issueUrl: draft.submittedIssueUrl,
    message: `This feedback was already submitted: ${draft.submittedIssueUrl ?? ''}`,
  };
}

export function describeApproval(kind: FeedbackDraftKindArg, payload: IssuePayload): string {
  return kind === 'issue_comment'
    ? `Approval required to comment on issue #${payload.issueNumber} in ${payload.repo}.`
    : `Approval required to create a new issue in ${payload.repo}.`;
}
