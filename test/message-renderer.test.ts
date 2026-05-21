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
  innerHTML = '';
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  classList = {
    values: new Set<string>(),
    add: (name: string) => {
      this.classList.values.add(name);
      this.syncClassName();
    },
    remove: (name: string) => {
      this.classList.values.delete(name);
      this.syncClassName();
    },
    contains: (name: string) => this.classList.values.has(name),
    [Symbol.iterator]: () => this.classList.values[Symbol.iterator](),
  };

  constructor(public tagName = 'div') { }

  createDiv(attr?: any) {
    return this.createEl('div', attr);
  }

  createSpan(attr?: any) {
    return this.createEl('span', attr);
  }

  createEl(tag: string, attr?: any) {
    const child = new FakeElement(tag);
    child.className = attr?.cls || '';
    for (const part of child.className.split(' ').filter(Boolean)) {
      child.classList.values.add(part);
    }
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

  setText(text: string) {
    this.textContent = text;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  addClass(name: string) {
    this.classList.add(name);
  }

  empty() {
    this.children = [];
    this.textContent = '';
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
  }

  insertBefore(child: FakeElement, reference: FakeElement) {
    child.parentElement = this;
    const index = this.children.indexOf(reference);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) {
      handler({ preventDefault: () => { } });
    }
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === 'pre > code') {
      return this.findAll((item) => item.tagName === 'code' && item.parentElement?.tagName === 'pre');
    }
    if (selector === 'a.internal-link') {
      return this.findAll((item) => item.tagName === 'a' && item.hasClass('internal-link'));
    }
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.findAll((item) => item.hasClass(className));
    }
    return [];
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name) || this.classList.values.has(name);
  }

  private findAll(predicate: (item: FakeElement) => boolean): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) matches.push(child);
      matches.push(...child.findAll(predicate));
    }
    return matches;
  }

  private syncClassName() {
    this.className = Array.from(this.classList.values).join(' ');
  }
}

async function runTests() {
  console.log('=== Message Renderer Tests ===');
  const { MessageRenderer } = await import('../src/ui/renderers/message-renderer');
  const { CodeBlockRenderer } = await import('../src/ui/renderers/code-block-renderer');

  await test('renders user and system messages as shell entries', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({ app: {}, component: {} });

    await renderer.renderMessage(container as any, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    });
    await renderer.renderMessage(container as any, {
      id: 's1',
      role: 'system',
      content: 'ready',
      timestamp: 2,
    });

    expect(container.children[0].className).toContain('shell-entry user');
    expect(container.children[0].textContent).toBe('hello');
    expect(container.children[1].className).toContain('shell-entry system');
    expect(container.children[1].textContent).toBe('[System] ready');
  });

  await test('renders cancelled system messages as low-emphasis status chips', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({ app: {}, component: {} });

    await renderer.renderMessage(container as any, {
      id: 'cancel-1',
      role: 'system',
      content: 'Cancelled: AI开发指南.md',
      timestamp: 2,
    });

    expect(container.children[0].className).toContain('shell-system-cancelled');
    expect(container.children[0].textContent).toBe('[System] Cancelled: AI开发指南.md');
  });

  await test('renders assistant markdown and creates an action toolbar', async () => {
    const container = new FakeElement();
    const rendered: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app, markdown, el) => {
        rendered.push(markdown);
        el.createDiv({ cls: 'rendered-markdown', text: markdown.toUpperCase() });
      },
    });

    await renderer.renderMessage(container as any, {
      id: 'a1',
      role: 'ai',
      content: '**hi**',
      timestamp: 3,
    });

    expect(rendered).toEqual(['**hi**']);
    expect(!!container.querySelector('.shell-message-actions')).toBe(true);
    expect(!!container.querySelector('.shell-copy-btn')).toBe(true);
    expect(container.querySelector('.shell-thumbs-up')?.getAttribute('title')).toBe('Useful');
    expect(!!container.querySelector('.shell-archive-btn')).toBe(false);
  });

  await test('feedback buttons can be clicked without referencing missing controls', async () => {
    const container = new FakeElement();
    const feedback: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app, markdown, el) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackUp: async () => { feedback.push('up'); },
      onFeedbackDown: async () => { feedback.push('down'); },
    });

    await renderer.renderMessage(container as any, {
      id: 'a-feedback',
      role: 'ai',
      content: 'answer',
      timestamp: 5,
    });

    container.querySelector('.shell-thumbs-up')?.click();
    container.querySelector('.shell-thumbs-down')?.click();

    expect(feedback).toEqual(['up', 'down']);
    expect(container.querySelector('.shell-thumbs-up')?.hasClass('active')).toBe(false);
    expect(container.querySelector('.shell-thumbs-down')?.hasClass('active')).toBe(true);
  });

  await test('renders approval cards and delegates approve and cancel callbacks', async () => {
    const container = new FakeElement();
    const calls: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      onApprove: async () => { calls.push('approve'); },
      onCancel: () => { calls.push('cancel'); },
      onFocusApprovalPreview: () => { calls.push('focus'); },
    });

    await renderer.renderMessage(container as any, {
      id: 'approval-1',
      role: 'system',
      content: 'approval',
      timestamp: 4,
      approval: {
        action: 'create_note',
        target: 'Clippings/example.md',
        args: {},
        message: 'Create note?',
        preview: {
          kind: 'note-create',
          target: 'Clippings/example.md',
          summary: 'Create note',
          preconditions: ['Folder exists'],
          risk: 'medium',
          supportsPartialApply: false,
          undoable: true,
        },
      },
    });

    const approveButton = container.querySelector('.shell-approval-confirm');
    const cancelButton = container.querySelector('.shell-approval-cancel');
    const focusButton = container.querySelector('.shell-approval-focus-preview');
    const approvalEntry = container.querySelector('.shell-approval-entry');
    const approvalAvatar = container.querySelector('.shell-approval-avatar');
    const previewTarget = container.querySelector('.shell-change-preview-target');
    focusButton?.click();
    approveButton?.click();
    cancelButton?.click();

    expect(calls).toEqual(['focus', 'approve']);
    expect(!!container.querySelector('.shell-approval-card')).toBe(false);
    expect(!!approvalEntry).toBe(true);
    expect(approvalAvatar?.textContent).toBe('AI');
    expect(previewTarget?.textContent).toBe('Clippings/example.md');
  });

  await test('code block renderer adds review headers and keeps review callback', () => {
    const container = new FakeElement();
    const pre = container.createEl('pre');
    const code = pre.createEl('code');
    code.classList.add('language-ts');
    code.textContent = 'const answer = 42;';
    const reviewed: string[] = [];

    new CodeBlockRenderer({
      onReviewCodeBlock: async (content) => { reviewed.push(content); },
    }).process(container as any);

    const header = container.querySelector('.shell-code-block-header');
    const filename = container.querySelector('.shell-code-block-filename');
    const reviewButton = container.querySelector('.shell-apply-btn');

    expect(!!header).toBe(true);
    expect(filename?.textContent).toBe('untitled.ts');
    reviewButton?.click();
    expect(reviewed).toEqual(['const answer = 42;']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
