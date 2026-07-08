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
  value = '';
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
    if (attr?.value !== undefined) child.value = String(attr.value);
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

  keydown(key: string) {
    for (const handler of this.listeners.keydown || []) {
      handler({ key, preventDefault: () => { } });
    }
  }

  focus() {
    return;
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
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
  // i18n 引入后,t() 在中文机器 locale 下会把 [System] 等译成中文。这些是消息渲染的
  // 结构性断言,与语言无关,固定英文 locale 以保证在任意机器上确定性通过。
  const { setLocaleForTesting } = await import('../src/i18n/zh');
  setLocaleForTesting(false);
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

  await test('renders updated system messages as compact status rows', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({ app: {}, component: {} });

    await renderer.renderMessage(container as any, {
      id: 's-update',
      role: 'system',
      content: '✅ Updated: Study/财经理论入门课程/01_course_materials/02_supply_demand_price.md',
      timestamp: 2,
    });

    const entry = container.children[0];
    const action = entry.querySelector('.shell-system-status-action');
    const target = entry.querySelector('.shell-system-status-target');

    expect(entry.className).toContain('shell-system-status');
    expect(!!entry.querySelector('.shell-system-status-icon')).toBe(true);
    expect(action?.textContent).toBe('Updated');
    expect(target?.textContent).toBe('02_supply_demand_price.md');
    expect(target?.getAttribute('title')).toBe('Study/财经理论入门课程/01_course_materials/02_supply_demand_price.md');
  });

  await test('renders workspace edit messages as one inline row with undo', async () => {
    const container = new FakeElement();
    const undone: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      onUndoWorkspaceEdit: (editId: string) => { undone.push(editId); },
    } as any);

    await renderer.renderMessage(container as any, {
      id: 'workspace-edit-edit-1',
      role: 'system',
      content: '',
      timestamp: 2,
      metadata: {
        workspaceEdit: {
          id: 'edit-1',
          action: 'update_file',
          path: 'Notes/规范驱动开发（SDD）.md',
          kind: 'update',
          appliedAt: 2,
          status: 'applied',
          lineDelta: 28,
        },
      },
    } as any);

    const entry = container.children[0];
    const name = entry.querySelector('.shell-workspace-edit-name');
    const meta = entry.querySelector('.shell-workspace-edit-meta');
    const undoButton = entry.querySelector('.shell-workspace-edit-undo');

    expect(entry.className).toContain('shell-workspace-edit-entry');
    expect(entry.querySelector('.shell-workspace-edit-bullet')?.textContent).toBe('\u2022');
    expect(name?.textContent).toBe('规范驱动开发（SDD）.md');
    expect(name?.getAttribute('title')).toBe('Notes/规范驱动开发（SDD）.md');
    expect(meta?.textContent).toBe('+28 lines');
    expect(undoButton?.getAttribute('data-icon')).toBe('undo-2');

    undoButton?.click();
    expect(undone).toEqual(['edit-1']);
  });

  await test('renders undone workspace edit rows without an active undo control', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({ app: {}, component: {} });

    await renderer.renderMessage(container as any, {
      id: 'workspace-edit-edit-1',
      role: 'system',
      content: '',
      timestamp: 2,
      metadata: {
        workspaceEdit: {
          id: 'edit-1',
          action: 'update_file',
          path: 'Notes/source.md',
          kind: 'update',
          appliedAt: 2,
          status: 'undone',
          lineDelta: 3,
        },
      },
    } as any);

    const entry = container.children[0];
    expect(entry.className).toContain('is-undone');
    expect(entry.querySelector('.shell-workspace-edit-meta')?.textContent).toBe('undone');
    expect(!!entry.querySelector('.shell-workspace-edit-undo')).toBe(false);
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
    // 未接入反馈通路时只有复制按钮,不出现点赞/点踩(避免死按钮)。
    expect(!!container.querySelector('.shell-thumbs-up')).toBe(false);
    expect(!!container.querySelector('.shell-thumbs-down')).toBe(false);
  });

  await test('renders thumbs-up only when feedback-up handler is provided', async () => {
    const container = new FakeElement();
    const approved: string[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app, markdown, el) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackUp: async () => { approved.push('up'); },
    });

    await renderer.renderMessage(container as any, {
      id: 'a-up',
      role: 'ai',
      content: 'answer',
      timestamp: 5,
    });

    const upBtn = container.querySelector('.shell-thumbs-up');
    expect(!!upBtn).toBe(true);
    expect(upBtn?.getAttribute('title')).toBe('认可并保存到知识库');
    // 未提供 onFeedbackDown 时不渲染点踩。
    expect(!!container.querySelector('.shell-thumbs-down')).toBe(false);

    upBtn?.click();
    expect(approved).toEqual(['up']);
    expect(upBtn?.hasClass('active')).toBe(true);
  });

  await test('thumbs-down expands a reason input and submits feedback with reason', async () => {
    const container = new FakeElement();
    const feedback: Array<{ id: string; reason: string }> = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app, markdown, el) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackDown: async (message, reason) => {
        feedback.push({ id: message.id, reason });
      },
    });

    await renderer.renderMessage(container as any, {
      id: 'a-down',
      role: 'ai',
      content: 'answer',
      timestamp: 6,
    });

    const downBtn = container.querySelector('.shell-thumbs-down');
    expect(!!downBtn).toBe(true);
    // 初始无理由输入框。
    expect(!!container.querySelector('.shell-feedback-reason')).toBe(false);

    // 点踩 → 展开理由输入。
    downBtn?.click();
    const input = container.querySelector('.shell-feedback-reason-input');
    expect(!!input).toBe(true);
    expect(downBtn?.hasClass('active')).toBe(true);

    // 空理由不应提交。
    input!.keydown('Enter');
    expect(feedback.length).toBe(0);

    // 填写理由并回车提交 → 回调带 reason,输入框收起。
    input!.value = '太啰嗦,要直接结论';
    input!.keydown('Enter');
    expect(feedback).toEqual([{ id: 'a-down', reason: '太啰嗦,要直接结论' }]);
    expect(!!container.querySelector('.shell-feedback-reason')).toBe(false);
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

  // 阶段C:ai 消息的重试按钮 —— 仅在已锚定会话树(sessionEntryId)且宿主接入 onRetry 时渲染。
  await test('renders retry button only for anchored ai messages', async () => {
    const retried: string[] = [];
    const renderer = new MessageRenderer({
      app: {}, component: {},
      renderMarkdown: (_app, md, el: any) => { el.textContent = md; },
      onRetry: (m) => { retried.push(m.id); },
    });

    // 未锚定:不渲染重试按钮。
    const c1 = new FakeElement();
    await renderer.renderMessage(c1 as any, { id: 'a1', role: 'ai', content: 'ans', timestamp: 1 });
    expect(!!c1.querySelector('.shell-retry-btn')).toBe(false);

    // 已锚定:渲染并点击回调。
    const c2 = new FakeElement();
    await renderer.renderMessage(c2 as any, { id: 'a2', role: 'ai', content: 'ans', timestamp: 1, sessionEntryId: 'e-a2' });
    const retryBtn = c2.querySelector('.shell-retry-btn');
    expect(!!retryBtn).toBe(true);
    retryBtn?.click();
    expect(retried).toEqual(['a2']);
  });

  // 阶段C:ai 操作栏的分叉按钮 —— 展开预填源问题的输入,提交回调带新文本。
  await test('fork button on ai toolbar prefills source question and submits new text', async () => {
    const forked: Array<{ id: string; text: string }> = [];
    const renderer = new MessageRenderer({
      app: {}, component: {},
      renderMarkdown: (_app, md, el: any) => { el.textContent = md; },
      onFork: (m, text) => { forked.push({ id: m.id, text }); },
    });

    // 未锚定:不渲染分叉按钮。
    const c1 = new FakeElement();
    await renderer.renderMessage(c1 as any, { id: 'a1', role: 'ai', content: 'ans', timestamp: 1 });
    expect(!!c1.querySelector('.shell-fork-btn')).toBe(false);

    // 已锚定:渲染分叉按钮,点开预填源问题,改写后提交。
    const c2 = new FakeElement();
    await renderer.renderMessage(c2 as any, {
      id: 'a2', role: 'ai', content: 'ans', timestamp: 1,
      sessionEntryId: 'e-a2', forkSourceText: '原始问题',
    });
    const forkBtn = c2.querySelector('.shell-fork-btn');
    expect(!!forkBtn).toBe(true);
    forkBtn?.click();
    const input = c2.querySelector('.shell-edit-input');
    expect(input?.value).toBe('原始问题');
    input!.value = '改写后的问题';
    c2.querySelector('.shell-edit-submit')?.click();
    expect(forked).toEqual([{ id: 'a2', text: '改写后的问题' }]);
  });

  // 阶段C:ai 操作栏的兄弟分支导航 —— branch.count>1 时渲染 < n/m >,点击切换回调带目标 leaf。
  await test('branch nav on ai toolbar switches siblings', async () => {
    const switched: Array<{ id: string; leaf: string }> = [];
    const renderer = new MessageRenderer({
      app: {}, component: {},
      renderMarkdown: (_app, md, el: any) => { el.textContent = md; },
      onSwitchBranch: (m, leaf) => { switched.push({ id: m.id, leaf }); },
    });
    const container = new FakeElement();
    await renderer.renderMessage(container as any, {
      id: 'a1', role: 'ai', content: 'ans', timestamp: 1, sessionEntryId: 'e-a1',
      branch: { index: 1, count: 2, leafIds: ['leaf-0', 'leaf-1'] },
    });
    expect(container.querySelector('.shell-branch-count')?.textContent).toBe('2/2');
    container.querySelector('.shell-branch-prev')?.click();
    expect(switched).toEqual([{ id: 'a1', leaf: 'leaf-0' }]);
  });

  // 阶段C:user 消息的兄弟分支导航条 —— count>1 时渲染 < n/m >,点击切换回调带目标 leaf。
  await test('renders branch navigation for user messages with siblings', async () => {
    const switched: Array<{ id: string; leaf: string }> = [];
    const renderer = new MessageRenderer({
      app: {}, component: {},
      onSwitchBranch: (m, leaf) => { switched.push({ id: m.id, leaf }); },
    });

    const container = new FakeElement();
    await renderer.renderMessage(container as any, {
      id: 'u1', role: 'user', content: 'Q', timestamp: 1, sessionEntryId: 'e-u1',
      branch: { index: 1, count: 2, leafIds: ['leaf-0', 'leaf-1'] },
    });

    const count = container.querySelector('.shell-branch-count');
    expect(count?.textContent).toBe('2/2');
    // 当前 index=1,点上一个 → 切到 index 0 的 leaf-0。
    container.querySelector('.shell-branch-prev')?.click();
    expect(switched).toEqual([{ id: 'u1', leaf: 'leaf-0' }]);
  });

  // 阶段C:无兄弟(count<=1)的 user 消息不渲染导航条。
  await test('omits branch navigation when a user message has no siblings', async () => {
    const renderer = new MessageRenderer({
      app: {}, component: {},
      onSwitchBranch: () => { },
    });
    const container = new FakeElement();
    await renderer.renderMessage(container as any, {
      id: 'u1', role: 'user', content: 'Q', timestamp: 1, sessionEntryId: 'e-u1',
    });
    expect(!!container.querySelector('.shell-branch-nav')).toBe(false);
  });

  // 阶段C:编辑重问 —— 点编辑展开预填输入,提交回调带新文本。
  await test('edit flow expands a prefilled input and submits new text', async () => {
    const edited: Array<{ id: string; text: string }> = [];
    const renderer = new MessageRenderer({
      app: {}, component: {},
      onEdit: (m, text) => { edited.push({ id: m.id, text }); },
    });
    const container = new FakeElement();
    await renderer.renderMessage(container as any, {
      id: 'u1', role: 'user', content: 'original', timestamp: 1, sessionEntryId: 'e-u1',
    });

    const editBtn = container.querySelector('.shell-edit-btn');
    expect(!!editBtn).toBe(true);
    editBtn?.click();
    const input = container.querySelector('.shell-edit-input');
    expect(input?.value).toBe('original'); // 预填原文
    input!.value = 'revised question';
    container.querySelector('.shell-edit-submit')?.click();
    expect(edited).toEqual([{ id: 'u1', text: 'revised question' }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
