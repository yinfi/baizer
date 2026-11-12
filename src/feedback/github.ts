// src/feedback/github.ts — GitHub REST 客户端（提交、检索、探活）
//
// 只走 Obsidian 的 requestUrl，不引入新的 HTTP 依赖（移动端可用）。
// 所有失败都归到 FeedbackErrorCategory 上，每一类对应一句不同的、可操作的用户提示
// （决策表 1）——把所有失败归成一句「提交失败」，用户与发布方都无法判断该做什么。

import { stripFeedbackToken } from './config';
import type { FeedbackErrorCategory, FeedbackLastError, IssueCandidate } from './types';

export interface GithubRequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** false 时不因非 2xx 抛错，把响应原样交回给分类逻辑。 */
  throw?: boolean;
}

export interface GithubResponse {
  status: number;
  text: string;
  headers?: Record<string, string>;
}

export type GithubRequester = (options: GithubRequestOptions) => Promise<GithubResponse>;

export interface GithubFailure {
  ok: false;
  error: FeedbackLastError;
  /** 仅限流类失败带此值：调用方按它退避。 */
  retryAfterMs?: number;
}

export type GithubResult<T> = { ok: true; data: T } | GithubFailure;

const USER_AGENT = 'baizer-obsidian-plugin';
const MAX_ERROR_MESSAGE_CHARS = 300;

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/** 错误文本只取 status / statusText / message 层，绝不回显请求头或凭据。 */
function safeMessage(status: number, bodyText: string): string {
  const trimmed = stripFeedbackToken((bodyText ?? '').replace(/\s+/g, ' ').trim());
  const clipped = trimmed.length > MAX_ERROR_MESSAGE_CHARS ? trimmed.slice(0, MAX_ERROR_MESSAGE_CHARS) : trimmed;
  return clipped || `GitHub returned HTTP ${status}`;
}

/**
 * 非 2xx → 分类（决策表 1）。
 *
 * 401 通常意味着发布方已轮换而用户未升级；403 带 Retry-After 是限流、不带是权限不足；
 * 404 是目标仓库不可用；422 是仓库规则拒绝，需要回显仓库的具体报错。
 */
export function classifyHttpFailure(
  status: number,
  headers: Record<string, string> | undefined,
  bodyText: string,
  at: string,
): GithubFailure {
  const retryAfterMs = parseRetryAfter(headers);
  let category: FeedbackErrorCategory;
  if (status === 401) category = 'credentials';
  else if (status === 429) category = 'rate_limited';
  else if (status === 403) category = retryAfterMs !== undefined ? 'rate_limited' : 'permission';
  else if (status === 404) category = 'not_found';
  else if (status === 422) category = 'rejected';
  else category = 'network';

  return {
    ok: false,
    error: { category, httpStatus: status, message: safeMessage(status, bodyText), at },
    retryAfterMs,
  };
}

/** Retry-After（秒）优先，其次 x-ratelimit-reset（epoch 秒）。 */
export function parseRetryAfter(headers: Record<string, string> | undefined, nowMs = Date.now()): number | undefined {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - nowMs);
  }
  const reset = headerValue(headers, 'x-ratelimit-reset');
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, epochSeconds * 1000 - nowMs);
    }
  }
  return undefined;
}

/** 用户可见的分类提示。 */
export function describeFailure(category: FeedbackErrorCategory): string {
  switch (category) {
    case 'credentials':
      return 'The built-in credential is no longer valid. Update Baizer to the latest version and try again.';
    case 'permission':
      return 'The built-in credential lacks the Issues: write permission for this repository.';
    case 'rate_limited':
      return 'GitHub is rate limiting this request. Try again later.';
    case 'not_found':
      return 'The target repository does not exist or its Issues are disabled.';
    case 'rejected':
      return 'GitHub rejected the submission because of the repository rules.';
    default:
      return 'The request could not reach GitHub. It has been saved locally — you can retry later.';
  }
}

function networkFailure(error: unknown, at: string): GithubFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { category: 'network', message: safeMessage(0, message), at },
  };
}

export interface GithubClientDeps {
  request: GithubRequester;
  token: () => string;
  repo: string;
  now?: () => Date;
  /** 测试注入：等待实现。 */
  wait?: (ms: number) => Promise<void>;
}

