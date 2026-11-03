import { DEFAULT_PROVIDERS } from '../src/mcp/types';
import { setLocaleForTesting, t } from '../src/i18n/zh';
import { ZH_MESSAGES } from '../src/i18n/zh-messages';
import { FakeElement } from './ui-fakes';
import { ModelService } from '../src/services/model-service';
import {
  CONNECTION_FIELD_GROUP,
  ConnectionFieldId,
  buildNewProviderConfig,
  describeRequestPath,
  getConnectionFieldOrder,
  getConnectionGroups,
  getConnectionTestReport,
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
      css.includes('@container (max-width: 840px)') && css.includes('@container (max-width: 560px)'),
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

    for (const type of ['gemini', 'openai-compatible', 'anthropic'] as const) {
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
    const hasFlavor = (type: 'gemini' | 'openai-compatible' | 'anthropic') =>
      getConnectionFieldOrder(type).includes('apiFlavor');

    expect({
      openai: hasFlavor('openai-compatible'),
      gemini: hasFlavor('gemini'),
      anthropic: hasFlavor('anthropic'),
    }).toEqual({ openai: true, gemini: false, anthropic: false });
  });

  await test('Gemini hides the service address while Anthropic and OpenAI-compatible show it', () => {
    const hasBaseUrl = (type: 'gemini' | 'openai-compatible' | 'anthropic') =>
      getConnectionFieldOrder(type).includes('baseUrl');

    expect({
      gemini: hasBaseUrl('gemini'),
      openai: hasBaseUrl('openai-compatible'),
      anthropic: hasBaseUrl('anthropic'),
    }).toEqual({ gemini: false, openai: true, anthropic: true });
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

  await test('every new user-visible string has a Chinese translation', () => {
    setLocaleForTesting(true);
    const newKeys = [      'Provider identity and protocol',
      'Connection address and credentials',
      'Test result',
      'API type (Chat Completions / Responses)',
      'Service address (Base URL)',
      'Anthropic Messages API',
      'Custom headers (advanced)',
      'Required field',
      'Actual request path: {path}',
      'Provider name is required.',
      'Base URL is required.',
      'Base URL must start with http:// or https:// and must not contain spaces.',
      'Base URL must not include the request path — remove /chat/completions or /responses.',
      'Base URL must not include the request path — remove /v1/messages.',
      'For Anthropic the base URL must not include /v1 — the SDK appends /v1/messages. Use https://api.anthropic.com.',
      'missing ":" — write "Header-Name: value"',
      'missing header name',
      'duplicate header name, the last one wins',
      'Custom headers: {issues}. Those lines are ignored; the rest are kept.',
      'Model ID',
      'Model list',
      'Refresh list',
      'No models listed',
      'No API key yet — you can type the model ID by hand; the list loads once a key is set.',
      'This endpoint does not support listing models. Type the model ID by hand — this does not mean the model cannot generate.',
      'Could not load the model list: {reason}. Type the model ID by hand.',
      'unknown error',
      'Suggested models (not listed by this endpoint)',
      '{count} models listed. Pick one or type an ID.',
      'Add Provider',
      'Checks whether the model list is reachable at {url}. It does not run a generation, so a pass means "the endpoint answers", not "the model can generate".',
      '{label}: model list reachable at {url}. Only the endpoint was verified, not generation.',
      '{label}: could not reach the model list at {url}. Models cannot be listed — this does not prove the model cannot generate. Check the API key and service address, or type the model ID by hand.',
      'The service address must NOT include /v1 — the Anthropic SDK appends /v1/messages itself. The official endpoint is https://api.anthropic.com.',
      'The service address usually ends with /v1 — the OpenAI SDK appends /chat/completions itself, so do not paste the full request path.',
      'The service address usually ends with /v1 — the OpenAI SDK appends /responses itself, so do not paste the full request path.',
      'Gemini always uses the official endpoint, so there is no service address to configure.',
      'Shown in the provider list. An empty name is rejected instead of silently keeping the old one.',
      'Stored locally and hidden by default. Use Reveal to check it; Clear asks for confirmation.',
      'Type the model ID directly, or pick one from the list once the endpoint returns it.',
      'The wire protocol this provider speaks.',
      'The wire protocol this provider speaks. Switching it only shows the fields that apply.',
    ];
    // 逐 key 检查是否收录：t(key) === key 会把「译文与原文相同」的品牌名（Anthropic Messages API）
    // 误判成漏译，故直接查表。漏收录才是这里要抓的（t() 会静默回退英文原文）。
    const missing = newKeys.filter(key => !Object.prototype.hasOwnProperty.call(ZH_MESSAGES, key));
    expect(missing).toEqual([]);
    // 抽查两条：确认查表路径确实生效。
    assert(t('Provider identity and protocol') === '服务商身份与协议', 'missing zh for the identity group');
    assert(t('Test result') === '测试结果', 'missing zh for the test-result group');
    setLocaleForTesting(false);
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
    assert(
      getRequestPathSummary('gemini').pathTemplate.includes('generativelanguage.googleapis.com'),
      'Gemini must show its fixed official endpoint',
    );
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
        listingUnsupported: false,
      },
      currentModel: 'only-model',
      hasApiKey: true,
    });

    expect({ status: state.status, trustList: state.trustList })
      .toEqual({ status: 'listed', trustList: true });
  });

  await test('a 404/405/501 listing gap reads as "manual entry", not as an error', () => {
    const state = getModelFieldState({
      result: {
        // 端点不支持列模型时 models 是内置兜底列表（非空），绝不能当候选当真。
        models: [{ value: 'gateway-model', label: 'gateway-model (Current)' }],
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
      result: { models: [], listingUnsupported: true },
      currentModel: '',
      hasApiKey: true,
    });
    const failure = getModelFieldState({
      result: { models: [], listingUnsupported: false, error: new Error('network down') },
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
      result: { models: [], listingUnsupported: false, error: new Error('Gateway API Key not configured') },
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

  await test('a real failure is shown in place while the field stays editable', async () => {
    const container = fakeContainer();
    const changes: string[] = [];

    renderModelField(container as unknown as HTMLElement, {
      currentModel: '',
      hasApiKey: true,
      loadModels: async () => ({
        models: [{ value: 'fallback-only', label: 'fallback-only' }],
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
        return { models: [{ value: 'a', label: 'A' }], listingUnsupported: false };
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

  await test('the connection test separates "cannot list" from "cannot generate"', () => {
    const reachable = getConnectionTestReport({
      label: 'Gateway',
      stage: 'endpoint-reachable',
      endpoint: 'https://gw.example.com/v1/models',
    });
    const unreachable = getConnectionTestReport({
      label: 'Gateway',
      stage: 'model-list-unavailable',
      endpoint: 'https://gw.example.com/v1/models',
    });
    const missingKey = getConnectionTestReport({
      label: 'Gateway',
      stage: 'missing-key',
      endpoint: 'https://gw.example.com/v1/models',
    });

    expect({ reachable: reachable.state, unreachable: unreachable.state, missingKey: missingKey.state })
      .toEqual({ reachable: 'success', unreachable: 'error', missingKey: 'error' });

    assert(
      reachable.message.includes('https://gw.example.com/v1/models')
        && /not generation/i.test(reachable.message),
      `a pass must not claim generation was verified, got: ${reachable.message}`,
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
    // 三种结局各不相同——此前除缺 key 外全被塞进同一句「连接失败」。
    expect(new Set([reachable.message, unreachable.message, missingKey.message]).size).toEqual(3);
  });

  await test('names the exact model-list endpoint that was probed', () => {
    expect({
      anthropic: getModelListEndpoint('anthropic', 'https://api.anthropic.com'),
      openai: getModelListEndpoint('openai-compatible', 'https://api.deepseek.com/'),
      gemini: getModelListEndpoint('gemini', ''),
    }).toEqual({
      anthropic: 'https://api.anthropic.com/v1/models',
      openai: 'https://api.deepseek.com/models',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
    });
  });

  // ── 新增 provider 可选协议(含 Anthropic) ──

  await test('offers all three protocols when adding a provider', () => {
    expect(getProtocolOptions().map(option => option.value))
      .toEqual(['gemini', 'openai-compatible', 'anthropic']);
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
    // Gemini 忽略服务地址,不该留一个日后会冒出来的值。
    expect(buildNewProviderConfig('gemini', 'G', 'https://ignored.example.com').baseUrl).toEqual('');
  });

  await test('migrates the service address when the protocol changes', () => {
    expect({
      // Gemini 不使用地址,清空。
      toGemini: resolveBaseUrlOnProtocolChange('gemini', 'https://api.deepseek.com'),
      // 从 Gemini 切过来时地址为空,填该协议的官方端点。
      toAnthropicFromEmpty: resolveBaseUrlOnProtocolChange('anthropic', ''),
      toOpenAiFromEmpty: resolveBaseUrlOnProtocolChange('openai-compatible', ''),
      // 其余情况保留用户填的值,交给就地校验提示。
      keepCustomGateway: resolveBaseUrlOnProtocolChange('anthropic', 'https://gw.example.com'),
    }).toEqual({
      toGemini: '',
      toAnthropicFromEmpty: DEFAULT_PROVIDERS.anthropic.baseUrl,
      toOpenAiFromEmpty: DEFAULT_PROVIDERS.openai.baseUrl,
      keepCustomGateway: 'https://gw.example.com',
    });
    expect(getDefaultBaseUrlForType('gemini')).toEqual('');
  });
}

runTests();
