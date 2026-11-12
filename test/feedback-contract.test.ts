// test/feedback-contract.test.ts — 反馈功能的契约锁定
//
// 覆盖四组「错了不会被别处发现」的契约：
//   1. 插件字段清单 / dropdown 选项 / label 与 .github/ISSUE_TEMPLATE/*.yml 同源
//   2. 正文渲染的确定性与必填语义
//   3. 提交失败分类与幂等键
//   4. 读侧点目录守卫与凭据识别

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import {
  BUG_TEMPLATE_FIELDS,
  FEATURE_TEMPLATE_FIELDS,
  PROVIDER_MAPPING,
  PROVIDER_OPTIONS,
  PROVIDER_TEMPLATE_EXCEPTIONS,
  renderIssueBody,
  resolveProvider,
  singleLine,
  TEMPLATE_LABELS,
  type TemplateField,
} from '../src/feedback/issue-template';
import { computeDedupKey } from '../src/feedback/drafts';
import { classifyHttpFailure, parseRetryAfter, sanitizeExternalText, toCandidates } from '../src/feedback/github';
import { buildErrorDigest } from '../src/feedback/diagnostics';
import { isConfigDirPath, isPluginBundlePath, isReadDeniedPath } from '../src/permissions/read-guard';
import { looksLikeCredential } from '../src/utils/credential-pattern';
import { redactCredentials } from '../src/feedback/config';

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

interface RawTemplateField {
  type?: unknown;
  id?: unknown;
  attributes?: { label?: unknown; options?: unknown };
  validations?: { required?: unknown };
}

interface RawTemplate {
  labels?: unknown;
  body?: unknown;
}

function readTemplate(name: string): RawTemplate {
  return parse(readFileSync(join(process.cwd(), '.github/ISSUE_TEMPLATE', name), 'utf8')) as RawTemplate;
}

/** 模板里真正可填的字段（textarea / input / dropdown）；markdown 引导块不算。 */
function fillableFields(template: RawTemplate): RawTemplateField[] {
  const body = Array.isArray(template.body) ? (template.body as RawTemplateField[]) : [];
  return body.filter(entry => ['textarea', 'input', 'dropdown'].includes(String(entry.type)));
}

function assertTemplateMatches(name: string, expected: TemplateField[], expectedLabels: string[]) {
  const template = readTemplate(name);
  const actual = fillableFields(template);

  expectEqual(actual.map(field => field.id), expected.map(field => field.id),
    `${name}: fillable field ids (and their order)`);
  expectEqual(
    actual.map(field => field.attributes?.label),
    expected.map(field => field.label),
    `${name}: field labels`,
  );
  expectEqual(
    actual.map(field => field.validations?.required === true),
    expected.map(field => field.required),
    `${name}: required flags`,
  );
  // dropdown 的合法取值就是模板的全部信息量——只比对字段 id 等于没锁。
  expectEqual(
    actual.map(field => (Array.isArray(field.attributes?.options) ? field.attributes?.options : undefined)),
    expected.map(field => field.options),
    `${name}: dropdown option values`,
  );
  expectEqual(template.labels, expectedLabels, `${name}: labels`);
}

