// 回归测试:knowledge/compiler、ontology、metadata-index 与 services/operation-audit-log、
// model-catalog-service 里对外部输入(JSON.parse / 磁盘 / frontmatter)的 unknown 窄化。

import { parseCompilerResponse } from '../src/knowledge/compiler';
import { parseOntologySchema, parseDiscoveryResponse } from '../src/knowledge/ontology';
import { MetadataIndex } from '../src/knowledge/metadata-index';
import { OperationAuditLog, OPERATION_AUDIT_LOG_PATH } from '../src/services/operation-audit-log';
import { listModels, isModelListingUnsupported } from '../src/services/model-catalog-service';

function eq(actual: unknown, expected: unknown, label = ''): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e} but got ${a}`);
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: unknown) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async read(path: string) {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`Missing file: ${path}`);
    return v;
  }
  async write(path: string, content: string) { this.files.set(path, content); }
  async mkdir(path: string) { this.folders.add(path); }
}

function jsonResponse(status: number, body: unknown): any {
  return { status, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

async function main(): Promise<void> {
  console.log('=== narrow-g2 knowledge/services tests ===');

  // ---- compiler.parseCompilerResponse ----
  await test('parseCompilerResponse: non-object / missing title -> null', () => {
    eq(parseCompilerResponse('null'), null);
    eq(parseCompilerResponse('42'), null);
    eq(parseCompilerResponse('[]'), null);
    eq(parseCompilerResponse('{"title": 5}'), null);
    eq(parseCompilerResponse('{}'), null);
  });

  await test('parseCompilerResponse: topics fall back slug<->label, drop empty slugs, tolerate junk', () => {
    const r = parseCompilerResponse(JSON.stringify({
      title: 'T',
      topics: [{ slug: 'AI Ops' }, { label: 'Only Label' }, 'junk', 7, {}, { slug: '', label: '' }],
    }));
    eq(r?.topics, [
      { slug: 'ai-ops', label: 'AI Ops' },
      { slug: 'only-label', label: 'Only Label' },
    ]);
  });

  await test('parseCompilerResponse: malformed topics keep the original throw->null behavior', () => {
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: 'x' })), null);
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: { a: 1 } })), null);
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: [null] })), null);
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: [{ slug: 5 }] })), null);
    // falsy topics values are treated as "no topics"
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: null }))?.topics, []);
    eq(parseCompilerResponse(JSON.stringify({ title: 'T', topics: 0 }))?.topics, []);
  });

  await test('parseCompilerResponse: non-array concepts/key_claims/review_flags default to []', () => {
    const r = parseCompilerResponse(JSON.stringify({
      title: 'T', concepts: 'x', key_claims: { a: 1 }, review_flags: 3,
    }));
    eq(r?.topics, []);
    eq(r?.concepts, []);
    eq(r?.key_claims, []);
    eq(r?.review_flags, []);
  });

  await test('parseCompilerResponse: author/source_url/created_at default to empty string', () => {
    const r = parseCompilerResponse(JSON.stringify({ title: 'T', author: 'A', source_url: null, created_at: 7 }));
    eq(r?.author, 'A');
    eq(r?.source_url, '');
    eq(r?.created_at, '');
  });

  await test('parseCompilerResponse: ontology fields filter malformed entries', () => {
    const r = parseCompilerResponse(JSON.stringify({
      title: 'T',
      categorized_knowledge: [
        { category: 'C1', items: ['a', 1, 'b'] },
        { category: 'C2' },
        { category: 3, items: [] },
        null,
      ],
      entities: [
        { name: 'N', type: 'P', description: 'D' },
        { name: 'N2', type: 'P', description: 9 },
        { name: 'N3' },
        'x',
      ],
    }));
    eq(r?.categorized_knowledge, [{ category: 'C1', items: ['a', 'b'] }]);
    eq(r?.entities, [
      { name: 'N', type: 'P', description: 'D' },
      { name: 'N2', type: 'P', description: '' },
    ]);
  });

  await test('parseCompilerResponse: fenced JSON still parsed; invalid JSON -> null', () => {
    const r = parseCompilerResponse('x\n```json\n{"title":"F"}\n```');
    eq(r?.title, 'F');
    eq(parseCompilerResponse('not json'), null);
  });

  // ---- ontology ----
  await test('parseOntologySchema: rejects non-objects and wrong artifact type', () => {
    eq(parseOntologySchema(undefined), null);
    eq(parseOntologySchema(null), null);
    eq(parseOntologySchema('str'), null);
    eq(parseOntologySchema({ knowledge_artifact_type: 'other', categories: [{ name: 'a' }] }), null);
  });

  await test('parseOntologySchema: trims names, defaults version and description, skips bad entries', () => {
    const s = parseOntologySchema({
      knowledge_artifact_type: 'ontology_schema',
      categories: [{ name: '  Model  ', description: ' d ' }, { name: '   ' }, { name: 5 }, null, 'x', { name: 'NoDesc' }],
      entity_types: [{ name: 'Person', description: 7 }],
    });
    eq(s, {
      version: 1,
      categories: [{ name: 'Model', description: 'd' }, { name: 'NoDesc', description: '' }],
      entity_types: [{ name: 'Person', description: '' }],
    });
  });

  await test('parseOntologySchema: numeric version kept; empty lists -> null', () => {
    eq(parseOntologySchema({ knowledge_artifact_type: 'ontology_schema', version: 3, categories: [{ name: 'a' }] })?.version, 3);
    eq(parseOntologySchema({ knowledge_artifact_type: 'ontology_schema', version: '3', categories: [{ name: 'a' }] })?.version, 1);
    eq(parseOntologySchema({ knowledge_artifact_type: 'ontology_schema', categories: 'x' }), null);
  });

  await test('parseDiscoveryResponse: handles non-object JSON and valid payload', () => {
    eq(parseDiscoveryResponse('null'), null);
    eq(parseDiscoveryResponse('[1,2]'), null);
    const s = parseDiscoveryResponse('{"categories":[{"name":"A","description":"d"}],"entity_types":[]}');
    eq(s, { version: 1, categories: [{ name: 'A', description: 'd' }], entity_types: [] });
  });

  // ---- metadata-index (frontmatter from metadataCache) ----
  await test('MetadataIndex: tolerant extraction of topics/categorized_knowledge/entities', () => {
    const fm: Record<string, unknown> = {
      knowledge_generated: 'true',
      title: 'Hello',
      topics: ['plain', { slug: 's', label: 'Labelled' }, { slug: 'nolabel' }, 7, null],
      concepts: '["c1","c2"]',
      categorized_knowledge: [
        { category: 'K', items: ['a', 2] },
        { category: 'S', items: '["x","y"]' },
        { category: 'N' },
        { category: '', items: ['drop'] },
        { items: ['no cat'] },
        null,
      ],
      entities: [
        { name: 'E', type: 'T', description: 'D' },
        { name: 'E2', type: 'T' },
        { name: '', type: 'T' },
        { name: 'E3' },
        'x',
      ],
    };
    const file: any = { path: 'Wiki/Articles/a.md', basename: 'a' };
    const app: any = {
      vault: { getMarkdownFiles: () => [file] },
      metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
    };
    const index = new MetadataIndex(app, 'Wiki');
    index.rebuild();
    const [meta] = index.getAllArticles();
    eq(meta.topics, ['plain', 'Labelled']);
    eq(meta.concepts, ['c1', 'c2']);
    eq(meta.categorizedKnowledge, [
      { category: 'K', items: ['a', '2'] },
      { category: 'S', items: ['x', 'y'] },
      { category: 'N', items: [] },
    ]);
    eq(meta.entities, [
      { name: 'E', type: 'T', description: 'D' },
      { name: 'E2', type: 'T', description: '' },
    ]);
  });

  // ---- operation-audit-log.readFile ----
  const validOp = {
    id: 'op1', action: 'create_note', target: 'a.md', timestamp: 10,
    approvalSource: 'user-click', undoable: true,
  };
  const validReq = { id: 'r1', action: 'create_note', target: 'a.md', state: 'succeeded', timestamp: 10, updatedAt: 11 };

  await test('audit log: malformed top-level JSON shapes yield an empty log', async () => {
    for (const raw of ['null', '42', '"s"', '[]', '{"version":2,"operations":[]}', '{"version":1}', '{"version":1,"operations":{}}', 'not json']) {
      const adapter = new FakeAdapter();
      adapter.files.set(OPERATION_AUDIT_LOG_PATH, raw);
      const log = new OperationAuditLog({ vault: { adapter } } as any);
      eq(await log.list(), [], raw);
      eq(await log.getPrunedRequestBefore(), 0, raw);
    }
  });

  await test('audit log: bad records are filtered individually, good ones and watermark preserved', async () => {
    const adapter = new FakeAdapter();
    adapter.files.set(OPERATION_AUDIT_LOG_PATH, JSON.stringify({
      version: 1,
      operations: [validOp, null, 'x', { ...validOp, id: 5 }, { ...validOp, approvalSource: 'nope' }, { ...validOp, id: 'op2', outcome: 'attempt-failed', timestamp: 20 }],
      requests: [validReq, { ...validReq, id: 'r2', state: 'bogus' }, null],
      requestsPrunedBefore: 99,
    }));
    const log = new OperationAuditLog({ vault: { adapter } } as any);
    const ops = await log.list();
    eq(ops.map(o => o.id), ['op2', 'op1']);
    eq((await log.getRequestState('r1'))?.updatedAt, 11);
    eq(await log.getRequestState('r2'), undefined);
    eq(await log.getPrunedRequestBefore(), 99);
  });

  await test('audit log: non-array requests / non-number watermark default to [] / 0', async () => {
    const adapter = new FakeAdapter();
    adapter.files.set(OPERATION_AUDIT_LOG_PATH, JSON.stringify({
      version: 1, operations: [validOp], requests: 'x', requestsPrunedBefore: '5',
    }));
    const log = new OperationAuditLog({ vault: { adapter } } as any);
    eq((await log.list()).length, 1);
    eq(await log.getRequestState('r1'), undefined);
    eq(await log.getPrunedRequestBefore(), 0);
  });

  // ---- model-catalog-service ----
  const cfg: any = { type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://x/v1', label: 'X' };
  const anthropicCfg: any = { type: 'anthropic', apiKey: 'k', baseUrl: 'http://a', label: 'A' };

  await test('listModels(openai): non-string ids and junk rows are skipped, ids trimmed/filtered/sorted', async () => {
    const rows = [{ id: ' gpt-b ' }, { id: 'gpt-a' }, { id: 'text-embedding-3' }, { id: 5 }, null, 'x', {}, { id: 'gpt-a' }];
    const out = await listModels(cfg, { requestUrl: async () => jsonResponse(200, { data: rows }) });
    eq(out, [{ value: 'gpt-a', label: 'gpt-a' }, { value: 'gpt-b', label: 'gpt-b' }]);
  });

  await test('listModels: missing / non-array data yields an empty list; null body ok', async () => {
    eq(await listModels(cfg, { requestUrl: async () => jsonResponse(200, { data: 'x' }) }), []);
    eq(await listModels(cfg, { requestUrl: async () => jsonResponse(200, 'null') }), []);
    eq(await listModels(cfg, { requestUrl: async () => jsonResponse(200, '') }), []);
  });

  await test('listModels(anthropic): display_name labels, blank display_name falls back to id', async () => {
    const rows = [
      { id: 'claude-b', display_name: 'Claude B' },
      { id: 'claude-a', display_name: '   ' },
      { id: 'claude-c', display_name: 9 },
      { id: 'same', display_name: 'same' },
      { id: 7 },
      null,
    ];
    const out = await listModels(anthropicCfg, { requestUrl: async () => jsonResponse(200, { data: rows }) });
    eq(out, [
      { value: 'claude-a', label: 'claude-a' },
      { value: 'claude-b', label: 'Claude B (claude-b)' },
      { value: 'claude-c', label: 'claude-c' },
      { value: 'same', label: 'same' },
    ]);
  });

  await test('isModelListingUnsupported: duck-typed code on plain objects, false for others', () => {
    eq(isModelListingUnsupported({ code: 'model-listing-unsupported' }), true);
    eq(isModelListingUnsupported({ code: 'other' }), false);
    eq(isModelListingUnsupported(null), false);
    eq(isModelListingUnsupported('model-listing-unsupported'), false);
    eq(isModelListingUnsupported(undefined), false);
  });

  console.log('All narrow-g2 knowledge/services tests passed!');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
