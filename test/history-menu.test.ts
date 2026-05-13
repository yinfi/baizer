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
  value = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};

  createDiv(attr?: any) {
    return this.createEl('div', attr);
  }

  createSpan(attr?: any) {
    return this.createEl('span', attr);
  }

  createEl(_tag: string, attr?: any) {
    const child = new FakeElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    child.value = attr?.value || '';
    if (attr?.attr) {
      for (const [name, value] of Object.entries(attr.attr)) {
        child.attributes[name] = String(value);
      }
    }
    this.children.push(child);
    return child;
  }

  empty() {
    this.children = [];
    this.textContent = '';
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  focus() {
    return;
  }

  click() {
    const event = { stopPropagation: () => { } };
    for (const handler of this.listeners.click || []) {
      handler(event);
    }
  }

  input(value: string) {
    this.value = value;
    for (const handler of this.listeners.input || []) {
      handler({ target: this });
    }
  }

  keydown(key: string) {
    for (const handler of this.listeners.keydown || []) {
      handler({
        key,
        preventDefault: () => { },
        stopPropagation: () => { },
        target: this,
      });
    }
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  querySelector(selector: string): FakeElement | null {
    const matches = this.querySelectorAll(selector);
    return matches[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.findAllByClass(className);
  }

  private findAllByClass(className: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (child.hasClass(className)) matches.push(child);
      matches.push(...child.findAllByClass(className));
    }
    return matches;
  }
}

async function runTests() {
  console.log('=== History Menu Tests ===');
  const { HistoryMenu } = await import('../src/ui/components/history-menu');

  await test('renders saved conversations and wires open and delete callbacks', () => {
    const opened: string[] = [];
    const deleted: string[] = [];
    const container = new FakeElement();
    const menu = new HistoryMenu(container as any, {
      onOpen: (id) => opened.push(id),
      onDelete: (id) => deleted.push(id),
    });

    menu.update([
      { id: 'c-1', title: 'Roadmap chat', updatedAt: 20, providerId: 'gemini' },
      { id: 'c-2', title: 'Daily note', updatedAt: 10, providerId: 'openai' },
    ]);

    expect(container.style.display).toBe('block');
    expect(container.querySelectorAll('.ocli-history-item').length).toBe(2);
    expect(container.querySelector('.ocli-history-title')?.textContent).toBe('Roadmap chat');

    container.querySelectorAll('.ocli-history-item')[0].click();
    container.querySelectorAll('.ocli-history-item')[1].querySelector('.ocli-history-delete')?.click();

    expect(opened).toEqual(['c-1']);
    expect(deleted).toEqual(['c-2']);
  });

  await test('filters saved conversations by search query and closes on Escape', () => {
    const opened: string[] = [];
    const deleted: string[] = [];
    let closed = 0;
    const container = new FakeElement();
    const menu = new HistoryMenu(container as any, {
      onOpen: (id) => opened.push(id),
      onDelete: (id) => deleted.push(id),
      onClose: () => { closed += 1; },
    } as any);

    menu.update([
      { id: 'c-1', title: 'Roadmap chat', updatedAt: 20, providerId: 'gemini', modelId: 'gemini-2.5-pro', currentNote: 'Projects/roadmap.md' } as any,
      { id: 'c-2', title: 'Daily note', updatedAt: 10, providerId: 'openai', modelId: 'gpt-4o', currentNote: 'Daily/2026-05-12.md' } as any,
    ]);

    const search = container.querySelector('.ocli-history-search');
    if (!search) {
      throw new Error('Expected search input to exist');
    }

    search.input('daily');

    expect(container.querySelectorAll('.ocli-history-item').length).toBe(1);
    expect(container.querySelector('.ocli-history-title')?.textContent).toBe('Daily note');

    search.input('roadmap.md');

    expect(container.querySelectorAll('.ocli-history-item').length).toBe(1);
    expect(container.querySelector('.ocli-history-title')?.textContent).toBe('Roadmap chat');

    search.keydown('Escape');

    expect(opened).toEqual([]);
    expect(deleted).toEqual([]);
    expect(closed).toBe(1);
  });

  await test('groups pinned and recent conversations and wires pin callbacks', () => {
    const pinned: string[] = [];
    const container = new FakeElement();
    const menu = new HistoryMenu(container as any, {
      onOpen: () => { },
      onDelete: () => { },
      onClose: () => { },
      onTogglePin: (id) => pinned.push(id),
    } as any);

    const now = Date.now();
    menu.update([
      { id: 'c-1', title: 'Pinned roadmap', updatedAt: now - 1_000, providerId: 'gemini', pinnedAt: now - 500 } as any,
      { id: 'c-2', title: 'Today note', updatedAt: now - 60_000, providerId: 'openai' } as any,
      { id: 'c-3', title: 'Old backlog', updatedAt: now - (8 * 24 * 60 * 60 * 1000), providerId: 'openai' } as any,
    ]);

    expect(container.querySelectorAll('.ocli-history-group-title').map(item => item.textContent)).toEqual([
      'Pinned',
      'Today',
      'Older',
    ]);

    const pinButton = container.querySelector('.ocli-history-pin');
    if (!pinButton) {
      throw new Error('Expected pin button to exist');
    }
    pinButton.click();

    expect(pinned).toEqual(['c-1']);
  });

  await test('shows a no match state when the search query filters everything out', () => {
    const container = new FakeElement();
    const menu = new HistoryMenu(container as any, {
      onOpen: () => { },
      onDelete: () => { },
      onClose: () => { },
    } as any);

    menu.update([
      { id: 'c-1', title: 'Roadmap chat', updatedAt: 20, providerId: 'gemini' },
      { id: 'c-2', title: 'Daily note', updatedAt: 10, providerId: 'openai' },
    ]);

    const search = container.querySelector('.ocli-history-search');
    if (!search) {
      throw new Error('Expected search input to exist');
    }

    search.input('missing');

    expect(container.querySelectorAll('.ocli-history-item').length).toBe(0);
    expect(container.querySelector('.ocli-history-empty')?.textContent).toBe('No matching conversations.');
  });

  await test('shows an empty state and can be hidden', () => {
    const container = new FakeElement();
    const menu = new HistoryMenu(container as any, {
      onOpen: () => { },
      onDelete: () => { },
    });

    menu.update([]);

    expect(container.style.display).toBe('block');
    expect(container.children[0].textContent).toBe('No saved conversations yet.');

    menu.hide();

    expect(container.style.display).toBe('none');
    expect(container.children.length).toBe(0);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
