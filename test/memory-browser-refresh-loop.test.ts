/**
 * Regression: MemoryBrowserPage.display() <-> refresh() must not spin.
 *
 * Before the fix, a getMemoryView() that kept resolving to null (no memoryManager because the
 * active provider has no API key) or kept rejecting made display() -> refresh() -> display() ...
 * recurse through the microtask queue with no backoff, starving every timer and paint.
 *
 * The page is driven through its real SettingTab definition against a tiny fake DOM, so the
 * production class (not a copy) is what is under test.
 */
import { App } from 'obsidian';
import { DEFAULT_SETTINGS, IPlugin, PluginSettings } from '../src/mcp/types';
import { setLocaleForTesting, t } from '../src/i18n/zh';
import { SettingTab } from '../src/settings';

const UNAVAILABLE_KEY =
  'Memory is unavailable until the active provider has an API key. Add one on the Connection page, then press Refresh.';

/** Hard stop so a regression fails the assertions instead of hanging the whole test run. */
const RUNAWAY_CAP = 2000;
/** One automatic load, plus at most a couple of explicit user retries inside a scenario. */
const BOUND = 3;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

class FakeEl {
  children: FakeEl[] = [];
  text = '';
  cls = '';
  tag = 'div';
  disabled = false;
  value = '';
  private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

  empty(): void { this.children = []; this.text = ''; }
  private add(tag: string, opts?: { text?: string; cls?: string }): FakeEl {
    const el = new FakeEl();
    el.tag = tag;
    el.text = opts?.text ?? '';
    el.cls = opts?.cls ?? '';
    this.children.push(el);
    return el;
  }
  createDiv(opts?: { text?: string; cls?: string }): FakeEl { return this.add('div', opts); }
  createSpan(opts?: { text?: string; cls?: string }): FakeEl { return this.add('span', opts); }
  createEl(tag: string, opts?: { text?: string; cls?: string }): FakeEl { return this.add(tag, opts); }
  addEventListener(ev: string, fn: (e?: unknown) => void): void {
    (this.listeners[ev] ||= []).push(fn);
  }
  click(): void { for (const fn of this.listeners.click || []) fn(); }
  allText(): string {
    return [this.text, ...this.children.map(c => c.allText())].filter(Boolean).join('\n');
  }
  findButton(label: string): FakeEl | undefined {
    if (this.tag === 'button' && this.text === label) return this;
    for (const c of this.children) {
      const hit = c.findButton(label);
      if (hit) return hit;
    }
    return undefined;
  }
}

const EMPTY_VIEW = {
  privacyMode: false,
  stats: { total: 0, world: 0, experience: 0, observation: 0, lastUpdatedAt: null },
  sections: { observations: [], facts: [], recent: [], searchResults: [], raw: [] },
};

function viewWithOneObservation() {
  return {
    ...EMPTY_VIEW,
    sections: {
      ...EMPTY_VIEW.sections,
      observations: [{
        id: 'o1', type: 'observation', text: 'user prefers short answers', tags: [],
        confidence: 0.9, mentionedAt: 1, updatedAt: 1,
      }],
    },
  };
}

interface Rig {
  page: any;
  root: FakeEl;
  calls: () => number;
}

function makeRig(getMemoryView: ((req: unknown) => Promise<unknown>) | undefined): Rig {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
  let calls = 0;
  const modelService: Record<string, unknown> = {};
  if (getMemoryView) {
    modelService.getMemoryView = async (req: unknown) => {
      calls++;
      // A regression would otherwise spin forever and hang CI; break the loop so the asserts fail.
      if (calls > RUNAWAY_CAP) return viewWithOneObservation();
      return getMemoryView(req);
    };
  }
  const plugin = { settings, modelService, saveSettings: async () => {} } as unknown as IPlugin;
  const tab = new SettingTab({} as App, plugin);
  const page = findMemoryPage(tab.getSettingDefinitions() as any[]);
  const root = new FakeEl();
  page.containerEl = root;
  return { page, root, calls: () => calls };
}

function findMemoryPage(items: any[]): any {
  for (const item of items) {
    if (item && item.type === 'page') {
      if (typeof item.page === 'function') {
        const candidate = item.page();
        if (candidate.title === t('Browse memory')) return candidate;
      }
      if (Array.isArray(item.items)) {
        const nested = findMemoryPage(item.items);
        if (nested) return nested;
      }
    } else if (item && Array.isArray(item.items)) {
      const nested = findMemoryPage(item.items);
      if (nested) return nested;
    }
  }
  return undefined;
}

const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Starts display(), then asks for a setTimeout(0). Returns how many getMemoryView calls had
 * happened by the time that timer fired: a spinning page lets the count run away first.
 */
async function openAndProbe(rig: Rig): Promise<number> {
  let callsWhenTimerFired = -1;
  const probe = macrotask().then(() => { callsWhenTimerFired = rig.calls(); });
  rig.page.display();
  await probe;
  await macrotask();
  await macrotask();
  return callsWhenTimerFired;
}

