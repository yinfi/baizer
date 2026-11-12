// src/feedback/config.ts — 反馈功能的固定配置与内置凭据
//
// 凭据形态（Q2=B）：用户在插件里不做任何配置，token 由构建期经 esbuild define
// 注入 bundle，用户零配置。**接受 token 随发行包公开**——这是已拍板的前提，
// 不是缺陷；不得在任何注释、文档或 UI 里把它描述为「加密」或「安全保护」。

declare const __BAIZER_FEEDBACK_TOKEN__: string;

import { redactCredentialLiterals } from '../utils/credential-pattern';

/** 目标仓库。只读常量，无配置路径（FR3.3 / Q4=A）。 */
export const FEEDBACK_REPO = 'yinfi/baizer';

/** 安全漏洞的私密上报入口，与 .github/ISSUE_TEMPLATE/config.yml 的 contact_links 一致。 */
export const SECURITY_ADVISORY_URL = `https://github.com/${FEEDBACK_REPO}/security/advisories/new`;

/** 未提交草稿（draft / awaiting_confirmation / failed）的总数上限。 */
export const MAX_PENDING_DRAFTS = 20;

/** 错误摘要的截断长度。 */
export const ERROR_DIGEST_MAX_CHARS = 300;

/**
 * 构建期注入的内置 token。
 *
 * esbuild 的 define 会把标识符替换成字面量；在未定义该 define 的环境（tsx 单测、
 * 直接执行源码）里 `typeof` 判定让它安全地退化为空串，而不是抛 ReferenceError。
 */
export function getFeedbackToken(): string {
  return typeof __BAIZER_FEEDBACK_TOKEN__ === 'string' ? __BAIZER_FEEDBACK_TOKEN__ : '';
}

/** 凭据是否已内置。空串即未配置（本地构建未注入），反馈功能给出「未配置」提示。 */
export function isFeedbackConfigured(): boolean {
  return getFeedbackToken().trim().length > 0;
}

/**
 * 把一段可能承载凭据的文本脱敏。
 *
 * 用于任何将要进入日志、错误、诊断、正文或 UI 的输出。只做确定性替换：
 * 命中 GitHub 凭据格式的串、以及 Authorization/Bearer 片段一律替换为占位符。
 */
export function redactCredentials(text: string): string {
  return redactCredentialLiterals(text)
    .replace(/\b(?:Bearer|token|Authorization:)\s*[A-Za-z0-9_\-.]{8,}/gi, '[redacted-credential]');
}

/** 内置 token 不得出现在任何用户可见输出里——统一经此裁剪。 */
export function stripFeedbackToken(text: string): string {
  const token = getFeedbackToken().trim();
  const redacted = redactCredentials(text);
  return token ? redacted.split(token).join('[redacted-credential]') : redacted;
}
