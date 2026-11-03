import { DEFAULT_PROVIDERS } from '../src/mcp/types';
import { setLocaleForTesting, t } from '../src/i18n/zh';
import { ZH_MESSAGES } from '../src/i18n/zh-messages';
import { FakeElement } from './ui-fakes';
import { ModelService } from '../src/services/model-service';
import { checkAvailabilityWithStatus } from '../src/services/model-catalog-service';
import {
  CONNECTION_FIELD_GROUP,
  ConnectionFieldId,
  buildNewProviderConfig,
  describeRequestPath,
  getConnectionFieldOrder,
  getConnectionGroups,
  getConnectionTestReport,
  getConnectionTestStage,
  getConnectionTestStatusPresentation,
  getDefaultBaseUrlForType,
  getModelFieldState,
  getModelListEndpoint,
  getProtocolOptions,
  getRequestPathSummary,
  getSettingsFallbackCss,
  renderModelField,
  resolveBaseUrlOnProtocolChange,
} from '../src/settings';
import { readFileSync } from 'fs';

// 断言用英文原文 key(t() 在非中文环境返回原文),固定 locale 保证与运行环境无关。
setLocaleForTesting(false);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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

/**
 * 模型字段渲染要断言真实 DOM 属性（输入框是否 disabled），而 test/__mocks__/obsidian.ts
 * 的 Setting/PluginSettingTab 是空壳、跑不了完整设置页。故按仓库既有做法复用
 * test/ui-fakes.ts 的 FakeElement，只补上 renderModelField 用到的 Obsidian 便捷方法。
 */
class FakeNode extends FakeElement {
  attrs: Record<string, string> = {};
  /** 模型输入框用 title 承载完整值（长 ID 被输入框宽度截断时的兜底），故要能断言。 */
  title = '';

  setText(text: string): void {
    this.textContent = text;
  }

  /** FakeElement 没有属性表；aria-label 等属性要能被断言，故补一份最小实现。 */
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  createEl(tag: string, attr?: any): any {
    const child = new FakeNode();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    // 真实 createEl 会把 attr 里的键写成属性/属性值（如 option 的 value）。
    Object.keys(attr || {}).forEach((key) => {
      if (key === 'cls' || key === 'text') return;
      if (key === 'attr' && attr.attr && typeof attr.attr === 'object') {
        Object.keys(attr.attr).forEach((name) => child.setAttribute(name, attr.attr[name]));
        return;
      }
      (child as any)[key] = attr[key];
    });
    this.children.push(child);
    return child;
  }
}

function fakeContainer(): FakeNode {
  return new FakeNode();
}

/** 断言计算样式前先去掉注释：注释里出现 "nowrap" 这类词不该影响判定。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 从源码里抽出所有 `t('…')` 的 key。
 *
 * 负向后顾是必需的：朴素的 /t\('…'\)/ 会把 `format('a, b')`、`setAttribute('style', …)`
 * 里结尾的 `t('` 也当成翻译调用，于是「key」会多出 `,` `\n` `style` 之类的噪声。
 * 本文件所在的 settings.ts 中，注释里没有 `t('…')`，也没有模板字符串形式的 t()，
 * 故不需要更复杂的词法分析。
 */
function extractTranslationKeys(source: string): string[] {
  const pattern = /(?<![A-Za-z0-9_$])t\('((?:[^'\\]|\\.)*)'\)/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

/**
 * 本次改动之前就漏译的 key（共 7 条：权限 / 采集 / 连接面板既有文案）。
 * 它们不是本次变更的问题，把它们纳入断言只会让测试长期变红、反而掩盖新漏译。
 * 这份清单必须精确：多写一条就等于永久放过一条真实漏译。
 *
 * 注：`API Key` 是字段标签，而同一术语既有的译文就是 `'API key': 'API Key'`——
 * 中文界面下本来就该显示 "API Key"，所以没有用户可见的问题，只是缺一条同值映射。
 */
const PRE_EXISTING_UNTRANSLATED = new Set([
  'API Key',
  'Allow Reading Plugin Config Values',
  'Disable Execution Confirmation',
  'Grant AI permission to execute commands from other plugins? This can trigger destructive plugin actions on your behalf.',
  'Let AI read third-party plugin configuration values. When off, only key names and types are returned. API keys, tokens, and secrets are always redacted regardless of this setting.',
  'Turn off confirmation? AI will write files and run commands without asking each time.',
  'Use this URL scheme from iOS Shortcuts or Android automation. Fallback command: Save URL from clipboard.',
]);

