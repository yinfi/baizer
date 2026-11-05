import assert from 'node:assert/strict';

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: unknown) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Narrowing regression (pi runtime, g5) ===');
  const { unwrapPiToolResult, mapPiEventToStreamEvent } = await import('../src/runtime/pi/pi-event-adapter');
  const { isPiApprovalResponse } = await import('../src/runtime/pi/pi-approval-policy');
  const { estimateTokens } = await import('../src/runtime/pi/session-store/compaction');
  const { APIError } = await import('../src/runtime/pi/anthropic-sdk-shim');
  const { adaptToolDefinitionsToPi } = await import('../src/runtime/pi/pi-tool-adapter');

  await test('unwrapPiToolResult passes through non-object results unchanged', () => {
    assert.equal(unwrapPiToolResult(undefined), undefined);
    assert.equal(unwrapPiToolResult(null), null);
    assert.equal(unwrapPiToolResult('plain'), 'plain');
    assert.equal(unwrapPiToolResult(42), 42);
  });

  await test('unwrapPiToolResult ignores non-object details and falls back to content text', () => {
    assert.deepEqual(unwrapPiToolResult({ details: 'oops', content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  });

  await test('unwrapPiToolResult returns baizerResponse even when it is undefined/null', () => {
    assert.equal(unwrapPiToolResult({ details: { baizerResponse: null } }), null);
    assert.equal(unwrapPiToolResult({ details: { baizerResponse: undefined } }), undefined);
  });

  await test('unwrapPiToolResult ignores content whose first block has a non-string text', () => {
    const result = { content: [{ type: 'text', text: 5 }] };
    assert.equal(unwrapPiToolResult(result), result);
    const notArray = { content: 'abc' };
    assert.equal(unwrapPiToolResult(notArray), notArray);
  });

  await test('tool_execution_end error prefers details.error, then content text, then undefined', () => {
    const end = (result: unknown) =>
      mapPiEventToStreamEvent({ type: 'tool_execution_end', toolCallId: 'c', toolName: 't', result, isError: true } as never);
    assert.equal((end({ details: { error: 'd' }, content: [{ text: 'c' }] }) as { error?: string }).error, 'd');
    assert.equal((end({ details: { error: 7 }, content: [{ text: 'c' }] }) as { error?: string }).error, 'c');
    assert.equal((end(null) as { error?: string }).error, undefined);
    assert.equal((end('boom') as { error?: string }).error, undefined);
  });

  await test('isPiApprovalResponse accepts only approval_required === true on objects', () => {
    assert.equal(isPiApprovalResponse({ approval_required: true }), true);
    assert.equal(isPiApprovalResponse({ approval_required: 'true' }), false);
    assert.equal(isPiApprovalResponse({ approval_required: false }), false);
    assert.equal(isPiApprovalResponse({}), false);
    assert.equal(isPiApprovalResponse(null), false);
    assert.equal(isPiApprovalResponse(undefined), false);
    assert.equal(isPiApprovalResponse('approval_required'), false);
  });

  await test('estimateTokens counts only well-formed text blocks', () => {
    const message = {
      content: [
        null,
        'str',
        { type: 'text', text: 'abcd' },
        { type: 'text', text: 123 },
        { type: 'image', text: 'zzzzzzzz' },
        { type: 'text' },
        { type: 'text', text: 'efgh' },
      ],
    };
    assert.equal(estimateTokens(message), 2);
    assert.equal(estimateTokens({ content: 'abcdefgh' }), 2);
    assert.equal(estimateTokens({ content: { type: 'text', text: 'abcd' } }), 0);
  });

  await test('APIError message/type come from the parsed body when well-formed', () => {
    const err = APIError.generate(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, undefined);
    // 与原实现一致:message 只读响应体顶层,嵌套的 error.message 会落到 JSON.stringify(body)。
    assert.equal(err.message, '401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    assert.equal(err.type, 'authentication_error');
    assert.equal(APIError.generate(400, { message: 'top level' }, undefined, undefined).message, '400 top level');
  });

  await test('APIError tolerates malformed bodies', () => {
    assert.equal(APIError.generate(500, undefined, 'raw text', undefined).message, '500 raw text');
    assert.equal(APIError.generate(500, undefined, undefined, undefined).message, '500 status code (no body)');
    assert.equal(APIError.generate(undefined, undefined, undefined, undefined).message, '(no status code or body)');
    const nonStringType = APIError.generate(400, { error: { type: 5 } }, undefined, undefined);
    assert.equal(nonStringType.type, null);
    assert.equal(nonStringType.message, '400 {"error":{"type":5}}');
    const objMessage = APIError.generate(400, { message: { a: 1 } }, undefined, undefined);
    assert.equal(objMessage.message, '400 {"a":1}');
  });

  await test('adapted tool terminates only on approval_required === true', async () => {
    const make = (response: unknown) => {
      const tools = adaptToolDefinitionsToPi({
        definitions: [{ name: 'noop', description: '', parameters: {} }],
        toolRegistry: { get: () => undefined, execute: async () => response } as never,
        skillScope: { allowedToolNames: null },
      });
      return tools[0].execute('id', {}, undefined) as Promise<{ terminate: boolean }>;
    };
    assert.equal((await make({ approval_required: true })).terminate, true);
    assert.equal((await make({ approval_required: 'yes' })).terminate, false);
    assert.equal((await make(undefined)).terminate, false);
    assert.equal((await make(null)).terminate, false);
    assert.equal((await make('text')).terminate, false);
  });

  await test('tool_execution_start narrows non-object args to an empty record and keeps object args', () => {
    const start = (args: unknown) => mapPiEventToStreamEvent({
      type: 'tool_execution_start', toolCallId: 'c', toolName: 't', args,
    } as never) as { args?: unknown };

    assert.deepEqual(start({ path: 'a.md', nested: { deep: true } }).args, { path: 'a.md', nested: { deep: true } });
    assert.deepEqual(start(undefined).args, {});
    assert.deepEqual(start(null).args, {});
    assert.deepEqual(start('text').args, {});
    assert.deepEqual(start(7).args, {});
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
