import type { ChatMessage } from '../src/ui/types';

/**
 * 消息投影所有权测试(ADR 0002)。
 *
 * 契约:ChatController 是消息列表的唯一作者,tab.state 只是只读投影。
 * 宿主永远写投影,只有「尚未随 stream 事件上屏」的消息才额外画一次。
 * 这里用真实 ChatState 当投影,断言两份列表 id 一致——id 分叉正是
 * 点赞/点踩对流式回复静默失效的根因。
 */

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

function createApi(events: any[]) {
  return {
    getSkillCommands: () => [],
    executeSlashSkillCommand: async () => ({ success: true }),
    chat: async () => 'fallback',
    chatStream: async function* () {
      for (const event of events) yield event;
    },
    clearSession: async () => { },
    getUserProfile: () => null,
    updateProfile: async () => { },
    getAvailableTools: () => [],
  } as any;
}

/**
 * 最小宿主:照 ADR 0002 的规定连线。
 * 收到 onMessageAdded 就写投影;只有未上屏的才画。
 */
function createHost(ChatState: any) {
  const state = new ChatState('tab-1');
  const drawn: ChatMessage[] = [];
  return {
    state,
    drawn,
    onMessageAdded: (msg: ChatMessage, options?: { alreadyRendered?: boolean }) => {
      state.addMessage(msg);
      if (!options?.alreadyRendered) drawn.push(msg);
    },
  };
}

