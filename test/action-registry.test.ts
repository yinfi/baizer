function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toContain: (sub: string) => {
      if (typeof actual !== 'string' || !actual.includes(sub)) throw new Error(`Expected "${actual}" to contain "${sub}"`);
    },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== Action Registry Tests ===');
  const { SELECTION_ACTIONS, getAction, detectTranslateDirection, buildActionPrompt } =
    await import('../src/ui/selection-ai/action-registry');

  await test('每个动作元数据字段完整', () => {
    for (const a of SELECTION_ACTIONS) {
      if (!a.id || !a.icon || !a.label || !a.promptTemplate || !a.kind) {
        throw new Error(`action ${a.id} 字段缺失`);
      }
      if (a.kind !== 'rewrite' && a.kind !== 'readonly') {
        throw new Error(`action ${a.id} kind 非法: ${a.kind}`);
      }
    }
  });

  await test('包含约定的六个动作', () => {
    const ids = SELECTION_ACTIONS.map(a => a.id).sort();
    expect(ids).toEqual(['expand', 'explain', 'fix', 'improve', 'summarize', 'translate']);
  });

  await test('explain 是只读,其余是改写', () => {
    expect(getAction('explain')!.kind).toBe('readonly');
    expect(getAction('improve')!.kind).toBe('rewrite');
    expect(getAction('translate')!.kind).toBe('rewrite');
  });

  await test('翻译方向:中文译英,其余译中', () => {
    expect(detectTranslateDirection('你好世界')).toBe('to-en');
    expect(detectTranslateDirection('hello world')).toBe('to-zh');
    expect(detectTranslateDirection('包含some英文的中文')).toBe('to-en');
  });

  await test('buildActionPrompt 把选区文本嵌入模板', () => {
    const p = buildActionPrompt('improve', '这是一段草稿');
    expect(p).toContain('这是一段草稿');
  });

  await test('翻译 prompt 按方向给出目标语言', () => {
    expect(buildActionPrompt('translate', '你好')).toContain('English');
    expect(buildActionPrompt('translate', 'hello')).toContain('中文');
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
