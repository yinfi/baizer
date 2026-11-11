import { readFileSync } from 'fs';

/**
 * 思考时间线的展示/动效契约。
 *
 * 这些是 CSS 事实,跑不到 DOM 里,但每一条都对应真实回归:
 * - 折叠不能再走 display:none,否则展开/收起没有过渡;
 * - 折叠后的正文必须离开无障碍树,否则读屏会念出已收起的内容;
 * - 思考正文是多行纯文本,换行必须保留;
 * - 展开朝下、收起朝右,箭头不能指反;
 * - 新增的持续动画必须进 prefers-reduced-motion 关闭清单。
 */

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
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

/** 取选择器对应规则体(首个匹配),并把空白压平便于断言。 */
function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return (match?.[1] || '').replace(/\s+/g, ' ');
}

/** 取 @media 块的整体内容(按花括号配对,不依赖缩进)。 */
function mediaBlock(css: string, query: string) {
  const start = css.indexOf(query);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i).replace(/\s+/g, ' ');
    }
  }
  return '';
}

async function runTests() {
  console.log('=== Thinking Timeline Style Tests ===');
  const css = readFileSync('styles.css', 'utf8');

  await test('collapsing animates the content row instead of cutting it with display:none', () => {
    const block = ruleBody(css, '.baizer-thinking-block');
    const expanded = ruleBody(css, '.baizer-thinking-block:not(.is-collapsed)');

    expect(block).toContain('grid-template-rows: auto 0fr');
    expect(block).toContain('transition: grid-template-rows');
    expect(expanded).toContain('grid-template-rows: auto 1fr');
  });

  await test('collapsed thinking content leaves the accessibility tree', () => {
    // 收起是默认态(visibility: hidden),展开态才显式放回无障碍树。
    const content = ruleBody(css, '.baizer-thinking-content');
    const expanded = ruleBody(css, '.baizer-thinking-block:not(.is-collapsed) .baizer-thinking-content');

    expect(content).toContain('visibility: hidden');
    expect(expanded).toContain('visibility: visible');
  });

  await test('thinking text keeps the model line breaks and wraps long tokens', () => {
    const content = ruleBody(css, '.baizer-thinking-content');

    expect(content).toContain('white-space: pre-wrap');
    expect(content).toContain('overflow-wrap: anywhere');
    expect(content).toContain('overflow: hidden');
  });

  await test('the segment caret points down when expanded and right when collapsed', () => {
    const expanded = ruleBody(css, '.baizer-thinking-block:not(.is-collapsed) .baizer-thinking-caret');
    const collapsed = ruleBody(css, '.baizer-thinking-block.is-collapsed .baizer-thinking-caret');

    expect(expanded).toContain('transform: rotate(90deg)');
    expect(collapsed).toContain('transform: rotate(0deg)');
  });

  await test('the streaming cursor and the live summary dot are driven by their state classes', () => {
    const cursor = ruleBody(css, '.baizer-thinking-block.is-thinking .baizer-thinking-content::after');
    const summaryDot = ruleBody(css, '.shell-think-timeline.is-thinking-active .shell-think-summary::before');

    expect(cursor).toContain('animation: cursor-blink');
    expect(summaryDot).toContain('animation: think-pulse');
  });

  await test('prefers-reduced-motion turns the new continuous animations off', () => {
    const reduced = mediaBlock(css, '@media (prefers-reduced-motion: reduce)');

    // 新增的两处持续动画必须进关闭清单,且选择器与原规则同特异性。
    expect(reduced).toContain('.baizer-thinking-block.is-thinking .baizer-thinking-content::after');
    expect(reduced).toContain('.shell-think-timeline.is-thinking-active .shell-think-summary::before');
    // 浮动面板也用同一套思考节点,过渡变量要一起压平。
    expect(reduced).toContain('.baizer-floating-panel');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