async function main() {
  setLocaleForTesting(false);
  console.log('=== MemoryBrowserPage refresh-loop regression ===');

  await test('getMemoryView resolving null (no memoryManager) settles after a bounded number of calls', async () => {
    const rig = makeRig(async () => null);
    const atTimer = await openAndProbe(rig);
    assert(atTimer !== -1, 'setTimeout(0) probe never fired');
    assert(atTimer <= BOUND, `timer only fired after ${atTimer} getMemoryView calls (page is starving the event loop)`);
    assert(rig.calls() <= BOUND, `getMemoryView called ${rig.calls()} times, expected <= ${BOUND}`);
  });

  await test('null result is terminal: shows the configure-a-provider message, not Loading', async () => {
    const rig = makeRig(async () => null);
    await openAndProbe(rig);
    const text = rig.root.allText();
    assert(text.includes(t(UNAVAILABLE_KEY)), `unavailable message missing; got:\n${text}`);
    assert(!text.includes(t('Loading memory...')), 'still shows the Loading state');
  });

  await test('rejecting getMemoryView settles after a bounded number of calls and shows the error', async () => {
    const rig = makeRig(async () => { throw new Error('store init failed'); });
    const atTimer = await openAndProbe(rig);
    assert(atTimer !== -1 && atTimer <= BOUND, `timer fired after ${atTimer} calls`);
    assert(rig.calls() <= BOUND, `getMemoryView called ${rig.calls()} times, expected <= ${BOUND}`);
    assert(rig.root.allText().includes('store init failed'), 'error text not shown');
  });

  await test('missing modelService.getMemoryView shows the existing error and does not recurse', async () => {
    const rig = makeRig(undefined);
    rig.page.display();
    await macrotask();
    assert(rig.root.allText().includes(t('Memory service is not available.')), 'error text not shown');
  });

  await test('an explicit Refresh click retries exactly once per click', async () => {
    const rig = makeRig(async () => null);
    await openAndProbe(rig);
    const before = rig.calls();
    const refresh = rig.root.findButton(t('Refresh'));
    assert(!!refresh, 'Refresh button not rendered');
    refresh!.click();
    await macrotask();
    await macrotask();
    assert(rig.calls() === before + 1, `expected ${before + 1} calls after one click, got ${rig.calls()}`);
    assert(rig.root.allText().includes(t(UNAVAILABLE_KEY)), 'unavailable message lost after retry');
  });

  await test('recovers once the provider is configured: Refresh then shows the records', async () => {
    let configured = false;
    const rig = makeRig(async () => (configured ? viewWithOneObservation() : null));
    await openAndProbe(rig);
    assert(rig.root.allText().includes(t(UNAVAILABLE_KEY)), 'precondition: unavailable message');
    configured = true;
    rig.root.findButton(t('Refresh'))!.click();
    await macrotask();
    await macrotask();
    const text = rig.root.allText();
    assert(text.includes('user prefers short answers'), `record not shown after recovery; got:\n${text}`);
    assert(!text.includes(t(UNAVAILABLE_KEY)), 'unavailable message still shown after recovery');
  });

  await test('healthy view loads with a single call', async () => {
    const rig = makeRig(async () => viewWithOneObservation());
    await openAndProbe(rig);
    assert(rig.calls() === 1, `expected 1 call, got ${rig.calls()}`);
    assert(rig.root.allText().includes('user prefers short answers'), 'record not rendered');
  });

  await test('repeated display() while a load is in flight does not start more loads', async () => {
    const rig = makeRig(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return viewWithOneObservation();
    });
    rig.page.display();
    rig.page.display();
    rig.page.display();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(rig.calls() === 1, `expected 1 call, got ${rig.calls()}`);
  });

  await test('a getMemoryView() that never resolves times out into the retryable error state', async () => {
    const rig = makeRig(() => new Promise(() => { /* never settles */ }));
    rig.page.memoryRequestTimeoutMs = 40;
    rig.page.display();
    await new Promise(resolve => setTimeout(resolve, 150));   // wait past the timeout
    const text = rig.root.allText();
    assert(text.includes(t('Memory request timed out. Please try again.')), `timeout message missing; got:\n${text}`);
    assert(!text.includes(t('Loading memory...')), 'still stuck showing Loading after the timeout');
    // still retryable: the explicit Refresh button must work, not be swallowed
    const before = rig.calls();
    rig.root.findButton(t('Refresh'))!.click();
    await macrotask();
    await macrotask();
    assert(rig.calls() === before + 1, `Refresh must retry after a timeout, got ${rig.calls()} vs ${before + 1}`);
  });

  await test('a tab switch during an in-flight load is honoured, not silently dropped', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rig = makeRig(async () => { await gate; return viewWithOneObservation(); });
    rig.page.display();                       // starts the in-flight load
    await macrotask();
    const factsTab = rig.root.children
      .flatMap((c: FakeEl) => c.children)
      .find((c: FakeEl) => c.tag === 'button' && c.text === t('Facts'));
    assert(!!factsTab, 'Facts tab not rendered');
    factsTab!.click();                        // user switches tab while the load is in flight
    release();
    await macrotask();
    await macrotask();
    await macrotask();
    assert(rig.calls() === 2, `tab switch during flight must trigger a second load, got ${rig.calls()}`);
    assert((rig.page as any).memoryActiveTab === 'facts', 'active tab should stay on Facts');
  });

  await test('the new message has a Chinese translation', async () => {
    setLocaleForTesting(true);
    try {
      assert(t(UNAVAILABLE_KEY) !== UNAVAILABLE_KEY, 'no zh entry for the unavailable message');
    } finally {
      setLocaleForTesting(false);
    }
  });

  console.log('MemoryBrowserPage refresh-loop: all passed');
}

main().catch(e => { console.error(e); process.exit(1); });