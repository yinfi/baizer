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

  await test('/profile renders hindsight memory profile text when available', async () => {
    const messages: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => ({
          profession: 'Engineer',
          expertise: ['Obsidian'],
          preferences: { responseStyle: 'balanced' },
          context: { currentProjects: ['Memory'], goals: [] },
        }),
        updateProfile: async () => undefined,
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/profile');

    expect(messages[messages.length - 1].content).toContain('Engineer');
    controller.cleanup();
  });

  await test('/memory overview renders Hindsight memory view', async () => {
    const messages: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getMemoryView: async () => ({
          privacyMode: false,
          stats: { total: 2, world: 1, experience: 1, observation: 0, lastUpdatedAt: 2000 },
          sections: {
            observations: [],
            facts: [{
              id: 'mem_fact',
              type: 'world',
              text: 'User stated: I prefer local-first memory.',
              confidence: 0.75,
              tags: ['preference'],
            }],
            recent: [{
              id: 'mem_recent',
              type: 'experience',
              text: 'Assistant outcome: Acknowledged.',
              confidence: 0.55,
              tags: ['assistant-outcome'],
            }],
            searchResults: [],
            raw: [],
          },
          legacyProfile: null,
        }),
        getUserProfile: () => null,
        updateProfile: async () => undefined,
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/memory overview');

    const content = messages[messages.length - 1].content;
    expect(content).toContain('Hindsight Memory');
    expect(content).toContain('Total: 2');
    expect(content).toContain('local-first memory');
    controller.cleanup();
  });

  await test('/forget all clears profile and hindsight memories', async () => {
    const messages: any[] = [];
    const calls: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => ({
          name: 'User',
          profession: 'Engineer',
          expertise: ['Obsidian'],
          preferences: { responseStyle: 'balanced' },
          workflows: [],
          context: { currentProjects: ['LaunchPlan'], goals: ['Ship memory'], challenges: [] },
          metadata: { totalInteractions: 1, updatedAt: 1, lastProfileUpdate: 1 },
        }),
        updateProfile: async (updates: any) => {
          calls.push({ type: 'updateProfile', updates });
        },
        forgetMemory: async (field: string) => {
          calls.push({ type: 'forgetMemory', field });
        },
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/forget all');

    expect(calls.map(call => call.type)).toEqual(['updateProfile', 'forgetMemory']);
    expect(calls[1].field).toBe('all');
    expect(messages[messages.length - 1].content).toContain('Cleared all remembered user data');
    controller.cleanup();
  });

  await test('/memory forget all clears profile and hindsight memories', async () => {
    const messages: any[] = [];
    const calls: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => ({
          name: 'User',
          profession: 'Engineer',
          expertise: ['Obsidian'],
          preferences: { responseStyle: 'balanced' },
          workflows: [],
          context: { currentProjects: ['LaunchPlan'], goals: ['Ship memory'], challenges: [] },
          metadata: { totalInteractions: 1, updatedAt: 1, lastProfileUpdate: 1 },
        }),
        updateProfile: async (updates: any) => {
          calls.push({ type: 'updateProfile', updates });
        },
        forgetMemory: async (field: string) => {
          calls.push({ type: 'forgetMemory', field });
          return { success: true, deletedCount: 2, message: `forgot ${field}` };
        },
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/memory forget all');

    expect(calls.map(call => call.type)).toEqual(['updateProfile', 'forgetMemory']);
    expect(calls[1].field).toBe('all');
    expect(messages[messages.length - 1].content).toContain('forgot all');
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
      'shell',
      undefined,
      undefined,
      undefined,
      [],
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
    expect(help).toContain('`/memory [overview|observations|search <query>|forget <field>]`');
    expect(help).notToContain('`/profile`');
    expect(help).notToContain('`/forget [field]`');
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

  await test('streaming workspace edit result notifies the shell undo surface', async () => {
    const { app } = createWorkspaceApp();
    const edits: any[] = [];

    const controller = new ChatController({
      app,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield {
            type: 'tool_result',
            name: 'update_file',
            result: {
              success: true,
              path: 'Notes/source.md',
              workspaceEdit: {
                id: 'edit-1',
                action: 'update_file',
                path: 'Notes/source.md',
                kind: 'update',
                appliedAt: 1,
                status: 'applied',
              },
            },
          };
          yield { type: 'done', text: 'Done.' };
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onStreamEvent: () => { },
      onWorkspaceEdit: (edit) => edits.push(edit),
    });

    await controller.processCommand('Update this file');

    expect(edits).toEqual([{
      id: 'edit-1',
      action: 'update_file',
      path: 'Notes/source.md',
      kind: 'update',
      appliedAt: 1,
      status: 'applied',
    }]);

    controller.cleanup();
  });

  await test('undoWorkspaceEdit delegates to the model service and reports success', async () => {
    const calls: string[] = [];
    const undone: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
        undoWorkspaceEdit: async (editId: string) => {
          calls.push(editId);
          return { success: true, edit: { id: editId, status: 'undone', path: 'Notes/source.md' } };
        },
      } as any,
      onWorkspaceEditUndone: (edit) => undone.push(edit),
    });

    const result = await controller.undoWorkspaceEdit('edit-1');

    expect(result).toEqual({ success: true, edit: { id: 'edit-1', status: 'undone', path: 'Notes/source.md' } });
    expect(calls).toEqual(['edit-1']);
    expect(undone).toEqual([{ id: 'edit-1', status: 'undone', path: 'Notes/source.md' }]);

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

  await test('second turn forwards prior user and AI messages so the model keeps context', async () => {
    const chatCalls: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => {
          chatCalls.push(args);
          return 'Method one: create the files. Method two: use absolute links.';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
    });

    await controller.processCommand('Why can the links not jump?');
    await controller.processCommand('Use the second method');

    // 第一轮没有历史
    expect(chatCalls[0][7]).toEqual([]);
    // 第二轮必须带上第一轮的 user 提问 + AI 回答，否则模型看不到"两个方法"
    expect(chatCalls[1][7]).toEqual([
      { role: 'user', content: 'Why can the links not jump?' },
      { role: 'model', content: 'Method one: create the files. Method two: use absolute links.' },
    ]);

    controller.cleanup();
  });

  await test('interrupted AI replies are excluded from prior messages', async () => {
    const chatCalls: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async (...args: any[]) => {
          chatCalls.push(args);
          return 'ok';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
    });

    (controller as any).messages.push(
      { id: 'u0', role: 'user', content: 'earlier question', timestamp: 1 },
      { id: 'a0', role: 'ai', content: 'partial answer', timestamp: 2, metadata: { interrupted: true } },
      { id: 's0', role: 'system', content: 'Session cleared.', timestamp: 3 },
    );

    await controller.processCommand('next question');

    // 中断的 AI 回答和 system 消息都不应进入历史
    expect(chatCalls[0][7]).toEqual([
      { role: 'user', content: 'earlier question' },
    ]);

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
            baizer: {
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
