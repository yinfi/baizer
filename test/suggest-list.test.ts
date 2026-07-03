function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toEqual: (e: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)} but got ${JSON.stringify(actual)}`);
    },
  };
}
async function test(name: string, fn: () => any) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

class FakeEl {
  children: FakeEl[] = [];
  className = ''; textContent = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  createDiv(a?: any) { return this.createEl('div', a); }
  createSpan(a?: any) { return this.createEl('span', a); }
  createEl(_t: string, a?: any) { const c = new FakeEl(); c.className = a?.cls || ''; c.textContent = a?.text || ''; if (a?.attr) for (const [k,v] of Object.entries(a.attr)) c.attributes[k]=String(v); this.children.push(c); return c; }
  empty() { this.children = []; }
  setAttribute(n: string, v: string) { this.attributes[n] = v; }
  addEventListener(t: string, h: Function) { (this.listeners[t] ||= []).push(h); }
  scrollIntoView() {}
}

async function runTests() {
  console.log('=== Suggest List Tests ===');
  const { SuggestList } = await import('../src/ui/components/suggest-list');

  await test('打 @ 触发 file 类,回调收到 query', () => {
    const container = new FakeEl();
    let askedQuery: string | null = null;
    const list = new SuggestList({
      container: container as any,
      provideItems: (type, query) => { askedQuery = query; return type === 'file' ? [{ label: 'Note', desc: 'Note.md', value: 'Note.md', source: 'file', kind: 'file' }] : []; },
      onApply: () => {},
    });
    list.handleInput('hello @No', 9);
    expect(askedQuery).toBe('No');
    expect(list.isOpen()).toBe(true);
  });

  await test('Enter 选中 file 项:走 contextItem 分支并触发 onApply', () => {
    const container = new FakeEl();
    const applied: any[] = [];
    const list = new SuggestList({
      container: container as any,
      provideItems: () => [{ label: 'Note', desc: 'Note.md', value: 'Note.md', source: 'file', kind: 'file' }],
      onApply: (sel) => applied.push(sel),
    });
    list.handleInput('@No', 3);
    const handled = list.handleKeyDown({ key: 'Enter', preventDefault() {} } as any);
    expect(handled).toBe(true);
    expect(applied.length).toBe(1);
    expect(applied[0].contextItem.id).toBe('file:Note.md');
    expect(applied[0].contextItem.type).toBe('file');
  });

  await test('无 trigger 时关闭', () => {
    const container = new FakeEl();
    const list = new SuggestList({ container: container as any, provideItems: () => [], onApply: () => {} });
    list.handleInput('plain text', 10);
    expect(list.isOpen()).toBe(false);
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
