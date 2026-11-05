/**
 * #76 P2-C：`ShellView.handleTabMessageUpdated()` 的 DOM 桩用例。
 *
 * 这是 #71 里唯一以真实 DOM 为宿主的新代码（按 data-message-id 找 entry、
 * 清空 `.shell-approval-message-body` 后原地重画、按原焦点决定是否移交）。
 * 既有用例都跑在 `renderApprovalCard` 上，从未执行过这段粘合层，所以这里用
 * 一个克制的假容器真正调用 `handleTabMessageUpdated`，覆盖 empty / 就地重画 /
 * 焦点三个分支。
 */

(global as any).window = {
  setInterval,
  clearInterval,
};

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${JSON.stringify(actual)}`);
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
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

class FakeDomElement {
  children: FakeDomElement[] = [];
  classes: string[] = [];
  attributes: Record<string, string> = {};
  textContent = '';
  emptyCalls = 0;

  constructor(public tagName = 'div') { }

  get className(): string {
    return this.classes.join(' ');
  }

  set className(value: string) {
    this.classes = value.split(' ').filter(Boolean);
  }

  hasClass(name: string): boolean {
    return this.classes.includes(name);
  }

  createDiv(attr: any = {}): FakeDomElement {
    const child = new FakeDomElement('div');
    if (attr.cls) child.className = attr.cls;
    if (attr.text) child.textContent = attr.text;
    this.children.push(child);
    return child;
  }

  createEl(tag: string, attr: any = {}): FakeDomElement {
    const child = new FakeDomElement(tag);
    if (attr.cls) child.className = attr.cls;
    if (attr.text) child.textContent = attr.text;
    this.children.push(child);
    return child;
  }

  empty() {
    this.emptyCalls += 1;
    this.children = [];
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  querySelector(selector: string): FakeDomElement | null {
    for (const part of selector.split(',').map(item => item.trim()).filter(Boolean)) {
      const match = this.findBySelector(part);
      if (match) return match;
    }
    return null;
  }

  contains(target: FakeDomElement | null): boolean {
    if (!target) return false;
    if (target === this) return true;
    return this.children.some(child => child.contains(target));
  }

  focus() {
    (global as any).document.activeElement = this;
  }

  private findBySelector(selector: string): FakeDomElement | null {
    const entry = selector.match(/^\.shell-entry\[data-message-id="(.*)"\]$/);
    if (entry) {
      return this.find(item => item.hasClass('shell-entry') && item.attributes['data-message-id'] === entry[1]);
    }
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.find(item => item.hasClass(className));
    }
    return null;
  }

  private find(predicate: (item: FakeDomElement) => boolean): FakeDomElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

function createApprovalMessage(id: string, status: 'failed' | 'unknown' | 'succeeded') {
  return {
    id,
    role: 'system' as const,
    content: `Approval required: ${id}`,
    timestamp: 1,
    approval: {
      id: `req-${id}`,
      conversationId: 'tab-a',
      action: 'update_note',
      target: 'Docs/a.md',
      args: { path: 'Docs/a.md' },
      message: `Approval required: ${id}`,
    },
    approvalState: { status, outcome: { status, detail: 'detail', completedAt: 2 } },
  } as any;
}

async function createHarness() {
  const { ShellView } = await import('../src/ui/shell-view');

  // 必须在 import 之后再定义 document：@codemirror/view 在模块加载期会读取
  // document.documentElement.style，缺了它会把整条 import 链打断。
  // 不定义 document 时 codemirror 用内置兜底；这里只提供焦点断言需要的最小宿主。
  (global as any).document = { documentElement: { style: {} }, activeElement: null };

  const container = new FakeDomElement();
  const entries: Record<string, FakeDomElement> = {};
  for (const id of ['msg-1', 'msg-2', 'msg-3']) {
    const entry = new FakeDomElement();
    entry.className = 'shell-entry system';
    entry.setAttribute('data-message-id', id);
    if (id !== 'msg-3') entry.createDiv({ cls: 'shell-approval-message-body' });
    container.children.push(entry);
    entries[id] = entry;
  }

  const updates: Array<{ id: string; message: any }> = [];
  const rendered: Array<{ body: FakeDomElement; message: any }> = [];
  const scrollHooks: string[] = [];
  let persisted = 0;

  const tab = {
    id: 'tab-a',
    state: {
      updateMessage: (id: string, message: any) => {
        updates.push({ id, message });
      },
    },
  };

  const view = new ShellView({} as any, { getSkillCommands: () => [] } as any) as any;
  view.tabManager = {
    getAllTabs: () => [tab],
    getActiveTab: () => tab,
  };
  view.dirtyTabs = new Set();
  view.persistTab = async () => { persisted += 1; };
  view.getActiveMessageContainer = () => container;
  view.getMessageRenderer = () => ({
    renderApproval: (body: FakeDomElement, message: any) => {
      rendered.push({ body, message });
      const status = message.approvalState?.status;
      body.createDiv({ cls: `shell-approval-card is-${status}` });
      if (status === 'failed') body.createDiv({ cls: 'shell-approval-retry' });
      if (status === 'unknown') body.createDiv({ cls: 'shell-approval-recheck' });
      if (status === 'succeeded') body.createDiv({ cls: 'shell-approval-outcome' });
    },
  });
  view.captureScrollGrowth = () => {
    scrollHooks.push('capture');
    return {};
  };
  view.afterScrollGrowth = (_token: any, markUnread: boolean) => {
    scrollHooks.push(`after:${markUnread}`);
  };

  return {
    view,
    container,
    entries,
    updates,
    rendered,
    scrollHooks,
    get persisted() {
      return persisted;
    },
  };
}

async function runTests() {
  console.log('=== Approval In-place Update Tests ===');

  await test('repaints only the target approval body in place', async () => {
    const harness = await createHarness();
    const targetBody = harness.entries['msg-1'].querySelector('.shell-approval-message-body')!;
    const untouchedBody = harness.entries['msg-2'].querySelector('.shell-approval-message-body')!;

    (global as any).document.activeElement = null;
    harness.view.handleTabMessageUpdated('tab-a', createApprovalMessage('msg-1', 'failed'));

    // 只有目标 body 被清空并重建，其它 entry 完全不碰。
    expect(targetBody.emptyCalls).toBe(1);
    expect(untouchedBody.emptyCalls).toBe(0);
    expect(untouchedBody.children.length).toBe(0);
    expect(harness.rendered.length).toBe(1);
    expect(harness.rendered[0].body).toBe(targetBody);
    expect(targetBody.children.length).toBe(2);
    // 投影同步 + 快照落盘 + 滚动钩子各走一次。
    expect(harness.updates.length).toBe(1);
    expect(harness.updates[0].id).toBe('msg-1');
    expect(harness.persisted).toBe(1);
    expect(harness.scrollHooks).toEqual(['capture', 'after:false']);
  });

  await test('keeps keyboard focus on the retry button when the card already had focus', async () => {
    const harness = await createHarness();
    const body = harness.entries['msg-1'].querySelector('.shell-approval-message-body')!;
    const previousFocus = body.createDiv({ cls: 'shell-approval-confirm' });
    (global as any).document.activeElement = previousFocus;

    harness.view.handleTabMessageUpdated('tab-a', createApprovalMessage('msg-1', 'failed'));

    const retry = body.querySelector('.shell-approval-retry');
    expect(retry !== null).toBe(true);
    expect((global as any).document.activeElement).toBe(retry);
  });

  await test('moves focus to the recheck button for an unknown result', async () => {
    const harness = await createHarness();
    const body = harness.entries['msg-1'].querySelector('.shell-approval-message-body')!;
    (global as any).document.activeElement = body.createDiv({ cls: 'shell-approval-confirm' });

    harness.view.handleTabMessageUpdated('tab-a', createApprovalMessage('msg-1', 'unknown'));

    const recheck = body.querySelector('.shell-approval-recheck');
    expect(recheck !== null).toBe(true);
    expect((global as any).document.activeElement).toBe(recheck);
  });

  await test('never steals focus from the composer', async () => {
    const harness = await createHarness();
    const composer = new FakeDomElement('textarea');
    (global as any).document.activeElement = composer;

    harness.view.handleTabMessageUpdated('tab-a', createApprovalMessage('msg-1', 'succeeded'));

    expect((global as any).document.activeElement).toBe(composer);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
