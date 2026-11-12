// src/feedback/tools.ts — 四个反馈工具
//
// 可见性：四个工具都声明 visibility = 'feedback-session'，只在反馈会话的工具集里
// 出现（BR1.1 / 决策表 6）。反馈会话内部再以 feedback 技能声明的子集收窄——该子集
// 刻意不含任何 vault 读工具，反馈会话从能力上就没有读取用户笔记的路径。
//
// 审批：两个写入工具**不调用 needsApproval()**，由自身的 args.approved 判定驱动，
// 因此该确认不受 confirmExecutions 关闭的影响。用户关掉那个设置授权的是「改动你自己
// 的 vault」，不是「以你的名义公开发帖」——性质不同，既有设置不构成对这一动作的授权。
//
// 载荷的构造与渲染在 payload.ts；本文件只管工具契约与执行编排。

import type { Tool, ToolArgs, ToolContext, ToolResult } from '../skills/types';
import { strArg } from '../skills/tool-args';
import { isFeedbackConfigured } from './config';
import { recordFeedbackError } from './diagnostics';
import { describeFailure } from './github';
import {
  alreadySubmittedResult,
  approvalResponse,
  buildPayload,
  buildSnapshot,
  describeApproval,
  detectObsidianVersionDefault,
  detectPlatformDefault,
  detectPluginVersionDefault,
  NOT_CONFIGURED,
  readApprovedPayload,
  resolveConversationId,
  type FeedbackDraftKindArg,
  type FeedbackToolDeps,
  type ResolvedDeps,
} from './payload';

export type { FeedbackToolDeps } from './payload';

const VISIBILITY = 'feedback-session' as const;

function createGithubIssue(deps: ResolvedDeps): Tool {
  return {
    name: 'create_github_issue',
    description:
      'Prepare a new GitHub issue for the user to review and confirm. The first call renders the issue and returns an approval request; it does not publish anything. Only after the user approves does the issue get created.',
    executionMode: 'sequential',
    risk: 'write',
    visibility: VISIBILITY,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'enhancement'], description: 'Whether this is a defect report or a feature request.' },
        title: { type: 'string', description: 'Issue title, single line.' },
        whatHappened: { type: 'string', description: 'Bug only: what you expected and what happened instead.' },
        repro: { type: 'string', description: 'Bug only: numbered steps to reproduce.' },
        problem: { type: 'string', description: 'Feature only: the problem you are trying to solve.' },
        proposal: { type: 'string', description: 'Feature only: the shape you have in mind.' },
        workaround: { type: 'string', description: 'Feature only: how you handle it today.' },
        surface: { type: 'string', description: 'Which part of Baizer this is about. Must be one of the template dropdown values.' },
      },
      required: ['type', 'title'],
    },
    execute: async (args, ctx) => submitOrConfirm(deps, ctx, args, 'new_issue'),
  };
}

function addIssueComment(deps: ResolvedDeps): Tool {
  return {
    name: 'add_issue_comment',
    description:
      'Prepare a comment on an existing GitHub issue for the user to review and confirm. The first call renders the comment and returns an approval request; it does not publish anything.',
    executionMode: 'sequential',
    risk: 'write',
    visibility: VISIBILITY,
    parameters: {
      type: 'object',
      properties: {
        issueNumber: { type: 'integer', description: 'The number of the existing issue to comment on.' },
        body: { type: 'string', description: 'The full comment body, as Markdown.' },
      },
      required: ['issueNumber', 'body'],
    },
    execute: async (args, ctx) => submitOrConfirm(deps, ctx, args, 'issue_comment'),
  };
}

const searchGithubIssues = (deps: ResolvedDeps): Tool => ({
  name: 'search_github_issues',
  description:
    'Search the target repository for existing issues that may already describe the same problem. Returns candidates for the user to choose from — never decide on their behalf.',
  executionMode: 'parallel',
  risk: 'network',
  visibility: VISIBILITY,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords describing the problem, without quotes.' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    if (!deps.isConfigured()) return { results: [], message: NOT_CONFIGURED };
    const query = strArg(args, 'query');
    if (query === undefined || !query.trim()) return { results: [], message: 'Missing query parameter' };

    // 检索侧不退避（BR5.2）：触限即跳过去重并明示，不阻断澄清。
    const result = await deps.client.searchIssues(query.trim());
    if (!result.ok) {
      return {
        results: [],
        dedupSkipped: true,
        message: `Duplicate check skipped: ${describeFailure(result.error.category)}`,
      };
    }
    return { results: result.data, dedupSkipped: false };
  },
});

const getPluginDiagnostics = (deps: ResolvedDeps): Tool => ({
  name: 'get_plugin_diagnostics',
  description:
    'Read a fixed set of diagnostic facts about this plugin installation (versions, platform, provider). Takes no arguments — it cannot be used to read anything else.',
  executionMode: 'parallel',
  risk: 'read',
  visibility: VISIBILITY,
  parameters: { type: 'object', properties: {} },
  execute: async (_args, ctx) => ({ ...buildSnapshot(ctx, deps) }),
});

