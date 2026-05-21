function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
  };
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
    if (!this.hasClass(name)) {
      this.className = `${this.className} ${name}`.trim();
    }
  }

  removeClass(name: string) {
    this.className = this.className
      .split(' ')
      .filter(part => part && part !== name)
      .join(' ');
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

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Thinking Renderer Tests ===');
  const { ThinkingRenderer } = await import('../src/ui/renderers/thinking-renderer');

  await test('appendThinking creates an accessible thinking block with a timer label', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => 1000 });

    renderer.appendThinking('This is a very long thought message for testing label truncation.');

    const block = timeline.querySelector('.ocli-thinking-block');
    const header = timeline.querySelector('.ocli-thinking-header');
    const label = timeline.querySelector('.ocli-thinking-label');
    const timer = timeline.querySelector('.ocli-thinking-timer');
    const content = timeline.querySelector('.ocli-thinking-content');

    expect(!!block).toBe(true);
    expect(header?.attributes.role).toBe('button');
    expect(header?.attributes.tabindex).toBe('0');
    expect(header?.attributes['aria-expanded']).toBe('true');
    expect(label?.textContent.endsWith('...')).toBe(true);
    expect(timer?.textContent).toBe('0s');
    expect(content?.textContent).toContain('very long thought');
  });

  await test('click and keyboard toggle collapsed state', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => 1000 });

    renderer.appendThinking('checking context');

    const block = timeline.querySelector('.ocli-thinking-block')!;
    const header = timeline.querySelector('.ocli-thinking-header')!;

    header.click();
    expect(block.hasClass('is-collapsed')).toBe(true);
    expect(header.attributes['aria-expanded']).toBe('false');

    header.keydown('Enter');
    expect(block.hasClass('is-collapsed')).toBe(false);
    expect(header.attributes['aria-expanded']).toBe('true');

    header.keydown(' ');
    expect(block.hasClass('is-collapsed')).toBe(true);
    expect(header.attributes['aria-expanded']).toBe('false');
  });

  await test('finalizeCurrentThinking marks the block complete with a final duration label', () => {
    let now = 1000;
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => now });

    renderer.appendThinking('done soon');
    now = 3600;
    renderer.finalizeCurrentThinking();

    const block = timeline.querySelector('.ocli-thinking-block')!;
    const label = timeline.querySelector('.ocli-thinking-label')!;

    expect(block.hasClass('is-thinking')).toBe(false);
    expect(block.hasClass('is-complete')).toBe(true);
    expect(label.textContent).toBe('Thought for 2s');
  });

  await test('completed thinking blocks remain individually expandable', () => {
    let now = 1000;
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => now });

    renderer.appendThinking('first detail');
    now = 2500;
    renderer.finalizeCurrentThinking();
    const firstBlock = timeline.querySelector('.ocli-thinking-block')!;
    const firstHeader = timeline.querySelector('.ocli-thinking-header')!;

    firstHeader.click();
    expect(firstBlock.hasClass('is-collapsed')).toBe(true);
    expect(firstHeader.attributes['aria-expanded']).toBe('false');

    firstHeader.click();
    expect(firstBlock.hasClass('is-collapsed')).toBe(false);
    expect(firstHeader.attributes['aria-expanded']).toBe('true');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
