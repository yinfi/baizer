// test/knowledge/narrowing-regression.test.ts
// 回归：src/knowledge/* 去除 any（改为 unknown + 类型守卫窄化）后，
// 面对「缺失字段 / 类型错误」的畸形 frontmatter 必须继续安全工作：
// 不再把非字符串值塞进 string 字段（旧实现会让下游 .map()/.join() 抛错）。

import { TFile } from 'obsidian';
import { MetadataIndex } from '../../src/knowledge/metadata-index';
import { KnowledgeLinter } from '../../src/knowledge/linter';
import {
  getKnowledgeStatus,
  getPendingReason,
  getSourceId,
} from '../../src/knowledge/frontmatter';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error('Expected truthy'); },
    toBeFalsy: () => { if (actual) throw new Error('Expected falsy'); },
    toBeNull: () => { if (actual !== null) throw new Error(`Expected null but got ${JSON.stringify(actual)}`); },
    toBeUndefined: () => { if (actual !== undefined) throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`); },
    toHaveLength: (expected: number) => {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected length ${expected} but got ${Array.isArray(actual) ? actual.length : `non-array(${typeof actual})`}`);
      }
    },
    toEqual: (expected: unknown) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b} but got ${a}`);
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = 'md';
  return file;
}

/** app mock：按路径提供 frontmatter，覆盖 vault + metadataCache 的最小接口 */
function createApp(entries: { path: string; frontmatter: Record<string, unknown> }[]) {
  const files = new Map(entries.map((entry) => [entry.path, {
    file: createFile(entry.path),
    frontmatter: entry.frontmatter,
  }]));
  const all = () => Array.from(files.values()).map((entry) => entry.file);
  return {
    app: {
      vault: {
        getMarkdownFiles: all,
        getFiles: all,
        getAbstractFileByPath: () => null,
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const entry = files.get(file.path);
          return entry ? { frontmatter: entry.frontmatter } : null;
        },
      },
    } as any,
    files,
  };
}

function buildIndex(entries: { path: string; frontmatter: Record<string, unknown> }[]): MetadataIndex {
  const index = new MetadataIndex(createApp(entries).app, 'Knowledge Wiki');
  index.rebuild();
  return index;
}

console.log('=== Knowledge Narrowing Regression Tests ===');

async function runTests() {
  // --- MetadataIndex：类型错误的 frontmatter 不得污染 string 字段 ---

  await test('MetadataIndex coerces wrong-typed frontmatter fields to safe defaults', async () => {
    const index = buildIndex([{
      path: 'Knowledge Wiki/Articles/ksrc_a.md',
      frontmatter: {
        knowledge_generated: 'true',
        knowledge_source_id: 5,        // 应为 string
        title: 42,                     // 应为 string
        compiled_at: 7,                // 应为 string
        source_url: 99,                // 应为 string
        author: false,                 // 应为 string
        schema_hash: 1,                // 应为 string
      },
    }]);

    const article = index.getAllArticles()[0];
    expect(article.sourceId).toBe('ksrc_a');   // 非字符串 → 回退 basename
    expect(article.title).toBe('ksrc_a');
    expect(article.compiledAt).toBe('');
    expect(article.sourceUrl).toBeUndefined();
    expect(article.author).toBeUndefined();
    expect(article.schemaHash).toBeUndefined();
  });

  await test('MetadataIndex keeps concepts a string[] when frontmatter holds a non-array JSON string', async () => {
    // 旧实现直接返回 JSON.parse 的结果：concepts 会变成字符串 "single"，
    // 下游 article.concepts.map(...) 抛 TypeError。
    const index = buildIndex([{
      path: 'Knowledge Wiki/Articles/ksrc_b.md',
      frontmatter: {
        knowledge_generated: true,
        concepts: '"single"',
        key_claims: '5',
      },
    }]);

    const article = index.getAllArticles()[0];
    expect(Array.isArray(article.concepts)).toBeTruthy();
    expect(article.concepts).toEqual(['"single"']);
    expect(article.keyClaims).toEqual(['5']);
  });

  await test('MetadataIndex tolerates missing optional fields', async () => {
    const index = buildIndex([{
      path: 'Knowledge Wiki/Articles/ksrc_c.md',
      frontmatter: { knowledge_generated: true },
    }]);

    const article = index.getAllArticles()[0];
    expect(article.sourceId).toBe('ksrc_c');
    expect(article.title).toBe('ksrc_c');
    expect(article.topics).toHaveLength(0);
    expect(article.concepts).toHaveLength(0);
    expect(article.keyClaims).toHaveLength(0);
    expect(article.compiledAt).toBe('');
    expect(article.sourceUrl).toBeUndefined();
  });

  await test('MetadataIndex drops non-string topic entries and keeps string labels', async () => {
    const index = buildIndex([{
      path: 'Knowledge Wiki/Articles/ksrc_d.md',
      frontmatter: {
        knowledge_generated: 'true',
        topics: [{ label: 5 }, { label: 'Second Brain' }, 'ok', 7, null],
      },
    }]);

    expect(index.getAllArticles()[0].topics).toEqual(['Second Brain', 'ok']);
  });

  // --- frontmatter 读取：类型错误一律视为「未设置」 ---

  await test('getSourceId/getKnowledgeStatus/getPendingReason reject wrong-typed values', async () => {
    const { app, files } = createApp([
      { path: 'wrong.md', frontmatter: { knowledge_source_id: 5, knowledge_status: 123, knowledge_pending_reason: true } },
      { path: 'right.md', frontmatter: { knowledge_source_id: 'ksrc_x', knowledge_status: 'done', knowledge_pending_reason: 'new' } },
      { path: 'missing.md', frontmatter: {} },
    ]);

    const wrong = files.get('wrong.md')!.file;
    expect(getSourceId(app, wrong)).toBeNull();
    expect(getKnowledgeStatus(app, wrong)).toBeNull();
    expect(getPendingReason(app, wrong)).toBeNull();

    const right = files.get('right.md')!.file;
    expect(getSourceId(app, right)).toBe('ksrc_x');
    expect(getKnowledgeStatus(app, right)).toBe('done');
    expect(getPendingReason(app, right)).toBe('new');

    const missing = files.get('missing.md')!.file;
    expect(getSourceId(app, missing)).toBeNull();
    expect(getKnowledgeStatus(app, missing)).toBeNull();
    expect(getPendingReason(app, missing)).toBeNull();
  });

  // --- linter：畸形 frontmatter 不得让 runLint 抛错，也不得误报 ---

  await test('runLint survives non-array JSON review_flags and non-string knowledge_summary', async () => {
    // 旧实现：review_flags='\"abc\"' → JSON.parse 得字符串 → .join 抛 TypeError。
    // 旧实现：knowledge_summary=5 会被当成路径 → 误报 missing_summary。
    const { app } = createApp([
      { path: 'note.md', frontmatter: { knowledge_status: 'done', knowledge_summary: 5 } },
      {
        path: 'Knowledge Wiki/Articles/ksrc_e.md',
        frontmatter: { knowledge_generated: true, review_flags: '"abc"', concepts: '5', title: 1 },
      },
    ]);

    const issues = await new KnowledgeLinter(app, 'Knowledge Wiki').runLint();
    expect(issues).toHaveLength(0);
  });

  await test('runLint still reports a genuinely missing summary file', async () => {
    const { app } = createApp([
      { path: 'note.md', frontmatter: { knowledge_status: 'done', knowledge_summary: 'Knowledge Wiki/Articles/ksrc_gone.md' } },
    ]);

    const issues = await new KnowledgeLinter(app, 'Knowledge Wiki').runLint();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('missing_summary');
  });

  console.log('All knowledge narrowing regression tests passed!');
}

void runTests();
