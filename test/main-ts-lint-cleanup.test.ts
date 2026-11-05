/**
 * test/main-ts-lint-cleanup.test.ts
 *
 * issue #67（main.ts 的 lint 清理）的回归测试。
 *
 * main.ts 顶层 import 了 7 个 SKILL.md（走 esbuild 的 text loader），tsx 在测试环境下
 * 解析不了这些 .md 导入，所以不能直接 import main.ts。沿用
 * test/settings-provider-migration.test.ts 的两条办法：
 *
 *   1. 能独立成模块的纯函数直接 import 真实现：thrownMessage（src/utils/thrown-message.ts）
 *      与 legacyFlatString（src/mcp/types.ts）——前者语义细节多（非 Error 抛出值、
 *      跨 realm、假值 message），后者是本次唯一的行为收口（脏数据下的窄化），都必须真跑；
 *   2. 只能留在 main.ts 里的，就从 main.ts 源码里取出**真实产物**再验行为 ——
 *      onFileModify 的链接正则是现场从源码里抽出来编译的，不是测试里另抄一份，
 *      源码一改这个测试就跟着变；其余用结构性断言锁住「清理没有顺手改行为」。
 *
 * 运行：npx tsx --tsconfig tsconfig.test.json test/main-ts-lint-cleanup.test.ts
 */

