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

  await test('ModelService passes privacyMode into MemoryManager options', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.settings = {
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      privacyMode: true,
    };

    const options = service.buildMemoryOptions();

    // 只断言 privacyMode 被正确传入,不锁死整个 options 形状(避免每加一个记忆选项都改测试)。
    expect({ privacyMode: options.privacyMode }).toEqual({ privacyMode: true });
  });

  await test('switchProvider flushes the active memory session before cleanup', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [];
    service.memoryManager = {
      ready: async () => { order.push('ready'); },
      clearSession: async () => { order.push('clearSession'); },
      flush: async () => { order.push('flush'); },
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
      'flush',
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
      flush: async () => { order.push('flush'); },
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
      'flush',
      'save',
      'cleanup',
      'initializeProvider',
    ]);
  });

  await test('updateSettings notifies provider listeners so UI selectors refresh immediately', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [
      () => { order.push('providerChanged'); },
    ];
    service.memoryManager = null;
    service.cleanup = () => {
      order.push('cleanup');
    };
    service.initializeProvider = () => {
      order.push('initializeProvider');
    };

    const nextSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    nextSettings.providers['custom-local'] = {
      type: 'openai-compatible',
      label: 'Local Gateway',
      apiKey: 'sk-local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };
    nextSettings.activeProvider = 'custom-local';

    await service.updateSettings(nextSettings);

    expect(order).toEqual([
      'cleanup',
      'initializeProvider',
      'providerChanged',
    ]);
  });

  await test('ModelService exposes memory view and memory deletion facade methods', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.memoryManager = {
      getMemoryView: async (request: any) => ({ request, stats: { total: 0 }, sections: {} }),
      deleteMemoryById: async (id: string) => ({ success: true, deletedCount: 1, message: id }),
      forgetMemory: async (field: string) => ({ success: true, deletedCount: 2, message: field }),
    };

    const view = await service.getMemoryView({ mode: 'observations', limit: 3 });
    const deleted = await service.deleteMemoryById('mem_1');
    const forgotten = await service.forgetMemory('projects');

    expect(view.request).toEqual({ mode: 'observations', limit: 3 });
    expect(deleted).toEqual({ success: true, deletedCount: 1, message: 'mem_1' });
    expect(forgotten).toEqual({ success: true, deletedCount: 2, message: 'projects' });
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

  await test('executeWorkspaceTool proxies to the shared workspace edit service', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];
    service.workspaceEditService = {
      executeWorkspaceTool: async (action: string, args: Record<string, any>) => {
        calls.push({ action, args });
        return { success: true, workspaceEdit: { id: 'edit-1' } };
      },
    };

    const result = await service.executeWorkspaceTool('update_file', {
      path: 'Notes/source.md',
      content: 'after',
    });

    expect(result).toEqual({ success: true, workspaceEdit: { id: 'edit-1' } });
    expect(calls).toEqual([{
      action: 'update_file',
      args: {
        path: 'Notes/source.md',
        content: 'after',
      },
    }]);
  });

  await test('purgeSession delegates to the session manager to delete the persisted session', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: string[] = [];
    service.sessionManager = {
      purge: async (conversationId: string) => { calls.push(conversationId); },
    };

    await service.purgeSession('tab-7');

    expect(calls).toEqual(['tab-7']);
  });

  await test('purgeSession is a no-op when no session manager exists', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.sessionManager = null;
    // 无 sessionManager(降级/临时会话):不应抛错。
    await service.purgeSession('tab-x');
    expect(true).toEqual(true);
  });

  await test('undoWorkspaceEdit proxies to the shared workspace edit service', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: string[] = [];
    service.workspaceEditService = {
      undoWorkspaceEdit: async (editId: string) => {
        calls.push(editId);
        return { success: true, edit: { id: editId, status: 'undone' } };
      },
    };

    const result = await service.undoWorkspaceEdit('edit-1');

    expect(result).toEqual({ success: true, edit: { id: 'edit-1', status: 'undone' } });
    expect(calls).toEqual(['edit-1']);
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
    const auditCalls: any[] = [];

    service.toolRegistry = {
      execute: async (name: string, args: any) => {
        calls.push({ name, args });
        return { success: true, message: 'approved execution' };
      },
    };
    service.operationAuditLog = {
      record: async (entry: any) => {
        auditCalls.push(entry);
      },
    };
    service.settings = { activeProvider: 'openai' };
    service.getActiveProviderConfig = () => ({ model: 'gpt-4o' });

    const outcomeCalls: any[] = [];
    service.sessionManager = {
      appendApprovalOutcome: async (conversationId: string | undefined, text: string) => {
        outcomeCalls.push({ conversationId, text });
      },
    };

    const result = await service.executeApprovedAction('create_note', {
      filename: 'approved.md',
      content: '# Approved',
    }, 'tab-1');

    expect(result).toEqual({ success: true, message: 'approved execution' });
    expect(calls).toEqual([{
      name: 'create_note',
      args: {
        filename: 'approved.md',
        content: '# Approved',
        approved: true,
      },
    }]);
    expect(auditCalls).toEqual([{
      action: 'create_note',
      target: 'approved.md',
      provider: 'openai',
      model: 'gpt-4o',
      approvalSource: 'user-click',
      undoable: true,
    }]);
    // 论断2:批准后的真实结果回灌进该会话 session,下一轮模型可见「已批准执行」。
    expect(outcomeCalls.length).toEqual(1);
    expect(outcomeCalls[0].conversationId).toEqual('tab-1');
    expect(outcomeCalls[0].text.includes('create_note')).toEqual(true);
    expect(outcomeCalls[0].text.includes('approved.md')).toEqual(true);
    expect(outcomeCalls[0].text.includes('successfully')).toEqual(true);
  });

  await test('executeApprovedAction feeds a failure outcome back into the session', async () => {
    const service: any = Object.create(ModelService.prototype);

    service.toolRegistry = {
      execute: async () => ({ success: false, error: 'File modification is disabled' }),
    };
    service.operationAuditLog = { record: async () => { } };
    service.settings = { activeProvider: 'openai' };
    service.getActiveProviderConfig = () => ({ model: 'gpt-4o' });

    const outcomeCalls: any[] = [];
    service.sessionManager = {
      appendApprovalOutcome: async (conversationId: string | undefined, text: string) => {
        outcomeCalls.push({ conversationId, text });
      },
    };

    await service.executeApprovedAction('update_note', { path: 'locked.md', content: 'x' }, 'tab-9');

    expect(outcomeCalls.length).toEqual(1);
    expect(outcomeCalls[0].conversationId).toEqual('tab-9');
    expect(outcomeCalls[0].text.includes('failed')).toEqual(true);
    expect(outcomeCalls[0].text.includes('File modification is disabled')).toEqual(true);
  });

  await test('executeApprovedAction skips session feedback when no session manager exists', async () => {
    const service: any = Object.create(ModelService.prototype);

    service.toolRegistry = {
      execute: async () => ({ success: true, message: 'ok' }),
    };
    service.operationAuditLog = { record: async () => { } };
    service.settings = { activeProvider: 'openai' };
    service.getActiveProviderConfig = () => ({ model: 'gpt-4o' });
    service.sessionManager = null;

    // 无 sessionManager(临时/降级会话):不应抛错,静默跳过回灌。
    const result = await service.executeApprovedAction('create_note', {
      filename: 'x.md',
      content: 'y',
    });

    expect(result).toEqual({ success: true, message: 'ok' });
  });

  await test('chat delegates prepared turn execution to ChatRuntime', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: string[] = [];
    const request = {
      userMessage: 'hello',
      contextItems: [{ type: 'file', data: 'note.md', content: 'content' }],
      selection: 'selected text',
      source: 'shell',
      obsidianContext: { activeNote: { path: 'note.md', title: 'note' } },
      userProfile: { preferences: { responseStyle: 'balanced' } },
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
      request.source,
      request.obsidianContext,
      request.userProfile,
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
      source: 'selection-menu',
      obsidianContext: { activeNote: { path: 'note.md', title: 'note' } },
      userProfile: { preferences: { responseStyle: 'balanced' } },
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
      request.source,
      request.obsidianContext,
      request.userProfile,
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

  await test('chatStream preserves the legacy 4-argument shell signature', async () => {
    const service: any = Object.create(ModelService.prototype);
    const signal = new AbortController().signal;
    const calls: any[] = [];

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.createChatRuntime = () => ({
      prepareTurn: async (input: any) => {
        calls.push({ type: 'prepareTurn', input });
        return { prompt: 'prepared stream', tools: [] };
      },
      queryStream: async function* (_prepared: any, receivedSignal?: AbortSignal) {
        calls.push({ type: 'queryStream', receivedSignal });
        yield { type: 'done', text: 'ok' as const };
      },
    });

    const events: any[] = [];
    for await (const event of service.chatStream(
      'legacy stream',
      [],
      '',
      signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'done', text: 'ok' }]);
    expect(calls).toEqual([
      {
        type: 'prepareTurn',
        input: {
          userMessage: 'legacy stream',
          contextItems: [],
          selection: '',
          source: 'shell',
          obsidianContext: undefined,
          userProfile: null,
        },
      },
      {
        type: 'queryStream',
        receivedSignal: signal,
      },
    ]);
  });

  await test('getProviderCapabilities returns static capabilities for the active provider type', async () => {
    const service: any = Object.create(ModelService.prototype);
    // openai-compatible：不支持图像输入、支持自定义 baseUrl（model-catalog 静态表）。
    service.settings = { activeProvider: 'openai' };
    service.getActiveProviderConfig = () => ({ type: 'openai-compatible' });

    expect(service.getProviderCapabilities()).toEqual({
      supportsThinking: true,
      supportsModelListing: true,
      supportsImageInput: false,
      supportsToolCalling: true,
      supportsCustomBaseUrl: true,
    });
  });

  await test('generate prefixes guardian prompts with generation-plan metadata while staying stateless', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.buildNativeCompleteFn = () => async (prompt: string, systemPrompt?: string) => {
      calls.push({ prompt, systemPrompt });
      return '{"type":"none"}';
    };
    service.memoryManager = {
      getProfile: () => ({
        preferences: {
          responseStyle: 'balanced',
        },
      }),
    };

    const result = await service.generate(
      'guardian prompt',
      'Return ONLY JSON.',
      'guardian',
      {
        activeNote: { path: 'Daily/2026-05-13.md', title: '2026-05-13' },
        selection: null,
        activeHeading: '## Draft',
        frontmatter: {},
        tags: [],
        outgoingLinks: [],
        backlinks: [],
        recentNotes: [],
        explicitScopes: [],
        contextItems: [],
      },
    );

    expect(result).toEqual('{"type":"none"}');
    expect(calls).toEqual([{
      prompt: calls[0].prompt,
      systemPrompt: 'Return ONLY JSON.',
    }]);
    expect(calls[0].prompt.includes('[Generation Plan]')).toEqual(true);
    expect(calls[0].prompt.includes('Source: guardian')).toEqual(true);
    expect(calls[0].prompt.includes('Mode: co-write')).toEqual(true);
  });

  await test('generate can bypass generation-plan metadata for raw guardian prompts', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.buildNativeCompleteFn = () => async (prompt: string, systemPrompt?: string, options?: any) => {
      calls.push({ prompt, systemPrompt, options });
      return '{"type":"completion","suggestion":"raw continuation"}';
    };
    service.memoryManager = {
      getProfile: () => null,
    };

    const result = await service.generate(
      'guardian prompt',
      'Return ONLY JSON.',
      'guardian',
      {
        activeNote: { path: 'Daily/2026-05-13.md', title: '2026-05-13' },
        selection: null,
        activeHeading: '## Draft',
        frontmatter: {},
        tags: [],
        outgoingLinks: [],
        backlinks: [],
        recentNotes: [],
        explicitScopes: [],
        contextItems: [],
      },
      null,
      {
        temperature: 0.2,
        skipGenerationPlan: true,
      } as any,
    );

    expect(result).toEqual('{"type":"completion","suggestion":"raw continuation"}');
    expect(calls[0].prompt).toEqual('guardian prompt');
    expect(calls[0].options).toEqual({ temperature: 0.2 });
  });

  await test('generate forwards guardian generation options to the provider', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];

    service.hasValidConfig = () => true;
    service.getActiveProviderConfig = () => ({ label: 'Test Provider' });
    service.buildNativeCompleteFn = () => async (prompt: string, systemPrompt?: string, options?: any) => {
      calls.push({ prompt, systemPrompt, options });
      return '{"type":"none"}';
    };
    service.memoryManager = {
      getProfile: () => null,
    };

    await service.generate(
      'guardian prompt',
      'Return ONLY JSON.',
      'guardian',
      {
        activeNote: { path: 'Daily/2026-05-13.md', title: '2026-05-13' },
        selection: null,
        activeHeading: '## Draft',
        frontmatter: {},
        tags: [],
        outgoingLinks: [],
        backlinks: [],
        recentNotes: [],
        explicitScopes: [],
        contextItems: [],
      },
      null,
      {
        temperature: 0.2,
        maxTokens: 64,
        timeoutMs: 5000,
      },
    );

    // timeoutMs 已不再透传给生成层（pi 用原生 signal 硬中断），仅 temperature/maxTokens 保留。
    expect(calls[0].options).toEqual({
      temperature: 0.2,
      maxTokens: 64,
    });
  });

  await test('getAvailableModels uses fallbacks without calling provider when api key is missing', async () => {
    const service: any = Object.create(ModelService.prototype);
    let listModelsCalled = false;

    service.settings = {
      activeProvider: 'openai',
      providers: {
        openai: {
          type: 'openai-compatible',
          label: 'OpenAI',
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        },
      },
    };
    service.modelListCache = new Map();
    service.modelListCacheTtlMs = 10 * 60 * 1000;
    service.getActiveProviderConfig = () => service.settings.providers.openai;

    // apiKey 为空 → getAvailableModels 的守卫直接跳过 model-catalog 的网络列模型，
    // 回落到 fallback 列表。listModelsCalled 保持 false 即证明未触发任何网络查询。
    const models = await service.getAvailableModels(true);

    expect(listModelsCalled).toEqual(false);
    expect(models.some((model: any) => model.value === 'gpt-4o')).toEqual(true);
  });

  // ---- Anthropic Messages 三分支接线 ----
  // 这三条合起来锁住 issue #58 part 2 的核心回归：'anthropic' 绝不能静默落到
  // OpenAI-compatible 分支（那会发 /chat/completions 而不是 /v1/messages）。

  await test('buildModelForConfig dispatches gemini / anthropic / openai-compatible explicitly', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.settings = { contextWindow: 100000, thinkingLevel: 'medium' };

    const gemini = service.buildModelForConfig({
      type: 'gemini', label: 'Gemini', apiKey: 'k', baseUrl: '', model: 'gemini-2.5-flash',
    });
    expect(gemini.api).toEqual('google-generative-ai');
    expect(gemini.provider).toEqual('google');

    const anthropic = service.buildModelForConfig({
      type: 'anthropic', label: 'Anthropic', apiKey: 'k',
      baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
    });
    expect(anthropic.api).toEqual('anthropic-messages');
    expect(anthropic.provider).toEqual('anthropic');
    expect(anthropic.baseUrl).toEqual('https://api.anthropic.com');
    expect(anthropic.id).toEqual('claude-sonnet-4-5');
    // Anthropic Messages 协议要求 max_tokens 必填
    expect(anthropic.maxTokens).toEqual(8192);

    const openai = service.buildModelForConfig({
      type: 'openai-compatible', label: 'OpenAI', apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
    });
    expect(openai.api).toEqual('openai-completions');
    expect(openai.provider).toEqual('openai');
  });

  await test('buildModelForConfig threads settings.contextWindow/thinkingLevel into the anthropic model', async () => {
    const service: any = Object.create(ModelService.prototype);
    service.settings = { contextWindow: 200000, thinkingLevel: 'off' };

    const model = service.buildModelForConfig({
      type: 'anthropic', label: 'Anthropic', apiKey: 'k',
      baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
    });
    expect(model.contextWindow).toEqual(200000);
    // thinkingLevel='off' → 不发 thinking 字段
    expect(model.reasoning).toEqual(false);
  });

  await test('getAvailableModels falls back to Claude models for anthropic without an api key', async () => {
    const service: any = Object.create(ModelService.prototype);

    service.settings = {
      activeProvider: 'anthropic',
      providers: {
        anthropic: {
          type: 'anthropic',
          label: 'Anthropic',
          apiKey: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
        },
      },
    };
    service.modelListCache = new Map();
    service.modelListCacheTtlMs = 10 * 60 * 1000;
    service.getActiveProviderConfig = () => service.settings.providers.anthropic;

    // apiKey 为空 → 不走网络列模型，回落到内置 Claude 列表，
    // 保证下拉框非空（兼容网关常常没有 GET /v1/models）。
    const models = await service.getAvailableModels(true);

    expect(models.some((model: any) => model.value === 'claude-sonnet-4-5')).toEqual(true);
    expect(models.some((model: any) => model.value === 'claude-opus-4-5')).toEqual(true);
    expect(models.some((model: any) => model.value === 'claude-haiku-4-5')).toEqual(true);
  });

  // ---- 模型列表状态：让 settings 面板不必再靠数组形状猜 ----
  // 契约：listingUnsupported 为 true **仅当** listModels 抛 ModelListingUnsupportedError
  // （列模型端点 404/405/501）；其他失败进 error；两者都空 = models 是端点真实清单。

  function serviceWithListingEndpoint(requestUrlImpl: (opts: any) => any) {
    const service: any = Object.create(ModelService.prototype);
    service.settings = {
      activeProvider: 'anthropic',
      providers: {
        anthropic: {
          type: 'anthropic',
          label: 'Anthropic',
          apiKey: 'sk-ant-test',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
        },
      },
    };
    service.modelListCache = new Map();
    service.modelListCacheTtlMs = 10 * 60 * 1000;
    service.getActiveProviderConfig = () => service.settings.providers.anthropic;
    return { service, deps: { requestUrl: requestUrlImpl } as any };
  }

  await test('getAvailableModelsWithStatus: 404 列表端点 → listingUnsupported=true 且不带 error', async () => {
    const { service, deps } = serviceWithListingEndpoint(() => ({ status: 404, text: 'not found' }));

    const result = await service.getAvailableModelsWithStatus(true, deps);

    expect(result.listingUnsupported).toEqual(true);
    expect(result.error).toEqual(undefined);
    // 仍然给出可渲染的兜底列表（UI 不能空着）
    expect(result.models.some((model: any) => model.value === 'claude-sonnet-4-5')).toEqual(true);
  });

  await test('getAvailableModelsWithStatus: 405 / 501 也算 listingUnsupported', async () => {
    for (const status of [405, 501]) {
      const { service, deps } = serviceWithListingEndpoint(() => ({ status, text: '' }));
      const result = await service.getAvailableModelsWithStatus(true, deps);
      expect(result.listingUnsupported).toEqual(true);
    }
  });

  await test('getAvailableModelsWithStatus: 401 是故障而不是能力缺口 → error 有值、listingUnsupported=false', async () => {
    const { service, deps } = serviceWithListingEndpoint(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' }));

    const result = await service.getAvailableModelsWithStatus(true, deps);

    expect(result.listingUnsupported).toEqual(false);
    expect(result.error instanceof Error).toEqual(true);
    expect(result.error.message.includes('401')).toEqual(true);
    expect(result.models.some((model: any) => model.value === 'claude-sonnet-4-5')).toEqual(true);
  });

  await test('getAvailableModelsWithStatus: 未配置 apiKey → error 有值、listingUnsupported=false、不发请求', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 200, text: '{"data":[]}' };
    });
    service.settings.providers.anthropic.apiKey = '';

    const result = await service.getAvailableModelsWithStatus(true, deps);

    expect(requests).toEqual(0);
    expect(result.listingUnsupported).toEqual(false);
    expect(result.error.message.includes('API Key')).toEqual(true);
    expect(result.models.some((model: any) => model.value === 'claude-sonnet-4-5')).toEqual(true);
  });

  await test('getAvailableModelsWithStatus: 端点正常列模型 → 两者都空，models 来自端点', async () => {
    const { service, deps } = serviceWithListingEndpoint(() => ({
      status: 200,
      text: JSON.stringify({ data: [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' }] }),
    }));

    const result = await service.getAvailableModelsWithStatus(true, deps);

    expect(result.listingUnsupported).toEqual(false);
    expect(result.error).toEqual(undefined);
    expect(result.models.some((model: any) => model.value === 'claude-opus-4-5')).toEqual(true);
  });

  await test('getAvailableModelsWithStatus: listingUnsupported 走缓存，第二次不再打端点', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 404, text: 'not found' };
    });

    const first = await service.getAvailableModelsWithStatus(true, deps);
    const second = await service.getAvailableModelsWithStatus(false, deps);

    expect(requests).toEqual(1);
    expect(first.listingUnsupported).toEqual(true);
    expect(second.listingUnsupported).toEqual(true);
  });

  await test('getAvailableModels stays a thin wrapper over getAvailableModelsWithStatus', async () => {
    const { service, deps } = serviceWithListingEndpoint(() => ({
      status: 200,
      text: JSON.stringify({ data: [{ id: 'claude-opus-4-5' }] }),
    }));

    // 先用注入的 deps 把「端点真实清单」灌进缓存（缓存键与调用方无关）
    const withStatus = await service.getAvailableModelsWithStatus(true, deps);
    // 薄包装只接受 forceRefresh，此处命中同一份缓存，必须给出同一个列表
    const plain = await service.getAvailableModels(false);

    expect(plain).toEqual(withStatus.models);
    expect(plain.some((model: any) => model.value === 'claude-opus-4-5')).toEqual(true);
  });

  // ---- 缓存命中路径必须复现「失败」状态（WP-B 集成时抓到的 bug）----
  // 症状：失败结果进缓存时只存了 models，丢掉 error；于是第一次（forceRefresh）报错，
  // 之后每次非 forceRefresh 的调用都既无 error 也无 listingUnsupported → UI 谎报 listed。
  // 非 forceRefresh 正是每次重渲染走的路，所以这几条必须直接盯住缓存命中路径。

  await test('cached failure replays error on a non-forced call (401 must not become "listed")', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 401, text: '{"error":{"message":"bad key"}}' };
    });

    const forced = await service.getAvailableModelsWithStatus(true, deps);
    // 关键：不传 forceRefresh，模拟「重渲染」
    const cached = await service.getAvailableModelsWithStatus(false, deps);

    expect(requests).toEqual(1);
    expect(forced.error instanceof Error).toEqual(true);
    expect(forced.listingUnsupported).toEqual(false);
    // 缓存命中必须给出同样的判定，而不是「两者皆空 = 已列出」
    expect(cached.error instanceof Error).toEqual(true);
    expect(cached.error.message.includes('401')).toEqual(true);
    expect(cached.listingUnsupported).toEqual(false);
    expect(cached.models).toEqual(forced.models);
  });

  await test('cached listingUnsupported replays as true with no error on a non-forced call', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 404, text: 'not found' };
    });

    await service.getAvailableModelsWithStatus(true, deps);
    const cached = await service.getAvailableModelsWithStatus(false, deps);

    expect(requests).toEqual(1);
    expect(cached.listingUnsupported).toEqual(true);
    expect(cached.error).toEqual(undefined);
  });

  await test('cached success replays as neither error nor listingUnsupported', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 200, text: JSON.stringify({ data: [{ id: 'claude-opus-4-5' }] }) };
    });

    await service.getAvailableModelsWithStatus(true, deps);
    const cached = await service.getAvailableModelsWithStatus(false, deps);

    expect(requests).toEqual(1);
    expect(cached.error).toEqual(undefined);
    expect(cached.listingUnsupported).toEqual(false);
    expect(cached.models.some((model: any) => model.value === 'claude-opus-4-5')).toEqual(true);
  });

  await test('cached "missing api key" failure also replays on a non-forced call', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      return { status: 200, text: '{"data":[]}' };
    });
    service.settings.providers.anthropic.apiKey = '';

    await service.getAvailableModelsWithStatus(true, deps);
    const cached = await service.getAvailableModelsWithStatus(false, deps);

    expect(requests).toEqual(0);
    expect(cached.error instanceof Error).toEqual(true);
    expect(cached.error.message.includes('API Key')).toEqual(true);
    expect(cached.listingUnsupported).toEqual(false);
  });

  await test('forceRefresh escapes a cached failure and retries the endpoint', async () => {
    let requests = 0;
    const { service, deps } = serviceWithListingEndpoint(() => {
      requests += 1;
      // 第一次失败，之后恢复：证明缓存不是「失败粘住 10 分钟」的死结
      return requests === 1
        ? { status: 401, text: '{"error":{"message":"bad key"}}' }
        : { status: 200, text: JSON.stringify({ data: [{ id: 'claude-opus-4-5' }] }) };
    });

    const failed = await service.getAvailableModelsWithStatus(true, deps);
    const retried = await service.getAvailableModelsWithStatus(true, deps);

    expect(requests).toEqual(2);
    expect(failed.error instanceof Error).toEqual(true);
    expect(retried.error).toEqual(undefined);
    expect(retried.listingUnsupported).toEqual(false);
    expect(retried.models.some((model: any) => model.value === 'claude-opus-4-5')).toEqual(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