/** renderModelField 内部是 `void load(false)`，等一轮宏任务让 Promise 链跑完。 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function runTests() {
  console.log('=== Settings Provider Layout Tests ===');

  await test('the inline fallback stylesheet is brace-balanced', () => {
    const css = getSettingsFallbackCss();
    let depth = 0;
    let lowest = 0;
    for (const char of css) {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        lowest = Math.min(lowest, depth);
      }
    }
    // 兜底 CSS 是注入 <style> 的模板字符串：少一个括号就会把后续所有规则吞掉，
    // 且只在运行时才看得出来。这里把「结构完整」纳入验收。
    expect({ depth, lowest }).toEqual({ depth: 0, lowest: 0 });
    assert(
      css.includes('@container (max-width: 840px)') && css.includes('@container (max-width: 640px)'),
      'both narrow breakpoints must exist in the fallback stylesheet',
    );
    // 标题栏里序号徽章排在 Setting 之前，Setting 不再是 :first-child：
    // 若不清零，Obsidian 默认的 .setting-item 上边框与内边距会在卡片标题上方多出一条线。
    assert(
      css.includes('.baizer-settings-connection-card-header .setting-item'),
      'the card header must neutralize the .setting-item border/padding',
    );
    assert(
      css.includes('.baizer-settings-connection-card-header { justify-content: flex-start; }'),
      'the card header must not use space-between (it would push the title to the far right)',
    );
  });

  // ── F4/F5：副标题不许被裁切，且最窄窗口要拿到窄屏布局 ──

  await test('the page subtitle never clips at any width', () => {
    // F4：页面正文被 ellipsis 吃掉就是「读不到」。宽屏下副标题只落在 hero 左列
    // （316px）而文字约 390px，此前 scrollWidth 390 > clientWidth 316，74px 永远看不到。
    // 兜底表最后注入、优先级更高，所以两张表都必须干净。
    const sources: Array<[string, string]> = [
      ['fallback', stripCssComments(getSettingsFallbackCss())],
      ['styles.css', stripCssComments(readFileSync('styles.css', 'utf8'))],
    ];

    for (const [name, css] of sources) {
      const rule = css.match(/\.baizer-settings-subtitle\s*\{[^}]*\}/);
      assert(Boolean(rule), `${name} must define .baizer-settings-subtitle`);
      const body = rule![0];
      assert(
        !/nowrap/.test(body),
        `${name}: .baizer-settings-subtitle must not use nowrap (it clips page body text)`,
      );
      assert(
        !/text-overflow\s*:\s*ellipsis/.test(body),
        `${name}: .baizer-settings-subtitle must not use an ellipsis`,
      );
      assert(
        !/overflow\s*:\s*hidden/.test(body),
        `${name}: .baizer-settings-subtitle must not hide its overflow`,
      );
      assert(
        /white-space\s*:\s*normal/.test(body),
        `${name}: .baizer-settings-subtitle must explicitly allow wrapping`,
      );
    }

    // 副标题横跨两列，宽屏才有整行可用（只靠换行仍会被挤成两行窄栏文字）。
    for (const [name, css] of sources) {
      assert(
        css.includes('grid-template-areas: "title search" "subtitle subtitle"'),
        `${name}: the hero must let the subtitle span both columns`,
      );
    }
  });

  await test('page body text is never clipped to a single line by the fallback sheet', () => {
    // 同一个双重来源陷阱：兜底表最后注入、优先级更高，所以「styles.css 改好了」不等于
    // 界面上改好了。分区描述就是第二个受害者——styles.css 是两行截断，兜底表却是单行
    // nowrap+ellipsis，于是真实界面里只显示一行。
    const fallback = stripCssComments(getSettingsFallbackCss());
    const styles = stripCssComments(readFileSync('styles.css', 'utf8'));

    for (const [name, css] of [['fallback', fallback], ['styles.css', styles]] as Array<[string, string]>) {
      const rule = css.match(/\.baizer-settings-section-description\s*\{[^}]*\}/);
      assert(Boolean(rule), `${name} must define .baizer-settings-section-description`);
      assert(
        !/nowrap/.test(rule![0]),
        `${name}: .baizer-settings-section-description must not use nowrap`,
      );
      assert(
        /-webkit-line-clamp\s*:\s*2/.test(rule![0]),
        `${name}: .baizer-settings-section-description must clamp to two lines`,
      );
    }
  });

  await test('the narrow breakpoint sits above the app minimum window width', () => {
    // F5：设置浮窗声明 minWidth: 600，600px 是真实用户能到的最窄窗口。
    // 断点若 ≤600，最窄窗口会拿到宽屏布局 —— 恰好是唯一没被量过的一档。
    const POPOUT_MIN_WIDTH = 600;
    for (const [name, css] of [
      ['fallback', getSettingsFallbackCss()],
      ['styles.css', readFileSync('styles.css', 'utf8')],
    ] as Array<[string, string]>) {
      const widths = Array.from(css.matchAll(/@container \(max-width: (\d+)px\)/g))
        .map(match => Number(match[1]))
        // 只看会塌陷 hero 栅格的那个断点。
        .filter(width => new RegExp(`@container \\(max-width: ${width}px\\)\\s*\\{\\s*\\.baizer-settings-hero`).test(css));
      assert(widths.length > 0, `${name} must collapse the hero grid at some container width`);
      const narrowest = Math.max(...widths);
      assert(
        narrowest > POPOUT_MIN_WIDTH,
        `${name}: the hero-collapsing breakpoint (${narrowest}) must exceed the popout minimum (${POPOUT_MIN_WIDTH})`,
      );
      assert(
        css.includes(`@container (max-width: ${narrowest}px)`),
        `${name}: the narrow breakpoint must be declared as a container query`,
      );
    }
  });

  // ── 分组与字段顺序：配置流程 = 身份与协议 → 地址与凭证 → 模型 → 测试结果 ──

  await test('renders the configuration flow in four ordered groups', () => {
    expect(getConnectionGroups().map(group => group.id))
      .toEqual(['identity', 'credentials', 'model', 'test']);
    expect(getConnectionGroups().map(group => group.title)).toEqual([
      'Provider identity and protocol',
      'Connection address and credentials',
      'Model',
      'Test result',
    ]);
  });

  await test('groups every field and keeps fields ordered inside the flow', () => {
    const groupOrder = getConnectionGroups().map(group => group.id);

    for (const type of ['openai-compatible', 'anthropic'] as const) {
      const fields = getConnectionFieldOrder(type);
      // 每个字段都必须归属于某个分组,否则它会掉出流程之外。
      fields.forEach(field => assert(
        Boolean(CONNECTION_FIELD_GROUP[field]),
        `${field} has no group`,
      ));
      // 分组序号必须单调不减：字段不能跨组来回跳。
      const indexes = fields.map(field => groupOrder.indexOf(CONNECTION_FIELD_GROUP[field]));
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      // 每个分组都要有字段,否则会出现空卡片。
      expect(Array.from(new Set(fields.map(field => CONNECTION_FIELD_GROUP[field]))))
        .toEqual(groupOrder);
    }
  });

  await test('only OpenAI-compatible exposes the API type (flavor) field', () => {
    const hasFlavor = (type: 'openai-compatible' | 'anthropic') =>
      getConnectionFieldOrder(type).includes('apiFlavor');

    expect({
      openai: hasFlavor('openai-compatible'),
      anthropic: hasFlavor('anthropic'),
    }).toEqual({ openai: true, anthropic: false });
  });

  await test('every surviving protocol shows the service address', () => {
    // 'gemini' 被移除后不存在「地址不适用」的协议：两种协议都要填地址
    // （各自的 SDK 在其后追加端点路径），故 baseUrl 对二者都必须出现在字段序里。
    const hasBaseUrl = (type: 'openai-compatible' | 'anthropic') =>
      getConnectionFieldOrder(type).includes('baseUrl');

    expect({
      openai: hasBaseUrl('openai-compatible'),
      anthropic: hasBaseUrl('anthropic'),
    }).toEqual({ openai: true, anthropic: true });
  });

  await test('identity and protocol fields come before address, model and test', () => {
    const fields = getConnectionFieldOrder('openai-compatible');
    const at = (field: ConnectionFieldId) => fields.indexOf(field);

    assert(at('providerName') < at('apiFlavor'), 'provider name must precede the API type');
    assert(at('apiFlavor') < at('baseUrl'), 'API type must precede the service address');
    assert(at('baseUrl') < at('apiKey'), 'address must precede the API key');
    assert(at('apiKey') < at('model'), 'credentials must precede the model');
    assert(at('model') < at('connectionTest'), 'model must precede the connection test');
  });

  // ── 「API 类型」与「服务地址」不再同名 ──
  // issue 的原始缺陷:两侧字段都叫「API endpoint」,左边是 OpenAI 方言、右边是 Base URL。

  await test('the two formerly identically-named fields now have distinct labels', () => {
    const source = readFileSync('src/settings.ts', 'utf8');

    assert(!source.includes("t('API endpoint')"), 'the ambiguous "API endpoint" label must be gone');
    assert(!source.includes("t('API Endpoint')"), 'the ambiguous "API Endpoint" label must be gone');
    assert(
      source.includes("t('API type (Chat Completions / Responses)')"),
      'the OpenAI flavor field must be named "API type (Chat Completions / Responses)"',
    );
    assert(
      source.includes("t('Service address (Base URL)')"),
      'the base URL field must be named "Service address (Base URL)"',
    );
  });

  await test('every t() key in settings.ts has a Chinese translation', () => {
    setLocaleForTesting(true);
    // 关键：从源码里**派生**待检查的 key，而不是手工维护一份列表。
    // 上一版就是手工列表，结果两条 header 文案改了/新增了却没同步，
    // 测试照样全绿而中文用户看到英文。
    const keys = extractTranslationKeys(readFileSync('src/settings.ts', 'utf8'));
    assert(keys.length > 250, `expected to extract the full key set, got ${keys.length}`);
    // 逐 key 查表：t(key) === key 会把「译文与原文相同」的品牌名（Anthropic Messages API）
    // 误判成漏译，故直接查表。漏收录才是这里要抓的（t() 会静默回退英文原文）。
    const missing = keys
      .filter(key => !Object.prototype.hasOwnProperty.call(ZH_MESSAGES, key))
      // 本次改动之前就存在的漏译（权限/采集等既有文案，共 7 条，见上方清单）。
      // 它们不属于本次范围；把它们也纳入断言只会让测试长期变红，
      // 反而掩盖新引入的漏译。清单必须精确，多一条就等于放过一条新的漏译。
      .filter(key => !PRE_EXISTING_UNTRANSLATED.has(key));
    expect(missing).toEqual([]);
    // 抽查两条：确认查表路径确实生效。
    assert(t('Provider identity and protocol') === '服务商身份与协议', 'missing zh for the identity group');
    assert(t('Test result') === '测试结果', 'missing zh for the test-result group');
    setLocaleForTesting(false);
  });

  await test('the source-derived i18n check catches a key that the map is missing', () => {
    // 反向验证：派生逻辑必须真的会报错，否则它只是一个永远为空的过滤器。
    const fakeSource = `const a = t('This key is definitely not in the map');\nconst b = t('Test result');`;
    const keys = extractTranslationKeys(fakeSource);
    expect(keys).toEqual(['This key is definitely not in the map', 'Test result']);
    const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(ZH_MESSAGES, key));
    expect(missing).toEqual(['This key is definitely not in the map']);
  });

  await test('the i18n check does not mistake other identifiers ending in t for t()', () => {
    // 回归：`format('a, b')` / `split(...)` / `assert(...)` / `expect(...)` 里的
    // `t('` 子串（前一个字符属于标识符）会被朴素正则误当成翻译调用，于是测试会去
    // 要求给 `a, b`、`x` 这些「key」配译文。
    // 注意 `setAttribute('style', 'x')` 结尾是 `e(`，**根本不含** `t('`，
    // 对这条断言没有贡献 —— 真正压住 lookbehind 的是下面这几个以 `t` 结尾的标识符。
    const fakeSource = `format('a, b'); parts.split('a, b'); assert('x'); expect('y'); const c = t('Real key');`;
    expect(extractTranslationKeys(fakeSource)).toEqual(['Real key']);
  });

  // ── 地址是否含 /v1、实际请求打到哪里 ──

  await test('states whether the address includes /v1 for each protocol', () => {
    const anthropic = getRequestPathSummary('anthropic');
    expect({
      pathTemplate: anthropic.pathTemplate,
      baseUrlIncludesV1: anthropic.baseUrlIncludesV1,
    }).toEqual({ pathTemplate: '{baseUrl}/v1/messages', baseUrlIncludesV1: false });
    assert(
      anthropic.note.includes('must NOT include /v1'),
      'Anthropic must say the address does not include /v1',
    );
    expect(getRequestPathSummary('openai-compatible', 'completions').pathTemplate)
      .toEqual('{baseUrl}/chat/completions');
    expect(getRequestPathSummary('openai-compatible', 'responses').pathTemplate)
      .toEqual('{baseUrl}/responses');
    expect(getRequestPathSummary('openai-compatible').baseUrlIncludesV1).toEqual(true);
  });

  await test('spells out the actual request path without doubling /v1', () => {
    const anthropic = describeRequestPath('anthropic', undefined, 'https://api.anthropic.com/');
    assert(
      anthropic.includes('https://api.anthropic.com/v1/messages'),
      `expected the resolved Anthropic path, got: ${anthropic}`,
    );
    assert(!anthropic.includes('/v1/v1'), 'the resolved path must not double /v1');

    const completions = describeRequestPath('openai-compatible', 'completions', 'https://api.deepseek.com');
    assert(
      completions.includes('https://api.deepseek.com/chat/completions'),
      `expected the resolved completions path, got: ${completions}`,
    );

    const responses = describeRequestPath('openai-compatible', 'responses', 'https://api.openai.com/v1');
    assert(
      responses.includes('https://api.openai.com/v1/responses'),
      `expected the resolved responses path, got: ${responses}`,
    );
  });

  // ── 模型字段：三态来自 ModelService 的语义化信号，不再靠数组形状猜 ──

  await test('the panel loads through the status-aware API that actually exists', () => {
    // IPlugin.modelService 声明为 any：方法名写错 tsc 不会报错。
    // 这里对真实类做一次存在性校验，并确认 settings.ts 调用的就是它。
    const proto: any = ModelService.prototype;
    assert(
      typeof proto.getAvailableModelsWithStatus === 'function',
      'ModelService must expose getAvailableModelsWithStatus',
    );
    // 旧薄包装仍在（其它调用方不受影响）。
    assert(typeof proto.getAvailableModels === 'function', 'the legacy loader must stay available');

    const source = readFileSync('src/settings.ts', 'utf8');
    assert(
      source.includes('getAvailableModelsWithStatus(forceRefresh)'),
      'the model field must load through the status-aware API',
    );
    // 「靠数组形状猜」的旧加载器必须彻底消失，否则两种信号会并存、互相矛盾。
    assert(
      !source.includes('getAvailableModels('),
      'the shape-guessing loader must be gone from settings.ts',
    );
  });

  await test('a real listing is trusted and offers the candidate select', () => {
    const state = getModelFieldState({
      result: {
        models: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        listed: true,
        listingUnsupported: false,
      },
      currentModel: 'a',
      hasApiKey: true,
    });

    expect({ status: state.status, tone: state.noteTone, trustList: state.trustList, count: state.options.length })
      .toEqual({ status: 'listed', tone: 'muted', trustList: true, count: 2 });
    assert(/2 models listed/i.test(state.note), `the note must state the real count, got: ${state.note}`);
  });

  await test('a single-model real listing is no longer mistaken for "cannot list"', () => {
    // 旧启发式（「除当前模型外空无一物」= 列不出）会把这个合法情况误判成能力缺口。
    const state = getModelFieldState({
      result: {
        models: [{ value: 'only-model', label: 'only-model (Current)' }],
        listed: true,
        listingUnsupported: false,
      },
      currentModel: 'only-model',
      hasApiKey: true,
    });

    expect({ status: state.status, trustList: state.trustList })
      .toEqual({ status: 'listed', trustList: true });
  });

  await test('an empty 200 listing is NOT trusted, even with neither flag set', () => {
    // F1 回归：端点回 200 但清单为空（或响应体不是 {data:[...]}）时，
    // model-service 用内置兜底列表补上 models，两个标志都不设。
    // 若按「两个标志都没设」反推可信，就会把 claude-sonnet-4-5 这类内置值
    // 当成端点宣称的模型，并自动写进 config.model。
    const state = getModelFieldState({
      result: {
        models: [
          { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
          { value: 'gpt-4o', label: 'gpt-4o' },
        ],
        listed: false,
        listingUnsupported: false,
      },
      currentModel: '',
      hasApiKey: true,
    });

    expect({ status: state.status, trustList: state.trustList, tone: state.noteTone })
      .toEqual({ status: 'empty-listing', trustList: false, tone: 'warning' });
    assert(
      !/models listed/i.test(state.note),
      `an empty listing must not be reported as "N models listed", got: ${state.note}`,
    );
    assert(
      /type the model id by hand/i.test(state.note),
      `an empty listing must invite manual entry, got: ${state.note}`,
    );
  });

  await test('trustList follows the listed flag alone, never the absence of flags', () => {
    const combos = [
      { listed: true, listingUnsupported: false, error: undefined, expected: true },
      { listed: false, listingUnsupported: false, error: undefined, expected: false },
      { listed: false, listingUnsupported: true, error: undefined, expected: false },
      { listed: false, listingUnsupported: false, error: new Error('401'), expected: false },
      // 自相矛盾的输入（既说列到了又带 error）也必须保守：不可信。
      { listed: true, listingUnsupported: false, error: new Error('partial'), expected: false },
    ];

    for (const combo of combos) {
      const state = getModelFieldState({
        result: {
          models: [{ value: 'm', label: 'M' }],
          listed: combo.listed,
          listingUnsupported: combo.listingUnsupported,
          error: combo.error,
        },
        currentModel: '',
        hasApiKey: true,
      });
      assert(
        state.trustList === combo.expected,
        `listed=${combo.listed} unsupported=${combo.listingUnsupported} error=${Boolean(combo.error)} → trustList ${state.trustList}, expected ${combo.expected}`,
      );
    }
  });

  await test('a 404/405/501 listing gap reads as "manual entry", not as an error', () => {
    const state = getModelFieldState({
      result: {
        // 端点不支持列模型时 models 是内置兜底列表（非空），绝不能当候选当真。
        models: [{ value: 'gateway-model', label: 'gateway-model (Current)' }],
        listed: false,
        listingUnsupported: true,
      },
      currentModel: 'gateway-model',
      hasApiKey: true,
    });

    expect({ status: state.status, tone: state.noteTone, trustList: state.trustList, manualEntry: state.manualEntry })
      .toEqual({ status: 'listing-unsupported', tone: 'warning', trustList: false, manualEntry: true });
    assert(
      /type the model id by hand/i.test(state.note),
      `the note must invite manual entry, got: ${state.note}`,
    );
    assert(
      /does not mean the model cannot generate/i.test(state.note),
      'the note must separate "cannot list" from "cannot generate"',
    );
    assert(
      !/error/i.test(state.note),
      'a capability gap must not be dressed up as a failure',
    );
  });

  await test('a real failure surfaces the reason instead of hiding behind "list unavailable"', () => {
    const state = getModelFieldState({
      result: {
        models: [{ value: 'fallback-model', label: 'fallback-model' }],
        listed: false,
        listingUnsupported: false,
        error: new Error('401 Unauthorized'),
      },
      currentModel: '',
      hasApiKey: true,
    });

    expect({ status: state.status, tone: state.noteTone, trustList: state.trustList })
      .toEqual({ status: 'error', tone: 'error', trustList: false });
    assert(/401 Unauthorized/.test(state.note), `the note must name the real reason, got: ${state.note}`);
    assert(
      !/does not mean the model cannot generate/i.test(state.note),
      'a real failure must not be excused as a capability gap',
    );
  });

  await test('a capability gap and a real failure are visibly different states', () => {
    const gap = getModelFieldState({
      result: { models: [], listed: false, listingUnsupported: true },
      currentModel: '',
      hasApiKey: true,
    });
    const failure = getModelFieldState({
      result: { models: [], listed: false, listingUnsupported: false, error: new Error('network down') },
      currentModel: '',
      hasApiKey: true,
    });

    assert(gap.status !== failure.status, 'the two states must not collapse into one');
    assert(gap.noteTone !== failure.noteTone, 'the two states must not share a tone');
    assert(gap.note !== failure.note, 'the two states must not share wording');
  });

  await test('an over-long error reason is truncated so it cannot wreck the layout', () => {
    const state = getModelFieldState({
      result: {
        models: [],
        listed: false,
        listingUnsupported: false,
        error: new Error(`<html>${'x'.repeat(500)}</html>`),
      },
      currentModel: '',
      hasApiKey: true,
    });

    assert(state.note.length < 260, `the note must stay short, got ${state.note.length} chars`);
    assert(state.note.includes('…'), 'a truncated reason must show it was truncated');
  });

  await test('points at the missing key instead of blaming the endpoint', () => {
    const state = getModelFieldState({
      // 未配 key 时 ModelService 不发请求，把「没配 key」当 error 报回来。
      result: { models: [], listed: false, listingUnsupported: false, error: new Error('Gateway API Key not configured') },
      currentModel: '',
      hasApiKey: false,
    });

    expect({ status: state.status, tone: state.noteTone, trustList: state.trustList })
      .toEqual({ status: 'missing-key', tone: 'warning', trustList: false });
    assert(/api key/i.test(state.note), `the note must mention the API key, got: ${state.note}`);
  });

  await test('a failed model listing still yields an editable model input, not a disabled one', async () => {
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: 'gateway-model-x',
      hasApiKey: true,
      // 兼容网关没实现 /models：端点返回 404，WP-A 报 listingUnsupported 并给出兜底列表。
      loadModels: async () => ({
        models: [{ value: 'gateway-model-x', label: 'gateway-model-x (Current)' }],
        listed: false,
        listingUnsupported: true,
      }),
      onModelChange: async (modelId) => { changes.push(modelId); },
      isStale: () => false,
    });
    await settle();

    const input = container.querySelector('.baizer-settings-model-input') as FakeNode | null;
    const select = container.querySelector('.baizer-settings-model-select') as FakeNode | null;
    assert(Boolean(input), 'the model field must render a text input');
    assert(Boolean(select), 'the model field must render the candidate dropdown');

    expect({
      inputValue: input!.value,
      inputDisabled: (input as any).disabled === true,
      selectDisabled: (select as any).disabled === true,
    }).toEqual({ inputValue: 'gateway-model-x', inputDisabled: false, selectDisabled: false });

    // 悬停可看完整值,且输入框本身可编辑全文。
    expect(input!.title).toEqual('gateway-model-x');

    const note = container.querySelector('.baizer-settings-field-hint') as FakeNode | null;
    assert(
      Boolean(note) && /type the model id by hand/i.test(note!.textContent),
      `expected a manual-entry note, got: ${note?.textContent}`,
    );

    // 兜底列表不得冒充「模型列表」，也不得染上 error 色调。
    assert(select!.hasClass('is-untrusted'), 'an untrusted list must be marked as suggestions only');
    assert(
      /suggested models/i.test(select!.getAttribute('aria-label') || ''),
      `an untrusted select must be labelled as suggestions, got: ${select!.getAttribute('aria-label')}`,
    );
    assert(!note!.hasClass('is-error'), 'a capability gap must not be shown with the error tone');

    // 手填一个新模型必须能落盘。
    input!.value = 'gateway-model-y';
    for (const handler of input!.listeners.change || []) handler();
    await settle();
    expect(changes).toEqual(['gateway-model-y']);
  });

  await test('an empty 200 listing never gets auto-written into config.model', async () => {
    // F1 端到端回归：这正是「兜底列表被当成端点清单并自动回填」的那条路径。
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: '',
      hasApiKey: true,
      loadModels: async () => ({
        models: [{ value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }],
        listed: false,
        listingUnsupported: false,
      }),
      onModelChange: async (modelId) => { changes.push(modelId); },
      isStale: () => false,
    });
    await settle();

    const input = container.querySelector('.baizer-settings-model-input') as FakeNode | null;
    const select = container.querySelector('.baizer-settings-model-select') as FakeNode | null;
    expect({ inputValue: input!.value, changes }).toEqual({ inputValue: '', changes: [] });
    assert(select!.hasClass('is-untrusted'), 'a built-in list must never be styled as the endpoint listing');
    assert(
      !/models listed/i.test((container.querySelector('.baizer-settings-field-hint') as FakeNode)!.textContent),
      'an empty 200 must not read as "N models listed"',
    );
  });

  await test('a real failure is shown in place while the field stays editable', async () => {
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: '',
      hasApiKey: true,
      loadModels: async () => ({
        models: [{ value: 'fallback-only', label: 'fallback-only' }],
        listed: false,
        listingUnsupported: false,
        error: new Error('403 Forbidden'),
      }),
      onModelChange: async (modelId) => { changes.push(modelId); },
      isStale: () => false,
    });
    await settle();

    const note = container.querySelector('.baizer-settings-field-hint') as FakeNode | null;
    assert(Boolean(note), 'the model field must render a help/status line');
    assert(/403 Forbidden/.test(note!.textContent), `the note must show the reason, got: ${note!.textContent}`);
    assert(note!.hasClass('is-error'), 'a real failure must use the error tone');
    assert(!note!.hasClass('is-warning'), 'a real failure must not be toned down to a warning');

    const input = container.querySelector('.baizer-settings-model-input') as FakeNode | null;
    assert((input as any).disabled !== true, 'the input must stay editable after a failure');

    // 兜底列表不可信：不许自动回填 config.model，否则等于替用户编了个模型。
    expect({ inputValue: input!.value, changes }).toEqual({ inputValue: '', changes: [] });
  });

  await test('picking from the list writes the model through', async () => {
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: 'a',
      hasApiKey: true,
      loadModels: async () => ({
        models: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        listed: true,
        listingUnsupported: false,
      }),
      onModelChange: async (modelId) => { changes.push(modelId); },
      isStale: () => false,
    });
    await settle();

    const select = container.querySelector('.baizer-settings-model-select') as FakeNode | null;
    expect(select!.children.map((child: any) => child.value)).toEqual(['a', 'b']);
    assert(!select!.hasClass('is-untrusted'), 'a real listing must not be marked as suggestions only');
    expect(select!.getAttribute('aria-label')).toEqual('Model list');

    select!.value = 'b';
    for (const handler of select!.listeners.change || []) handler();
    await settle();
    expect(changes).toEqual(['b']);
  });

  await test('auto-selects the first listed model when none is configured yet', async () => {
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: '',
      hasApiKey: true,
      loadModels: async () => ({
        models: [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }],
        listed: true,
        listingUnsupported: false,
      }),
      onModelChange: async (modelId) => { changes.push(modelId); },
      isStale: () => false,
    });
    await settle();

    const input = container.querySelector('.baizer-settings-model-input') as FakeNode | null;
    expect({ inputValue: input!.value, changes }).toEqual({ inputValue: 'first', changes: ['first'] });
  });

  await test('a thrown loader is reported as an error instead of pretending the list is fine', async () => {
    const container = fakeContainer();

    renderModelField(container as unknown as HTMLElement, {
      currentModel: 'x',
      hasApiKey: true,
      loadModels: async () => { throw new Error('boom'); },
      onModelChange: () => undefined,
      isStale: () => false,
    });
    await settle();

    const note = container.querySelector('.baizer-settings-field-hint') as FakeNode | null;
    assert(/boom/.test(note!.textContent), `an unexpected throw must be surfaced, got: ${note!.textContent}`);
    assert(note!.hasClass('is-error'), 'an unexpected throw must use the error tone');
  });

  await test('a refresh button reloads the list with a forced refresh', async () => {
    const container = fakeContainer();
    const forces: boolean[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: 'a',
      hasApiKey: true,
      loadModels: async (forceRefresh) => {
        forces.push(forceRefresh);
        return { models: [{ value: 'a', label: 'A' }], listed: true, listingUnsupported: false };
      },
      onModelChange: () => undefined,
      isStale: () => false,
    });
    await settle();

    const refresh = container.children
      .flatMap((child: any) => child.children || [])
      .find((child: any) => child.hasClass('baizer-settings-action')) as FakeNode | undefined;
    assert(Boolean(refresh), 'the model field must render a refresh button');
    refresh!.click();
    await settle();

    expect(forces).toEqual([false, true]);
  });

  // ── 连接测试:区分「列不出模型」与「无法生成」 ──

  await test('maps a real availability result onto a test stage', () => {
    expect({
      healthy: getConnectionTestStage({ reachable: true, listingUnsupported: false }),
      // 端点活着但不提供模型清单：不是成功。
      upButNoList: getConnectionTestStage({ reachable: true, listingUnsupported: true }),
      down: getConnectionTestStage({ reachable: false, listingUnsupported: false }),
    }).toEqual({
      healthy: 'endpoint-reachable',
      upButNoList: 'model-list-unavailable',
      down: 'unreachable',
    });
  });

  await test('a 404 on the model-list endpoint is not reported as a green "reachable"', async () => {
    // F2 端到端：这是真正的失败模式——此前 checkAvailability() 把 404 当 true，
    // 于是同一屏里测试报绿色「模型列表可达」，模型输入框却说「该端点不支持列出模型」。
    const status = await checkAvailabilityWithStatus(
      { type: 'anthropic', label: 'Gateway', apiKey: 'k', baseUrl: 'https://gw.example.com', model: '' },
      // 网关没实现 /v1/models：返回 404（不是抛网络错）。
      { requestUrl: async () => ({ status: 404, text: '' }) },
    );

    expect({ reachable: status.reachable, listingUnsupported: status.listingUnsupported })
      .toEqual({ reachable: true, listingUnsupported: true });

    const report = getConnectionTestReport({
      label: 'Gateway',
      stage: getConnectionTestStage(status),
      endpoint: 'https://gw.example.com/v1/models',
    });

    assert(report.state !== 'success', `a 404 must never render as success, got ${report.state}`);
    expect(report.state).toEqual('warning');
    assert(
      /does not offer a model list/i.test(report.message),
      `the message must say the endpoint offers no list, got: ${report.message}`,
    );
    assert(
      /NOT verified/i.test(report.message),
      `the message must say generation was not verified, got: ${report.message}`,
    );
  });

  await test('a genuine connection failure is reported as an error with the reason', async () => {
    // 用 anthropic 走可注入路径：listModels() 里 openai-compatible 分支目前没有透传 deps
    // （`return listOpenAICompatModels(config)`），故那条路在测试中无法注入 requestUrl。
    const status = await checkAvailabilityWithStatus(
      { type: 'anthropic', label: 'Gateway', apiKey: 'k', baseUrl: 'https://gw.example.com', model: '' },
      { requestUrl: async () => { throw new Error('getaddrinfo ENOTFOUND gw.example.com'); } },
    );

    expect({ reachable: status.reachable, listingUnsupported: status.listingUnsupported })
      .toEqual({ reachable: false, listingUnsupported: false });

    const report = getConnectionTestReport({
      label: 'Gateway',
      stage: getConnectionTestStage(status),
      endpoint: 'https://gw.example.com/v1/models',
      reason: status.error?.message,
    });

    expect(report.state).toEqual('error');
    assert(
      /ENOTFOUND/.test(report.message),
      `the failure reason must be carried through, got: ${report.message}`,
    );
  });

  await test('the connection test separates "cannot list" from "cannot generate"', () => {
    const reachable = getConnectionTestReport({
      label: 'Gateway',
      stage: 'endpoint-reachable',
      endpoint: 'https://gw.example.com/v1/models',
    });
    const upButNoList = getConnectionTestReport({
      label: 'Gateway',
      stage: 'model-list-unavailable',
      endpoint: 'https://gw.example.com/v1/models',
    });
    const unreachable = getConnectionTestReport({
      label: 'Gateway',
      stage: 'unreachable',
      endpoint: 'https://gw.example.com/v1/models',
    });
    const missingKey = getConnectionTestReport({
      label: 'Gateway',
      stage: 'missing-key',
      endpoint: 'https://gw.example.com/v1/models',
    });

    expect({
      reachable: reachable.state,
      upButNoList: upButNoList.state,
      unreachable: unreachable.state,
      missingKey: missingKey.state,
    }).toEqual({
      reachable: 'success',
      // 「端点活着但没有清单」既不能报成功也不能报失败。
      upButNoList: 'warning',
      unreachable: 'error',
      missingKey: 'error',
    });

    assert(
      reachable.message.includes('https://gw.example.com/v1/models')
        && /not generation/i.test(reachable.message),
      `a pass must not claim generation was verified, got: ${reachable.message}`,
    );
    assert(
      upButNoList.message.includes('https://gw.example.com/v1/models')
        && /does not offer a model list/i.test(upButNoList.message)
        && /NOT verified/i.test(upButNoList.message),
      `the "up but no list" case must not read as success, got: ${upButNoList.message}`,
    );
    assert(
      unreachable.message.includes('https://gw.example.com/v1/models')
        && /does not prove the model cannot generate/i.test(unreachable.message),
      `a failure must name the endpoint and stay honest about generation, got: ${unreachable.message}`,
    );
    assert(
      missingKey.message.includes('no API key configured'),
      `the missing-key case must stay explicit, got: ${missingKey.message}`,
    );
    // 四种结局各不相同——此前除缺 key 外全被塞进同一句「连接失败」。
    expect(new Set([reachable.message, upButNoList.message, unreachable.message, missingKey.message]).size)
      .toEqual(4);
  });

  await test('a "warning" connection result is neither the success nor the danger badge', () => {
    const presentation = getConnectionTestStatusPresentation({
      state: 'warning',
      message: 'the endpoint answers but offers no model list',
    });
    expect(presentation?.tone).toEqual('warning');
    assert(
      presentation?.tone !== 'success' && presentation?.tone !== 'danger',
      'a warning must not be rendered with the success or danger tone',
    );
  });

  await test('names the exact model-list endpoint that was probed', () => {
    expect({
      anthropic: getModelListEndpoint('anthropic', 'https://api.anthropic.com'),
      openai: getModelListEndpoint('openai-compatible', 'https://api.deepseek.com/'),
    }).toEqual({
      anthropic: 'https://api.anthropic.com/v1/models',
      openai: 'https://api.deepseek.com/models',
    });
  });

  // ── 新增 provider 可选协议 ──

  await test('offers both surviving protocols when adding a provider', () => {
    expect(getProtocolOptions().map(option => option.value))
      .toEqual(['openai-compatible', 'anthropic']);
  });

  await test('seeds the new provider with the chosen protocol, not a hardcoded one', () => {
    const anthropic = buildNewProviderConfig('anthropic', ' My Gateway ', '');
    expect({
      type: anthropic.type,
      label: anthropic.label,
      apiKey: anthropic.apiKey,
      baseUrl: anthropic.baseUrl,
      model: anthropic.model,
    }).toEqual({
      type: 'anthropic',
      label: 'My Gateway',
      apiKey: '',
      baseUrl: DEFAULT_PROVIDERS.anthropic.baseUrl,
      model: '',
    });
    // 冻结接口:Anthropic 官方地址不带 /v1(SDK 自己追加 /v1/messages)。
    assert(
      !DEFAULT_PROVIDERS.anthropic.baseUrl.replace(/^https?:\/\//, '').includes('/'),
      'the official Anthropic base URL must not carry a path',
    );

    expect(buildNewProviderConfig('anthropic', 'GW', 'https://gw.example.com').baseUrl)
      .toEqual('https://gw.example.com');
    expect(buildNewProviderConfig('openai-compatible', 'O', '').baseUrl)
      .toEqual(DEFAULT_PROVIDERS.openai.baseUrl);
  });

  await test('migrates the service address when the protocol changes', () => {
    expect({
      // 地址为空时填该协议的官方端点。
      toAnthropicFromEmpty: resolveBaseUrlOnProtocolChange('anthropic', ''),
      toOpenAiFromEmpty: resolveBaseUrlOnProtocolChange('openai-compatible', ''),
      // 其余情况保留用户填的值,交给就地校验提示。
      keepCustomGateway: resolveBaseUrlOnProtocolChange('anthropic', 'https://gw.example.com'),
    }).toEqual({
      toAnthropicFromEmpty: DEFAULT_PROVIDERS.anthropic.baseUrl,
      toOpenAiFromEmpty: DEFAULT_PROVIDERS.openai.baseUrl,
      keepCustomGateway: 'https://gw.example.com',
    });
    // 两种存活协议都有官方端点兜底——不存在「默认地址为空」的协议。
    expect({
      anthropic: getDefaultBaseUrlForType('anthropic'),
      openai: getDefaultBaseUrlForType('openai-compatible'),
    }).toEqual({
      anthropic: DEFAULT_PROVIDERS.anthropic.baseUrl,
      openai: DEFAULT_PROVIDERS.openai.baseUrl,
    });
  });
}

runTests();
