// Regression tests for the explicit-any cascade (issue #90): inputs that used to flow through
// `any` unchecked are now narrowed from `unknown`. Each case pins the malformed-input branch.

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e} but got ${a}`);
}

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
  console.log('=== Unknown-narrowing regression tests ===');

  const contract = await import('../src/utils/file-operation-contract');
  await test('file-operation-contract tolerates null / primitive tool results', () => {
    for (const bad of [null, undefined, 'oops', 42, true]) {
      eq(contract.isSuccessfulWriteToolResult(bad), false, `success(${String(bad)})`);
      eq(contract.getFileWriteError(bad), '', `error(${String(bad)})`);
      eq(contract.getFileWriteResultPath('create_note', bad, { filename: 'a.md' }), 'a.md', `path(${String(bad)})`);
    }
    eq(contract.getFileWriteResultPath('x', { path: 7 }, { path: 'p.md' }), 'p.md', 'non-string result.path falls through');
  });

  const adapter = await import('../src/runtime/pi/pi-event-adapter');
  await test('pi-event-adapter: unwrapPiToolResult handles malformed results', () => {
    eq(adapter.unwrapPiToolResult(null), null, 'null');
    eq(adapter.unwrapPiToolResult('raw'), 'raw', 'string');
    eq(adapter.unwrapPiToolResult({ content: 'not-an-array' }), { content: 'not-an-array' }, 'content not array');
    eq(adapter.unwrapPiToolResult({ content: [null] }), { content: [null] }, 'content[0] null');
    eq(adapter.unwrapPiToolResult({ content: [{ text: 'not json' }] }), { message: 'not json' }, 'non-JSON text');
    eq(adapter.unwrapPiToolResult({ details: { baizerResponse: { ok: 1 } } }), { ok: 1 }, 'baizerResponse');
  });
  await test('pi-event-adapter: tool_call args fall back to {} when not an object', () => {
    for (const args of [null, undefined, 'str', 5]) {
      const ev = adapter.mapPiEventToStreamEvent({
        type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_note', args,
      } as never);
      eq(ev, { type: 'tool_call', id: 'c1', name: 'read_note', args: {} }, `args=${String(args)}`);
    }
  });
  await test('pi-event-adapter: tool error message extraction tolerates malformed results', () => {
    const mk = (result: unknown) => adapter.mapPiEventToStreamEvent({
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 't', result, isError: true,
    } as never);
    eq((mk(null) as { error?: string }).error, undefined, 'null result');
    eq((mk({ details: { error: 'boom' } }) as { error?: string }).error, 'boom', 'details.error');
    eq((mk({ details: { error: 3 }, content: [{ text: 'txt' }] }) as { error?: string }).error, 'txt', 'non-string details.error');
  });

  const approval = await import('../src/runtime/pi/pi-approval-policy');
  await test('pi-approval-policy: isPiApprovalResponse rejects non-objects', () => {
    for (const bad of [null, undefined, 'approval_required', 1, false]) {
      eq(approval.isPiApprovalResponse(bad), false, String(bad));
    }
    eq(approval.isPiApprovalResponse({ approval_required: true }), true, 'valid');
    eq(approval.isPiApprovalResponse({ approval_required: 'true' }), false, 'string flag');
  });

  const toolAdapter = await import('../src/runtime/pi/pi-tool-adapter');
  await test('pi-tool-adapter: non-object params reach the tool as {}', async () => {
    const seen: unknown[] = [];
    const registry = {
      get: () => undefined,
      execute: (_name: string, args: unknown) => { seen.push(args); return Promise.resolve({ success: true }); },
    };
    const [tool] = toolAdapter.adaptToolDefinitionsToPi({
      definitions: [{ name: 'read_note', description: 'd', parameters: { type: 'object', properties: {} } }],
      toolRegistry: registry as never,
      skillScope: { allowedToolNames: null },
    });
    for (const params of [null, undefined, 'x', 3]) {
      await tool.execute('id', params as never);
    }
    eq(seen, [{}, {}, {}, {}], 'args seen by tool');
  });

  const skillSource = await import('../src/skills/pi-skill-source');
  await test('pi-skill-source: non-string tools / triggers entries are dropped', () => {
    const md = [
      '---',
      'name: demo',
      'description: demo skill',
      'tools: [read_note, 5, null, search_vault]',
      'triggers:',
      '  commands: ["/demo", 7]',
      '  keywords: [1, 2]',
      '---',
      'body',
    ].join('\n');
    const loaded = skillSource.parseBuiltinSkill(md, 'x/SKILL.md');
    eq(loaded?.sidecar.tools, ['read_note', 'search_vault'], 'tools');
    eq(loaded?.sidecar.triggers, { commands: ['/demo'], keywords: [] }, 'triggers');
  });
  await test('pi-skill-source: scalar frontmatter is treated as no frontmatter fields', () => {
    eq(skillSource.parseBuiltinSkill('---\njust a string\n---\nbody', 'p'), null, 'scalar fm');
  });

  const shim = await import('../src/runtime/pi/anthropic-sdk-shim');
  await test('anthropic shim: APIError tolerates malformed error bodies', () => {
    const e1 = shim.APIError.generate(500, { error: { type: 123 } }, undefined, undefined);
    eq(e1.type, null, 'non-string type -> null');
    const e2 = shim.APIError.generate(401, null, 'raw text', undefined);
    eq(e2.message, '401 raw text', 'null body uses text');
    const e3 = shim.APIError.generate(400, { message: 'bad', error: { type: 'invalid_request_error' } }, undefined, undefined);
    eq([e3.type, e3.message], ['invalid_request_error', '400 bad'], 'well-formed');
    eq(shim.APIError.makeMessage(undefined, 'str', undefined), '"str"', 'string body is JSON-stringified');
  });

  const canvas = await import('../src/skills/builtin/json-canvas/executor');
  await test('json-canvas: non-object nodes/edges report errors instead of throwing', () => {
    const r = canvas.validateCanvasContent(JSON.stringify({ nodes: [null, 'x', 5], edges: [null] }));
    eq(r.success, false, 'fails');
    if (!r.errors.some(e => e.includes('nodes[0].id'))) throw new Error('missing nodes[0].id error');
    if (!r.errors.some(e => e.includes('edges[0].fromNode must be a node id'))) throw new Error('missing edge error');
  });

  const bases = await import('../src/skills/builtin/obsidian-bases/executor');
  await test('obsidian-bases: malformed views / properties do not throw', () => {
    const r = bases.validateBaseYamlContent('views:\n  - null\n  - 5\n  - type: 3\nproperties: "str"\n');
    eq(r.success, false, 'fails');
    if (!r.errors.some(e => e.includes('views[0] must be an object'))) throw new Error('views[0] error missing');
    if (!r.errors.some(e => e.includes('views[2].type must be one of'))) throw new Error('views[2].type error missing');
    if (!r.errors.some(e => e.includes('properties must be an object'))) throw new Error('properties error missing');
  });

  const compaction = await import('../src/runtime/pi/session-store/compaction');
  await test('compaction: estimateTokens ignores null / non-text blocks', () => {
    const n = compaction.estimateTokens({ content: [null, 'x', { type: 'text', text: 'abcdefgh' }, { type: 'text', text: 9 }, { type: 'image' }] });
    eq(n, 2, 'only the one valid text block counts');
  });

  const { Logger } = await import('../src/utils/logger');
  await test('logger: non-Error values are serialized without throwing', () => {
    const log = Logger.getInstance();
    log.setConsoleOutput(false);
    log.clearLogs();
    log.error('m1', 'plain string');
    log.error('m2', { code: 1 });
    const entries = log.getRecentLogs('error');
    eq(entries.length, 2, 'two entries');
    eq((entries[0].error as { message: string }).message, 'plain string', 'string message');
    log.clearLogs();
    log.setConsoleOutput(true);
  });

  console.log('All unknown-narrowing tests passed.');
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});