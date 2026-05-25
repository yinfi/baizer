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
  dataset: Record<string, string> = {};
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

  keydown(key: string) {
    const event = { key, preventDefault: () => { } };
    for (const handler of this.listeners.keydown || []) {
      handler(event);
    }
  }

  addClass(name: string) {
    if (!this.hasClass(name)) this.className = `${this.className} ${name}`.trim();
  }

  removeClass(name: string) {
    this.className = this.className.split(' ').filter(part => part && part !== name).join(' ');
  }

  toggleClass(name: string, enabled: boolean) {
    if (enabled) this.addClass(name);
    else this.removeClass(name);
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return [];
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
  console.log('=== Workbench Tool Renderer Tests ===');
  const { ToolRenderer, getToolStatus, getToolSummary } = await import('../src/ui/renderers/tool-renderer');

  await test('summarizes common tool families before raw JSON details', () => {
    expect(getToolSummary('read_file', { path: 'Notes/a.md' })).toBe('Read: a.md');
    expect(getToolSummary('write_file', { path: 'Notes/a.md' })).toBe('Write: a.md');
    expect(getToolSummary('edit_file', { path: 'Notes/a.md' })).toBe('Edit: a.md');
    expect(getToolSummary('web_search', { query: 'Obsidian plugins' })).toBe('Search: Obsidian plugins');
    expect(getToolSummary('query_knowledge', { query: 'AI notes' })).toBe('Knowledge: AI notes');
    expect(getToolSummary('plugin-obsidian-tasks', { command: 'list' })).toBe('Plugin: plugin-obsidian-tasks');
    expect(getToolSummary('custom_tool', { foo: 'bar' })).toBe('custom_tool');
  });

  await test('maps result and error status labels', () => {
    expect(getToolStatus({ ok: true })).toBe('Completed');
    expect(getToolStatus(undefined, 'failed')).toBe('Error');
  });

  await test('renders a collapsed workbench tool row and updates completion state', () => {
    const timeline = new FakeElement();
    const updates: any[] = [];
    const renderer = new ToolRenderer(timeline as any, {
      onToolUpdate: (run) => updates.push(run),
    });

    renderer.addToolCall('read_file', { path: 'Notes/a.md' });

    const node = timeline.querySelector('.baizer-tool-call')!;
    const header = timeline.querySelector('.baizer-tool-header')!;
    const label = timeline.querySelector('.baizer-tool-label')!;
    const status = timeline.querySelector('.baizer-tool-status')!;
    const detail = timeline.querySelector('.baizer-tool-detail')!;

    expect(header.attributes.role).toBe('button');
    expect(header.attributes.tabindex).toBe('0');
    expect(header.attributes['aria-expanded']).toBe('false');
    expect(label.textContent).toBe('Read: a.md');
    expect(status.textContent).toBe('Running');
    expect(detail.textContent).toContain('"path": "Notes/a.md"');

    header.click();
    expect(node.hasClass('is-expanded')).toBe(true);
    expect(header.attributes['aria-expanded']).toBe('true');

    renderer.updateToolResult('read_file', { content: '# A' });

    expect(node.hasClass('is-complete')).toBe(true);
    expect(status.textContent).toBe('Completed');
    expect(detail.textContent).toContain('--- Result ---');
    expect(updates.map(update => update.status)).toEqual(['running', 'completed']);
  });

  await test('renders error results with details kept in the collapsible body', () => {
    const timeline = new FakeElement();
    const renderer = new ToolRenderer(timeline as any);

    renderer.addToolCall('web_search', { query: 'bad query' });
    renderer.updateToolResult('web_search', undefined, 'network failed');

    const node = timeline.querySelector('.baizer-tool-call')!;
    const status = timeline.querySelector('.baizer-tool-status')!;
    const detail = timeline.querySelector('.baizer-tool-detail')!;

    expect(node.hasClass('is-error')).toBe(true);
    expect(status.textContent).toBe('Error');
    expect(detail.textContent).toContain('Error: network failed');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