/** 限流退避：有上限 + 抖动，避免多用户同时重试形成同步冲击。 */
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export class GithubClient {
  private readonly now: () => Date;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: GithubClientDeps) {
    this.now = deps.now ?? (() => new Date());
    this.wait = deps.wait ?? ((ms: number) => new Promise(resolve => window.setTimeout(resolve, ms)));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.deps.token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
  }

  private async send(options: GithubRequestOptions): Promise<GithubResult<unknown>> {
    const at = this.now().toISOString();
    let response: GithubResponse;
    try {
      response = await this.deps.request({ ...options, throw: false });
    } catch (error) {
      return networkFailure(error, at);
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, data: parseJson(response.text) };
    }
    return classifyHttpFailure(response.status, response.headers, response.text, at);
  }

  /**
   * 检索是否已有相同问题。
   *
   * **检索侧不退避**（BR5.2）：直接返回失败让调用方跳过去重并明示，避免在用户等待
   * 澄清结果时叠加不可预期的延迟。
   */
  async searchIssues(terms: string): Promise<GithubResult<IssueCandidate[]>> {
    const query = encodeURIComponent(`repo:${this.deps.repo} ${terms} in:title,body`);
    const url = `https://api.github.com/search/issues?q=${query}&per_page=5&sort=updated`;
    const result = await this.send({ url, method: 'GET', headers: this.headers() });
    if (!result.ok) return result;
    return { ok: true, data: toCandidates(result.data, this.deps.repo) };
  }

  /** 探活：只验「凭据可用」，不验权限范围恰好是 Issues: write。 */
  async probeRepo(): Promise<GithubResult<{ fullName: string; issuesEnabled: boolean }>> {
    const result = await this.send({
      url: `https://api.github.com/repos/${this.deps.repo}`,
      method: 'GET',
      headers: this.headers(),
    });
    if (!result.ok) return result;
    const data = (result.data ?? {}) as { full_name?: unknown; has_issues?: unknown };
    return {
      ok: true,
      data: {
        fullName: typeof data.full_name === 'string' ? data.full_name : this.deps.repo,
        issuesEnabled: data.has_issues !== false,
      },
    };
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<GithubResult<{ number: number; url: string }>> {
    const result = await this.submitWithBackoff({
      url: `https://api.github.com/repos/${this.deps.repo}/issues`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
    });
    if (!result.ok) return result;
    return { ok: true, data: toCreatedIssue(result.data, this.deps.repo) };
  }

  async addIssueComment(input: { issueNumber: number; body: string }): Promise<GithubResult<{ number: number; url: string }>> {
    const result = await this.submitWithBackoff({
      url: `https://api.github.com/repos/${this.deps.repo}/issues/${input.issueNumber}/comments`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ body: input.body }),
    });
    if (!result.ok) return result;
    const data = (result.data ?? {}) as { id?: unknown; html_url?: unknown };
    return {
      ok: true,
      data: {
        number: input.issueNumber,
        url: typeof data.html_url === 'string'
          ? data.html_url
          : `https://github.com/${this.deps.repo}/issues/${input.issueNumber}`,
      },
    };
  }

  /** 提交路径的退避重试：仅限流类，且次数有上限。 */
  private async submitWithBackoff(options: GithubRequestOptions): Promise<GithubResult<unknown>> {
    let last: GithubFailure = {
      ok: false,
      error: { category: 'network', message: 'No attempt was made.', at: this.now().toISOString() },
    };
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
      const result = await this.send(options);
      if (result.ok) return result;
      last = result;
      if (result.error.category !== 'rate_limited') return result;
      if (attempt === MAX_RETRY_ATTEMPTS - 1) break;
      const base = Math.min(result.retryAfterMs ?? 1000, MAX_RETRY_DELAY_MS);
      await this.wait(base + Math.floor(Math.random() * 250));
    }
    return last;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 外部内容按不可信数据处理：只映射结构化字段、单行化、截断 200 字符、剔除控制字符，
 * 且 url 只接受 `https://github.com/<repo>/issues/<n>` 形态（其余一律丢弃该候选）。
 */
export function toCandidates(payload: unknown, repo: string): IssueCandidate[] {
  const items = (payload as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const candidates: IssueCandidate[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as { number?: unknown; title?: unknown; state?: unknown; html_url?: unknown; updated_at?: unknown };
    if (typeof raw.number !== 'number' || !Number.isFinite(raw.number)) continue;
    if (typeof raw.html_url !== 'string' || !isIssueUrl(raw.html_url, repo, raw.number)) continue;
    const candidate: IssueCandidate = {
      number: raw.number,
      title: sanitizeExternalText(raw.title),
      state: raw.state === 'closed' ? 'closed' : 'open',
      url: raw.html_url,
    };
    if (typeof raw.updated_at === 'string') candidate.updatedAt = raw.updated_at;
    candidates.push(candidate);
  }
  return candidates;
}

function isIssueUrl(url: string, repo: string, number: number): boolean {
  return url === `https://github.com/${repo}/issues/${number}`;
}

/** 单行化 + 截断 + 剔除控制字符。 */
export function sanitizeExternalText(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  // 逐字符按码点判定，而不是用控制字符正则：no-control-regex 会拦下那种写法，
  // 而且「不可打印的一律换成空格」这个意图比字符类比更直白。
  const cleaned = Array.from(text)
    .map(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

function toCreatedIssue(payload: unknown, repo: string): { number: number; url: string } {
  const data = (payload ?? {}) as { number?: unknown; html_url?: unknown };
  const number = typeof data.number === 'number' && Number.isFinite(data.number) ? data.number : 0;
  const url = typeof data.html_url === 'string'
    ? data.html_url
    : number > 0 ? `https://github.com/${repo}/issues/${number}` : `https://github.com/${repo}/issues`;
  return { number, url };
}
