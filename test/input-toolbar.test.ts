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
  value = '';
  disabled = false;
  selected = false;
  selectedIndex = 0;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};

  get options() {
    return this.children;
  }

  createDiv(attr?: any) {
    return this.createEl('div', attr);
  }

  createEl(_tag: string, attr?: any) {
    const child = new FakeElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    child.value = attr?.value || '';
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

  change() {
    for (const handler of this.listeners.change || []) {
      handler({ target: this });
    }
  }

  click() {
    for (const handler of this.listeners.click || []) {
      handler({ target: this });
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
  console.log('=== Input Toolbar Tests ===');
  const { InputToolbar } = await import('../src/ui/components/input-toolbar');

  await test('renders provider selector and calls provider change callback', () => {
    const changes: string[] = [];
    const unavailable: string[] = [];
    const root = new FakeElement();
    const toolbar = new InputToolbar(root as any, {
      onProviderChange: id => changes.push(id),
      onUnavailableProvider: id => unavailable.push(id),
      onModelChange: () => { },
    });

    toolbar.updateProviders([
      { id: 'gemini', label: 'Gemini', configured: true },
      { id: 'openai', label: 'OpenAI', configured: true },
    ], 'gemini');

    const select = toolbar.getProviderSelectEl() as any as FakeElement;
    expect(select.children.map(option => option.textContent)).toEqual(['Gemini', 'OpenAI']);

    select.value = 'openai';
    select.change();

    expect(changes).toEqual(['openai']);
    expect(unavailable).toEqual([]);
  });

  await test('calls unavailable provider callback and restores active selection', () => {
    const unavailable: string[] = [];
    const root = new FakeElement();
    const toolbar = new InputToolbar(root as any, {
      onProviderChange: () => { throw new Error('should not switch unavailable provider'); },
      onUnavailableProvider: id => unavailable.push(id),
      onModelChange: () => { },
    });

    toolbar.updateProviders([
      { id: 'gemini', label: 'Gemini', configured: true },
      { id: 'openai', label: 'OpenAI', configured: false },
    ], 'gemini');

    const select = toolbar.getProviderSelectEl() as any as FakeElement;
    select.value = 'openai';
    select.change();

    expect(unavailable).toEqual(['openai']);
    expect(select.value).toBe('gemini');
  });

  await test('renders model loading state and model change callback', () => {
    const modelChanges: string[] = [];
    const root = new FakeElement();
    const toolbar = new InputToolbar(root as any, {
      onProviderChange: () => { },
      onUnavailableProvider: () => { },
      onModelChange: id => modelChanges.push(id),
    });

    toolbar.updateModels({ loading: true, providerLabel: 'Gemini', models: [], activeModelId: '' });
    let modelSelect = toolbar.getModelSelectEl() as any as FakeElement;
    expect(modelSelect.disabled).toBe(true);
    expect(modelSelect.children[0].textContent).toBe('Loading Gemini models...');

    toolbar.updateModels({
      loading: false,
      providerLabel: 'Gemini',
      models: [{ value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
      activeModelId: 'gemini-2.5-flash',
    });
    modelSelect = toolbar.getModelSelectEl() as any as FakeElement;
    modelSelect.value = 'gemini-2.5-flash';
    modelSelect.selectedIndex = 0;
    modelSelect.change();

    expect(modelSelect.disabled).toBe(false);
    expect(modelChanges).toEqual(['gemini-2.5-flash']);
  });

  await test('disables image and stop buttons when unsupported', () => {
    const root = new FakeElement();
    const toolbar = new InputToolbar(root as any, {
      onProviderChange: () => { },
      onUnavailableProvider: () => { },
      onModelChange: () => { },
    });

    toolbar.updateCapabilities({ supportsImageInput: false, supportsCancellation: false });

    expect((root.querySelector('.shell-image-btn') as any).disabled).toBe(true);
    expect((root.querySelector('.shell-stop-btn') as any).disabled).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
