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

async function test(name: string, fn: () => Promise<void>) {
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
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  style: Record<string, string> = {};

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

  appendChild(child: FakeElement) {
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

  click() {
    // 模拟真实 DOM 的事件冒泡:从自身沿 parentElement 向上,依次触发各级 click 监听,
    // 并携带 event.target(恒为被点击的原始节点)。这样才能正确驱动挂在祖先容器上的
    // 事件委托监听(如 outputContainer 上的 think-summary 折叠委托)。
    const event: any = { target: this, preventDefault() {} };
    let node: FakeElement | null = this;
    while (node) {
      for (const handler of node.listeners.click || []) {
        handler(event);
      }
      node = node.parentElement;
    }
  }

  closest(selector: string): FakeElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    let node: FakeElement | null = this;
    while (node) {
      if (node.hasClass(className)) return node;
      node = node.parentElement;
    }
    return null;
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

  toggleClass(name: string, enabled: boolean) {
    if (enabled) {
      this.addClass(name);
      return;
    }
    this.removeClass(name);
  }

  setCssStyles(styles: Record<string, string>) {
    Object.assign(this.style, styles);
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.findFirstByClass(className);
  }

  contains(target: FakeElement | null | undefined): boolean {
    if (!target) return false;
    if (this.children.includes(target)) return true;
    return this.children.some(child => child.contains(target));
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
  console.log('=== Command Suggestion Tests ===');
  const { buildCommandSuggestions } = await import('../src/ui/command-suggestions');

  await test('buildCommandSuggestions merges local and dynamic skill commands without duplicates', async () => {
    const suggestions = buildCommandSuggestions(
      [
        { label: '/clear', desc: 'Clear session history' },
        { label: '/save', desc: 'Old local save description' },
      ],
      [
        { command: '/save', description: 'Save webpage to vault' },
        { command: '/wiki:query', description: 'Query knowledge wiki' },
      ],
      '',
    );

    expect(suggestions).toEqual([
      { label: '/clear', desc: 'Clear session history' },
      { label: '/save', desc: 'Save webpage to vault' },
      { label: '/wiki:query', desc: 'Query knowledge wiki' },
    ]);
  });

  await test('ShellView keeps only genuinely local slash commands in its hardcoded suggestions', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    const labels = ((view as any).localCommandSuggestions as Array<{ label: string }>)
      .map(command => command.label)
      .sort();

    expect(labels.includes('/save')).toBe(false);
    expect(labels.includes('/memory')).toBe(true);
    expect(labels.includes('/profile')).toBe(false);
    expect(labels.includes('/forget')).toBe(false);
    expect(labels.includes('/file-back')).toBe(true);
    expect(labels.includes('/help')).toBe(true);
  });

  await test('ShellView suggests scoped note context entries before matching files for @ mentions', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({
      app: {
        vault: {
          getFiles: () => [
            { basename: 'Backlog', path: 'Projects/Backlog.md' },
            { basename: 'Background', path: 'Notes/Background.md' },
          ],
        },
      },
    } as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      vault: {
        getFiles: () => [
          { basename: 'Backlog', path: 'Projects/Backlog.md' },
          { basename: 'Background', path: 'Notes/Background.md' },
        ],
      },
    };
    const items = (view as any).buildSuggestionItems('file', 'bac');

    expect(items).toEqual([
      {
        label: '@backlinks',
        desc: 'Add notes linking to the current note',
        value: '@backlinks',
        source: 'scope',
        kind: 'scope',
        scope: 'backlinks',
      },
      {
        label: 'Backlog',
        desc: 'Projects/Backlog.md',
        value: 'Projects/Backlog.md',
        source: 'file',
        kind: 'file',
      },
      {
        label: 'Background',
        desc: 'Notes/Background.md',
        value: 'Notes/Background.md',
        source: 'file',
        kind: 'file',
      },
    ]);
  });

  await test('ShellView offers @current so excluded current note can be restored', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({
      app: {
        vault: {
          getFiles: () => [
            { basename: 'Current Project', path: 'Projects/Current Project.md' },
          ],
        },
      },
    } as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      vault: {
        getFiles: () => [
          { basename: 'Current Project', path: 'Projects/Current Project.md' },
        ],
      },
    };
    const items = (view as any).buildSuggestionItems('file', 'cur');

    expect(items).toEqual([
      {
        label: '@current',
        desc: 'Add the current note',
        value: '@current',
        source: 'scope',
        kind: 'scope',
        scope: 'current',
      },
      {
        label: 'Current Project',
        desc: 'Projects/Current Project.md',
        value: 'Projects/Current Project.md',
        source: 'file',
        kind: 'file',
      },
    ]);
  });

  await test('ShellView excludes current note until @current or file switch restores it', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    let activeFile = { basename: 'Center', path: 'Work/Center.md' };
    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      workspace: {
        getActiveFile: () => activeFile,
        openLinkText: () => {},
      },
    };
    (view as any).knowledgeStatusContainerEl = new FakeElement();

    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(true);
    (view as any).excludeCurrentNoteContext(activeFile.path);
    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(false);

    (view as any).excludedCurrentNotePath = null;
    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(true);

    (view as any).excludeCurrentNoteContext(activeFile.path);
    activeFile = { basename: 'Next', path: 'Work/Next.md' };
    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(true);
  });

  await test('ShellView keeps current note in the status host and renders only explicit context chips', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      workspace: {
        getActiveFile: () => ({ basename: 'Center', path: 'Work/Center.md' }),
        openLinkText: () => {},
      },
    };
    (view as any).contextManager.addContext({
      id: 'scope:backlinks',
      type: 'scope',
      data: '@backlinks',
      summary: 'Backlinks',
      scope: 'backlinks',
    });

    const container = new FakeElement();
    (view as any).renderContextChips(container as any);

    expect(container.querySelector('.context-chip-current')).toBe(null);
    expect(container.querySelector('.context-chip-scope')?.querySelector('.chip-label')?.textContent).toBe('backlinks');
  });

  await test('ShellView does not duplicate active file when it is explicitly selected', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      workspace: {
        getActiveFile: () => ({ basename: '任务看板', path: '任务看板.md' }),
        openLinkText: () => {},
      },
    };
    (view as any).knowledgeStatusPanel = {};
    (view as any).refreshKnowledgeStatusPanel = async () => {};
    (view as any).contextManager.addContext({
      id: 'file:任务看板.md',
      type: 'file',
      data: '任务看板.md',
      summary: '任务看板',
    });

    const container = new FakeElement();
    (view as any).renderContextChips(container as any);

    expect(container.querySelector('.shell-knowledge-status-host')?.hasClass('shell-knowledge-status-host')).toBe(true);
    expect(container.querySelector('.context-chip-file')).toBe(null);
  });

  await test('ShellView rerenders current note chip when active file changes', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    let activeFile = { basename: 'Home', path: 'Home.md' };
    let refreshCount = 0;
    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      workspace: {
        getActiveFile: () => activeFile,
        openLinkText: () => {},
      },
    };
    (view as any).knowledgeStatusPanel = {};
    (view as any).refreshKnowledgeStatusPanel = async () => {
      refreshCount += 1;
    };

    const container = new FakeElement();
    (view as any).renderContextChips(container as any);
    expect(container.children[0]?.hasClass('shell-knowledge-status-host')).toBe(true);

    (view as any).excludeCurrentNoteContext(activeFile.path);
    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(false);

    activeFile = { basename: 'Next', path: 'Next.md' };
    (view as any).excludedCurrentNotePath = null;
    (view as any).renderContextChips(container as any);

    expect((view as any).shouldIncludeCurrentNoteContext()).toBe(true);
    expect(container.children[0]?.hasClass('shell-knowledge-status-host')).toBe(true);
    expect(refreshCount).toBe(2);
  });

  await test('ShellView renders search and settings actions in the header', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
      getAvailableTools: () => [],
    } as any);

    const header = new FakeElement();
    (view as any).createHeaderActions(header as any);

    expect(header.querySelector('.shell-header-buttons')?.querySelector('.shell-history-btn')?.attributes['aria-label']).toBe('Search history');
    expect(header.querySelector('.shell-settings-btn')?.attributes['aria-label']).toBe('Settings');
    expect(header.querySelector('.shell-clear-btn')).toBe(null);
    expect(header.querySelector('.shell-tools-btn')).toBe(null);
  });

  await test('ShellView mounts suggestions beside the composer instead of inside the clipped input container', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
      getAvailableTools: () => [],
    } as any);

    const inputShell = new FakeElement();
    const inputContainer = inputShell.createDiv({ cls: 'shell-input-container' });
    const suggestions = (view as any).createSuggestionContainer(inputContainer as any) as FakeElement;

    expect(inputShell.contains(suggestions)).toBe(true);
    expect(inputContainer.contains(suggestions)).toBe(false);
  });

  await test('ShellView mounts current note status as the first context chip', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
      getAvailableTools: () => [],
      getProviderCapabilities: () => ({ supportsImageInput: false }),
      getAvailableModels: async () => [],
    } as any);

    (view as any).app = {
      workspace: {
        on: () => ({}),
        getActiveFile: () => ({ basename: 'Home', path: 'Home.md' }),
      },
      metadataCache: {
        on: () => ({}),
      },
    };
    (view as any).registerEvent = () => {};
    (view as any).refreshKnowledgeStatusPanel = async () => {};
    (view as any).tabManager.createTab();
    const root = new FakeElement();
    (view as any).createShellScaffold(root as any);

    const inputContextBar = root.querySelector('.shell-input-context-bar');
    const statusHost = root.querySelector('.shell-knowledge-status-host');
    const contextChips = root.querySelector('.shell-context-chips');
    const inputContainer = root.querySelector('.shell-input-container');

    expect(inputContextBar?.contains(statusHost as any)).toBe(true);
    expect(contextChips?.contains(statusHost as any)).toBe(true);
    expect(contextChips?.children[0]?.hasClass('shell-knowledge-status-host')).toBe(true);
    expect(inputContainer?.querySelector('.shell-input-top-actions')).toBe(null);
    expect(root.querySelector('.shell-input-shell')?.querySelector('.shell-input-top-actions')).toBe(null);
  });

  await test('ShellView keeps completed thinking summary expandable after stream cleanup', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);
    const output = new FakeElement();
    (globalThis as any).document = {
      createElement: () => new FakeElement(),
      getElementById: () => null,
    };
    (view as any).outputContainer = output;
    // 折叠交互经 outputContainer 事件委托,由 ensureStreamContainer→ensureTimelineDelegation
    // 幂等绑定(不依赖 onOpen 完整走过)。FakeElement.click 会沿 parentElement 冒泡并带 target,
    // 故此处无需手挂监听——若手挂会与生产委托双重触发,toggle 两次相互抵消。
    (view as any).getMessageRenderer = () => ({
      renderAiContent: async () => undefined,
      addActionToolbar: () => undefined,
    });
    (view as any).persistActiveTab = async () => undefined;

    (view as any).ensureStreamContainer();
    const timeline = output.querySelector('.shell-think-timeline')!;
    const summary = timeline.querySelector('.shell-think-summary')!;
    (view as any).streamNodeCount = 1;

    (view as any).finalizeStream();
    expect(timeline.hasClass('is-collapsed')).toBe(true);
    expect(summary.attributes['aria-expanded']).toBe('false');

    summary.click();

    expect(timeline.hasClass('is-collapsed')).toBe(false);
    expect(summary.attributes['aria-expanded']).toBe('true');
  });

  await test('ShellView helper actions add related context and prepare edit input', async () => {
    const { ShellView } = await import('../src/ui/shell-view');

    const settingCalls: string[] = [];
    const view = new ShellView({} as any, {
      getSkillCommands: () => [],
    } as any);

    (view as any).app = {
      setting: {
        open: () => settingCalls.push('open'),
        openTabById: (id: string) => settingCalls.push(id),
      },
    };
    (view as any).outputContainer = { parentElement: null };

    (view as any).addBacklinksScopeContext();

    expect((view as any).contextManager.getContexts()).toEqual([{
      id: 'scope:backlinks',
      type: 'scope',
      data: '@backlinks',
      summary: 'Add notes linking to the current note',
      scope: 'backlinks',
    }]);

    const input = {
      value: '',
      style: {} as Record<string, string>,
      scrollHeight: 42,
      selectionStart: 0,
      selectionEnd: 0,
      focused: false,
      focus() {
        this.focused = true;
      },
      setCssStyles(styles: Record<string, string>) {
        Object.assign(this.style, styles);
      },
    };
    (view as any).inputEl = input;

    (view as any).prepareSelectionEdit();

    expect(input.value).toBe('/edit ');
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);
    expect(input.focused).toBe(true);
    expect(input.style.height).toBe('42px');

    (view as any).openPluginSettings();

    expect(settingCalls).toEqual(['open', 'baizer']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
