/**
 * 设置页性能回归测试（issue #81：移动端设置页卡死）
 *
 * 覆盖三块可脱离真实 Obsidian DOM 验证的行为：
 *  1. 重绘调度器：同一轮合并、渲染中不嵌套、取消后不再执行；
 *  2. 搜索闸门：命中分区不变时不必重绘；模型字段缓存键只随端点身份变化；
 *  3. renderModelField：命中缓存结果时不再发 /models，只有「Refresh list」才强制重取。
 */

import { setLocaleForTesting } from '../src/i18n/zh';
import {
    MODEL_FIELD_CACHE_TTL_MS,
    getMatchingSettingsSections,
    getModelFieldCacheKey,
    isSameSettingsSectionList,
    renderModelField,
} from '../src/settings';
import type { ProviderConfig } from '../src/mcp/types';
import type { AvailableModelsResult } from '../src/services/model-service';
import { createRenderScheduler } from '../src/utils/render-scheduler';
import { FakeElement } from './ui-fakes';

// 断言用英文原文 key（t() 在非中文环境返回原文），与运行环境无关。
setLocaleForTesting(false);

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

function expect(actual: any) {
    return {
        toBe: (expected: any) => {
            if (actual !== expected) {
                throw new Error(`Expected "${expected}" but got "${actual}"`);
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

async function test(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
    } catch (e: any) {
        console.error(`  FAIL ${name}: ${e.message}`);
        process.exit(1);
    }
}

/** 与 settings-provider-layout.test.ts 同款假节点：补 renderModelField 用到的 Obsidian 便捷方法。 */
class FakeNode extends FakeElement {
    attrs: Record<string, string> = {};
    title = '';

    setText(text: string): void {
        this.textContent = text;
    }

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

const listedResult: AvailableModelsResult = {
    models: [
        { value: 'gpt-4o', label: 'gpt-4o' },
        { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ],
    listed: true,
    listingUnsupported: false,
};

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        label: 'Test',
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test-key-123456',
        model: 'gpt-4o',
        ...overrides,
    } as ProviderConfig;
}

async function runTests() {
    console.log('=== Settings Performance Tests ===');

    await test('render scheduler coalesces many requests into a single render', () => {
        let renders = 0;
        const pending: Array<() => void> = [];
        const scheduler = createRenderScheduler(() => { renders++; }, callback => pending.push(callback));

        for (let i = 0; i < 20; i++) scheduler.request();
        expect(renders).toBe(0);
        expect(pending.length).toBe(1);

        pending.shift()!();
        expect(renders).toBe(1);
        assert(!scheduler.isScheduled(), 'scheduler must be idle after a coalesced render');
    });

    await test('render scheduler never nests a render requested from inside a render', () => {
        let renders = 0;
        let depth = 0;
        let maxDepth = 0;
        let requestAgain = true;
        const pending: Array<() => void> = [];
        const scheduler: ReturnType<typeof createRenderScheduler> = createRenderScheduler(() => {
            renders++;
            depth++;
            maxDepth = Math.max(maxDepth, depth);
            depth--;
            if (requestAgain) {
                requestAgain = false;
                scheduler.request();
            }
        }, callback => pending.push(callback));

        scheduler.request();
        pending.shift()!();

        expect(renders).toBe(2);
        expect(maxDepth).toBe(1);
    });

    await test('render scheduler drops a queued render after cancel', () => {
        let renders = 0;
        const pending: Array<() => void> = [];
        const scheduler = createRenderScheduler(() => { renders++; }, callback => pending.push(callback));

        scheduler.request();
        scheduler.cancel();
        // 已排队的回调仍可能被宿主触发；代际号应让它失效。
        pending.shift()?.();
        expect(renders).toBe(0);
    });

    await test('section list comparison ignores identical lists but detects changes', () => {
        expect(isSameSettingsSectionList(['memory', 'knowledge'], ['memory', 'knowledge'])).toBe(true);
        expect(isSameSettingsSectionList(['memory'], ['knowledge'])).toBe(false);
        expect(isSameSettingsSectionList(['memory'], ['memory', 'knowledge'])).toBe(false);
        expect(isSameSettingsSectionList([], [])).toBe(true);
    });

    await test('typing more characters that match the same sections needs no repaint', () => {
        const atMemo = getMatchingSettingsSections('memo');
        const atMemor = getMatchingSettingsSections('memor');
        expect(atMemo).toEqual(atMemor);
        expect(atMemo.includes('memory')).toBe(true);
        // 闸门依赖这个相等判断：命中集合不变时 applySearchRender 直接返回。
        expect(isSameSettingsSectionList(atMemo, atMemor)).toBe(true);
    });

    await test('model field cache key follows endpoint identity, not the selected model', () => {
        const base = providerConfig();
        expect(getModelFieldCacheKey('p1', base)).toBe(getModelFieldCacheKey('p1', providerConfig({ model: 'gpt-4o-mini' })));
        assert(
            getModelFieldCacheKey('p1', base) !== getModelFieldCacheKey('p1', providerConfig({ baseUrl: 'https://other.example.com/v1' })),
            'baseUrl change must invalidate the cached model list',
        );
        assert(
            getModelFieldCacheKey('p1', base) !== getModelFieldCacheKey('p1', providerConfig({ apiKey: 'sk-other-key-9999' })),
            'apiKey change must invalidate the cached model list',
        );
        assert(
            getModelFieldCacheKey('p1', base) !== getModelFieldCacheKey('p1', providerConfig({ type: 'anthropic' })),
            'protocol change must invalidate the cached model list',
        );
        assert(
            getModelFieldCacheKey('p1', base) !== getModelFieldCacheKey('p2', base),
            'provider switch must invalidate the cached model list',
        );
        assert(
            getModelFieldCacheKey('p1', undefined) !== getModelFieldCacheKey('p2', undefined),
            'cache key must still differ per provider when no config exists',
        );
        assert(MODEL_FIELD_CACHE_TTL_MS > 0, 'the model field cache needs a positive TTL');
    });

    await test('re-rendering a cached model field issues no /models request', async () => {
        let loads = 0;
        const deps = {
            currentModel: 'gpt-4o',
            hasApiKey: true,
            loadModels: async (forceRefresh: boolean) => {
                loads++;
                assert(forceRefresh === false, 'an implicit load must not force refresh');
                return listedResult;
            },
            onModelChange: () => { /* no-op */ },
            isStale: () => false,
            loadedResult: listedResult,
        };

        for (let i = 0; i < 5; i++) {
            renderModelField(fakeContainer(), deps);
        }
        await settle();

        expect(loads).toBe(0);
    });

    await test('cached model field still renders the cached options and note', () => {
        const container = fakeContainer();
        renderModelField(container, {
            currentModel: 'gpt-4o',
            hasApiKey: true,
            loadModels: async () => listedResult,
            onModelChange: () => { /* no-op */ },
            isStale: () => false,
            loadedResult: listedResult,
        });

        const select = container.querySelector('.baizer-settings-model-select') as FakeNode;
        const note = container.querySelector('.baizer-settings-field-hint') as FakeNode;
        expect(select.children.length).toBe(2);
        assert(/2 models listed/i.test(note.textContent), `cached note must state the count, got: ${note.textContent}`);
    });

    await test('an uncached model field loads once and hands the result to the cache', async () => {
        let loads = 0;
        const cached: AvailableModelsResult[] = [];
        const container = fakeContainer();

        renderModelField(container, {
            currentModel: 'gpt-4o',
            hasApiKey: true,
            loadModels: async () => { loads++; return listedResult; },
            onModelChange: () => { /* no-op */ },
            isStale: () => false,
            onLoaded: result => cached.push(result),
        });
        await settle();

        expect(loads).toBe(1);
        expect(cached.length).toBe(1);
        expect(cached[0]).toBe(listedResult);
    });

    await test('only the refresh button forces a new model list request', async () => {
        let forceRefreshes = 0;
        const container = fakeContainer();

        renderModelField(container, {
            currentModel: 'gpt-4o',
            hasApiKey: true,
            loadModels: async (forceRefresh: boolean) => {
                if (forceRefresh) forceRefreshes++;
                return listedResult;
            },
            onModelChange: () => { /* no-op */ },
            isStale: () => false,
            loadedResult: listedResult,
        });
        await settle();
        expect(forceRefreshes).toBe(0);

        const refresh = container.querySelector('.baizer-settings-action') as FakeNode;
        refresh.click();
        await settle();
        expect(forceRefreshes).toBe(1);
    });

    await test('a stale render never writes fetched models into the discarded DOM', async () => {
        const container = fakeContainer();
        let stale = true;

        renderModelField(container, {
            currentModel: 'gpt-4o',
            hasApiKey: true,
            loadModels: async () => listedResult,
            onModelChange: () => { /* no-op */ },
            isStale: () => stale,
        });
        await settle();

        // 旧 DOM 的 select 仍停在 loading 占位，不会被迟到的结果写入。
        const select = container.querySelector('.baizer-settings-model-select') as FakeNode;
        expect(select.children.length).toBe(1);
        expect(select.children[0].value).toBe('__loading__');
        stale = false;
    });
}

void runTests();
