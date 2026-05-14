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
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected "${actual}" not to contain "${expected}"`);
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

function createWorkspaceApp() {
  const opened: string[] = [];
  const files = new Map<string, any>();
  return {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => {
          if (!files.has(path)) files.set(path, { path, basename: path.split('/').pop() });
          return files.get(path);
        },
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: any) => {
            opened.push(file.path);
          },
        }),
      },
    } as any,
    opened,
  };
}

async function runTests() {
  console.log('=== ChatController Tests ===');
  const { ChatController } = await import('../src/ui/chat-controller');

  await test('processCommand routes matching slash commands through executeSlashSkillCommand first', async () => {
    const messages: any[] = [];
    const apiCalls = {
      executeSlashSkillCommand: [] as any[],
      chat: [] as any[],
    };

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [
          { command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' },
        ],
        executeSlashSkillCommand: async (command: string, input: string) => {
          apiCalls.executeSlashSkillCommand.push({ command, input });
          return { success: true, message: 'Saved note' };
        },
        chat: async (...args: any[]) => {
          apiCalls.chat.push(args);
          return 'fallback';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/save https://example.com');

    expect(apiCalls.executeSlashSkillCommand).toEqual([
      { command: '/save', input: 'https://example.com' },
    ]);
    expect(apiCalls.chat.length).toBe(0);
    expect(messages[messages.length - 1].content).toBe('Saved note');

    controller.cleanup();
  });

  await test('processCommand does not fall back to a removed local /save handler', async () => {
    const messages: any[] = [];
    const apiCalls = {
      chat: [] as any[],
    };

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => {
          apiCalls.chat.push(args);
          return 'fallback';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/save https://example.com');

    expect(apiCalls.chat.length).toBe(0);
    expect(messages[messages.length - 1].content).toBe('Unknown command: /save');

    controller.cleanup();
  });

  await test('processCommand normalizes legacy string context before calling api.chat', async () => {
    const chatCalls: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => {
          chatCalls.push(args);
          return 'normalized';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
    });

    await controller.processCommand('Explain this', 'Selected Text:\nalpha' as any, 'alpha');

    expect(chatCalls).toEqual([[
      'Explain this',
      [{
        id: 'legacy-selection-context',
        type: 'selection',
        data: 'Editor selection',
        summary: 'Editor selection',
        content: 'Selected Text:\nalpha',
      }],
      'alpha',
    ]]);

    controller.cleanup();
  });

  await test('help output keeps local commands concise and lists dynamic skill commands separately', async () => {
    const messages: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [
          { command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' },
          { command: '/wiki:query', skillName: 'knowledge', description: 'Query the knowledge wiki' },
        ],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/help');

    const help = messages[messages.length - 1].content;
    expect(help).toContain('## Shell Commands');
    expect(help).toContain('`/file-back <message-id>`');
    expect(help).toContain('## Skill Commands');
    expect(help).toContain('`/save`');
    expect(help).toContain('Save webpage to vault');
    expect(help).toContain('`/wiki:query`');
    expect(help).notToContain('`/save <url>`');

    controller.cleanup();
  });

  await test('streaming file write request warns when no write tool ran', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'Copy this JSON into a new canvas file.' };
          yield { type: 'done', text: 'Copy this JSON into a new canvas file.' };
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: (event) => streamEvents.push(event),
    });

    await controller.processCommand('Create a canvas file for this article');

    expect(messages.map(message => message.role)).toEqual(['user', 'system']);
    expect(messages[messages.length - 1].content).toContain('No file was created or modified');
    expect(streamEvents.map(event => event.type)).toEqual(['done']);

    controller.cleanup();
  });

  await test('streaming successful write tool result opens the file in the workspace', async () => {
    const { app, opened } = createWorkspaceApp();
    const messages: any[] = [];

    const controller = new ChatController({
      app,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield {
            type: 'tool_call',
            name: 'create_file',
            args: {
              path: 'Assets/Canvas/summary.canvas',
              content: '{"nodes":[],"edges":[]}',
            },
          };
          yield {
            type: 'tool_result',
            name: 'create_file',
            result: {
              success: true,
              path: 'Assets/Canvas/summary.canvas',
              message: 'File created: Assets/Canvas/summary.canvas',
            },
          };
          yield { type: 'done', text: 'Done.' };
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: () => { },
    });

    await controller.processCommand('Create a canvas file for this article');

    expect(opened).toEqual(['Assets/Canvas/summary.canvas']);
    expect(messages.map(message => message.role)).toEqual(['user']);

    controller.cleanup();
  });

  await test('streaming failed write tool result suppresses false success text and shows a workspace warning', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield {
            type: 'tool_call',
            name: 'create_file',
            args: {
              path: '../summary.canvas',
              content: '{"nodes":[],"edges":[]}',
            },
          };
          yield {
            type: 'tool_result',
            name: 'create_file',
            result: {
              success: false,
              error: 'Unsafe vault path',
            },
          };
          yield { type: 'text_delta', content: 'I created the canvas file.' };
          yield { type: 'done', text: 'I created the canvas file.' };
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: (event) => streamEvents.push(event),
    });

    await controller.processCommand('Create a canvas file for this article');

    expect(messages.map(message => message.role)).toEqual(['user', 'system']);
    expect(messages[messages.length - 1].content).toContain('No file was created or modified');
    expect(messages[messages.length - 1].content).toContain('Unsafe vault path');
    expect(streamEvents.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'done']);

    controller.cleanup();
  });

  await test('cancelActiveStream aborts the current streaming response and preserves partial text', async () => {
    const messages: any[] = [];
    const streamEvents: any[] = [];
    let abortSignalSeen = false;

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* (_query: string, _context: any[], _selection: string, signal?: AbortSignal) {
          if (!signal) {
            throw new Error('Expected chatStream to receive an AbortSignal');
          }
          abortSignalSeen = true;
          yield { type: 'text_delta', content: 'partial' as const };
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
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
      onMessageAdded: (message) => messages.push(message),
      onStreamEvent: (event) => streamEvents.push(event),
    });

    const run = controller.processCommand('Stream something');
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.cancelActiveStream();
    await run;

    expect(abortSignalSeen).toBe(true);
    expect(streamEvents).toEqual([
      { type: 'text_delta', content: 'partial' },
      { type: 'done', text: 'partial', interrupted: true },
    ]);
    expect(messages[0].content).toBe('Stream something');
    expect(messages[messages.length - 1]).toEqual({
      id: messages[messages.length - 1].id,
      role: 'system',
      content: 'Response stopped.',
      timestamp: messages[messages.length - 1].timestamp,
    });

    controller.cleanup();
  });

  await test('/edit sends the selected text through the unified slash-edit source', async () => {
    const messages: any[] = [];
    const chatCalls: any[] = [];
    const app = {
      workspace: {
        getActiveViewOfType: () => ({
          editor: {
            getSelection: () => 'Selected paragraph',
          },
        }),
      },
    };

    const controller = new ChatController({
      app: app as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => {
          chatCalls.push(args);
          return 'Edited result';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => ({
          preferences: {
            responseStyle: 'balanced',
          },
        }),
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/edit rewrite for clarity');

    expect(chatCalls).toEqual([[
      'rewrite for clarity',
      [],
      'Selected paragraph',
      'slash-edit',
    ]]);
    expect(messages[messages.length - 1].content).toBe('Edited result');

    controller.cleanup();
  });

  await test('buildSelectionRewritePreview turns the latest AI reply into a selection preview', async () => {
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'after',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
    });

    await controller.processCommand('Rewrite this', [], 'before', 'selection-menu');

    expect((controller as any).buildSelectionRewritePreview('before')).toEqual({
      kind: 'editor-selection-replace',
      target: 'current-selection',
      summary: 'Replace the current editor selection',
      oldContent: 'before',
      newContent: 'after',
      risk: 'medium',
      supportsPartialApply: true,
      undoable: true,
    });

    controller.cleanup();
  });

  await test('archiveMessage uses file_back_knowledge when the knowledge tool is available', async () => {
    const messages: any[] = [];
    const executedTools: any[] = [];
    const controller = new ChatController({
      app: {
        plugins: {
          plugins: {
            'obsidian-cli': {
              toolRegistry: {
                execute: async (action: string, args: Record<string, any>) => {
                  executedTools.push({ action, args });
                  return { success: true, path: 'Knowledge Wiki/Articles/fb_test.md' };
                },
              },
            },
          },
        },
      } as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    (controller as any).messages.push({
      id: 'ai-archive',
      role: 'ai',
      content: '## Decision\n\nUse a knowledge status panel for the current note.',
      timestamp: 5,
    });

    await controller.archiveMessage('ai-archive');

    expect(executedTools[0].action).toBe('file_back_knowledge');
    expect(executedTools[0].args.content).toContain('Use a knowledge status panel');
    expect(executedTools[0].args.source_queries[0]).toBe('Archived from AI message ai-archive');
    expect(messages[messages.length - 1].content).toContain('Archived to the knowledge wiki');

    controller.cleanup();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
