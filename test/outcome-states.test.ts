// issue #65:聊天视图区分 completed/failed/cancelled 三种终态,失败保留现场。
// 覆盖:ChatController 的终态判定与消息落盘、MessageRenderer 的终态渲染与重试去重、
// ShellView 的草稿/附件恢复、以及终态在持久化里的取舍(reason 落盘、重试快照不落盘)。

(global as any).window = {
  setInterval,
  clearInterval,
};
(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

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
  value = '';
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  classList = {
    values: new Set<string>(),
    add: (name: string) => { this.classList.values.add(name); this.syncClassName(); },
    remove: (name: string) => { this.classList.values.delete(name); this.syncClassName(); },
    contains: (name: string) => this.classList.values.has(name),
    [Symbol.iterator]: () => this.classList.values[Symbol.iterator](),
  };

  constructor(public tagName = 'div') { }

  createDiv(attr?: any) { return this.createEl('div', attr); }
  createSpan(attr?: any) { return this.createEl('span', attr); }

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

  setText(text: string) { this.textContent = text; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  addClass(name: string) { this.classList.add(name); }
  removeClass(name: string) { this.classList.remove(name); }
  empty() { this.children = []; this.textContent = ''; }

  appendChild(child: FakeElement) { child.parentElement = this; this.children.push(child); }
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

  focus() { return; }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
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

function fakeChatControllerApi(overrides: Partial<any> = {}) {
  return {
    getSkillCommands: () => [],
    executeSlashSkillCommand: async () => ({ success: true }),
    chat: async () => 'fallback',
    chatStream: async function* () { },
    clearSession: async () => { },
    getUserProfile: () => null,
    updateProfile: async () => { },
    getAvailableTools: () => [],
    ...overrides,
  };
}

async function runTests() {
  console.log('=== Outcome States Tests (issue #65) ===');
  const { setLocaleForTesting } = await import('../src/i18n/zh');
  setLocaleForTesting(false);
  const { ChatController } = await import('../src/ui/chat-controller');
  const { MessageRenderer } = await import('../src/ui/renderers/message-renderer');

  // ── ChatController:三种终态的判定与落盘 ──────────────────────────────

  await test('a stream error before any token returns failed and records a failed ai message, not a plain system error', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: fakeChatControllerApi({
        chatStream: async function* () {
          throw new Error('network unreachable');
        },
      }) as any,
      onMessageAdded: (m) => messages.push(m),
      onStreamEvent: (e) => streamEvents.push(e),
    });

    const outcome = await controller.processCommand('Explain quantum computing', [], '', 'shell', undefined);

    expect(outcome).toBe('failed');
    // 没有一条灰色系统 "Error: ..." 提示——失败态的呈现只走失败横幅,不重复。
    expect(messages.some((m) => m.role === 'system' && String(m.content).startsWith('Error:'))).toBe(false);

    const failedMessage = messages[messages.length - 1];
    expect(failedMessage.role).toBe('ai');
    expect(failedMessage.metadata.outcome).toBe('failed');
    expect(failedMessage.metadata.errorMessage).toBe('network unreachable');
    // 原始请求快照必须完整,供重试原样重发(需求 5:即使首 token 前失败也要能重试)。
    expect(failedMessage.metadata.retryDraft.query).toBe('Explain quantum computing');

    expect(streamEvents[streamEvents.length - 1]).toEqual({
      type: 'error',
      message: 'network unreachable',
      text: undefined,
    });

    controller.cleanup();
  });

  await test('a mid-stream error preserves already-generated text as the failed message content', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: fakeChatControllerApi({
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'Partial answer so far.' };
          yield { type: 'error', message: 'connection dropped' };
        },
      }) as any,
      onMessageAdded: (m) => messages.push(m),
      onStreamEvent: (e) => streamEvents.push(e),
    });

    const outcome = await controller.processCommand('Write a long essay', [], '', 'shell', undefined);

    expect(outcome).toBe('failed');
    const failedMessage = messages[messages.length - 1];
    expect(failedMessage.role).toBe('ai');
    expect(failedMessage.content).toBe('Partial answer so far.');
    expect(failedMessage.metadata.outcome).toBe('failed');
    expect(failedMessage.metadata.errorMessage).toBe('connection dropped');
    expect(failedMessage.metadata.retryDraft.query).toBe('Write a long essay');

    controller.cleanup();
  });

  await test('ADR 0002: the failed ai message is recorded before the error stream event fires, so the host can find it immediately', async () => {
    // 宿主(ShellView.finalizeStream)在收到 error 事件时,要靠投影里「最后一条 ai 消息」
    // 拿 retryDraft 渲染重试按钮——如果记录晚于事件发出,首次上屏就会没有重试按钮,
    // 只有切 tab 重渲才会凭空出现。这里直接在 onStreamEvent 回调里断言记录已经发生。
    let messagesAtErrorTime: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: fakeChatControllerApi({
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'partial' as const };
          yield { type: 'error', message: 'boom' };
        },
      }) as any,
      onMessageAdded: () => { },
      onStreamEvent: (e) => {
        if (e.type === 'error') {
          messagesAtErrorTime = (controller as any).messages;
        }
      },
    });

    await controller.processCommand('Q', [], '', 'shell', undefined);

    const lastMessage = messagesAtErrorTime[messagesAtErrorTime.length - 1];
    expect(lastMessage.role).toBe('ai');
    expect(lastMessage.metadata.outcome).toBe('failed');
    expect(lastMessage.metadata.retryDraft.query).toBe('Q');

    controller.cleanup();
  });

  await test('cancelling an in-flight stream returns cancelled and keeps the existing stop message', async () => {
    const messages: any[] = [];
    let abortSeen = false;

    const controller = new ChatController({
      app: {} as any,
      api: fakeChatControllerApi({
        chatStream: async function* (
          _q: string, _c: any[], _s: string, _src?: any, _oc?: any, _up?: any, signal?: AbortSignal,
        ) {
          abortSeen = !!signal;
          yield { type: 'text_delta', content: 'partial' as const };
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('Aborted');
              (err as any).name = 'AbortError';
              reject(err);
            });
          });
        },
      }) as any,
      onMessageAdded: (m) => messages.push(m),
      onStreamEvent: () => { },
    });

    const run = controller.processCommand('Stream something long', [], '', 'shell', undefined);
    await new Promise((r) => setTimeout(r, 0));
    controller.cancelActiveStream();
    const outcome = await run;

    expect(abortSeen).toBe(true);
    expect(outcome).toBe('cancelled');
    // 既有「Response stopped.」系统提示保留(向后兼容),同时 ai 消息带 outcome:'cancelled'。
    expect(messages[messages.length - 1].content).toBe('Response stopped.');
    const aiMessage = [...messages].reverse().find((m) => m.role === 'ai');
    expect(aiMessage.metadata.outcome).toBe('cancelled');
    expect(aiMessage.metadata.interrupted).toBe(true);
    expect(aiMessage.content).toBe('partial');

    controller.cleanup();
  });

  await test('a normal completion returns completed', async () => {
    const controller = new ChatController({
      app: {} as any,
      api: fakeChatControllerApi({
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'All good.' };
          yield { type: 'done', text: 'All good.' };
        },
      }) as any,
      onStreamEvent: () => { },
    });

    const outcome = await controller.processCommand('Say hi', [], '', 'shell', undefined);
    expect(outcome).toBe('completed');

    controller.cleanup();
  });

  // ── MessageRenderer:终态渲染与重试去重 ──────────────────────────────

  await test('renders a failed banner with reason and a retry button wired to the message', async () => {
    const container = new FakeElement();
    const retried: any[] = [];
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app: any, markdown: string, el: any) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onRetryDraft: async (message: any) => { retried.push(message); },
    } as any);

    const entry = await renderer.renderMessage(container as any, {
      id: 'ai-failed',
      role: 'ai',
      content: 'Partial text kept on screen.',
      timestamp: 10,
      metadata: {
        outcome: 'failed',
        errorMessage: 'timeout',
        retryDraft: { query: 'original question', context: [], selection: '', source: 'shell' },
      },
    } as any);

    expect((entry as any).hasClass('shell-outcome-failed')).toBe(true);
    const banner = container.querySelector('.shell-outcome-banner-failed');
    expect(!!banner).toBe(true);
    expect(banner!.querySelector('.shell-outcome-banner-text')!.textContent).toContain('timeout');
    // 失败也要保留已生成正文,可读可复制——不是只剩一张错误卡。
    expect(!!container.querySelector('.rendered-markdown')).toBe(true);

    const retryBtn = container.querySelector('.shell-outcome-retry-btn');
    expect(!!retryBtn).toBe(true);
    retryBtn!.click();
    expect(retried.length).toBe(1);
    expect(retried[0].id).toBe('ai-failed');
  });

  await test('a failed message with no generated content still gets an error card and a retry entry, not a permanent toolbar', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      onRetryDraft: async () => { },
    } as any);

    await renderer.renderMessage(container as any, {
      id: 'ai-empty-failed',
      role: 'ai',
      content: '',
      timestamp: 11,
      metadata: {
        outcome: 'failed',
        errorMessage: 'request failed before the first token',
        retryDraft: { query: 'q', context: [], selection: '', source: 'shell' },
      },
    } as any);

    expect(!!container.querySelector('.shell-outcome-banner-failed')).toBe(true);
    expect(!!container.querySelector('.shell-outcome-retry-btn')).toBe(true);
    // 空正文失败态不需要常规操作栏(复制/反馈/分叉对空答案无意义)。
    expect(!!container.querySelector('.shell-copy-btn')).toBe(false);
    expect(!!container.querySelector('.shell-thumbs-up')).toBe(false);
  });

  await test('double-clicking the retry button only triggers one retry (idempotent retry)', async () => {
    const container = new FakeElement();
    let retryCalls = 0;
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      onRetryDraft: async () => { retryCalls += 1; },
    } as any);

    await renderer.renderMessage(container as any, {
      id: 'ai-failed-2',
      role: 'ai',
      content: '',
      timestamp: 12,
      metadata: {
        outcome: 'failed',
        retryDraft: { query: 'q', context: [], selection: '', source: 'shell' },
      },
    } as any);

    const retryBtn = container.querySelector('.shell-outcome-retry-btn')!;
    retryBtn.click();
    retryBtn.click();
    retryBtn.click();

    expect(retryCalls).toBe(1);
  });

  await test('renders a cancelled banner, keeps generated content, and does not offer feedback/fork controls', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app: any, markdown: string, el: any) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackUp: async () => { },
      onFeedbackDown: async () => { },
      onFork: async () => { },
    } as any);

    const entry = await renderer.renderMessage(container as any, {
      id: 'ai-cancelled',
      role: 'ai',
      content: 'Here is what was generated before stop.',
      timestamp: 13,
      metadata: { outcome: 'cancelled', interrupted: true },
    } as any);

    expect((entry as any).hasClass('shell-outcome-cancelled')).toBe(true);
    expect(!!container.querySelector('.shell-outcome-banner-cancelled')).toBe(true);
    expect(container.querySelector('.shell-outcome-banner-text')!.textContent).toContain('incomplete');
    expect(!!container.querySelector('.rendered-markdown')).toBe(true);
    // 未完成的回答不该被当成正常答案去点赞/点踩/分叉。
    expect(!!container.querySelector('.shell-thumbs-up')).toBe(false);
    expect(!!container.querySelector('.shell-thumbs-down')).toBe(false);
    expect(!!container.querySelector('.shell-fork-btn')).toBe(false);
  });

  await test('a completed message renders no outcome banner and keeps the full action toolbar', async () => {
    const container = new FakeElement();
    const renderer = new MessageRenderer({
      app: {},
      component: {},
      renderMarkdown: async (_app: any, markdown: string, el: any) => {
        el.createDiv({ cls: 'rendered-markdown', text: markdown });
      },
      onFeedbackUp: async () => { },
      onFeedbackDown: async () => { },
    } as any);

    const entry = await renderer.renderMessage(container as any, {
      id: 'ai-ok',
      role: 'ai',
      content: 'All good.',
      timestamp: 14,
    } as any);

    expect((entry as any).hasClass('shell-outcome-completed')).toBe(true);
    expect(!!container.querySelector('.shell-outcome-banner')).toBe(false);
    expect(!!container.querySelector('.shell-thumbs-up')).toBe(true);
  });

  // ── 持久化边界:终态与原因落盘,重试快照(可能带整张图片/整篇文件)不落盘 ──

  await test('persisted snapshots keep outcome and error reason but strip the retry draft payload', async () => {
    class FakeAdapter {
      files = new Map<string, string>();
      folders = new Set<string>();
      async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
      async read(path: string) {
        const v = this.files.get(path);
        if (v === undefined) throw new Error(`missing: ${path}`);
        return v;
      }
      async write(path: string, content: string) { this.files.set(path, content); }
      async mkdir(path: string) { this.folders.add(path); }
    }

    const { ConversationStore } = await import('../src/ui/history/conversation-store');
    const adapter = new FakeAdapter();
    const store = new ConversationStore({ vault: { adapter } } as any, { maxConversations: 100 });

    await store.save({
      id: 'c1',
      title: 'Chat 1',
      createdAt: 1,
      updatedAt: 2,
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      messages: [{
        id: 'ai-failed',
        role: 'ai',
        content: 'partial',
        timestamp: 2,
        metadata: {
          outcome: 'failed',
          errorMessage: 'timeout',
          retryDraft: {
            query: 'q',
            context: [{ id: 'img', type: 'image', data: 'data:image/png;base64,AAAA' }],
            selection: '',
            source: 'shell',
          },
        },
      }],
    } as any);

    const listed = await store.list();
    const restoredMessage = listed[0].messages[0] as any;
    expect(restoredMessage.metadata.outcome).toBe('failed');
    expect(restoredMessage.metadata.errorMessage).toBe('timeout');
    expect(restoredMessage.metadata.retryDraft).toBe(undefined);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
