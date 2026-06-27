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

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    const out: FakeElement[] = [];
    this.collectByClass(className, out);
    return out;
  }

  private collectByClass(className: string, out: FakeElement[]) {
    for (const child of this.children) {
      if (child.hasClass(className)) out.push(child);
      child.collectByClass(className, out);
    }
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
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => 1000,
      setInterval: () => 0,
      clearInterval: () => { /* no-op */ },
    });

    renderer.appendThinking('This is a very long thought message for testing label truncation.');

    const block = timeline.querySelector('.baizer-thinking-block');
    const header = timeline.querySelector('.baizer-thinking-header');
    const label = timeline.querySelector('.baizer-thinking-label');
    const timer = timeline.querySelector('.baizer-thinking-timer');
    const content = timeline.querySelector('.baizer-thinking-content');

    expect(!!block).toBe(true);
    expect(header?.attributes.role).toBe('button');
    expect(header?.attributes.tabindex).toBe('0');
    expect(header?.attributes['aria-expanded']).toBe('true');
    expect(label?.textContent.endsWith('...')).toBe(true);
    expect(timer?.textContent).toBe('0s');
    expect(content?.textContent).toContain('very long thought');
  });

  await test('blank-line boundaries split thinking into separate collapsible segments', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => 1000,
      setInterval: () => 0,
      clearInterval: () => { /* no-op */ },
    });

    // 两段完整段落 + 一段正在写的残留:应得到 3 个节点。
    renderer.appendThinking('First step: analyze the request.\n\nSecond step: plan the work.\n\nThird');

    const blocks = timeline.querySelectorAll('.baizer-thinking-block');
    expect(blocks.length).toBe(3);

    // 前两段为已完成、默认折叠;最后一段为活动、展开。
    expect(blocks[0].hasClass('is-complete')).toBe(true);
    expect(blocks[0].hasClass('is-collapsed')).toBe(true);
    expect(blocks[1].hasClass('is-complete')).toBe(true);
    expect(blocks[2].hasClass('is-thinking')).toBe(true);
    expect(blocks[2].hasClass('is-collapsed')).toBe(false);

    // 标题取各段首行摘要。
    const labels = timeline.querySelectorAll('.baizer-thinking-label');
    expect(labels[0].textContent).toContain('First step');
    expect(labels[1].textContent).toContain('Second step');
    expect(labels[2].textContent).toContain('Third');

    // getNodeCount 反映分段数,供外层「Thought through N steps」摘要使用。
    expect(renderer.getNodeCount()).toBe(3);
  });

  await test('only the active segment carries the live timer', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => 1000,
      setInterval: () => 0,
      clearInterval: () => { /* no-op */ },
    });

    renderer.appendThinking('done paragraph.\n\nstreaming paragraph');

    // 已完成段落不带计时 span;只有活动段落带。
    const timers = timeline.querySelectorAll('.baizer-thinking-timer');
    expect(timers.length).toBe(1);
  });

  await test('click and keyboard toggle collapsed state', () => {
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => 1000,
      setInterval: () => 0,
      clearInterval: () => { /* no-op */ },
    });

    renderer.appendThinking('checking context');

    const block = timeline.querySelector('.baizer-thinking-block')!;
    const header = timeline.querySelector('.baizer-thinking-header')!;

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

  await test('finalizeCurrentThinking marks the final segment complete with a total duration', () => {
    let now = 1000;
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => now });

    renderer.appendThinking('done soon');
    now = 3600;
    renderer.finalizeCurrentThinking();

    const block = timeline.querySelector('.baizer-thinking-block')!;
    const timer = timeline.querySelector('.baizer-thinking-timer')!;

    expect(block.hasClass('is-thinking')).toBe(false);
    expect(block.hasClass('is-complete')).toBe(true);
    expect(timer.textContent).toBe('2s');
  });

  await test('completed thinking segments remain individually expandable', () => {
    let now = 1000;
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, { now: () => now });

    renderer.appendThinking('first detail');
    now = 2500;
    renderer.finalizeCurrentThinking();
    const firstBlock = timeline.querySelector('.baizer-thinking-block')!;
    const firstHeader = timeline.querySelector('.baizer-thinking-header')!;

    // finalize 后该段为完成态,且保持可折叠/展开。
    expect(firstBlock.hasClass('is-complete')).toBe(true);

    const collapsedBefore = firstBlock.hasClass('is-collapsed');
    firstHeader.click();
    expect(firstBlock.hasClass('is-collapsed')).toBe(!collapsedBefore);
    expect(firstHeader.attributes['aria-expanded']).toBe(String(collapsedBefore));

    firstHeader.click();
    expect(firstBlock.hasClass('is-collapsed')).toBe(collapsedBefore);
    expect(firstHeader.attributes['aria-expanded']).toBe(String(!collapsedBefore));
  });

  await test('timer keeps advancing during model silence (interval-driven)', () => {
    let now = 1000;
    const ticks: Array<() => void> = [];
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => now,
      setInterval: (handler: () => void) => {
        ticks.push(handler);
        return ticks.length; // 句柄即索引,便于断言清除
      },
      clearInterval: () => { /* no-op for test */ },
    });

    renderer.appendThinking('starting to think');
    const timer = timeline.querySelector('.baizer-thinking-timer')!;
    expect(timer.textContent).toBe('0s');

    // 没有新的 appendThinking(模型静默),仅靠定时器驱动:推进时钟并触发 tick。
    now = 4000;
    ticks.forEach(tick => tick());
    expect(timer.textContent).toBe('3s');

    now = 9000;
    ticks.forEach(tick => tick());
    expect(timer.textContent).toBe('8s');
  });

  await test('finalize clears the interval so no further ticks mutate the block', () => {
    let now = 1000;
    let cleared = false;
    const ticks: Array<() => void> = [];
    const timeline = new FakeElement();
    const renderer = new ThinkingRenderer(timeline as any, {
      now: () => now,
      setInterval: (handler: () => void) => {
        ticks.push(handler);
        return ticks.length;
      },
      clearInterval: () => { cleared = true; },
    });

    renderer.appendThinking('thinking');
    now = 3000;
    renderer.finalizeCurrentThinking();

    expect(cleared).toBe(true);
    const timer = timeline.querySelector('.baizer-thinking-timer')!;
    expect(timer.textContent).toBe('2s');

    // finalize 后即使旧 tick 再被触发,也不应改写已完成块。
    now = 99000;
    ticks.forEach(tick => tick());
    expect(timer.textContent).toBe('2s');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
