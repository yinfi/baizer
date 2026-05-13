import { DEFAULT_SETTINGS } from '../src/mcp/types';

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

function expect(actual: any) {
  return {
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

async function runTests() {
  console.log('=== ModelService Tests ===');
  const { ModelService } = await import('../src/services/model-service');

  await test('switchProvider flushes the active memory session before cleanup', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [];
    service.memoryManager = {
      ready: async () => { order.push('ready'); },
      clearSession: async () => { order.push('clearSession'); },
      save: async () => { order.push('save'); },
    };
    service.cleanup = () => {
      order.push('cleanup');
      service.memoryManager = null;
    };
    service.initializeProvider = () => {
      order.push('initializeProvider');
    };

    await service.switchProvider('openai');

    expect(order).toEqual([
      'ready',
      'clearSession',
      'save',
      'cleanup',
      'initializeProvider',
    ]);
  });

  await test('updateSettings flushes the active memory session before rebuilding services', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [];
    service.memoryManager = {
      ready: async () => { order.push('ready'); },
      clearSession: async () => { order.push('clearSession'); },
      save: async () => { order.push('save'); },
    };
    service.cleanup = () => {
      order.push('cleanup');
      service.memoryManager = null;
    };
    service.initializeProvider = () => {
      order.push('initializeProvider');
    };

    await service.updateSettings({
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      systemPrompt: 'updated',
    });

    expect(order).toEqual([
      'ready',
      'clearSession',
      'save',
      'cleanup',
      'initializeProvider',
    ]);
  });

  await test('getSkillCommands proxies command entries from the skill registry', async () => {
    const service: any = Object.create(ModelService.prototype);
    const commands = [
      { command: '/save', skillName: 'web-clipper', description: 'Save webpage' },
      { command: '/wiki:query', skillName: 'knowledge', description: 'Query knowledge wiki' },
    ];

    service.skillRegistry = {
      listCommandEntries: () => commands,
    };

    expect(service.getSkillCommands()).toEqual(commands);
  });

  await test('executeSlashSkillCommand dispatches to the resolved skill with normalized args', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];
    const expectedResult = { success: true, message: 'saved' };

    service.app = { id: 'app' };
    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.skillRegistry = {
      resolveByCommand: (command: string) => command === '/save'
        ? {
          execute: async (args: any, ctx: any) => {
            calls.push({ args, ctx });
            return expectedResult;
          },
        }
        : null,
    };

    const result = await service.executeSlashSkillCommand('/save', 'https://example.com/article');

    expect(result).toEqual(expectedResult);
    expect(calls).toEqual([{
      args: {
        command: '/save',
        input: 'https://example.com/article',
        query: 'https://example.com/article',
        url: 'https://example.com/article',
      },
      ctx: {
        app: service.app,
        settings: service.settings,
      },
    }]);
  });

  await test('executeSlashSkillCommand runs instruction-only skills through ChatRuntime', async () => {
    const service: any = Object.create(ModelService.prototype);
    const runtimeCalls: any[] = [];

    service.app = { id: 'app' };
    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.skillRegistry = {
      resolveByCommand: (command: string) => command === '/tasks'
        ? {
            name: 'plugin-obsidian-tasks',
            executionMode: 'instructions',
            execute: async () => {
              throw new Error('instruction-only skills should not execute directly');
            },
          }
        : null,
    };
    service.createChatRuntime = () => ({
      prepareTurn: async (request: any) => {
        runtimeCalls.push({ type: 'prepareTurn', request });
        return { prompt: 'prepared prompt', tools: [] };
      },
      query: async (turn: any) => {
        runtimeCalls.push({ type: 'query', turn });
        return 'task result';
      },
    });

    const result = await service.executeSlashSkillCommand('/tasks', 'today');

    expect(result).toEqual({ success: true, message: 'task result' });
    expect(runtimeCalls).toEqual([
      {
        type: 'prepareTurn',
        request: {
          userMessage: 'today',
          contextItems: [],
          forcedSkillName: 'plugin-obsidian-tasks',
        },
      },
      {
        type: 'query',
        turn: {
          prompt: 'prepared prompt',
          tools: [],
        },
      },
    ]);
  });

  await test('executeApprovedAction replays the target tool with approved flag', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];

    service.toolRegistry = {
      execute: async (name: string, args: any) => {
        calls.push({ name, args });
        return { success: true, message: 'approved execution' };
      },
    };

    const result = await service.executeApprovedAction('create_note', {
      filename: 'approved.md',
      content: '# Approved',
    });

    expect(result).toEqual({ success: true, message: 'approved execution' });
    expect(calls).toEqual([{
      name: 'create_note',
      args: {
        filename: 'approved.md',
        content: '# Approved',
        approved: true,
      },
    }]);
  });

  await test('chat delegates prepared turn execution to ChatRuntime', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: string[] = [];
    const request = {
      userMessage: 'hello',
      contextItems: [{ type: 'file', data: 'note.md', content: 'content' }],
      selection: 'selected text',
    };

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.createChatRuntime = () => ({
      prepareTurn: async (input: any) => {
        calls.push(`prepare:${JSON.stringify(input)}`);
        return { prompt: 'prepared', tools: [] };
      },
      query: async (prepared: any) => {
        calls.push(`query:${JSON.stringify(prepared)}`);
        return 'runtime response';
      },
    });
    service.memoryManager = null;

    const result = await service.chat(
      request.userMessage,
      request.contextItems,
      request.selection,
    );

    expect(result).toEqual('runtime response');
    expect(calls).toEqual([
      `prepare:${JSON.stringify(request)}`,
      `query:${JSON.stringify({ prompt: 'prepared', tools: [] })}`,
    ]);
  });

  await test('chatStream forwards AbortSignal to runtime.queryStream', async () => {
    const service: any = Object.create(ModelService.prototype);
    const request = {
      userMessage: 'hello stream',
      contextItems: [{ type: 'file', data: 'note.md', content: 'content' }],
      selection: 'selected text',
    };
    const signal = new AbortController().signal;
    const calls: any[] = [];

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.createChatRuntime = () => ({
      prepareTurn: async (input: any) => {
        calls.push({ type: 'prepareTurn', input });
        return { prompt: 'prepared stream', tools: [] };
      },
      queryStream: async function* (prepared: any, receivedSignal?: AbortSignal) {
        calls.push({ type: 'queryStream', prepared, receivedSignal });
        yield { type: 'text_delta', content: 'hi' as const };
        yield { type: 'done', text: 'hi' as const };
      },
    });

    const events: any[] = [];
    for await (const event of service.chatStream(
      request.userMessage,
      request.contextItems,
      request.selection,
      signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', content: 'hi' },
      { type: 'done', text: 'hi' },
    ]);
    expect(calls).toEqual([
      {
        type: 'prepareTurn',
        input: request,
      },
      {
        type: 'queryStream',
        prepared: { prompt: 'prepared stream', tools: [] },
        receivedSignal: signal,
      },
    ]);
  });

  await test('getProviderCapabilities proxies the active provider capability declaration', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.provider = {
      getCapabilities: () => ({
        supportsThinking: true,
        supportsModelListing: true,
        supportsImageInput: false,
        supportsToolCalling: true,
        supportsCustomBaseUrl: false,
      }),
    };

    expect(service.getProviderCapabilities()).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: false,
      supportsToolCalling: true,
      supportsCustomBaseUrl: false,
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