async function runTests() {
  console.log('=== Feedback Contract Tests ===');

  await test('the plugin field list matches bug_report.yml exactly', () => {
    assertTemplateMatches('bug_report.yml', BUG_TEMPLATE_FIELDS, TEMPLATE_LABELS.bug);
  });

  await test('the plugin field list matches feature_request.yml exactly', () => {
    assertTemplateMatches('feature_request.yml', FEATURE_TEMPLATE_FIELDS, TEMPLATE_LABELS.enhancement);
  });

  await test('every mapped provider value exists in the template dropdown (or is a declared exception)', () => {
    const template = readTemplate('bug_report.yml');
    const providerField = fillableFields(template).find(field => field.id === 'provider');
    const options = (providerField?.attributes?.options ?? []) as string[];

    const mapped = new Set(PROVIDER_MAPPING.map(rule => rule.value));
    const allowed = new Set([...options, ...PROVIDER_TEMPLATE_EXCEPTIONS]);
    const uncovered = [...mapped].filter(value => !allowed.has(value));
    expectEqual(uncovered, [], 'mapped values missing from the template dropdown');
    if (PROVIDER_TEMPLATE_EXCEPTIONS.length) {
      // 例外必须可见：写进测试输出，而不是让它悄悄通过。
      console.log(`    (declared template exceptions: ${PROVIDER_TEMPLATE_EXCEPTIONS.join(', ')})`);
    }

    // 覆盖性：模板的每个下拉项都能被映射取到。
    const reachable = new Set(PROVIDER_MAPPING.map(rule => rule.value));
    expectEqual(options.filter(option => !reachable.has(option as never)), [],
      'template options that the mapping can never produce');
  });

  await test('each providerType has exactly one fallback rule (exhaustiveness)', () => {
    for (const type of ['openai-compatible', 'anthropic', 'unconfigured'] as const) {
      const fallbacks = PROVIDER_MAPPING.filter(rule => rule.providerType === type && !rule.labelMatches);
      expectEqual(fallbacks.length, 1, `fallback rule count for ${type}`);
    }
  });

  await test('provider labels map deterministically onto the template domain', () => {
    expectEqual(resolveProvider('openai-compatible', 'Google Gemini'), 'Google Gemini', 'gemini label');
    expectEqual(resolveProvider('openai-compatible', 'My GPT proxy'), 'OpenAI', 'gpt label');
    expectEqual(resolveProvider('openai-compatible', 'deepseek-chat'), 'DeepSeek', 'deepseek label');
    expectEqual(resolveProvider('openai-compatible', 'DashScope'), 'Qwen / DashScope', 'qwen label');
    expectEqual(resolveProvider('openai-compatible', 'My private endpoint'), 'Other OpenAI-compatible endpoint', 'unknown label');
    expectEqual(resolveProvider('anthropic', 'Claude'), 'Anthropic', 'anthropic');
    expectEqual(resolveProvider(undefined, undefined), 'Not relevant to this bug', 'unconfigured');
    // Anthropic 不得被塞进 OpenAI 兼容那一项——那是事实错误，会误导 triage。
    expectEqual(PROVIDER_OPTIONS.includes('Anthropic'), true, 'the template must offer an Anthropic option');
  });

  await test('the issue body renders deterministically from the template fields', () => {
    const diagnostics = {
      pluginVersion: '1.7.2',
      obsidianVersion: '1.9.0',
      platform: 'Windows',
      provider: 'OpenAI' as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fields = {
      'what-happened': 'The sidebar is blank.',
      repro: '1. Open\n2. Look',
      'plugin-version': '1.7.2',
      'obsidian-version': '1.9.0',
      platform: 'Windows',
      provider: 'OpenAI',
    };
    const first = renderIssueBody({ type: 'bug', fields, diagnostics });
    const second = renderIssueBody({ type: 'bug', fields, diagnostics });
    expect(first.ok && second.ok, 'both renders must succeed');
    expectEqual(first, second, 'identical inputs must produce byte-identical output');
    const body = first.ok ? first.body : '';
    expect(body.startsWith('### What happened'), 'the section order must follow the template');
    expect(body.includes('### Where it happened\n\nSomewhere else / not sure'),
      'a missing dropdown falls back to the documented value');
    expect(body.includes('### Console output\n\n无'), 'a missing optional section is filled explicitly');
  });

  await test('a missing required field fails the render instead of silently filling 无', () => {
    const result = renderIssueBody({
      type: 'bug',
      fields: { repro: '1. Open it' },
      diagnostics: { pluginVersion: '1', obsidianVersion: '1', platform: 'Linux', provider: 'OpenAI', generatedAt: '' },
    });
    expectEqual(result.ok, false, 'a bug without "what happened" must not render');
  });

  await test('the title is folded to a single line while the body keeps its bytes', () => {
    expectEqual(singleLine('Line one\n\nLine two'), 'Line one Line two', 'title folding');
  });

  await test('the dedup key ignores whitespace and line-ending differences but not content', () => {
    const a = computeDedupKey({ kind: 'new_issue', title: 'Crash', body: 'It crashes.' });
    const b = computeDedupKey({ kind: 'new_issue', title: 'Crash', body: 'It  crashes.\r\n' });
    const c = computeDedupKey({ kind: 'new_issue', title: 'Crash', body: 'It hangs.' });
    expectEqual(a, b, 'whitespace-only differences must share a key');
    expect(a !== c, 'different content must produce a different key');
    const comment = computeDedupKey({ kind: 'issue_comment', targetIssueNumber: 7, body: 'It crashes.' });
    expect(a !== comment, 'the two kinds must not collide');
  });

  await test('submission failures are classified per the decision table', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expectEqual(classifyHttpFailure(401, {}, '', at).error.category, 'credentials', '401');
    expectEqual(classifyHttpFailure(403, {}, '', at).error.category, 'permission', '403 without Retry-After');
    expectEqual(classifyHttpFailure(403, { 'Retry-After': '2' }, '', at).error.category, 'rate_limited', '403 with Retry-After');
    expectEqual(classifyHttpFailure(429, {}, '', at).error.category, 'rate_limited', '429');
    expectEqual(classifyHttpFailure(404, {}, '', at).error.category, 'not_found', '404');
    expectEqual(classifyHttpFailure(422, {}, 'Validation Failed', at).error.category, 'rejected', '422');
    expectEqual(classifyHttpFailure(500, {}, '', at).error.category, 'network', 'unexpected status');
    expectEqual(parseRetryAfter({ 'Retry-After': '3' }), 3000, 'Retry-After seconds');
  });

  await test('an error digest is single-lined, truncated, and stripped of paths', () => {
    const digest = buildErrorDigest(`Boom at C:\\Users\\someone\\vault\\note.md\n${'x'.repeat(400)}`);
    expect(!!digest, 'a non-empty error must produce a digest');
    expect(!digest!.includes('\n'), 'the digest must be a single line');
    expect(digest!.length <= 300, 'the digest must be truncated');
    expect(!digest!.includes('someone'), 'local paths must be redacted');
    expectEqual(buildErrorDigest('   '), undefined, 'a blank error produces nothing');
  });

  await test('external issue candidates are sanitized and URL-validated', () => {
    const candidates = toCandidates({
      items: [
        { number: 1, title: 'Bad\u0000 title\nwith newlines', state: 'open', html_url: 'https://github.com/yinfi/baizer/issues/1' },
        { number: 2, title: 'Evil', state: 'open', html_url: 'https://evil.example.com/2' },
        { number: 3, title: 'No url' },
      ],
    }, 'yinfi/baizer');
    expectEqual(candidates.length, 1, 'only well-formed candidates survive');
    expectEqual(candidates[0].title, 'Bad title with newlines', 'control characters and newlines are removed');
  });

  await test('sanitizeExternalText truncates to 200 characters', () => {
    expectEqual(sanitizeExternalText('y'.repeat(500)).length, 200, 'truncation');
  });

  await test('the read guard rejects the config directory and the plugin bundle explicitly', () => {
    expectEqual(isConfigDirPath('.obsidian', '.obsidian'), true, 'the config dir itself');
    expectEqual(isConfigDirPath('.obsidian', '.obsidian/plugins/baizer/main.js'), true, 'a path inside it');
    expectEqual(isConfigDirPath('.obsidian', 'Notes/Daily.md'), false, 'an ordinary note');
    // 前缀相似但不相同的目录名不能被误判。
    expectEqual(isConfigDirPath('.obsidian', '.obsidian-notes/a.md'), false, 'a lookalike directory');
    expectEqual(isPluginBundlePath('.obsidian', 'baizer', '.obsidian/plugins/baizer/main.js'), true, 'the bundle');
    expectEqual(isPluginBundlePath('.obsidian', 'baizer', '.obsidian/plugins/other/main.js'), false, 'another plugin');
    expectEqual(isReadDeniedPath('.obsidian', 'baizer', '.obsidian/plugins/baizer/main.js'), true, 'combined guard');
    expectEqual(isReadDeniedPath('.obsidian', 'baizer', 'Notes/a.md'), false, 'combined guard on a note');
  });

  await test('credential literals are recognized and redacted', () => {
    const fineGrained = `github_pat_${'A'.repeat(82)}`;
    const classic = `ghp_${'A'.repeat(36)}`;
    expectEqual(looksLikeCredential(fineGrained), true, 'fine-grained PAT');
    expectEqual(looksLikeCredential(classic), true, 'classic PAT');
    // 低于真实长度的合成串永不误报——守卫因此不需要白名单。
    expectEqual(looksLikeCredential('ghp_abcdefghij12'), false, 'a short synthetic fixture');
    expect(!redactCredentials(`token=${classic}`).includes(classic), 'redaction must remove the literal');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
