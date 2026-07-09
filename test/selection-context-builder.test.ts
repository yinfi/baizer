function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toContain: (s: string) => { if (typeof actual !== 'string' || !actual.includes(s)) throw new Error(`Expected "${actual}" to contain "${s}"`); },
    notToContain: (s: string) => { if (typeof actual === 'string' && actual.includes(s)) throw new Error(`Expected "${actual}" NOT to contain "${s}"`); },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== SelectionContextBuilder Tests ===');
  const { SelectionContextBuilder } = await import('../src/ui/selection-ai/selection-context-builder');

  const makeDeps = (over: any = {}) => ({
    knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => '[知识库相关笔记节选]\nKB内容' },
    modelService: { recallGuardianMemory: async () => '[Relevant Memory]\n记忆内容' },
    contextService: { collect: async () => ({ activeNote: { path: 'a.md', title: 'A' }, contextItems: [{ id: 'active-note:a.md', content: '当前小节正文' }] }) },
    ...over,
  });

  await test('校对(context 全空)只返回原 prompt,不预取', () => {
    let called = false;
    const deps = makeDeps({ knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => { called = true; return 'x'; } } });
    const b = new SelectionContextBuilder(deps as any);
    return b.build({ activeNote: false, knowledge: false, memory: false }, '选区文字', 'PROMPT').then((out: string) => {
      expect(out).toBe('PROMPT');
      expect(called).toBe(false);
    });
  });

  await test('扩写(全量)把三源拼进 prompt 前缀', async () => {
    const b = new SelectionContextBuilder(makeDeps() as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toContain('当前小节正文');
    expect(out).toContain('KB内容');
    expect(out).toContain('记忆内容');
    expect(out).toContain('PROMPT');
  });

  await test('翻译(仅知识库)不含笔记/记忆', async () => {
    const b = new SelectionContextBuilder(makeDeps() as any);
    const out = await b.build({ knowledge: true }, '选区文字', 'PROMPT');
    expect(out).toContain('KB内容');
    expect(out).notToContain('记忆内容');
    expect(out).notToContain('当前小节正文');
  });

  await test('某源超时/抛错降级为跳过该源,不阻断', async () => {
    const deps = makeDeps({ knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => { throw new Error('boom'); } } });
    const b = new SelectionContextBuilder(deps as any);
    const out = await b.build({ knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toContain('记忆内容');
    expect(out).notToContain('KB内容');
    expect(out).toContain('PROMPT');
  });

  await test('全源为空时返回裸 prompt', async () => {
    const deps = makeDeps({
      knowledgeRuntime: { getGuardianDeepKnowledgeContext: async () => '' },
      modelService: { recallGuardianMemory: async () => '' },
      contextService: { collect: async () => ({ activeNote: null, contextItems: [] }) },
    });
    const b = new SelectionContextBuilder(deps as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toBe('PROMPT');
  });

  await test('缺失依赖(null runtime)时安全跳过', async () => {
    const b = new SelectionContextBuilder({ knowledgeRuntime: null, modelService: null, contextService: null } as any);
    const out = await b.build({ activeNote: true, knowledge: true, memory: true }, '选区文字', 'PROMPT');
    expect(out).toBe('PROMPT');
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
