// src/utils/credential-pattern.ts — GitHub 凭据字面量的统一识别
//
// 与 scripts/guard-credentials.sh 的正则同源：前缀之后 ≥30 字符。真实凭据的长度是
// 确定的（classic / OAuth / App / refresh / server-to-server = 前缀 + 36 字符，
// fine-grained PAT = github_pat_ + 80 余字符），把阈值定在真实格式长度上，低于真实
// 长度的合成 fixture 就永不误报。

/** 命中即为疑似凭据。global 标志由调用方按需构造，避免共享 lastIndex 状态。 */
export const CREDENTIAL_PATTERN_SOURCE = '(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{30,}';

export function looksLikeCredential(value: string): boolean {
  return new RegExp(CREDENTIAL_PATTERN_SOURCE).test(value);
}

/** 把文本里所有疑似凭据替换为占位符。 */
export function redactCredentialLiterals(text: string): string {
  return text.replace(new RegExp(CREDENTIAL_PATTERN_SOURCE, 'g'), '[redacted-credential]');
}
