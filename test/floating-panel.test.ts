function expect(actual: any) {
  return {
    toBe: (e: any) => { if (actual !== e) throw new Error(`Expected ${e} but got ${actual}`); },
    toEqual: (e: any) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)} but got ${JSON.stringify(actual)}`); },
  };
}
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

async function runTests() {
  console.log('=== FloatingPanel geometry Tests ===');
  const { clampRect, DEFAULT_PANEL_RECT } = await import('../src/ui/selection-ai/floating-panel');

  await test('默认矩形有合理尺寸', () => {
    expect(DEFAULT_PANEL_RECT.width).toBe(420);
    expect(DEFAULT_PANEL_RECT.height).toBe(360);
  });

  await test('clampRect 把越界矩形拉回视口内', () => {
    const r = clampRect({ left: 5000, top: -100, width: 420, height: 360 }, { width: 1000, height: 800 });
    expect(r.left <= 580).toBe(true);
    expect(r.top >= 0).toBe(true);
  });

  await test('clampRect 尺寸超视口时收缩到视口', () => {
    const r = clampRect({ left: 0, top: 0, width: 9999, height: 9999 }, { width: 1000, height: 800 });
    expect(r.width <= 1000).toBe(true);
    expect(r.height <= 800).toBe(true);
  });

  await test('clampRect 保底最小尺寸', () => {
    const r = clampRect({ left: 0, top: 0, width: 10, height: 10 }, { width: 1000, height: 800 });
    expect(r.width >= 280).toBe(true);
    expect(r.height >= 200).toBe(true);
  });
}

runTests().catch((e) => { console.error(e); process.exit(1); });
