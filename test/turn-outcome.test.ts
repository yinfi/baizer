/**
 * 终态(completed / failed / cancelled)与失败恢复的回归测试。
 *
 * 覆盖 issue #65 的核心约定:
 * - 事件显式携带 outcome,UI/消息/持久化消费同一个来源;
 * - 失败即使没有正文也落一条带原因的消息(回放有错误卡与重试入口);
 * - 取消不被记为 completed,且保留已生成正文;
 * - 重试按原请求与上下文恢复、不重复插入 user 消息、处理中拒绝第二次重试。
 */

(global as any).window = {
  setInterval: () => 0,
  clearInterval: () => { },
};

import type { ChatMessage } from '../src/ui/types';

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

function tick() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function createApi(chatStream: (signal?: AbortSignal) => AsyncGenerator<any>) {
  return {
    getSkillCommands: () => [],
    executeSlashSkillCommand: async () => ({ success: true }),
    chat: async () => 'fallback',
    chatStream: (_query: string, _context: any[], _selection: string, _source?: any,
      _obsidianContext?: any, _userProfile?: any, signal?: AbortSignal) => chatStream(signal),
    clearSession: async () => { },
    getUserProfile: () => null,
    updateProfile: async () => { },
    getAvailableTools: () => [],
  } as any;
}

