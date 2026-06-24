function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
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

async function runTests() {
  console.log('=== Ghost Text Tests ===');
  const { showGhostText, storeGhostText } = await import('../src/ui/ghost-text');

  await test('storeGhostText preserves accept state without visible decoration', () => {
    let payload: any = null;
    const view = {
      dispatch: (value: any) => {
        payload = value;
      },
    } as any;

    storeGhostText(view, 'continue writing', 2, 4);

    expect(payload.effects.value.visible).toBe(false);
    expect(payload.effects.value.text).toBe('continue writing');
  });

  await test('showGhostText keeps the suggestion visible', () => {
    let payload: any = null;
    const view = {
      dispatch: (value: any) => {
        payload = value;
      },
    } as any;

    showGhostText(view, 'continue writing', 2, 4);

    expect(payload.effects.value.visible).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
