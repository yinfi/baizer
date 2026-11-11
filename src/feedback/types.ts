// src/feedback/types.ts — 反馈功能的数据形状
//
// 形状与 aidlc 设计产物 construction/functional-design/entities.md 一一对应：
// 一个持久化实体（FeedbackDraft）与三个派生值对象（IssuePayload /
// DiagnosticsSnapshot / IssueCandidate）。派生值对象不单独持久化。

/** 一次反馈的两种模式：在目标仓库新建 issue，或向已有 issue 追加评论。 */
export type FeedbackDraftKind = 'new_issue' | 'issue_comment';

/** 草稿生命周期。submitted 是成功终态；failed 可回到 submitting（重试）。 */
export type FeedbackDraftStatus =
  | 'draft'
  | 'awaiting_confirmation'
  | 'submitting'
  | 'submitted'
  | 'failed';

/** 模板侧的类型分类：bug 走 bug_report，enhancement 走 feature_request。 */
export type FeedbackIssueType = 'bug' | 'enhancement';

/** 提交失败分类（决策表 1）。每一类对应一句不同的用户可见提示。 */
export type FeedbackErrorCategory =
  | 'credentials'      // 401：内置凭据已失效
  | 'permission'       // 403 无 Retry-After：权限不足
  | 'rate_limited'     // 403/429 带 Retry-After
  | 'not_found'        // 404：目标仓库不可用
  | 'rejected'         // 422：仓库规则拒绝
  | 'network';         // 超时 / DNS / TLS

export interface FeedbackLastError {
  category: FeedbackErrorCategory;
  httpStatus?: number;
  /** 已脱敏的短文本——不得含 token、请求头、绝对路径。 */
  message: string;
  at: string;
}

/**
 * 一次反馈的载荷与其生命周期。本功能唯一的持久化实体。
 *
 * 它承载「用户已经确认过、可能还没提交成功」的内容，使关闭会话、提交失败、
 * 插件重启都不丢用户输入。
 */
export interface FeedbackDraft {
  id: string;
  kind: FeedbackDraftKind;
  targetRepo: string;
  /** kind = issue_comment 时必填；kind = new_issue 时必须为 undefined。 */
  targetIssueNumber?: number;
  /** kind = new_issue 时必填且单行；issue_comment 时不存在。 */
  title?: string;
  body: string;
  /** kind = new_issue 时必填。 */
  type?: FeedbackIssueType;
  /** kind = new_issue 时必填，取值由 type 唯一决定。 */
  labels?: string[];
  /**
   * 渲染时的内容派生键，一经派生不再随卡片编辑变化。
   *
   * 它仍是内容派生：对话里改写内容会派生新键，匹配不到旧草稿就新建一份。
   * 卡片编辑写的是 IssuePayload（审批请求的 args），不改本字段——否则用户改一个
   * 字就能绕过幂等。
   */
  dedupKey: string;
  /** 发起它的反馈 tab id。 */
  sourceConversationId: string;
  status: FeedbackDraftStatus;
  /** 每次实际发出写入请求前自增，用于退避上限判定。 */
  attempts: number;
  lastError?: FeedbackLastError;
  submittedIssueNumber?: number;
  submittedIssueUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一次对外写入的最终字节。派生值对象——**它就是审批请求的 args**：
 * 卡片从它渲染、编辑写回它、执行提交它。三者同源是本设计对不可撤销公开写入的
 * 核心不变量，任何一处另存副本都会重新引入「展示 ≠ 提交」。
 */
export interface IssuePayload {
  kind: FeedbackDraftKind;
  repo: string;
  title?: string;
  body: string;
  labels?: string[];
  issueNumber?: number;
  draftId: string;
  dedupKey: string;
}

/** provider 落到 bug_report.yml 下拉域之后的取值（见 issue-template.ts 的映射表）。 */
export type DiagnosticsProvider =
  | 'Google Gemini'
  | 'OpenAI'
  | 'DeepSeek'
  | 'Qwen / DashScope'
  | 'Other OpenAI-compatible endpoint'
  | 'Anthropic'
  | 'Not relevant to this bug';

/**
 * 固定白名单的诊断快照。字段集合封闭——不接受任何调用方传入的字段名或查询参数，
 * 边界由 get_plugin_diagnostics 的工具签名强制，而不是靠提示词约束。
 */
export interface DiagnosticsSnapshot {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  provider: DiagnosticsProvider;
  /** 会话内错误环形缓冲的最新一条；缺失是合法状态。 */
  lastErrorDigest?: string;
  generatedAt: string;
}

/** 去重检索返回的候选。来自外部系统，按不可信内容处理。 */
export interface IssueCandidate {
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  updatedAt?: string;
}