import { readFileSync } from 'fs';
import { legacyFlatString } from '../src/mcp/types';
import { thrownMessage } from '../src/utils/thrown-message';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy but got ${JSON.stringify(actual)}`);
    },
    toBeFalsy: () => {
      if (actual) throw new Error(`Expected falsy but got ${JSON.stringify(actual)}`);
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

const mainSource = readFileSync('main.ts', 'utf8');

/**
 * 从 main.ts 的 onFileModify 里抽出真实的链接正则字面量并现场编译。
 * 抽不到就直接失败 —— 说明正则被搬走或改写了，本文件的前提不再成立。
 */
function shippedLinkRegex(): RegExp {
  const match = /const regex = \/(.+)\/g;/.exec(mainSource);
  if (!match) throw new Error('main.ts 里找不到 onFileModify 的链接正则字面量');
  return new RegExp(match[1], 'g');
}

/** 按 onFileModify 的判据取出裸 URL 匹配（只认组 3），带索引与长度。 */
function bareUrlMatches(content: string) {
  const out: { url: string; index: number; length: number }[] = [];
  for (const m of content.matchAll(shippedLinkRegex())) {
    if (!m[1] && !m[2] && m[3]) {
      out.push({ url: m[3], index: m.index, length: m[0].length });
    }
  }
  return out;
}

/** 按 onFileModify 的做法倒序把裸 URL 换成 wikilink（索引取自原串，故必须倒序）。 */
function replaceBareUrls(content: string, linkText: (url: string) => string): string {
  let newContent = content;
  const matches = bareUrlMatches(content).sort((a, b) => b.index - a.index);
  for (const m of matches) {
    newContent = newContent.substring(0, m.index) + linkText(m.url) + newContent.substring(m.index + m.length);
  }
  return newContent;
}

async function runTests() {
  console.log('=== main.ts lint cleanup regression (issue #67) ===');

  // ── 1. 剪贴板异常文案：Error 与非 Error 抛出值 ──
  // 替换掉的原实现是 `Failed to read clipboard: ${e?.message || 'unknown error'}`。

  await test('thrownMessage reads Error and non-Error objects that carry a message', () => {
    expect(thrownMessage(new Error('boom'))).toBe('boom');
    // 非 Error 但带 message 的对象：原实现 `e?.message` 同样能显示。
    // 若改成 `error instanceof Error ? ... : String(error)`，这一格会退化成
    // 回退文案 —— 正是 issue #67 禁止的「因只接受 Error 而丢弃原先可显示的信息」。
    expect(thrownMessage({ message: 'clipboard denied' })).toBe('clipboard denied');
    // 跨 realm 的异常对象（Electron 渲染进程）在本 realm 里 instanceof Error 为 false。
    expect(thrownMessage(Object.assign(Object.create(null), { message: 'cross realm' }))).toBe('cross realm');
    // 真值非字符串 message 原实现也会被模板字符串文本化显示。
    expect(thrownMessage({ message: 123 })).toBe('123');
    expect(thrownMessage({ message: true })).toBe('true');
  });

  await test('thrownMessage returns "" when nothing readable is available', () => {
    expect(thrownMessage(new Error(''))).toBe('');
    expect(thrownMessage(null)).toBe('');
    expect(thrownMessage(undefined)).toBe('');
    // 字符串/数字抛出值在原实现里也没有 .message，故同样拿不到信息。
    expect(thrownMessage('boom')).toBe('');
    expect(thrownMessage(42)).toBe('');
    expect(thrownMessage({})).toBe('');
    // 假值 message 原实现走 `|| 'unknown error'`，这里同样交回空串。
    expect(thrownMessage({ message: '' })).toBe('');
    expect(thrownMessage({ message: 0 })).toBe('');
    expect(thrownMessage({ message: false })).toBe('');
    expect(thrownMessage({ message: null })).toBe('');
  });

  await test('clipboard Notice text is value-for-value identical to the old `e?.message || fallback`', () => {
    const noticeText = (thrown: unknown) => `Failed to read clipboard: ${thrownMessage(thrown) || 'unknown error'}`;

    expect(noticeText(new Error('denied'))).toBe('Failed to read clipboard: denied');
    expect(noticeText({ message: 'denied' })).toBe('Failed to read clipboard: denied');
    expect(noticeText({ message: 123 })).toBe('Failed to read clipboard: 123');
    // 回退语义（原实现的 `|| 'unknown error'`）逐值保留。
    expect(noticeText(new Error(''))).toBe('Failed to read clipboard: unknown error');
    expect(noticeText({ message: 0 })).toBe('Failed to read clipboard: unknown error');
    expect(noticeText(null)).toBe('Failed to read clipboard: unknown error');
    expect(noticeText(undefined)).toBe('Failed to read clipboard: unknown error');
    expect(noticeText('denied')).toBe('Failed to read clipboard: unknown error');
    expect(noticeText(42)).toBe('Failed to read clipboard: unknown error');
  });

  // ── 2. onFileModify 的链接正则（no-useless-escape 清理点）──

  await test('wikilink / Markdown link / bare URL are still told apart', () => {
    const content = '见 [[Note A]] 与 [B](https://b.example/x) 还有 https://c.example/y';
    const shape = [...content.matchAll(shippedLinkRegex())].map((m) => ({
      wikilink: m[1] ?? null,
      markdown: m[2] ?? null,
      rawUrl: m[3] ?? null,
    }));

    expect(shape).toEqual([
      { wikilink: '[[Note A]]', markdown: null, rawUrl: null },
      { wikilink: null, markdown: '[B](https://b.example/x)', rawUrl: null },
      { wikilink: null, markdown: null, rawUrl: 'https://c.example/y' },
    ]);
  });

  await test('a bare URL stops before a trailing right paren and keeps query/anchor/path', () => {
    expect(bareUrlMatches('(https://example.com/a)').map((m) => m.url)).toEqual(['https://example.com/a']);
    expect(bareUrlMatches('https://example.com/a)').map((m) => m.url)).toEqual(['https://example.com/a']);
    expect(bareUrlMatches('https://example.com/a/b?c=d#e').map((m) => m.url)).toEqual(['https://example.com/a/b?c=d#e']);
  });

  await test('[^\\s\\)] and [^\\s)] are the same character class', () => {
    const before = new RegExp('[^\\s\\)]');
    const after = new RegExp('[^\\s)]');
    const samples = ['a', '1', ' ', '\t', '\n', '\r', ')', '(', '/', '\\', '?', '#', '中', ']', '-', '.'];

    const beforeMatches = samples.map((ch) => before.test(ch));
    expect(beforeMatches).toEqual(samples.map((ch) => after.test(ch)));
    // 两者都排除右括号 —— 这正是「URL 分组不吞掉尾随右括号」的原因。
    expect(beforeMatches[samples.indexOf(')')]).toBe(false);
  });

  await test('main.ts uses the escaped-free character class and no other escape changed', () => {
    expect(mainSource.includes('[^\\s\\)]')).toBeFalsy();
    expect(mainSource.includes('[^\\s)]')).toBeTruthy();
    // Markdown 链接分组里那两个转义是有意义的（\( \) 是字面括号，\/ 是正则字面量必需），
    // 只允许改最后那个字符类。
    expect(mainSource.includes('(\\[.*?\\]\\(.*?\\))')).toBeTruthy();
    expect(mainSource.includes('https?:\\/\\/')).toBeTruthy();
  });

  await test('reverse-order replacement still splices at the original indices', () => {
    const content = 'A https://one.example/1 B https://two.example/2 C';

    expect(replaceBareUrls(content, (url) => `[[Saved|${url}]]`))
      .toBe('A [[Saved|https://one.example/1]] B [[Saved|https://two.example/2]] C');

    // 索引/长度取自匹配本身，替换前指向原串里的 URL 原文。
    expect(bareUrlMatches(content).map((m) => content.substring(m.index, m.index + m.length)))
      .toEqual(['https://one.example/1', 'https://two.example/2']);
  });

  // ── 3. 旧扁平设置迁移：类型收口没有改迁移策略 ──

  await test('LegacyFlatSettings declares exactly the old flat fields actually read, all as unknown', () => {
    const typeAt = mainSource.indexOf('type LegacyFlatSettings = {');
    expect(typeAt >= 0).toBeTruthy();
    const typeBody = mainSource.slice(typeAt, mainSource.indexOf('};', typeAt));

    const declared = [...typeBody.matchAll(/^\s*(\w+)\?: unknown;/gm)].map((m) => m[1]);
    expect(declared).toEqual([
      'provider',
      'openaiApiKey', 'openaiBaseUrl', 'openaiModel',
      'deepseekApiKey', 'deepseekBaseUrl', 'deepseekModel',
      'qwenApiKey', 'qwenBaseUrl', 'qwenModel',
    ]);
    // 已随 gemini 协议移除的 Google 凭证字段不再声明（也就不会被迁移）。
    expect(declared.includes('apiKey')).toBeFalsy();
    expect(declared.includes('primaryModel')).toBeFalsy();
  });

  await test('the legacy branch narrows every field through legacyFlatString and keeps every default', () => {
    const branchStart = mainSource.indexOf('if (!raw.providers && raw.provider)');
    expect(branchStart >= 0).toBeTruthy();
    // 切片到迁移分支之后的下一节（与 settings-provider-migration.test.ts 同一锚点），
    // 否则会漏掉位于注释「// 持久化迁移结果」之后的 saveData 调用。
    const branch = mainSource.slice(
      branchStart,
      mainSource.indexOf('// 确保 providers 中包含所有默认 provider', branchStart),
    );

    // 每个字段都过 legacyString，且保留原来的 `|| 默认值` 回退。
    for (const field of [
      'openaiApiKey', 'openaiBaseUrl', 'openaiModel',
      'deepseekApiKey', 'deepseekBaseUrl', 'deepseekModel',
      'qwenApiKey', 'qwenBaseUrl', 'qwenModel',
    ]) {
      expect({ field, guarded: branch.includes(`legacyFlatString(old.${field}) || `) }).toEqual({ field, guarded: true });
    }
    expect(branch.includes("this.settings.activeProvider = legacyFlatString(old.provider) || 'openai';")).toBeTruthy();

    // 默认值一字未改。
    for (const preset of [
      "'https://api.openai.com/v1'", "'gpt-4o'",
      "'https://api.deepseek.com'", "'deepseek-chat'",
      "'https://dashscope.aliyuncs.com/compatible-mode/v1'", "'qwen-turbo'",
    ]) {
      expect({ preset, kept: branch.includes(preset) }).toEqual({ preset, kept: true });
    }

    // 迁移触发与落盘时机保持原样。
    expect(mainSource.includes('if (!raw.providers && raw.provider)')).toBeTruthy();
    expect(branch.includes('await this.saveData(this.settings);')).toBeTruthy();
  });

  await test('legacyFlatString passes strings through and rejects everything else', () => {
    // 字符串原样放行（含空串——空串仍会走调用处的 `|| 默认值`）。
    expect(legacyFlatString('openai')).toBe('openai');
    expect(legacyFlatString('')).toBe('');
    expect(legacyFlatString('https://api.deepseek.com')).toBe('https://api.deepseek.com');

    // 非字符串（手工改坏的 data.json）一律交回 undefined，由调用处回落到默认值。
    const dirty: unknown[] = [123, 0, 1, true, false, null, undefined, {}, [], ['a'], { message: 'x' }];
    for (const value of dirty) {
      expect({ value: String(value), out: legacyFlatString(value) ?? null })
        .toEqual({ value: String(value), out: null });
    }
  });

  await test('the abnormal-data narrowing is exactly the declared one: non-strings fall back', () => {
    // 调用处的形状就是 `legacyFlatString(old.x) || 默认值`。
    const withDefault = (raw: unknown, fallback: string) => legacyFlatString(raw) || fallback;

    // 字符串与旧实现 `old.x || fallback` 逐值一致。
    expect(withDefault('sk-abc', 'DEFAULT')).toBe('sk-abc');
    expect(withDefault('0', 'DEFAULT')).toBe('0');
    expect(withDefault('', 'DEFAULT')).toBe('DEFAULT');

    // 旧实现会把 123 / {} 原样写进 ProviderConfig；现在回落到默认值——这是本次清理
    // 唯一的行为收口，issue #67 风险一节要求它被单独说明并覆盖。
    expect(withDefault(123, 'DEFAULT')).toBe('DEFAULT');
    expect(withDefault({}, 'DEFAULT')).toBe('DEFAULT');
    expect(withDefault(true, 'DEFAULT')).toBe('DEFAULT');
    expect(withDefault(null, 'DEFAULT')).toBe('DEFAULT');
    expect(withDefault(undefined, 'DEFAULT')).toBe('DEFAULT');

    // `provider` 的非字符串值最终结果与旧实现相同：旧实现把 123 直接赋给 activeProvider，
    // 紧随其后的「activeProvider 指向不存在的 provider 就修复」步骤同样把它改回 'openai'。
    expect(withDefault(123, 'openai')).toBe('openai');
  });

  await test('the persisted settings entry point no longer asserts untrusted JSON', () => {
    expect(mainSource.includes('(raw as any)')).toBeFalsy();
    expect(mainSource.includes('const old = raw as any')).toBeFalsy();
    // loadData 的 any 先落到 unknown，再一次性收窄成 Record（不再让 any 直接进 Record 赋值）。
    expect(mainSource.includes('const loaded: unknown = await this.loadData();')).toBeTruthy();
    expect(mainSource.includes('const raw = (loaded || {}) as Record<string, unknown>;')).toBeTruthy();
    expect(mainSource.includes('const old: LegacyFlatSettings = raw;')).toBeTruthy();
    // `|| {}` 而不是 `?? {}`：loadData 返回假值时也要兜底成空对象。
    expect(mainSource.includes('(await this.loadData()) ?? {}')).toBeFalsy();
    expect(mainSource.includes('(loaded ?? {}) as Record<string, unknown>')).toBeFalsy();
  });

  await test('save_webpage results are narrowed at the tool boundary instead of trusted as any', () => {
    // 工具返回形状不由契约导出：先 unknown 接住，再收窄成 ToolExecutionResult。
    expect(mainSource.includes('function narrowToolExecutionResult(value: unknown): ToolExecutionResult')).toBeTruthy();
    expect(mainSource.includes('const record = isRecord(value) ? value : {};')).toBeTruthy();
    expect(mainSource.includes('success: Boolean(record.success),')).toBeTruthy();
    expect(mainSource.includes("path: asString(record.path) ?? '',")).toBeTruthy();
    expect(mainSource.includes('error: asString(record.error),')).toBeTruthy();

    // 三个 saveUrl 回调与 onFileModify 的批量保存都必须经过该窄化，不再直接消费 any。
    const narrowedCalls = mainSource.split('narrowToolExecutionResult(await this.toolRegistry.execute').length - 1;
    expect(narrowedCalls).toBe(4);
    expect(mainSource.includes("saveUrl: async (url: string) => this.toolRegistry.execute('save_webpage', { url })")).toBeFalsy();
    expect(mainSource.includes("const result: ToolExecutionResult = await this.toolRegistry.execute('save_webpage'")).toBeFalsy();
  });

  // ── 4. 事件/回调接线没有因为类型清理而改变 ──

  await test('editor-change keeps its declared parameter types and stays registered', () => {
    expect(mainSource.includes('private onEditorChange = (editor: Editor, info: MarkdownView | MarkdownFileInfo)')).toBeTruthy();
    expect(mainSource.includes('private queueGuardianCheck(editor: Editor, info: MarkdownView | MarkdownFileInfo)')).toBeTruthy();
    expect(mainSource.includes('private onEditorChange = (editor: any')).toBeFalsy();
    expect(mainSource.includes('private queueGuardianCheck(editor: any')).toBeFalsy();
    // 事件照旧注册，回调照旧把两个参数一起传下去。
    expect(mainSource.includes("this.app.workspace.on('editor-change', this.onEditorChange)")).toBeTruthy();
    expect(mainSource.includes('void this.queueGuardianCheck(editor, info);')).toBeTruthy();
  });

  await test('the ribbon callback still opens the view and marks its unused argument', () => {
    const ribbonAt = mainSource.indexOf("addRibbonIcon('baizer-bz'");
    expect(ribbonAt >= 0).toBeTruthy();
    const callback = mainSource.slice(ribbonAt, mainSource.indexOf('});', ribbonAt) + 3);

    expect(callback.includes('void this.activateView();')).toBeTruthy();
    expect(callback.includes('(_evt: MouseEvent)')).toBeTruthy();
    expect(callback.includes('(evt: MouseEvent)')).toBeFalsy();
  });

  await test('the registerView catch drops its unused binding without changing the tolerance behaviour', () => {
    expect(mainSource.includes('} catch (e) {')).toBeFalsy();
    expect(mainSource.includes('} catch {')).toBeTruthy();

    const catchAt = mainSource.indexOf('} catch {');
    const body = mainSource.slice(catchAt, catchAt + 240);
    expect(body.includes("logger.info('View type already registered, skipping.', 'Baizer')")).toBeTruthy();
  });

  await test('the clipboard catch uses unknown + guard instead of an any binding', () => {
    expect(mainSource.includes('catch (e: any)')).toBeFalsy();
    expect(mainSource.includes('catch (error: unknown)')).toBeTruthy();
    expect(mainSource.includes("${thrownMessage(error) || 'unknown error'}")).toBeTruthy();
    expect(mainSource.includes("e?.message || 'unknown error'")).toBeFalsy();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
