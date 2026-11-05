(global as any).window = {
  setInterval,
  clearInterval,
};

import { readFileSync } from 'fs';
import { TFile, TFolder } from 'obsidian';

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
          if (!files.has(path)) {
            const file = new TFile();
            file.path = path;
            file.basename = path.split('/').pop() || '';
            files.set(path, file);
          }
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

  await test('write results pointing to folders never open them as files', async () => {
    let opened = false;
    const folder = new TFolder();
    folder.path = 'folder';
    const controller = new ChatController({
      app: { vault: { getAbstractFileByPath: () => folder },
        workspace: { getLeaf: () => ({ openFile: async () => { opened = true; } }) } } as any,
      api: {} as any,
    });
    await (controller as any).openFileFromToolResult('create_file', { success: true, path: 'folder' }, { path: 'folder' });
    expect(opened).toBe(false);
    controller.cleanup();
  });

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

  await test('/profile (alias of /memory) renders the Hindsight memory view', async () => {
    // 遗留 UserProfile 已退役(#6):/profile 现为 /memory 别名,统一走 getMemoryView。
    const messages: any[] = [];

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getMemoryView: async () => ({
          privacyMode: false,
          stats: { total: 1, world: 1, experience: 0, observation: 0, lastUpdatedAt: 1000 },
          sections: {
            observations: [],
            facts: [{ id: 'mem_fact', type: 'world', text: 'User is an Engineer.', confidence: 0.8, source: { kind: 'chat' }, mentionedAt: 1000 }],
            recent: [],
            searchResults: [],
            raw: [],
          },
        }),
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

    // #6 profile 退役后,/forget 只作用于 Hindsight,不再写 profile。
    expect(calls.map(call => call.type)).toEqual(['forgetMemory']);
    expect(calls[0].field).toBe('all');
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

    // #6 profile 退役后,/forget 只作用于 Hindsight,不再写 profile。
    expect(calls.map(call => call.type)).toEqual(['forgetMemory']);
    expect(calls[0].field).toBe('all');
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

    // 阶段1:UI 不再回灌 priorMessages。阶段A:末位透传 conversationId
    // (obsidianContext/userProfile/systemPromptOverride/conversationId 均为 undefined,
    //  此 controller 未配置 conversationId)。
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
      undefined,
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
      onMessageAdded: (message, options) => messages.push({ ...message, options }),
      onStreamEvent: () => { },
    });

    await controller.processCommand('Create a canvas file for this article');

    expect(opened).toEqual(['Assets/Canvas/summary.canvas']);
    // ADR 0002:ai 回复也走 onMessageAdded(唯一创建点),但带 alreadyRendered
    // ——宿主只写投影、不重画,屏幕上仍只有 stream 渲出的那一份。
    expect(messages.map(message => message.role)).toEqual(['user', 'ai']);
    expect(messages.map(message => message.options?.alreadyRendered)).toEqual([false, true]);

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
        chatStream: async function* (
          _query: string,
          _context: any[],
          _selection: string,
          _source?: any,
          _obsidianContext?: any,
          _userProfile?: any,
          signal?: AbortSignal,
        ) {
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
      { type: 'done', text: 'partial', outcome: 'cancelled', interrupted: true },
    ]);
    expect(messages[0].content).toBe('Stream something');
    // 取消不再另落一条 system 提示:终态卡片就是「已停止,答案不完整」的载体,
    // 且同一条 ai 消息带着 cancelled 终态持久化,回放不会把它画成成功。
    expect(messages.map(message => message.role)).toEqual(['user', 'ai']);
    const cancelled = messages[messages.length - 1];
    expect(cancelled.content).toBe('partial');
    expect(cancelled.metadata?.outcome).toBe('cancelled');
    expect(cancelled.metadata?.interrupted).toBe(true);

    controller.cleanup();
  });

  // 阶段1 移除:以下两个测试原本验证 UI 侧 buildPriorMessages 回灌跨轮历史(第 8 参 priorMessages)。
  // 该机制已删除——跨轮上下文改由 Harness 持久化 session 维护,UI 不再构造/转发历史。
  // 中断回答的过滤也随之下沉:Harness 只持久化真正完成的轮次。相应能力在 harness-session-manager
  // 与 harness-chat-runtime 层验证,此处不再复测已删除的 UI 行为。

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

  // ── issue #69 batch 1: getErrorText/getErrorName narrowing + isApprovalRequiredResult ──
  //
  // chat-controller.ts 把 14 处 `catch (error: any)` 换成了 `unknown` + 两个模块私有
  // 辅助函数 getErrorText/getErrorName，语义必须与旧的 `error?.message || fallback`
  // 逐值一致（包括真值非字符串 message 要显示，而不是被「只认字符串」悄悄丢弃）。
  // 两个函数都是模块私有，不可 import；下面优先走真实公开入口
  // (undoWorkspaceEdit 的 catch、processCommand 流式 catch 的 isAbortError 分支)
  // 实测行为，并用源码取证锁住实现没有在之后drift。

  const chatControllerSource = readFileSync('src/ui/chat-controller.ts', 'utf8');

  await test('getErrorText source: truthy message of any type is String()-ed, falsy/missing is undefined', () => {
    // 锁住实现没有退化成「只接受 Error」或「只接受 string message」。
    expect(chatControllerSource.includes('function getErrorText(error: unknown): string | undefined')).toBe(true);
    const bodyStart = chatControllerSource.indexOf('function getErrorText(error: unknown)');
    const body = chatControllerSource.slice(bodyStart, chatControllerSource.indexOf('\n}', bodyStart));
    expect(body.includes("typeof error === 'object' && error !== null")).toBe(true);
    // 真值但非字符串的 message(数字/布尔/普通对象)必须仍被转成文本返回,不能因为
    // 「只接受 string」而丢弃;具体转换手段允许随实现演进(当前用模板插值 + 显式
    // 抑制 no-base-to-string,而不是裸 `String()`),因此这里只锁语义、不锁字面写法。
    expect(body.includes("if (!message) return undefined;")).toBe(true);
    expect(body.includes("if (typeof message === 'string') return message;")).toBe(true);
    expect(/return\s*`\$\{message\}`;/.test(body)).toBe(true);
    expect(body.includes('instanceof Error')).toBe(false);
  });

  await test('getErrorName source: only a string name is accepted (mirrors `error?.name`, no coercion)', () => {
    expect(chatControllerSource.includes('function getErrorName(error: unknown): string | undefined')).toBe(true);
    const bodyStart = chatControllerSource.indexOf('function getErrorName(error: unknown)');
    const body = chatControllerSource.slice(bodyStart, chatControllerSource.indexOf('\n}', bodyStart));
    expect(body.includes("typeof name === 'string'")).toBe(true);
  });

  await test('undoWorkspaceEdit surfaces getErrorText(error) || fallback value-for-value through the real catch path', async () => {
    const cases: { thrown: unknown; expected: string }[] = [
      { thrown: new Error('boom'), expected: 'boom' },
      // 非 Error 但带 message 的对象：不能因为「只接受 Error」丢掉可读信息。
      { thrown: { message: 'denied' }, expected: 'denied' },
      // 跨 realm / null-prototype 对象照样能读到 message。
      { thrown: Object.assign(Object.create(null), { message: 'cross realm' }), expected: 'cross realm' },
      // 真值非字符串 message 必须显示，这正是 issue #69 明确禁止丢弃的那一格。
      { thrown: { message: 123 }, expected: '123' },
      { thrown: { message: true }, expected: 'true' },
      // 假值/缺失 message 落回调用方的 fallback 文案。
      { thrown: new Error(''), expected: 'Unable to undo workspace edit.' },
      { thrown: { message: 0 }, expected: 'Unable to undo workspace edit.' },
      { thrown: { message: false }, expected: 'Unable to undo workspace edit.' },
      { thrown: null, expected: 'Unable to undo workspace edit.' },
      { thrown: {}, expected: 'Unable to undo workspace edit.' },
      // 非对象抛出值同样没有 .message，原实现 `error?.message` 下也拿不到信息。
      { thrown: 'boom', expected: 'Unable to undo workspace edit.' },
      { thrown: 42, expected: 'Unable to undo workspace edit.' },
      { thrown: undefined, expected: 'Unable to undo workspace edit.' },
    ];

    for (const { thrown, expected } of cases) {
      const failed: string[] = [];
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
          undoWorkspaceEdit: async () => { throw thrown; },
        } as any,
        onWorkspaceEditUndoFailed: (message: string) => failed.push(message),
      });

      const result = await controller.undoWorkspaceEdit('edit-1');

      expect(result).toEqual({ success: false, error: expected });
      expect(failed).toEqual([expected]);

      controller.cleanup();
    }
  });

  await test('streaming catch tells AbortError (by name, via getErrorName) apart from an ordinary thrown error (via getErrorText)', async () => {
    // isAbortError() === getErrorName(error) === 'AbortError'. 一个带 AbortError 名字
    // 但不是 Error 实例的跨 realm/普通对象也要被认成中止，不能因为「只接受 Error.name」
    // 退化成走失败分支。
    const streamEventsAbort: any[] = [];
    const controllerAbort = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'partial' };
          throw Object.assign(Object.create(null), { name: 'AbortError', message: 'ignored' });
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onStreamEvent: (event: any) => streamEventsAbort.push(event),
    });

    await controllerAbort.processCommand('Stream something');

    expect(streamEventsAbort.map(event => event.type)).toEqual(['text_delta', 'done']);
    expect(streamEventsAbort[streamEventsAbort.length - 1].outcome).toBe('cancelled');
    controllerAbort.cleanup();

    // 真值非字符串 message（{ message: 123 }）走 getErrorText，在失败分支里原样显示为 '123'，
    // 不是因为「非 Error」或「非字符串」被丢弃成通用 fallback。
    const streamEventsFail: any[] = [];
    const controllerFail = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        chat: async () => 'fallback',
        chatStream: async function* () {
          yield { type: 'text_delta', content: 'partial' };
          throw { message: 123 };
        },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onStreamEvent: (event: any) => streamEventsFail.push(event),
    });

    await controllerFail.processCommand('Stream something');

    const errorEvent = streamEventsFail.find(event => event.type === 'error');
    expect(errorEvent.message).toBe('123');
    expect(streamEventsFail[streamEventsFail.length - 1].outcome).toBe('failed');
    controllerFail.cleanup();
  });

  await test('handleSlashCommand catch (getErrorText) reports a non-Error message instead of a generic fallback', async () => {
    const messages: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [{ command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' }],
        executeSlashSkillCommand: async () => { throw { message: 'denied' }; },
        chat: async () => 'fallback',
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message: any) => messages.push(message),
    });

    await controller.processCommand('/save https://example.com');

    expect(messages[messages.length - 1].content).toBe('Error: denied');
    controller.cleanup();
  });

  await test('isApprovalRequiredResult (toApprovalRequest) accepts a real approval-required payload and rejects a plain successful result', async () => {
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
      } as any,
    });

    const approvalPayload = {
      approval_required: true,
      action: 'delete_note',
      target: 'Notes/secret.md',
      requestId: 'req-1',
      args: { path: 'Notes/secret.md' },
      message: 'Delete this note?',
    };
    const approvalRequest = (controller as any).toApprovalRequest(approvalPayload);
    expect(approvalRequest).toEqual({
      id: 'req-1',
      conversationId: undefined,
      action: 'delete_note',
      target: 'Notes/secret.md',
      args: { path: 'Notes/secret.md' },
      message: 'Delete this note?',
      preview: undefined,
    });

    // 一个普通成功结果（没有 approval_required 判别位）必须被拒绝，不能误判成审批请求。
    const plainResult = { success: true, path: 'Notes/secret.md', message: 'Deleted.' };
    expect((controller as any).toApprovalRequest(plainResult)).toBe(null);

    // approval_required 为假值（非 true）也要被拒绝 —— 与原 `if (!result?.approval_required)` 的真值判断一致。
    expect((controller as any).toApprovalRequest({ approval_required: false, action: 'x', target: 'y' })).toBe(null);
    expect((controller as any).toApprovalRequest(null)).toBe(null);
    expect((controller as any).toApprovalRequest(undefined)).toBe(null);

    controller.cleanup();
  });

  await test('ToolResultView / isApprovalRequiredResult source shape: approval_required stays the discriminant, guard keeps truthy semantics', () => {
    const typesSource = readFileSync('src/ui/types.ts', 'utf8');
    expect(typesSource.includes('export interface ToolResultView {')).toBe(true);
    expect(typesSource.includes('export type ApprovalRequiredToolResult = ToolResultView & {')).toBe(true);
    expect(typesSource.includes('approval_required: true;')).toBe(true);
    expect(typesSource.includes('export function isApprovalRequiredResult(')).toBe(true);
    expect(typesSource.includes('return !!result?.approval_required;')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
