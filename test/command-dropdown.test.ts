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

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
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

  click() {
    for (const handler of this.listeners.click || []) {
      handler();
    }
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.findFirstByClass(className);
  }

  private findFirstByClass(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.hasClass(className)) return child;
      const nested = child.findFirstByClass(className);
      if (nested) return nested;
    }
    return null;
  }
}

async function runTests() {
  console.log('=== Command Dropdown Tests ===');
  const { CommandDropdown } = await import('../src/ui/components/command-dropdown');

  await test('renders slash commands with source labels and selected state', () => {
    const selected: any[] = [];
    const container = new FakeElement();
    const dropdown = new CommandDropdown(container as any, {
      onSelect: (item, index) => selected.push({ item, index }),
      onNavigate: () => { },
      onCancel: () => { },
    });

    dropdown.update({
      type: 'command',
      items: [
        { label: '/clear', desc: 'Clear chat', source: 'local' },
        { label: '/wiki:query', desc: 'Query wiki', source: 'skill' },
      ],
      selectedIndex: 1,
    });

    expect(container.style.display).toBe('block');
    expect(container.children.length).toBe(2);
    expect(container.children[1].hasClass('is-selected')).toBe(true);
    expect(container.children[0].querySelector('.suggestion-source')?.textContent).toBe('local');
    expect(container.children[1].querySelector('.suggestion-source')?.textContent).toBe('skill');
  });

  await test('renders file suggestions and click selection', () => {
    const selected: any[] = [];
    const container = new FakeElement();
    const dropdown = new CommandDropdown(container as any, {
      onSelect: (item, index) => selected.push({ label: item.label, index }),
      onNavigate: () => { },
      onCancel: () => { },
    });

    dropdown.update({
      type: 'file',
      items: [{ label: 'Daily', desc: 'Journal/Daily.md', value: '[[Journal/Daily.md]]', source: 'file' }],
      selectedIndex: 0,
    });
    container.children[0].click();

    expect(container.children[0].querySelector('.suggestion-icon')?.textContent).toBe('@');
    expect(container.children[0].querySelector('.suggestion-source')?.textContent).toBe('file');
    expect(selected).toEqual([{ label: 'Daily', index: 0 }]);
  });

  await test('hides when there are no results', () => {
    const container = new FakeElement();
    const dropdown = new CommandDropdown(container as any, {
      onSelect: () => { },
      onNavigate: () => { },
      onCancel: () => { },
    });

    dropdown.update({ type: 'command', items: [], selectedIndex: 0 });

    expect(container.style.display).toBe('none');
    expect(container.children.length).toBe(0);
  });

  await test('keyboard events emit navigation, selection, and cancel callbacks', () => {
    const events: string[] = [];
    const container = new FakeElement();
    const dropdown = new CommandDropdown(container as any, {
      onSelect: (item, index) => events.push(`select:${index}:${item.label}`),
      onNavigate: (dir) => events.push(`nav:${dir}`),
      onCancel: () => events.push('cancel'),
    });

    dropdown.update({
      type: 'skill',
      items: [{ label: '$web-clipper', desc: 'Save web pages', source: 'skill' }],
      selectedIndex: 0,
    });

    const preventions: string[] = [];
    dropdown.handleKeyDown({ key: 'ArrowDown', preventDefault: () => preventions.push('down') } as any);
    dropdown.handleKeyDown({ key: 'ArrowUp', preventDefault: () => preventions.push('up') } as any);
    dropdown.handleKeyDown({ key: 'Enter', preventDefault: () => preventions.push('enter') } as any);
    dropdown.handleKeyDown({ key: 'Escape', preventDefault: () => preventions.push('escape') } as any);

    expect(events).toEqual(['nav:1', 'nav:-1', 'select:0:$web-clipper', 'cancel']);
    expect(preventions).toEqual(['down', 'up', 'enter', 'escape']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
