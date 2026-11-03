import { setLocaleForTesting } from '../src/i18n/zh';
import {
  getProtocolOptions,
  validateBaseUrl,
  validateCustomHeaders,
  validateProviderName,
} from '../src/settings';

// 断言用英文原文 key(t() 在非中文环境返回原文),固定 locale 保证与运行环境无关。
setLocaleForTesting(false);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
  };
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

async function runTests() {
  console.log('=== Settings Connection Validation Tests ===');

  // ── 服务商名称：空值必须出声,而不是静默回退旧名 ──

  await test('rejects an empty provider name instead of silently keeping the old one', () => {
    expect({
      empty: validateProviderName('').state,
      whitespace: validateProviderName('   ').state,
      named: validateProviderName('Gateway').state,
    }).toEqual({ empty: 'error', whitespace: 'error', named: 'ok' });
    assert(
      validateProviderName('').message.length > 0,
      'an invalid name must carry an in-place message',
    );
    expect(validateProviderName('Gateway').message).toEqual('');
  });

  // ── 服务地址：格式、必填、以及「不能带端点路径」 ──

  // 'gemini' 被移除后不存在「地址不适用」的协议：每一种可选协议都必须填地址，
  // 否则用户能选出一个永远发不出请求的配置。
  await test('treats the service address as required for every offered protocol', () => {
    for (const option of getProtocolOptions()) {
      expect({
        type: option.value,
        empty: validateBaseUrl(option.value, '').state,
        garbage: validateBaseUrl(option.value, 'not a url at all').state,
      }).toEqual({ type: option.value, empty: 'error', garbage: 'error' });
    }
  });

  await test('requires a service address for protocols that use one', () => {
    expect({
      openai: validateBaseUrl('openai-compatible', '').state,
      anthropic: validateBaseUrl('anthropic', '   ').state,
    }).toEqual({ openai: 'error', anthropic: 'error' });
    assert(
      /required/i.test(validateBaseUrl('openai-compatible', '').message),
      'the empty case must say the field is required',
    );
  });

  await test('rejects addresses without an http(s) scheme or with spaces', () => {
    expect({
      noScheme: validateBaseUrl('openai-compatible', 'api.openai.com/v1').state,
      spaces: validateBaseUrl('openai-compatible', 'https://api.openai.com/v1 extra').state,
      ok: validateBaseUrl('openai-compatible', 'https://api.openai.com/v1').state,
      httpOk: validateBaseUrl('openai-compatible', 'http://localhost:11434/v1').state,
    }).toEqual({ noScheme: 'error', spaces: 'error', ok: 'ok', httpOk: 'ok' });
  });

  await test('accepts a query string and a trailing slash on a valid address', () => {
    expect({
      query: validateBaseUrl('openai-compatible', 'https://api.example.com/v1?key=abc').state,
      trailingSlash: validateBaseUrl('openai-compatible', 'https://api.example.com/v1/').state,
      anthropic: validateBaseUrl('anthropic', 'https://api.anthropic.com').state,
    }).toEqual({ query: 'ok', trailingSlash: 'ok', anthropic: 'ok' });
  });

  // 各协议 SDK 自己追加端点路径,粘上完整路径就会请求 .../chat/completions/chat/completions。
  await test('rejects a base URL that already contains the endpoint path', () => {
    const chat = validateBaseUrl('openai-compatible', 'https://api.openai.com/v1/chat/completions');
    const responses = validateBaseUrl('openai-compatible', 'https://api.openai.com/v1/responses');
    const messages = validateBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages');

    expect({ chat: chat.state, responses: responses.state, messages: messages.state })
      .toEqual({ chat: 'error', responses: 'error', messages: 'error' });
    assert(
      chat.message.includes('/chat/completions'),
      `the message must name the offending path, got: ${chat.message}`,
    );
    assert(
      messages.message.includes('/v1/messages'),
      `the message must name the offending path, got: ${messages.message}`,
    );
  });

  // 冻结接口:官方 Anthropic 地址是 https://api.anthropic.com,SDK 追加 /v1/messages。
  await test('rejects a /v1 suffix for Anthropic and explains why', () => {
    const withV1 = validateBaseUrl('anthropic', 'https://api.anthropic.com/v1');
    const withSlash = validateBaseUrl('anthropic', 'https://api.anthropic.com/v1/');

    expect({ withV1: withV1.state, withSlash: withSlash.state })
      .toEqual({ withV1: 'error', withSlash: 'error' });
    assert(
      withV1.message.includes('/v1/messages'),
      `the message must explain the SDK appends /v1/messages, got: ${withV1.message}`,
    );
    // /v1 结尾对 OpenAI 兼容协议是正常的,不能被同一条规则误伤。
    expect(validateBaseUrl('openai-compatible', 'https://api.openai.com/v1').state).toEqual('ok');
  });

  // ── 多行 header：非法行出声,但其余行不能丢 ──

  await test('accepts well-formed header lines and ignores blank lines', () => {
    const result = validateCustomHeaders('x-a: 1\n\n  \nx-b: 2');

    expect({
      state: result.state,
      message: result.message,
      issues: result.issues.length,
      headers: result.headers,
    }).toEqual({
      state: 'ok',
      message: '',
      issues: 0,
      headers: { 'x-a': '1', 'x-b': '2' },
    });
  });

  await test('reports an empty header block as ok with no headers', () => {
    const result = validateCustomHeaders('');

    expect({ state: result.state, headers: result.headers })
      .toEqual({ state: 'ok', headers: undefined });
  });

  // issue 原文:parseCustomHeaders() 静默忽略没有冒号的行。现在必须给出可读反馈。
  await test('flags a line without a colon instead of silently dropping it', () => {
    const result = validateCustomHeaders('x-a: 1\nbroken line\nx-b: 2');

    expect({
      state: result.state,
      issues: result.issues.map(issue => ({ line: issue.line, reason: issue.reason })),
    }).toEqual({
      state: 'error',
      issues: [{ line: 2, reason: 'missing-colon' }],
    });
    assert(result.message.length > 0, 'a bad line must produce a non-empty message');
    assert(
      result.message.includes('L2'),
      `the message must name the offending line, got: ${result.message}`,
    );
    // 关键:正在敲的那一行不能把已经配好的其它 header 一起清掉。
    expect(result.headers).toEqual({ 'x-a': '1', 'x-b': '2' });
  });

  await test('flags a line whose header name is empty', () => {
    const result = validateCustomHeaders(': value');

    expect({
      state: result.state,
      reason: result.issues[0]?.reason,
      headers: result.headers,
    }).toEqual({ state: 'error', reason: 'empty-name', headers: undefined });
  });

  await test('treats a duplicated header name as a warning, not an error', () => {
    const result = validateCustomHeaders('x-a: 1\nx-a: 2');

    expect({
      state: result.state,
      reason: result.issues[0]?.reason,
      // 后一行覆盖前一行——这一点必须让用户知道,但不能把配置判成坏的。
      headers: result.headers,
    }).toEqual({
      state: 'warning',
      reason: 'duplicate-name',
      headers: { 'x-a': '2' },
    });
  });

  await test('compares header names case-insensitively for duplicates', () => {
    const result = validateCustomHeaders('X-Session: 1\nx-session: 2');

    expect({ state: result.state, issues: result.issues.length })
      .toEqual({ state: 'warning', issues: 1 });
  });

  await test('reports every offending line at once', () => {
    const result = validateCustomHeaders('ok: 1\nnope\n: 2\nok: 3');

    expect(result.issues.map(issue => issue.line)).toEqual([2, 3, 4]);
    assert(
      result.message.includes('L2') && result.message.includes('L3') && result.message.includes('L4'),
      `all offending lines must be named, got: ${result.message}`,
    );
  });

  await test('keeps the parsed headers usable even when some lines are bad', () => {
    const result = validateCustomHeaders('x-opencode-session: {{conversationId}}\noops');

    expect({ state: result.state, headers: result.headers }).toEqual({
      state: 'error',
      headers: { 'x-opencode-session': '{{conversationId}}' },
    });
  });
}

runTests();
