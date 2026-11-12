// 回归:builtin 工具/校验器对 unknown 入参的显式窄化(issue #89, no-unsafe-member-access)。
// 覆盖 vault-ops / json-canvas / obsidian-bases / web-search / web-clipper / knowledge / read-skill。
import { TFile, App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e} but got ${a}`);
}

function assertIncludes(values: string[], expected: string, label: string) {
  if (!values.some(v => v.includes(expected))) {
    throw new Error(`${label}: expected one error to include "${expected}", got ${JSON.stringify(values)}`);
  }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function makeFile(path: string) {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') || path;
  (file as any).stat = { size: 1, mtime: 0 };
  return file;
}

function makeApp(initial: Record<string, string> = {}) {
  const files = new Map<string, any>();
  const contents = new Map<string, string>();
  const created: Array<{ path: string; content: string }> = [];
  const modified: Array<{ path: string; content: string }> = [];
  for (const [p, c] of Object.entries(initial)) {
    files.set(p, makeFile(p));
    contents.set(p, c);
  }
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) || null,
      createFolder: async () => { },
      create: async (p: string, c: string) => {
        created.push({ path: p, content: c });
        files.set(p, makeFile(p));
        contents.set(p, c);
      },
      modify: async (f: any, c: string) => { modified.push({ path: f.path, content: c }); },
      read: async (f: any) => contents.get(f.path) ?? '',
      trash: async () => { },
      rename: async () => { },
      getMarkdownFiles: () => Array.from(files.values()),
      getFiles: () => Array.from(files.values()),
    },
    metadataCache: { getFirstLinkpathDest: (p: string) => files.get(p) || null },
    workspace: { getLeaf: () => ({ openFile: async () => { } }) },
  } as unknown as App;
  return { app, created, modified };
}

const OPEN_SETTINGS = {
  ...DEFAULT_SETTINGS,
  allowFileCreation: true,
  allowFileModification: true,
  confirmExecutions: false,
};

async function runTests() {
  console.log('=== Narrowing regression (g3 builtin tools) ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { registerVaultTools } = await import('../src/skills/builtin/vault-ops');
  const { validateCanvasContent } = await import('../src/skills/builtin/json-canvas/executor');
  const { validateBaseYamlContent } = await import('../src/skills/builtin/obsidian-bases/executor');

  // ---------- json-canvas ----------
  const validNode = { id: '6f0ad84f44ce9c17', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' };

  await test('canvas: null nodes/edges are treated as absent', async () => {
    const r = validateCanvasContent(JSON.stringify({ nodes: null, edges: null }));
    assertEqual(r, { success: true, errors: [] }, 'null nodes/edges');
  });

  await test('canvas: non-array nodes and edges report both errors in order', async () => {
    const r = validateCanvasContent(JSON.stringify({ nodes: 'x', edges: {} }));
    assertEqual(r, {
      success: false,
      errors: ['nodes must be an array when present', 'edges must be an array when present'],
    }, 'non-array');
  });

  await test('canvas: root must be a plain object; invalid JSON keeps message', async () => {
    assertEqual(validateCanvasContent('[]').errors, ['Canvas root must be an object'], 'array root');
    assertEqual(validateCanvasContent('null').errors, ['Canvas root must be an object'], 'null root');
    assertEqual(validateCanvasContent(42 as unknown).errors, ['content must be a JSON string'], 'non-string');
    const bad = validateCanvasContent('{oops');
    assert(bad.errors.length === 1 && bad.errors[0].startsWith('Invalid JSON: '), 'invalid json prefix');
  });

  await test('canvas: non-object nodes/edges and non-string fields are reported without throwing', async () => {
    const r = validateCanvasContent(JSON.stringify({
      nodes: [null, 5, { ...validNode, type: 7 }],
      edges: [
        null,
        { id: 'bbbbbbbbbbbbbbbb', fromNode: 3, toNode: validNode.id, fromSide: 1, toEnd: 'weird' },
      ],
    }));
    assert(r.success === false, 'should fail');
    assertIncludes(r.errors, 'nodes[0].id', 'null node id');
    assertIncludes(r.errors, 'nodes[1].type', 'number node type');
    assertIncludes(r.errors, 'nodes[2].type must be one of', 'numeric type');
    assertIncludes(r.errors, 'edges[0].fromNode must be a node id', 'null edge');
    assertIncludes(r.errors, 'edges[1].fromNode must be a node id', 'numeric fromNode');
    assertIncludes(r.errors, 'edges[1].fromSide must be one of', 'numeric side');
    assertIncludes(r.errors, 'edges[1].toEnd must be none or arrow', 'bad end');
  });

  // ---------- obsidian-bases ----------
  await test('bases: scalar/array/invalid YAML roots', async () => {
    assertEqual(validateBaseYamlContent('0').errors, ['Base root must be a YAML object'], 'scalar');
    assertEqual(validateBaseYamlContent('- a').errors, ['Base root must be a YAML object'], 'array');
    assertEqual(validateBaseYamlContent('').errors, ['Base root must be a YAML object'], 'empty');
    assertEqual(validateBaseYamlContent(5 as unknown).errors, ['content must be a YAML string'], 'non-string');
    const bad = validateBaseYamlContent('a: [');
    assert(bad.errors.length === 1 && bad.errors[0].startsWith('Invalid YAML: '), 'invalid yaml prefix');
  });

  await test('bases: views shape, type narrowing and formula references', async () => {
    const r = validateBaseYamlContent([
      'properties:',
      '  formula.missing: {}',
      'views:',
      '  - 3',
      '  - type: 9',
      '    order: nope',
      '    filters: 1',
      '    groupBy: x',
      '  - type: table',
      '    order: [formula.gone]',
      '    groupBy: { property: formula.grp }',
      '    summaries: { formula.sum: Average }',
    ].join('\n'));
    assert(r.success === false, 'should fail');
    assertIncludes(r.errors, 'views[0] must be an object', 'non-object view');
    assertIncludes(r.errors, 'views[1].type must be one of', 'numeric type');
    assertIncludes(r.errors, 'views[1].order must be an array', 'order');
    assertIncludes(r.errors, 'views[1].filters must be a filter string or filter object', 'filters');
    assertIncludes(r.errors, 'views[1].groupBy must be an object', 'groupBy');
    for (const name of ['formula.missing', 'formula.gone', 'formula.grp', 'formula.sum']) {
      assertIncludes(r.errors, `Reference ${name} has no matching formulas.`, name);
    }
  });

  await test('bases: views missing or empty', async () => {
    assertEqual(validateBaseYamlContent('formulas: {}').errors, ['views must be a non-empty array'], 'missing');
    assertEqual(validateBaseYamlContent('views: []').errors, ['views must be a non-empty array'], 'empty');
    assertEqual(validateBaseYamlContent('views: x').errors, ['views must be a non-empty array'], 'string');
  });

  await test('validator tools tolerate non-object args', async () => {
    const reg = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    const canvas = await import('../src/skills/builtin/json-canvas/executor');
    const bases = await import('../src/skills/builtin/obsidian-bases/executor');
    canvas.registerTools(reg);
    bases.registerTools(reg);
    for (const args of [null, undefined, 'str', 7]) {
      const c = await reg.execute('validate_json_canvas', args);
      assertEqual(c.errors, ['content must be a JSON string'], 'canvas args');
      const b = await reg.execute('validate_base_yaml', args);
      assertEqual(b.errors, ['content must be a YAML string'], 'bases args');
    }
  });

  // ---------- vault-ops ----------
  await test('vault-ops: missing/non-object args take the pre-existing missing-parameter paths', async () => {
    const { app } = makeApp();
    const reg = new ToolRegistry(app, OPEN_SETTINGS);
    registerVaultTools(reg);
    for (const args of [null, undefined, 'x', { path: 5 }]) {
      assertEqual(await reg.execute('read_file', args), { success: false, error: 'Missing path parameter' }, 'read_file');
      assertEqual(await reg.execute('create_file', args), { success: false, error: 'Missing path parameter' }, 'create_file');
      assertEqual(await reg.execute('update_file', args), { success: false, error: 'Missing path parameter' }, 'update_file');
    }
    assertEqual(await reg.execute('create_note', {}), { success: false, error: 'Missing filename parameter' }, 'create_note');
    assertEqual(await reg.execute('read_note', {}), { success: false, error: 'File not found' }, 'read_note');
    assertEqual(await reg.execute('open_file', null), { success: false, error: 'File not found' }, 'open_file');
  });

  await test('vault-ops: create_note falls back filename -> path -> name and appends .md', async () => {
    const { app, created } = makeApp();
    const reg = new ToolRegistry(app, OPEN_SETTINGS);
    registerVaultTools(reg);
    await reg.execute('create_note', { name: 'viaName', content: 'c' });
    await reg.execute('create_note', { path: 'viaPath.md', filename: '', content: 5 });
    assertEqual(created, [
      { path: 'viaName.md', content: 'c' },
      { path: 'viaPath.md', content: '' },
    ], 'created');
  });

  await test('vault-ops: approved flag keeps truthiness semantics', async () => {
    const { app, modified } = makeApp({ 'a.md': 'old' });
    const reg = new ToolRegistry(app, { ...OPEN_SETTINGS, confirmExecutions: true });
    registerVaultTools(reg);
    const pending = await reg.execute('update_note', { path: 'a.md', content: 'new' });
    assert(pending.approval_required === true, 'needs approval without flag');
    assertEqual(modified, [], 'not modified yet');
    await reg.execute('update_note', { path: 'a.md', content: 'new', approved: true });
    await reg.execute('update_note', { path: 'a.md', content: 'newer', approved: 1 });
    assertEqual(modified.map(m => m.content), ['new', 'newer'], 'truthy approved applies');
  });

  await test('vault-ops: list_notes limit/folder defaults and search_vault tolerate bad types', async () => {
    const { app } = makeApp({ 'f/a.md': '', 'f/b.md': '', 'g/c.md': '' });
    const reg = new ToolRegistry(app, OPEN_SETTINGS);
    registerVaultTools(reg);
    const all = await reg.execute('list_notes', { limit: 'many', folder: 5 });
    assert(all.total === 3 && all.files.length === 3, 'defaults: whole vault, limit 20');
    const one = await reg.execute('list_notes', { folder: 'f', limit: 1 });
    assert(one.total === 2 && one.files.length === 1, 'folder + limit');
    assertEqual((await reg.execute('search_vault', { query: 'B' })).matches, ['f/b.md'], 'search');
    assert(Array.isArray((await reg.execute('search_vault', {})).matches), 'missing query does not throw');
  });

  // ---------- read-skill ----------
  await test('read_skill: non-string name is treated as missing; name is trimmed', async () => {
    const { registerSkillReadTool } = await import('../src/skills/builtin/read-skill');
    const reg = new ToolRegistry({ vault: { adapter: { read: async () => 'BODY' } } } as any, DEFAULT_SETTINGS);
    const seen: string[] = [];
    const skills = {
      resolveForRead: (n: string) => {
        seen.push(n);
        return n === 'web-search' ? { filePath: 'p/SKILL.md', instructions: 'mem' } : null;
      },
    };
    registerSkillReadTool(reg, skills as any);
    for (const args of [null, undefined, {}, { name: 5 }, { name: '   ' }]) {
      assertEqual(await reg.execute('read_skill', args), { error: 'Missing skill name' }, 'missing name');
    }
    assertEqual(seen, [], 'registry not consulted for missing names');
    assertEqual(
      await reg.execute('read_skill', { name: '  web-search ' }),
      { name: 'web-search', location: 'p/SKILL.md', instructions: 'BODY' },
      'trimmed lookup',
    );
    assertEqual(
      await reg.execute('read_skill', { name: 'nope' }),
      { error: 'Skill "nope" not found or disabled' },
      'unknown skill',
    );
  });

  // ---------- web-search ----------
  await test('web_search: query and time_range are narrowed; bad types do not throw', async () => {
    const { createWebSearchTool } = await import('../src/skills/builtin/web-search/executor');
    const urls: string[] = [];
    const tool = createWebSearchTool({
      requestUrl: (async (o: any) => { urls.push(o.url); return { status: 200, text: '' }; }) as any,
      wait: async () => undefined,
    });
    await tool.execute({ query: 'a b', time_range: 'w' }, {} as any);
    await tool.execute({ query: 7, time_range: 3 }, {} as any);
    await tool.execute(null, {} as any);
    assertEqual(urls.slice(0, 1), ['https://html.duckduckgo.com/html/?q=a%20b&df=w'], 'full url');
    assert(urls.includes('https://html.duckduckgo.com/html/?q='), 'non-string query becomes empty');
    assert(urls.every(u => !u.includes('df=') || u.endsWith('&df=w')), 'non-string time_range ignored');
    const failing = createWebSearchTool({
      requestUrl: (async () => { throw new Error('boom'); }) as any,
      wait: async () => undefined,
    });
    assertEqual(await failing.execute({ query: 'x' }, {} as any), { error: 'Search failed: boom' }, 'error message');
  });

  // ---------- knowledge ----------
  await test('knowledge executor: query/name fallback and max_results default', async () => {
    const { createExecutor } = await import('../src/skills/builtin/knowledge/executor');
    const calls: Array<[string, any]> = [];
    const registry = { execute: async (n: string, a: any) => { calls.push([n, a]); return 'ok'; } } as any;
    const exec = createExecutor(registry);
    await exec.execute({ name: 'topic', max_results: 5 }, {} as any);
    await exec.execute({ query: 'q', max_results: 'x' }, {} as any);
    assertEqual(calls, [
      ['query_knowledge', { query: 'topic', max_results: 5 }],
      ['query_knowledge', { query: 'q', max_results: 3 }],
    ], 'forwarded');
    for (const args of [null, undefined, {}, { query: 9 }]) {
      assertEqual(await exec.execute(args, {} as any), { error: 'Missing query parameter' }, 'missing');
    }
    assert(calls.length === 2, 'no extra calls');
  });

  await test('knowledge tools: narrowed args drop invalid fields and reject missing required ones', async () => {
    const { createKnowledgeTools } = await import('../src/skills/builtin/knowledge/executor');
    const queryCalls: Array<Record<string, unknown>> = [];
    const fileBackCalls: Array<Record<string, unknown>> = [];
    const tools = createKnowledgeTools(
      { execute: async (args: { query: string; max_results?: number }) => { queryCalls.push(args); return { query: args.query }; } } as any,
      { execute: async (args: Record<string, unknown>) => { fileBackCalls.push(args); return { success: true }; } } as any,
    );
    const queryTool = tools.find(tool => tool.name === 'query_knowledge')!;
    const fileBackTool = tools.find(tool => tool.name === 'file_back_knowledge')!;
    const ctx = {} as any;

    assertEqual(await queryTool.execute({ query: 'q', max_results: 5 }, ctx), { query: 'q' }, 'query forwarded');
    assertEqual(queryCalls[0], { query: 'q', max_results: 5 }, 'valid max_results kept');
    // 非 number 的 max_results 视为缺失（不再把外部值带进执行器）。
    await queryTool.execute({ query: 'q', max_results: 'x' }, ctx);
    assertEqual(queryCalls[1], { query: 'q' }, 'invalid max_results dropped');
    for (const args of [null, undefined, {}, { query: 7 }]) {
      assertEqual(await queryTool.execute(args, ctx), { error: 'Missing query parameter' }, 'missing query');
    }

    assertEqual(
      await fileBackTool.execute(
        { title: 'T', content: 'C', source_queries: ['q1'], topics: 'bad', extra: 'ignored' },
        ctx,
      ),
      { success: true },
      'file back forwarded',
    );
    assertEqual(fileBackCalls[0], {
      title: 'T',
      content: 'C',
      source_queries: ['q1'],
      related_sources: [],
      topics: undefined,
      source_url: undefined,
    }, 'narrowed file-back args');
    assertEqual(
      await fileBackTool.execute({ title: 5, content: 'C' }, ctx),
      { success: false, error: 'Missing title or content parameter' },
      'missing title',
    );
    assert(fileBackCalls.length === 1, 'invalid file-back args do not reach the executor');
  });

  // ---------- web-clipper ----------
  await test('save_webpage: non-object args and thrown values yield a failure result', async () => {
    const { createSaveWebpageTool } = await import('../src/skills/builtin/web-clipper/executor');
    const deps = {
      getVideoTranscript: async () => null,
      requestUrl: async () => { throw new Error('offline'); },
      htmlToMarkdown: () => '',
      notice: () => { },
      transcribeVideoAudio: async () => { throw new Error('unused'); },
    };
    const tool = createSaveWebpageTool({ generate: async () => '' } as any, deps as any);
    const ctx = { app: {}, settings: DEFAULT_SETTINGS } as any;
    assertEqual(await tool.execute(null, ctx), { success: false, error: 'offline' }, 'null args');
    assertEqual(await tool.execute({ url: 5 }, ctx), { success: false, error: 'offline' }, 'numeric url');
    const throwsString = createSaveWebpageTool({ generate: async () => '' } as any, {
      ...deps,
      getVideoTranscript: async () => { throw 'plain'; },
    } as any);
    assertEqual(await throwsString.execute({ url: 'u' }, ctx), { success: false, error: 'plain' }, 'string throw');
  });

  console.log('narrow-g3 builtin tools: all passed');
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
