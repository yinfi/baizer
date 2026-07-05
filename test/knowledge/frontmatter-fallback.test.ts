// test/knowledge/frontmatter-fallback.test.ts
// 回归测试：processFrontMatter 解析失败时走 fixAndSetFrontmatter 回退路径，
// 必须保证 (1) 反复写入不会翻倍转义引号；(2) 不会堆积重复的 knowledge_* 字段。
// 复现并锁死历史 bug：网页剪藏源目录文件被自动编译反复改写、frontmatter 撑成乱码。

import { TFile } from 'obsidian';
import { setKnowledgeStatus } from '../../src/knowledge/frontmatter';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeLessThan: (n: number) => {
      if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`);
    },
    toContain: (s: string) => {
      if (typeof actual !== 'string' || !actual.includes(s)) {
        throw new Error(`Expected string to contain "${s}"`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = 'md';
  return file;
}

/**
 * app mock：强制 processFrontMatter 抛错（模拟 YAML 解析失败），
 * 逼 setKnowledgeStatus 走 fixAndSetFrontmatter 回退。
 * vault.read/modify 操作内存里的文件内容。
 */
function makeFailingApp(initialContent: string) {
  const file = createFile('Assets/网页剪藏/a.md');
  const store: Record<string, string> = { [file.path]: initialContent };
  const app = {
    metadataCache: {
      // 回退路径不依赖 cache；返回空 frontmatter 让幂等短路不触发
      getFileCache: () => ({ frontmatter: {} }),
    },
    fileManager: {
      processFrontMatter: async () => {
        throw new Error('mock: invalid YAML, force fallback');
      },
    },
    vault: {
      read: async (f: TFile) => store[f.path],
      modify: async (f: TFile, content: string) => { store[f.path] = content; },
    },
  } as any;
  return { app, file, get content() { return store[file.path]; } };
}

console.log('=== Frontmatter Fallback (non-idempotent escape bomb) Tests ===');

async function runTests() {
  await test('repeated fallback writes do NOT blow up escape depth', async () => {
    // 剪藏产出的典型 frontmatter：source 含 :// 冒号
    const initial = [
      '---',
      'created: 2026-05-27T03:01:16.303Z',
      'source: https://mp.weixin.qq.com/s/Z8IOHlufZrZvgF4be5X-lA',
      'author: 关注AI的',
      'tags: clipping',
      '---',
      '',
      '# 正文标题',
      '正文内容不应被改动。',
    ].join('\n');

    const ctx = makeFailingApp(initial);

    // 连续 5 轮回退写入，模拟自动编译反复触碰
    for (let i = 0; i < 5; i++) {
      await setKnowledgeStatus(ctx.app, ctx.file, 'pending', { pending_reason: 'content_changed' });
    }

    // 引号翻倍炸弹的特征是连续多个反斜杠；幂等修复后不应出现 \\\\
    const maxBackslashRun = (ctx.content.match(/\\+/g) || [])
      .reduce((m, s) => Math.max(m, s.length), 0);
    expect(maxBackslashRun).toBeLessThan(3);

    // 正文必须原样保留
    expect(ctx.content).toContain('正文内容不应被改动。');
    expect(ctx.content).toContain('# 正文标题');
  });

  await test('repeated fallback writes keep exactly one knowledge_status field', async () => {
    const initial = [
      '---',
      'source: https://example.com/a:b',
      'tags: clipping',
      '---',
      '正文',
    ].join('\n');

    const ctx = makeFailingApp(initial);

    for (let i = 0; i < 4; i++) {
      await setKnowledgeStatus(ctx.app, ctx.file, 'pending', { pending_reason: 'new' });
    }

    const statusCount = (ctx.content.match(/^knowledge_status:/gm) || []).length;
    expect(statusCount).toBe(1);

    const sourceIdCount = (ctx.content.match(/^knowledge_source_id:/gm) || []).length;
    expect(sourceIdCount).toBe(0); // 本次未传 source_id，不应凭空出现

    // source 的 URL 值（含冒号）应被安全引号化且只一份
    const sourceCount = (ctx.content.match(/^source:/gm) || []).length;
    expect(sourceCount).toBe(1);
  });

  await test('recovers a previously corrupted frontmatter with duplicate fields', async () => {
    // 模拟历史损坏：多个重复 knowledge_status + 被翻倍转义的值
    const corrupted = [
      '---',
      'created: "\\"\\\\"2026-05-27T03:01:16.303Z\\\\"\\""',
      'source: https://mp.weixin.qq.com/s/xxx',
      'knowledge_status: processing',
      'knowledge_status: failed',
      'knowledge_status: pending',
      'knowledge_source_id: "ksrc_old"',
      '---',
      '正文保留',
    ].join('\n');

    const ctx = makeFailingApp(corrupted);
    await setKnowledgeStatus(ctx.app, ctx.file, 'done', {
      source_id: 'ksrc_new',
      compiled_at: '2026-07-05T00:00:00Z',
      summary: 'Knowledge Wiki/Articles/ksrc_new.md',
    });

    // 清理后只剩一份 knowledge_status，且为最新值
    const statusCount = (ctx.content.match(/^knowledge_status:/gm) || []).length;
    expect(statusCount).toBe(1);
    expect(ctx.content).toContain('knowledge_status: done');

    // 旧的 source_id 应被清除，只剩新的一份
    const sidCount = (ctx.content.match(/^knowledge_source_id:/gm) || []).length;
    expect(sidCount).toBe(1);
    expect(ctx.content).toContain('ksrc_new');

    expect(ctx.content).toContain('正文保留');
  });

  console.log('All frontmatter fallback tests passed!');
}

void runTests();
