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
    if (attr?.title) child.attributes.title = attr.title;
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
    const event = { stopPropagation: () => { } };
    for (const handler of this.listeners.click || []) {
      handler(event);
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
  console.log('=== Context Chips Tests ===');
  const { ContextChips, getContextChipLabel, getContextIconName } = await import('../src/ui/components/context-chips');

  await test('derives filename-first labels and icon names for context types', () => {
    expect(getContextChipLabel({ id: '1', type: 'file', data: 'Folder/Note.md' })).toBe('Note.md');
    expect(getContextChipLabel({ id: '2', type: 'url', data: 'https://example.com/a', summary: 'Example' })).toBe('Example');
    expect(getContextChipLabel({ id: '3', type: 'scope', data: '@current', summary: 'Current note', scope: 'current' } as any)).toBe('@current');
    expect(getContextIconName('file')).toBe('file-text');
    expect(getContextIconName('image')).toBe('image');
    expect(getContextIconName('url')).toBe('link');
    expect(getContextIconName('youtube')).toBe('youtube');
    expect(getContextIconName('scope' as any)).toBe('at-sign');
  });

  await test('renders chips with title, remove action, and open-file action', () => {
    const removed: string[] = [];
    const opened: string[] = [];
    const icons: string[] = [];
    const container = new FakeElement();
    const chips = new ContextChips(container as any, {
      onRemove: id => removed.push(id),
      onOpenFile: path => opened.push(path),
      setIcon: (el, icon) => {
        icons.push(icon);
        el.setAttribute('data-icon', icon);
      },
    });

    chips.update([
      { id: 'file-1', type: 'file', data: 'Folder/Note.md' },
      { id: 'img-1', type: 'image', data: 'data:image/png;base64,abc', summary: 'Pasted Image' },
      { id: 'url-1', type: 'url', data: 'https://example.com', summary: 'Example' },
      { id: 'yt-1', type: 'youtube', data: 'https://youtu.be/abc', summary: 'Video' },
      { id: 'scope-1', type: 'scope', data: '@backlinks', summary: 'Backlinks', scope: 'backlinks' } as any,
    ]);

    expect(container.children.length).toBe(5);
    expect(container.children[0].attributes.title).toBe('Folder/Note.md');
    expect(container.children[0].querySelector('.chip-label')?.textContent).toBe('Note.md');
    expect(container.children[4].querySelector('.chip-label')?.textContent).toBe('@backlinks');
    expect(icons).toEqual(['file-text', 'image', 'link', 'youtube', 'at-sign']);

    container.children[0].click();
    container.children[0].querySelector('.chip-remove')?.click();

    expect(opened).toEqual(['Folder/Note.md']);
    expect(removed).toEqual(['file-1']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