async function submitOrConfirm(
  deps: ResolvedDeps,
  ctx: ToolContext,
  args: ToolArgs,
  kind: FeedbackDraftKindArg,
): Promise<ToolResult> {
  if (!deps.isConfigured()) return { success: false, error: NOT_CONFIGURED };

  return args.approved === true
    ? performSubmit(deps, ctx, args, kind)
    : prepareConfirmation(deps, ctx, args, kind);
}

function prepareConfirmation(
  deps: ResolvedDeps,
  ctx: ToolContext,
  args: ToolArgs,
  kind: FeedbackDraftKindArg,
): ToolResult {
  const conversationId = resolveConversationId(ctx);
  if (!conversationId) {
    return { success: false, error: 'This tool can only run inside a feedback conversation.' };
  }

  const built = buildPayload(deps, ctx, args, kind);
  if (!built.ok) return { success: false, error: built.error };
  const { payload, title } = built;

  // 同 dedupKey 的草稿若属于另一个会话，说明这是一次串台/重放——拒绝，不猜。
  const existing = deps.drafts.findActiveByDedupKey(payload.dedupKey);
  if (existing && existing.sourceConversationId !== conversationId) {
    return { success: false, error: 'This draft belongs to another conversation.' };
  }

  const created = deps.drafts.createOrReuse({
    kind,
    targetRepo: payload.repo,
    targetIssueNumber: payload.issueNumber,
    title,
    body: payload.body,
    type: kind === 'new_issue' ? built.type : undefined,
    labels: payload.labels,
    dedupKey: payload.dedupKey,
    sourceConversationId: conversationId,
  });
  if (!created.ok) return { success: false, error: created.error };
  if (created.alreadySubmitted) return alreadySubmittedResult(created.draft);

  return approvalResponse({ ...payload, draftId: created.draft.id }, describeApproval(kind, payload));
}

async function performSubmit(
  deps: ResolvedDeps,
  ctx: ToolContext,
  args: ToolArgs,
  kind: FeedbackDraftKindArg,
): Promise<ToolResult> {
  const payload = readApprovedPayload(args, kind);
  if (!payload.ok) return { success: false, error: payload.error };

  const conversationId = resolveConversationId(ctx);
  if (!conversationId) {
    return { success: false, error: 'This tool can only run inside a feedback conversation.' };
  }

  // ③ 同步原子认领：读 status → 判 → 写 status 全在这一个同步块内，此前无 await。
  const claim = deps.drafts.claimForSubmit(payload.value.draftId);
  if (!claim.ok) {
    if (claim.reason === 'submitted' && claim.draft) return alreadySubmittedResult(claim.draft);
    if (claim.reason === 'submitting') {
      return { success: false, error: 'This submission is already in progress.' };
    }
    return { success: false, error: 'Unknown draft. Please prepare the feedback again.' };
  }
  if (claim.draft.sourceConversationId !== conversationId) {
    return { success: false, error: 'This draft belongs to another conversation.' };
  }

  const result = kind === 'issue_comment'
    ? await deps.client.addIssueComment({
      issueNumber: payload.value.issueNumber ?? 0,
      body: payload.value.body,
    })
    : await deps.client.createIssue({
      title: payload.value.title ?? '',
      body: payload.value.body,
      labels: payload.value.labels ?? [],
    });

  if (!result.ok) {
    deps.drafts.markFailed(claim.draft.id, result.error);
    await deps.drafts.flush();
    // 记进诊断缓冲：用户往往正是因为在别处碰了壁才来报障，这条失败本身也值得带进 issue。
    recordFeedbackError({ surface: 'feedback-submit', message: result.error.message });
    return { success: false, error: describeFailure(result.error.category), detail: result.error.message };
  }

  // 只有拿到 2xx 才允许声称成功、回显编号与链接（BR4.5）。
  deps.drafts.markSubmitted(claim.draft.id, {
    issueNumber: result.data.number,
    issueUrl: result.data.url,
    title: payload.value.title,
    body: payload.value.body,
  });
  await deps.drafts.flush();
  return {
    success: true,
    issueNumber: result.data.number,
    issueUrl: result.data.url,
    message: kind === 'issue_comment'
      ? `Comment posted: ${result.data.url}`
      : `Issue created: ${result.data.url}`,
  };
}

/** 注册四个反馈工具。deps 里的 store/client 由插件单实例持有。 */
export function registerFeedbackTools(
  registry: { register: (tool: Tool) => void },
  deps: FeedbackToolDeps,
): void {
  const resolved: ResolvedDeps = {
    ...deps,
    isConfigured: deps.isConfigured ?? isFeedbackConfigured,
    detectPlatform: deps.detectPlatform ?? detectPlatformDefault,
    detectObsidianVersion: deps.detectObsidianVersion ?? detectObsidianVersionDefault,
    detectPluginVersion: deps.detectPluginVersion ?? detectPluginVersionDefault,
    now: deps.now ?? (() => new Date()),
  };
  registry.register(searchGithubIssues(resolved));
  registry.register(getPluginDiagnostics(resolved));
  registry.register(createGithubIssue(resolved));
  registry.register(addIssueComment(resolved));
}
