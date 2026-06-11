import { readFileSync } from 'fs';

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

function getRuleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] || '';
}

function hasDeclaration(ruleBody: string, property: string, value: string) {
  const normalized = ruleBody.replace(/\s+/g, ' ');
  return normalized.includes(`${property}: ${value}`);
}

async function runTests() {
  console.log('=== Shell Input Layout Tests ===');
  const css = readFileSync('styles.css', 'utf8');

  await test('composer textarea fills the shell input width', () => {
    const wrapperRule = getRuleBody(css, '.baizer-shell-view .shell-input-wrapper');
    const textareaRule = getRuleBody(css, '.baizer-shell-view textarea.shell-input');

    expect(hasDeclaration(wrapperRule, 'width', '100%')).toBe(true);
    expect(hasDeclaration(textareaRule, 'display', 'block')).toBe(true);
    expect(hasDeclaration(textareaRule, 'width', '100%')).toBe(true);
    expect(hasDeclaration(textareaRule, 'box-sizing', 'border-box')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
