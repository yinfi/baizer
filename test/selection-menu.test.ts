function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Selection Menu Tests ===');
  const { findAtTrigger } = await import('../src/ui/selection-menu');

  await test('findAtTrigger opens on a single @ at line start or after whitespace', () => {
    expect(findAtTrigger('@', 1)).toEqual({ from: 0, to: 1 });
    expect(findAtTrigger('hello @', 7)).toEqual({ from: 6, to: 7 });
    expect(findAtTrigger('hello\n@', 7)).toEqual({ from: 6, to: 7 });
  });

  await test('findAtTrigger ignores non-at triggers and embedded @ characters', () => {
    expect(findAtTrigger('hello /', 7)).toBe(null);
    expect(findAtTrigger('hello #', 7)).toBe(null);
    expect(findAtTrigger('email@example.com', 6)).toBe(null);
    expect(findAtTrigger('@@', 2)).toBe(null);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