async function runTests() {
  console.log('=== Message Projection Tests (ADR 0002) ===');
  const { ChatController } = await import('../src/ui/chat-controller');
  const { ChatState } = await import('../src/ui/state/chat-state');

  await test('streamed AI reply reaches the projection with the owner\'s id', async () => {
    const host = createHost(ChatState);
    const controller = new ChatController({
      app: {} as any,
      api: createApi([
        { type: 'text_delta', content: 'Hello' },
        { type: 'done', text: 'Hello', entryIds: { userEntryId: 'u1', assistantEntryId: 'a1' } },
      ]),
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: () => { },
    });

    await controller.processCommand('Say hello');

    const owned = controller.getMessages();
    const projected = host.state.getMessages();

    expect(owned.map((m: ChatMessage) => m.id)).toEqual(projected.map((m: ChatMessage) => m.id));
    expect(owned.map((m: ChatMessage) => m.role)).toEqual(['user', 'ai']);
    // 流式正文已随 text_delta 上屏,记录时不得再画一次。
    expect(host.drawn.map(m => m.role)).toEqual(['user']);

    const ai = projected[projected.length - 1];
    expect(ai.content).toBe('Hello');
    expect(ai.sessionEntryId).toBe('a1');
    // user 的 entry 锚定是 done 事件里就地回填的,只断言 owner——真实宿主
    // 另有一条扫描投影补锚的路径(shell-view 的 done 处理),不在本测试的最小宿主里。
    expect(owned[0].sessionEntryId).toBe('u1');

    controller.cleanup();
  });

  await test('interrupted reply lands in both lists', async () => {
    const host = createHost(ChatState);
    let abortSeen = false;
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* (
          _query: string,
          _context: any[],
          _selection: string,
          _source?: any,
          _obsidianContext?: any,
          _userProfile?: any,
          signal?: AbortSignal,
        ) {
          abortSeen = true;
          yield { type: 'text_delta', content: 'partial' };
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const error = new Error('Aborted');
              (error as any).name = 'AbortError';
              reject(error);
            });
          });
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: () => { },
    });

    const run = controller.processCommand('Stream something');
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.cancelActiveStream();
    await run;

    expect(abortSeen).toBe(true);

    const owned = controller.getMessages();
    const projected = host.state.getMessages();

    // 中断路径过去只落 tab.state、不落 owner,两份内容因此分叉。
    expect(owned.map((m: ChatMessage) => m.id)).toEqual(projected.map((m: ChatMessage) => m.id));
    expect(owned.map((m: ChatMessage) => m.role)).toEqual(['user', 'ai', 'system']);

    const ai = owned.find((m: ChatMessage) => m.role === 'ai');
    expect(ai.content).toBe('partial');
    expect(ai.metadata?.interrupted).toBe(true);

    controller.cleanup();
  });

  await test('aborting while text is withheld records no ghost reply', async () => {
    const host = createHost(ChatState);
    const shown: string[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* (
          _query: string,
          _context: any[],
          _selection: string,
          _source?: any,
          _obsidianContext?: any,
          _userProfile?: any,
          signal?: AbortSignal,
        ) {
          yield { type: 'text_delta', content: 'Copy this JSON yourself.' };
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const error = new Error('Aborted');
              (error as any).name = 'AbortError';
              reject(error);
            });
          });
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: (event) => {
        if (event.type === 'text_delta') shown.push(event.content);
      },
    });

    // 写请求 + 没有成功的写工具 ⇒ 正文被缓冲,屏幕上从未出现。
    const run = controller.processCommand('Create a canvas file for this article');
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.cancelActiveStream();
    await run;

    expect(shown).toEqual([]);
    // 记下这条就成了幽灵回复:它标 alreadyRendered、宿主不画,只在切 tab 重渲时冒出来。
    expect(controller.getMessages().map((m: ChatMessage) => m.role)).toEqual(['user', 'system']);
    expect(host.state.getMessages().map((m: ChatMessage) => m.role)).toEqual(['user', 'system']);

    controller.cleanup();
  });

  await test('feedback handlers resolve the id the projection rendered', async () => {
    const host = createHost(ChatState);
    const archived: any[] = [];
    const controller = new ChatController({
      app: {
        plugins: {
          plugins: {
            baizer: {
              toolRegistry: {
                execute: async (action: string, args: Record<string, any>) => {
                  archived.push({ action, args });
                  return { success: true, path: 'Knowledge Wiki/Articles/x.md' };
                },
              },
            },
          },
        },
      } as any,
      api: createApi([
        { type: 'text_delta', content: '## Decision\n\nUse a projection.' },
        { type: 'done', text: '## Decision\n\nUse a projection.' },
      ]),
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: () => { },
    });

    await controller.processCommand('Explain the decision');

    // 操作栏渲染自投影;点赞按该 id 回查 owner,过去必然 miss 而静默返回。
    const rendered = host.state.getMessages().reverse().find((m: ChatMessage) => m.role === 'ai');
    await controller.recordPositiveFeedback(rendered.id);

    expect(archived.length).toBe(1);
    expect(archived[0].action).toBe('file_back_knowledge');
    expect(archived[0].args.source_queries[0]).toBe('Explain the decision');

    controller.cleanup();
  });

  await test('write-request failure keeps both lists aligned without an AI message', async () => {
    const host = createHost(ChatState);
    const controller = new ChatController({
      app: {} as any,
      api: createApi([
        { type: 'text_delta', content: 'Copy this JSON into a new canvas file.' },
        { type: 'done', text: 'Copy this JSON into a new canvas file.' },
      ]),
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: () => { },
    });

    await controller.processCommand('Create a canvas file for this article');

    const owned = controller.getMessages();
    expect(owned.map((m: ChatMessage) => m.role)).toEqual(['user', 'system']);
    expect(owned.map((m: ChatMessage) => m.id)).toEqual(
      host.state.getMessages().map((m: ChatMessage) => m.id),
    );
    // 系统警告没走 stream,必须画出来。
    expect(host.drawn.map(m => m.role)).toEqual(['user', 'system']);

    controller.cleanup();
  });

  await test('non-streaming path still records and draws once', async () => {
    const host = createHost(ChatState);
    const controller = new ChatController({
      app: {} as any,
      api: createApi([]),
      onMessageAdded: host.onMessageAdded,
    });

    await controller.processCommand('Plain question');

    expect(controller.getMessages().map((m: ChatMessage) => m.role)).toEqual(['user', 'ai']);
    expect(host.drawn.map(m => m.role)).toEqual(['user', 'ai']);
    expect(controller.getMessages().map((m: ChatMessage) => m.id)).toEqual(
      host.state.getMessages().map((m: ChatMessage) => m.id),
    );

    controller.cleanup();
  });

  await test('a tool-only turn with no final text records no empty AI bubble', async () => {
    const host = createHost(ChatState);
    const controller = new ChatController({
      app: {} as any,
      api: createApi([
        { type: 'tool_call', name: 'read_note', args: { path: 'A.md' } },
        { type: 'tool_result', name: 'read_note', result: { success: true, content: 'x' } },
        { type: 'done', text: '' },
      ]),
      onMessageAdded: host.onMessageAdded,
      onStreamEvent: () => { },
    });

    await controller.processCommand('Read a note');

    // 空正文不落消息:该列表现在也是重渲来源,空 ai 会变成带操作栏的空气泡。
    expect(controller.getMessages().map((m: ChatMessage) => m.role)).toEqual(['user']);
    expect(host.state.getMessages().map((m: ChatMessage) => m.role)).toEqual(['user']);

    controller.cleanup();
  });

  await test('the AI message is recorded before the done event fires', async () => {
    const order: string[] = [];
    const state = new ChatState('tab-1');
    const controller = new ChatController({
      app: {} as any,
      api: createApi([
        { type: 'text_delta', content: 'answer' },
        { type: 'done', text: 'answer', entryIds: { assistantEntryId: 'a9' } },
      ]),
      onMessageAdded: (msg: ChatMessage) => {
        state.addMessage(msg);
        order.push(`added:${msg.role}`);
      },
      onStreamEvent: (event) => {
        if (event.type !== 'done') return;
        // 宿主在 done 时用投影里的真实 ai 消息渲染操作栏,所以记录必须先到。
        const ai = state.getMessages().reverse().find((m: ChatMessage) => m.role === 'ai');
        order.push(`done:${ai?.sessionEntryId ?? 'missing'}`);
      },
    });

    await controller.processCommand('Ask');

    expect(order).toEqual(['added:user', 'added:ai', 'done:a9']);

    controller.cleanup();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
