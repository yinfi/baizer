#!/usr/bin/env node
/**
 * 发布前的反馈凭据 preflight（BR9.2）。
 *
 * 两步，缺一不可：
 *   1. secret 非空——否则构建出来的版本没有反馈能力；
 *   2. 用该 token 发一次 GET /repos/<repo> 探活，非 2xx 即失败。
 *
 * 为什么非空校验不够：secret 里可能是一个**已撤销/已过期**的 token。那种情况下
 * 非空校验通过、构建成功、Release 发布，而所有用户拿到的是一个必然 401 的版本，
 * 现象还是静默的（用户只会觉得反馈按钮不好使）。一次 GET 的代价与「一轮发布 +
 * 全体用户升级」完全不成比例。
 *
 * 边界：只验「凭据可用」，不验「权限范围恰好是 Issues: write」——后者需要一次真实
 * 写入才能确证，不适合放进发布门禁，留给轮换 runbook 的人工步骤。
 *
 * 本脚本绝不回显 token（GitHub Actions 会 mask secrets，但不依赖它）。
 */

const REPO = 'yinfi/baizer';

const token = (process.env.BAIZER_FEEDBACK_TOKEN || '').trim();
if (!token) {
	console.error('[preflight] BAIZER_FEEDBACK_TOKEN is empty. Refusing to publish a release without a working feedback credential.');
	process.exit(1);
}

let response;
try {
	response = await fetch(`https://api.github.com/repos/${REPO}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'baizer-release-preflight',
		},
	});
} catch (error) {
	console.error(`[preflight] Could not reach the GitHub API: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

if (response.status < 200 || response.status >= 300) {
	// 只报状态码，不打印响应体——响应体里可能带请求上下文。
	console.error(`[preflight] GET /repos/${REPO} returned HTTP ${response.status}. The built-in credential is not usable; refusing to publish.`);
	process.exit(1);
}

const body = await response.json().catch(() => ({}));
if (body?.has_issues === false) {
	console.error(`[preflight] ${REPO} is reachable but its Issues are disabled. Refusing to publish.`);
	process.exit(1);
}

console.log(`[preflight] Credential OK; ${REPO} is reachable and Issues are enabled.`);
