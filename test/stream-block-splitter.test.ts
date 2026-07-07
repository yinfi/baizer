import { findBlockBoundary } from '../src/ui/renderers/stream-block-splitter';

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (error: any) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
}

console.log('=== Stream Block Splitter Tests ===');

// 没有空行 → 无可闭合块,整体仍在尾部。
test('no blank line yields no boundary', () => {
  const r = findBlockBoundary('# Title\nsome text still streaming');
  expect(r === 0, `expected 0, got ${r}`);
});

// 单个空行分隔两段 → 切分点在空行之后,第二段作为尾部保留。
test('blank line splits first paragraph off', () => {
  const text = 'para one\n\npara two';
  const r = findBlockBoundary(text);
  expect(text.slice(0, r) === 'para one\n\n', `prefix was ${JSON.stringify(text.slice(0, r))}`);
  expect(text.slice(r) === 'para two', `tail was ${JSON.stringify(text.slice(r))}`);
});

// 取最后一个安全边界:多段时前面都冻结,只留最后一段做尾部。
test('takes the last safe boundary', () => {
  const text = 'a\n\nb\n\nc';
  const r = findBlockBoundary(text);
  expect(text.slice(r) === 'c', `tail was ${JSON.stringify(text.slice(r))}`);
  expect(text.slice(0, r) === 'a\n\nb\n\n', `prefix was ${JSON.stringify(text.slice(0, r))}`);
});

// 代码围栏内的空行不能当边界(否则会把半截代码块切碎渲染错)。
test('blank line inside fence is not a boundary', () => {
  const text = '```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
  const r = findBlockBoundary(text);
  // 唯一安全边界是围栏闭合后的空行,尾部应为 after。
  expect(text.slice(r) === 'after', `tail was ${JSON.stringify(text.slice(r))}`);
  expect(text.slice(0, r).includes('```\n\n'), 'prefix should contain the closed fence');
});

// 未闭合围栏:即便内部有空行也绝不切分,整体留作尾部。
test('unclosed fence never splits', () => {
  const text = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
  const r = findBlockBoundary(text);
  // intro 之后的空行是安全的,但围栏一旦开启且未闭合,其后的空行都不算。
  expect(text.slice(0, r) === 'intro\n\n', `prefix was ${JSON.stringify(text.slice(0, r))}`);
});

// 行内 markdown 不产生空行,天然全部留在尾部,不被提前切分。
test('inline markdown stays in tail', () => {
  const r = findBlockBoundary('this has **bold** and `code` inline');
  expect(r === 0, `expected 0, got ${r}`);
});

// ~~~ 围栏与 ``` 等价,且不同标记不互相闭合。
test('tilde fence behaves like backtick fence', () => {
  const text = '~~~\nblank\n\ninside\n~~~\n\ndone';
  const r = findBlockBoundary(text);
  expect(text.slice(r) === 'done', `tail was ${JSON.stringify(text.slice(r))}`);
});

// 空字符串安全返回 0。
test('empty string is safe', () => {
  expect(findBlockBoundary('') === 0, 'empty should be 0');
});

// 结尾多个空行:边界推进到最后一个空行之后,尾部为空(等待下一块流入)。
test('trailing blank lines advance boundary', () => {
  const text = 'done block\n\n';
  const r = findBlockBoundary(text);
  expect(text.slice(0, r) === 'done block\n\n', `prefix was ${JSON.stringify(text.slice(0, r))}`);
  expect(text.slice(r) === '', `tail was ${JSON.stringify(text.slice(r))}`);
});

console.log('  All stream-block-splitter tests passed.');
