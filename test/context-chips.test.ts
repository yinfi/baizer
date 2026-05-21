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
  parentElement: FakeElement | null = null;
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
    child.parentElement = this;
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

  addClass(name: string) {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    classes.add(name);
    this.className = Array.from(classes).join(' ');
  }

  removeClass(name: string) {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    classes.delete(name);
    this.className = Array.from(classes).join(' ');
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
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

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    return this.findAllByClass(className);
  }

  private findFirstByClass(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.hasClass(className)) return child;
      const nested = child.findFirstByClass(className);
      if (nested) return nested;
    }
    return null;
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
  console.log('=== Context Chips Tests ===');
  const { ContextChips, getContextChipLabel, getContextIconName } = await import('../src/ui/components/context-chips');

  await test('derives filename-first labels and icon names for context types', () => {
    expect(getContextChipLabel({ id: '1', type: 'file', data: 'Folder/Note.md' })).toBe('Note.md');
    expect(getContextChipLabel({ id: '2', type: 'url', data: 'https://example.com/a', summary: 'Example' })).toBe('Example');
    expect(getContextChipLabel({ id: '3', type: 'scope', data: '@current', summary: 'Current note', scope: 'current' } as any)).toBe('current');
    expect(getContextChipLabel({ id: '4', type: 'scope', data: '@backlinks', summary: 'Backlinks', scope: 'backlinks' } as any)).toBe('backlinks');
    expect(getContextChipLabel({ id: '5', type: 'scope', data: '@tag:project', summary: 'Project tag', scope: 'tag', tag: 'project' } as any)).toBe('tag:project');
    expect(getContextIconName('file')).toBe('file-text');
    expect(getContextIconName('image')).toBe('image');
    expect(getContextIconName('url')).toBe('link');
    expect(getContextIconName('youtube')).toBe('youtube');
    expect(getContextIconName('scope' as any)).toBe('at-sign');
  });

  await test('renders chips with title, remove action, and file action popover', () => {
    const removed: string[] = [];
    const opened: string[] = [];
    const compiled: string[] = [];
    const related: string[] = [];
    const summary: string[] = [];
    const lint: string[] = [];
    const copied: string[] = [];
    const settings: string[] = [];
    const icons: string[] = [];
    const container = new FakeElement();
    const chips = new ContextChips(container as any, {
      onRemove: id => removed.push(id),
      onOpenFile: path => opened.push(path),
      onCompileFile: path => compiled.push(path),
      onAddRelatedContext: path => related.push(path),
      onOpenSummary: path => summary.push(path),
      onRunLint: path => lint.push(path),
      onCopyPath: path => copied.push(path),
      onOpenSettings: () => settings.push('settings'),
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
    expect(container.children[4].querySelector('.chip-label')?.textContent).toBe('backlinks');
    expect(container.children[0].hasClass('context-chip-file')).toBe(true);
    expect(container.children[4].hasClass('context-chip-scope')).toBe(true);
    expect(icons).toEqual(['file-text', 'image', 'link', 'youtube', 'at-sign']);

    container.children[0].click();
    expect(container.children[0].hasClass('is-action-open')).toBe(true);
    container.children[0].click();
    expect(container.children[0].hasClass('is-action-open')).toBe(false);
    container.children[0].click();
    const fileActions = container.children[0].querySelectorAll('.context-chip-icon-action');
    expect(fileActions.map(action => action.attributes.title)).toEqual([
      'Open file',
      'Compile note',
      'Add backlinks',
      'Open wiki summary',
      'Run knowledge lint',
      'Copy note path',
      'Settings',
    ]);
    fileActions[0].click();
    fileActions[1].click();
    fileActions[2].click();
    fileActions[3].click();
    fileActions[4].click();
    fileActions[5].click();
    fileActions[6].click();
    container.children[0].querySelector('.chip-remove')?.click();

    expect(opened).toEqual(['Folder/Note.md']);
    expect(compiled).toEqual(['Folder/Note.md']);
    expect(related).toEqual(['Folder/Note.md']);
    expect(summary).toEqual(['Folder/Note.md']);
    expect(lint).toEqual(['Folder/Note.md']);
    expect(copied).toEqual(['Folder/Note.md']);
    expect(settings).toEqual(['settings']);
    expect(removed).toEqual(['file-1']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