async function runTests() {
  console.log('=== Turn Outcome Tests ===');
  const { StreamController } = await import('../src/ui/controllers/stream-controller');
  const { ChatController } = await import('../src/ui/chat-controller');

  await test('stream controller forwards explicit done outcomes and error messages', async () => {
    const calls: any[] = [];
    const controller = new StreamController({
      onThinking: () => { },
      onToolCall: () => { },
      onToolResult: () => { },
      onTextDelta: () => { },
      onDone: (text, outcome) => calls.push({ kind: 'done', text, outcome }),
      onError: (message) => calls.push({ kind: 'error', message }),
    });

    controller.handleEvent({ type: 'done', text: 'ok', outcome: 'completed' });
    controller.handleEvent({ type: 'done', text: 'partial', outcome: 'cancelled', interrupted: true });
    controller.handleEvent({ type: 'error', message: 'network down', outcome: 'failed' });

    expect(calls).toEqual([
      { kind: 'done', text: 'ok', outcome: 'completed' },
      { kind: 'done', text: 'partial', outcome: 'cancelled' },
      { kind: 'error', message: 'network down' },
    ]);
  });

  await test('failed turn records reason + partial text and retries without a duplicate user message', async () => {
    const messages: ChatMessage[] = [];
    const removed: string[] = [];
    let streamCount = 0;
    const api = createApi(async function* () {
      streamCount++;
      if (streamCount === 1) {
        yield { type: 'text_delta', content: 'partial answer' };
        yield { type: 'error', message: 'network down', outcome: 'failed' };
        return;
      }
      yield { type: 'text_delta', content: 'retry answer' };
      yield { type: 'done', text: 'retry answer', outcome: 'completed' };
    });

    const controller = new ChatController({
      app: {} as any,
      api,
      onMessageAdded: (message) => messages.push(message),
      onMessageRemoved: (id) => {
        removed.push(id);
        const index = messages.findIndex(message => message.id === id);
        if (index >= 0) messages.splice(index, 1);
      },
      onStreamEvent: () => { },
    });

    const context = [{ id: 'ctx-1', type: 'file', data: 'note.md', content: 'note body' }];
    const outcome = await controller.processCommand('Explain this note', context, 'selection');

    expect(outcome).toBe('failed');
    const failed = messages.find(message => message.role === 'ai')!;
    expect(failed.content).toBe('partial answer');
    expect(failed.metadata?.outcome).toBe('failed');
    expect(failed.metadata?.failureReason).toBe('network down');

    // 失败现场包含原文 + 附件上下文,供重试与恢复草稿使用。
    const request = controller.getRetryRequest(failed.id)!;
    expect(request.query).toBe('Explain this note');
    expect(request.selection).toBe('selection');
    expect(request.context).toEqual(context);

    const retryOutcome = await controller.retryTurn(request);

    expect(retryOutcome).toBe('completed');
    expect(streamCount).toBe(2);
    // 同一请求只出现一条 user 消息;失败回复被新答案原地替换。
    expect(messages.filter(message => message.role === 'user').length).toBe(1);
    expect(messages.filter(message => message.role === 'ai').map(message => message.content))
      .toEqual(['retry answer']);
    expect(removed).toEqual([failed.id]);
    expect(messages.find(message => message.role === 'ai')?.metadata?.outcome).toBe('completed');

    controller.cleanup();
  });

  await test('retry while a run is active is a no-op (single in-flight request)', async () => {
    const messages: ChatMessage[] = [];
    let streamCount = 0;
    let unblock: (() => void) | null = null;
    const api = createApi(async function* () {
      streamCount++;
      if (streamCount === 1) {
        yield { type: 'text_delta', content: 'partial' };
        yield { type: 'error', message: 'boom', outcome: 'failed' };
        return;
      }
      await new Promise<void>(resolve => { unblock = resolve; });
      yield { type: 'done', text: 'done', outcome: 'completed' };
    });

    const controller = new ChatController({
      app: {} as any,
      api,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: () => { },
    });

    await controller.processCommand('question');
    const request = controller.getRetryRequest(messages.find(m => m.role === 'ai')!.id)!;

    const firstRetry = controller.retryTurn(request);
    await tick();
    // 第二次(例如双击)在首个请求在途时必须直接返回,不启动新流。
    const secondRetry = await controller.retryTurn(request);
    expect(secondRetry).toBe(undefined);
    expect(streamCount).toBe(2);

    unblock?.();
    expect(await firstRetry).toBe('completed');
    expect(messages.filter(message => message.role === 'user').length).toBe(1);

    controller.cleanup();
  });

  await test('cancelled turn keeps partial text, is not recorded as completed, and exposes a retry request', async () => {
    const messages: ChatMessage[] = [];
    const streamEvents: any[] = [];
    const api = createApi(async function* (signal?: AbortSignal) {
      yield { type: 'text_delta', content: 'partial answer' };
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('Aborted');
          (error as any).name = 'AbortError';
          reject(error);
        });
      });
    });

    const controller = new ChatController({
      app: {} as any,
      api,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: (event) => streamEvents.push(event),
    });

    const run = controller.processCommand('question');
    await tick();
    controller.cancelActiveStream();
    const outcome = await run;

    expect(outcome).toBe('cancelled');
    const ai = messages.find(message => message.role === 'ai')!;
    expect(ai.content).toBe('partial answer');
    expect(ai.metadata?.outcome).toBe('cancelled');
    expect(ai.metadata?.interrupted).toBe(true);
    expect(streamEvents[streamEvents.length - 1]).toEqual({
      type: 'done',
      text: 'partial answer',
      outcome: 'cancelled',
      interrupted: true,
    });
    expect(controller.getRetryRequest(ai.id)?.query).toBe('question');

    controller.cleanup();
  });

  await test('first-token failure still records a retryable terminal message', async () => {
    const messages: ChatMessage[] = [];
    const api = createApi(async function* () {
      yield { type: 'error', message: 'provider unavailable', outcome: 'failed' };
    });

    const controller = new ChatController({
      app: {} as any,
      api,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: () => { },
    });

    const outcome = await controller.processCommand('question');

    expect(outcome).toBe('failed');
    const ai = messages.find(message => message.role === 'ai')!;
    expect(ai.content).toBe('');
    expect(ai.metadata?.outcome).toBe('failed');
    expect(ai.metadata?.failureReason).toBe('provider unavailable');
    expect(controller.getRetryRequest(ai.id)?.query).toBe('question');

    controller.cleanup();
  });

  console.log('=== Turn Outcome Tests: done ===');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
