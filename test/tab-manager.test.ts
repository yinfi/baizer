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
    toContain: (expected: any) => {
      if (!Array.isArray(actual) || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${expected}`);
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

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};

  createDiv(attr?: any) {
    const child = new FakeElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    this.children.push(child);
    return child;
  }

  empty() {
    this.children = [];
    this.textContent = '';
  }

  addClass(name: string) {
    const parts = this.className.split(' ').filter(Boolean);
    if (!parts.includes(name)) parts.push(name);
    this.className = parts.join(' ');
  }

  removeClass(name: string) {
    this.className = this.className.split(' ').filter(part => part && part !== name).join(' ');
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) handler();
  }

  contextmenu() {
    const event = { preventDefault: () => { } };
    for (const handler of this.listeners.contextmenu || []) handler(event);
  }
}

async function runTests() {
  console.log('=== TabManager Tests ===');
  const { TabManager } = await import('../src/ui/tabs/tab-manager');
  const { TabBar } = await import('../src/ui/tabs/tab-bar');

  await test('creates the first active tab with stable defaults', () => {
    const manager = new TabManager({ createId: () => 'tab-1' });
    const tab = manager.createTab();

    expect(tab.id).toBe('tab-1');
    expect(tab.index).toBe(1);
    expect(tab.title).toBe('Chat 1');
    expect(tab.isActive).toBe(true);
    expect(tab.isStreaming).toBe(false);
    expect(tab.needsAttention).toBe(false);
    expect(manager.getActiveTab()?.id).toBe('tab-1');
  });

  await test('creating another tab switches active tab and reindexes items', () => {
    const ids = ['tab-1', 'tab-2'];
    const manager = new TabManager({ createId: () => ids.shift()! });

    manager.createTab();
    manager.createTab();

    expect(manager.getActiveTab()?.id).toBe('tab-2');
    expect(manager.getAllTabs().map(tab => ({
      id: tab.id,
      index: tab.index,
      isActive: tab.isActive,
    }))).toEqual([
      { id: 'tab-1', index: 1, isActive: false },
      { id: 'tab-2', index: 2, isActive: true },
    ]);
  });

  await test('switches tabs and clears attention on the selected tab', () => {
    const ids = ['tab-1', 'tab-2'];
    const manager = new TabManager({ createId: () => ids.shift()! });
    manager.createTab();
    manager.createTab();
    manager.markAttention('tab-1', true);

    manager.switchTab('tab-1');

    expect(manager.getActiveTab()?.id).toBe('tab-1');
    expect(manager.getAllTabs().map(tab => ({
      id: tab.id,
      active: tab.isActive,
      attention: tab.needsAttention,
    }))).toEqual([
      { id: 'tab-1', active: true, attention: false },
      { id: 'tab-2', active: false, attention: false },
    ]);
  });

  await test('closes inactive tabs without changing the active tab', () => {
    const ids = ['tab-1', 'tab-2', 'tab-3'];
    const manager = new TabManager({ createId: () => ids.shift()! });
    manager.createTab();
    manager.createTab();
    manager.createTab();

    const closed = manager.closeTab('tab-1');

    expect(closed).toBe(true);
    expect(manager.getActiveTab()?.id).toBe('tab-3');
    expect(manager.getAllTabs().map(tab => ({ id: tab.id, index: tab.index }))).toEqual([
      { id: 'tab-2', index: 1 },
      { id: 'tab-3', index: 2 },
    ]);
  });

  await test('prevents closing the last tab', () => {
    const manager = new TabManager({ createId: () => 'tab-1' });
    manager.createTab();

    expect(manager.closeTab('tab-1')).toBe(false);
    expect(manager.getAllTabs().length).toBe(1);
  });

  await test('marks streaming and attention state by id', () => {
    const ids = ['tab-1', 'tab-2'];
    const manager = new TabManager({ createId: () => ids.shift()! });
    manager.createTab();
    manager.createTab();

    manager.markStreaming('tab-1', true);
    manager.markAttention('tab-1', true);

    const tab = manager.getAllTabs().find(item => item.id === 'tab-1')!;
    expect(tab.isStreaming).toBe(true);
    expect(tab.needsAttention).toBe(true);
  });

  await test('updates tab metadata and keeps active state intact', () => {
    const ids = ['tab-1', 'tab-2'];
    const manager = new TabManager({ createId: () => ids.shift()! });
    manager.createTab();
    manager.createTab();

    const updated = manager.updateTab('tab-1', {
      title: 'Saved roadmap',
      providerId: 'openai',
      modelId: 'gpt-4o',
      currentNote: 'Notes/roadmap.md',
      createdAt: 10,
      updatedAt: 20,
    });

    expect(updated).toBe(true);
    expect(manager.getActiveTab()?.id).toBe('tab-2');
    expect(manager.getAllTabs().map(tab => ({
      id: tab.id,
      title: tab.title,
      providerId: tab.providerId,
      modelId: tab.modelId,
      currentNote: tab.currentNote,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
    }))).toEqual([
      {
        id: 'tab-1',
        title: 'Saved roadmap',
        providerId: 'openai',
        modelId: 'gpt-4o',
        currentNote: 'Notes/roadmap.md',
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: 'tab-2',
        title: 'Chat 2',
        providerId: undefined,
        modelId: undefined,
        currentNote: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);
  });

  await test('hydrates a tab from a conversation snapshot', () => {
    const manager = new TabManager({ createId: () => 'unused' });
    const tab = manager.createTab({
      id: 'conversation-1',
      title: 'Saved chat',
      createdAt: 1,
      updatedAt: 2,
      providerId: 'gemini',
      modelId: 'gemini-2.5-flash',
      messages: [{ id: 'm1', role: 'user', content: 'saved', timestamp: 1 }],
    });

    expect(tab.id).toBe('conversation-1');
    expect(tab.title).toBe('Saved chat');
    expect(tab.state.getMessages()).toEqual([
      { id: 'm1', role: 'user', content: 'saved', timestamp: 1 },
    ]);
    expect(tab.state.isDirty()).toBe(false);
  });

  await test('TabBar renders accessible tab badges and emits callbacks', () => {
    const clicked: string[] = [];
    const closed: string[] = [];
    const newTabs: string[] = [];
    const container = new FakeElement();
    const tabBar = new TabBar(container as any, {
      onTabClick: id => clicked.push(id),
      onTabClose: id => closed.push(id),
      onNewTab: () => newTabs.push('new'),
    });

    tabBar.update([
      { id: 'tab-1', index: 1, title: 'First', isActive: true, isStreaming: false, needsAttention: false, canClose: false },
      { id: 'tab-2', index: 2, title: 'Second', isActive: false, isStreaming: true, needsAttention: false, canClose: true },
    ]);

    expect(container.attributes.role).toBe('tablist');
    expect(container.children.length).toBe(4);
    expect(container.children[0].attributes.role).toBe('tab');
    expect(container.children[0].attributes['aria-selected']).toBe('true');
    expect(container.children[1].className).toBe('ocli-tab-active-title');
    expect(container.children[1].textContent).toBe('First');
    expect(container.children[2].attributes['aria-selected']).toBe('false');

    container.children[2].click();
    container.children[2].contextmenu();
    container.children[3].click();

    expect(clicked).toEqual(['tab-2']);
    expect(closed).toEqual(['tab-2']);
    expect(newTabs).toEqual(['new']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
