import { KnowledgeCompiler } from '../../src/knowledge/compiler';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
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

/** 构造 N 个 pending markdown 文件的 mock app(无 knowledge_summary → 每个都需真正编译)。 */
function createMockApp(count: number): any {
  const files = Array.from({ length: count }, (_, i) => ({ path: `note-${i}.md`, basename: `note-${i}` }));
  return {
    vault: {
      getMarkdownFiles: () => files,
      read: async () => 'body',
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { knowledge_status: 'pending' } }),
    },
  };
}

/**
 * 可控 compileNote 的子类:记录并发峰值,按注入的 failSet 决定成功/失败。
 * 不触真实 AI / 文件写;只验证批处理循环的并发上限与计数正确性。
 */
class ProbeCompiler extends KnowledgeCompiler {
  running = 0;
  peak = 0;
  compiled: string[] = [];
  constructor(app: any, private failPaths: Set<string>) {
    super(app, async () => '{}', 'Wiki');
  }
  async compileNote(file: any): Promise<string | null> {
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    await new Promise((r) => setTimeout(r, 5));
    this.compiled.push(file.path);
    this.running--;
    return this.failPaths.has(file.path) ? null : `Wiki/Articles/${file.basename}.md`;
  }
}

async function runTests() {
  console.log('=== Knowledge Compile Concurrency Tests ===');

  await test('counts success/failed correctly under file-level concurrency', async () => {
    const app = createMockApp(6);
    const compiler = new ProbeCompiler(app, new Set(['note-1.md', 'note-4.md']));
    const result = await compiler.compileAllPending(50, undefined, undefined, undefined, undefined, { fileConcurrency: 3 });
    // 6 个文件,2 个失败 → 4 成功 2 失败。
    expect(result).toEqual({ success: 4, failed: 2 });
    // 全部被编译过。
    expect(compiler.compiled.length).toBe(6);
  });

  await test('respects fileConcurrency upper bound', async () => {
    const app = createMockApp(9);
    const compiler = new ProbeCompiler(app, new Set());
    await compiler.compileAllPending(50, undefined, undefined, undefined, undefined, { fileConcurrency: 2 });
    // 并发峰值不超过 fileConcurrency。
    expect(compiler.peak <= 2).toBe(true);
    // 但确实发生了并发(>1),证明不是串行。
    expect(compiler.peak).toBe(2);
  });

  await test('onProgress reports completion count up to total', async () => {
    const app = createMockApp(4);
    const compiler = new ProbeCompiler(app, new Set());
    const progress: Array<{ current: number; total: number }> = [];
    await compiler.compileAllPending(50, (current, total) => progress.push({ current, total }), undefined, undefined, undefined, { fileConcurrency: 2 });
    // 回调次数 = 文件数;total 恒为 4;current 最终到 4。
    expect(progress.length).toBe(4);
    expect(progress.every(p => p.total === 4)).toBe(true);
    expect(Math.max(...progress.map(p => p.current))).toBe(4);
  });

  await test('defaults to fileConcurrency 3 when unspecified', async () => {
    const app = createMockApp(5);
    const compiler = new ProbeCompiler(app, new Set());
    await compiler.compileAllPending(50);
    expect(compiler.peak).toBe(3);
  });

  await test('respects maxBatch cap', async () => {
    const app = createMockApp(10);
    const compiler = new ProbeCompiler(app, new Set());
    const result = await compiler.compileAllPending(4);
    // 只编译前 4 个。
    expect(compiler.compiled.length).toBe(4);
    expect(result).toEqual({ success: 4, failed: 0 });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
