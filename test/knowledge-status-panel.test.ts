import { App, TFile } from 'obsidian';

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

  constructor(public tagName = 'div') {}

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

  parentElement: FakeElement | null = null;

  empty() {
    this.children = [];
    this.textContent = '';
  }

  setText(text: string) {
    this.textContent = text;
  }

  addClass(name: string) {
    this.classList.add(name);
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) {
      handler({ preventDefault: () => {} });
    }
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name) || this.classList.values.has(name);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) {
      return [];
    }
    const className = selector.slice(1);
    return this.findAll((item) => item.hasClass(className));
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

function createFile(path: string) {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = 'md';
  return file;
}

function collectText(node: FakeElement): string[] {
  const result: string[] = [];
  if (node.textContent) {
    result.push(node.textContent);
  }
  for (const child of node.children) {
    result.push(...collectText(child));
  }
  return result;
}

console.log('=== Knowledge Status Panel Tests ===');

async function runTests() {
  const { KnowledgeStatusPanel } = await import('../src/ui/components/knowledge-status-panel');

  await test('renders a concise failed summary without raw diagnostics or global counters', async () => {
    const activeFile = createFile('Assets/网页剪藏/Windows.md');
    const container = new FakeElement();
    const panel = new KnowledgeStatusPanel(container as any, {
      app: {
        workspace: {
          getActiveFile: () => activeFile,
        },
        metadataCache: {
          getBacklinksForFile: () => new Map([['Projects/A.md', {}]]),
        },
        commands: {
          executeCommandById: () => {},
        },
      } as unknown as App,
      plugin: {
        knowledgeRuntime: {
          getStatusService: () => ({
            getNoteStatus: async () => ({
              path: activeFile.path,
              state: 'failed',
              summaryPath: 'Knowledge Wiki/Windows.md',
              compiledAt: '2026-05-13T10:00:00Z',
              error: '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent: [429 ] You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests',
            }),
            getGlobalCounts: async () => ({
              pending: 2,
              stale: 0,
              failed: 242,
            }),
          }),
          compileByPath: async () => ({ success: 1, failed: 0 }),
        },
      },
    });

    await panel.refresh();

    const text = collectText(container).join(' | ');
    expect(container.querySelector('.shell-knowledge-status-badge')?.textContent).toBe('failed');
    expect(text).toContain('Failed: quota exceeded');
    expect(text.includes('https://generativelanguage.googleapis.com')).toBe(false);
    expect(text.includes('Backlinks')).toBe(false);
    expect(text.includes('Pending 2')).toBe(false);
    expect(text.includes('Knowledge Wiki/Windows.md')).toBe(false);
  });
}

void runTests();
