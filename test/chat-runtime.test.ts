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
  console.log('=== ChatRuntime Tests ===');
  const { createChatRuntime } = await import('../src/runtime/runtime-factory');
  const { setRuntimeEngineForTesting } = await import('../src/runtime/runtime-engine');
  setRuntimeEngineForTesting('legacy');
  const createObsidianContext = (overrides: Record<string, any> = {}) => ({
    activeNote: { path: 'Projects/Native AI.md', title: 'Native AI' },
    selection: { text: 'Bad sentence.', from: 1, to: 1 },
    activeHeading: '## Draft',
    frontmatter: {},
    tags: ['#native-ai'],
    outgoingLinks: ['[[Roadmap]]'],
    backlinks: [],
    recentNotes: [],
    explicitScopes: [],
    contextItems: [],
    ...overrides,
  });

  await test('prepareTurn builds a prompt with memory, context, selection, and user request', async () => {
    const runtime = createChatRuntime({
      provider: {} as any,
      memoryManager: {
        ready: async () => { },
        buildContext: () => '[Memory Context]',
        getOrCreateSession: () => { throw new Error('not used'); },
        recordMessage: async () => { },
      } as any,
      toolRegistry: {
        getAllDefinitions: () => [],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'Explain this',
      contextItems: [{ type: 'file', data: 'note.md', content: 'note body' }],
      selection: 'selected line',
    });

    expect(prepared.prompt.includes('[Memory Context]')).toBe(true);
    expect(prepared.prompt.includes('[Context: [Context (file): note.md]\nnote body]')).toBe(true);
    expect(prepared.prompt.includes('[Selected Text: selected line]')).toBe(true);
    expect(prepared.prompt.includes('User Request: Explain this')).toBe(true);
  });

  await test('runtime recalls relevant memory and retains completed turns', async () => {
    const memoryCalls: any[] = [];
    const providerInputs: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            providerInputs.push(input);
            return { text: 'Done' };
          },
        }),
      } as any,
      memoryManager: {
        ready: async () => undefined,
        buildContext: () => '',
        recallForPrompt: async (input: any) => {
          memoryCalls.push({ type: 'recallForPrompt', input });
          return '[Relevant Memory]\n- world: User prefers local-first memory.\n';
        },
        retainTurn: async (input: any) => {
          memoryCalls.push({ type: 'retainTurn', input });
        },
        getOrCreateSession: () => {
          throw new Error('provider chat session should be scoped to the runtime turn');
        },
        recordMessage: async () => undefined,
      } as any,
      toolRegistry: {
        getAllDefinitions: () => [],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const turn = await runtime.prepareTurn({
      userMessage: 'Design memory for Baizer',
      contextItems: [],
      selection: '',
      source: 'shell',
    });
    const response = await runtime.query(turn);

    expect(turn.prompt).toContain('[Relevant Memory]');
    expect(response).toBe('Done');
    expect(providerInputs.length).toBe(1);
    expect(memoryCalls[0].type).toBe('recallForPrompt');
    expect(memoryCalls[memoryCalls.length - 1].type).toBe('retainTurn');
  });

  await test('prepareTurn activates the matched intent skill and scopes turn tools', async () => {
    const runtime = createChatRuntime({
      provider: {} as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'search_vault', description: 'Search vault', parameters: {} },
          { name: 'save_webpage', description: 'Save webpage', parameters: {} },
        ],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: (message: string) => (
          message.includes('save') ? { name: 'web-clipper' } : null
        ),
        getSkillSummaryText: () => '- web-clipper: Save webpages',
        activateSkill: (name: string) => (
          name === 'web-clipper'
            ? {
                skill: { name: 'web-clipper' },
                instructions: 'Use save_webpage to save the requested page.',
                tools: [{ name: 'save_webpage', description: 'Save webpage', parameters: {} }],
              }
            : null
        ),
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'Please save this webpage',
      contextItems: [],
    });

    expect((prepared as any).activeSkillName).toBe('web-clipper');
    expect((prepared as any).allowedToolNames).toEqual(['save_webpage']);
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['save_webpage', 'use_skill']);
    expect(prepared.prompt.includes('Use save_webpage to save the requested page.')).toBe(true);
  });

  await test('prepareTurn adds a file-operation contract for write requests', async () => {
    const runtime = createChatRuntime({
      provider: {} as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'create_file', description: 'Create file', parameters: {} },
          { name: 'update_file', description: 'Update file', parameters: {} },
        ],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: '帮我创建一个canvas文件，总结当前文章',
      contextItems: [],
    });

    expect(prepared.prompt.includes('[File Operation Contract]')).toBe(true);
    expect(prepared.prompt.includes('must call an appropriate vault write tool')).toBe(true);
    expect(prepared.prompt.includes('Do not provide copy-paste instructions')).toBe(true);
  });

  await test('prepareTurn constrains assistant-visible slash commands to registered commands', async () => {
    const runtime = createChatRuntime({
      provider: {} as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        listCommandEntries: () => [
          { command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' },
          { command: '/wiki:query', skillName: 'knowledge', description: 'Query the knowledge wiki' },
        ],
        activateSkill: () => null,
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'Say hello and suggest next actions',
      contextItems: [],
    });

    expect(prepared.prompt).toContain('[Slash Command Contract]');
    expect(prepared.prompt).toContain('`/clear`');
    expect(prepared.prompt).toContain('`/memory [overview|observations|search <query>|forget <field>]`');
    expect(prepared.prompt.includes('/profile')).toBe(false);
    expect(prepared.prompt.includes('/forget [field]')).toBe(false);
    expect(prepared.prompt).toContain('`/save`');
    expect(prepared.prompt).toContain('Do not mention or recommend slash commands that are not listed here');
    expect(prepared.prompt).toContain('Do not invent generic commands like `/do` or `/ask`');
  });

  await test('prepareTurn injects generation-plan metadata for rewrite flows', async () => {
    const runtime = createChatRuntime({
      provider: {} as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: '把这段话改写得更清晰',
      contextItems: [{ type: 'file', data: 'Projects/Native AI.md', content: '## Draft\nBad sentence.' }],
      selection: 'Bad sentence.',
      source: 'slash-edit',
      obsidianContext: createObsidianContext(),
      userProfile: {
        name: 'Ada',
        profession: 'Engineer',
        expertise: [],
        preferences: {
          language: 'zh-CN',
          responseStyle: 'detailed',
          topics: [],
        },
        workflows: [],
        context: {
          currentProjects: [],
          goals: [],
          challenges: [],
        },
        metadata: {
          createdAt: 1,
          updatedAt: 1,
          totalInteractions: 1,
          lastProfileUpdate: 1,
        },
      },
    } as any);

    expect((prepared as any).generationPlan).toEqual({
      source: 'slash-edit',
      mode: 'rewrite',
      targetShape: 'replacement',
      previewRequired: true,
      mustPreserveVoice: true,
      mustUseObsidianMarkdown: true,
      qualityChecklist: [
        'Return only the revised replacement text.',
        'Preserve markdown structure, links, and task syntax.',
        'Improve clarity or structure beyond surface-level word swaps.',
      ],
    });
    expect(prepared.prompt.includes('[Generation Plan]')).toBe(true);
    expect(prepared.prompt.includes('Mode: rewrite')).toBe(true);
    expect(prepared.prompt.includes('Target Shape: replacement')).toBe(true);
    expect(prepared.prompt.includes('Return only the revised replacement text.')).toBe(true);
  });

  await test('query resolves use_skill and tool calls through the runtime loop', async () => {
    const chatInputs: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            chatInputs.push(input);
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  { name: 'use_skill', args: { name: 'web-search' } },
                  { name: 'search_vault', args: { query: 'obsidian' } },
                ],
              };
            }
            return { text: 'done' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [{ name: 'search_vault', description: 'Search vault', parameters: {} }],
        execute: async (name: string, args: any) => ({ name, args, ok: true }),
      } as any,
      skillRegistry: {
        getSkillSummaryText: () => '- web-search: Search the web',
        activateSkill: () => ({
          instructions: 'Use search tools',
          tools: [{ name: 'web_search', description: 'Search the web', parameters: {} }],
        }),
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [{ name: 'search_vault', description: 'Search vault', parameters: {} }],
    });

    expect(result).toBe('done');
    expect(chatInputs.length).toBe(2);
    expect(Array.isArray(chatInputs[1])).toBe(true);
  });

  await test('query preserves provider tool call ids when returning tool results', async () => {
    const chatInputs: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            chatInputs.push(input);
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  { id: 'call_tasks', name: 'read_note', args: { path: 'tasks.md' } },
                  { id: 'call_home', name: 'read_note', args: { path: 'home.md' } },
                ],
              };
            }
            return { text: 'done' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [{ name: 'read_note', description: 'Read note', parameters: {} }],
        execute: async (name: string, args: any) => ({ name, args, ok: true }),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [{ name: 'read_note', description: 'Read note', parameters: {} }],
    });

    const toolResultIds = chatInputs[1].map((input: any) => input.id).join(',');

    expect(result).toBe('done');
    expect(toolResultIds).toBe('call_tasks,call_home');
  });

  await test('query blocks tool calls outside the active skill scope after use_skill', async () => {
    const executedCalls: any[] = [];
    const toolResponses: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  { name: 'use_skill', args: { name: 'web-search' } },
                  { name: 'search_vault', args: { query: 'obsidian' } },
                ],
              };
            }
            toolResponses.push(...input);
            return { text: 'done' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'search_vault', description: 'Search vault', parameters: {} },
          { name: 'web_search', description: 'Search the web', parameters: {} },
        ],
        execute: async (name: string, args: any) => {
          executedCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '- web-search: Search the web',
        activateSkill: () => ({
          skill: { name: 'web-search' },
          instructions: 'Use web_search for internet lookups.',
          tools: [{ name: 'web_search', description: 'Search the web', parameters: {} }],
        }),
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [
        { name: 'search_vault', description: 'Search vault', parameters: {} },
        { name: 'web_search', description: 'Search the web', parameters: {} },
        { name: 'use_skill', description: 'Activate a skill', parameters: {} },
      ],
    } as any);

    expect(result).toBe('done');
    expect(executedCalls).toEqual([]);
    expect(toolResponses[1].response.error).toBe(
      'Tool "search_vault" is not available for active skill "web-search"'
    );
  });

  await test('query stops before the model can claim success when a tool requires approval', async () => {
    const chatInputs: any[] = [];
    const executedCalls: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            chatInputs.push(input);
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  {
                    name: 'create_file',
                    args: {
                      path: 'Assets/Canvas/summary.canvas',
                      content: '{"nodes":[],"edges":[]}',
                    },
                  },
                ],
              };
            }
            return { text: 'I created the canvas file.' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'create_file', description: 'Create file', parameters: {} },
        ],
        execute: async (name: string, args: any) => {
          executedCalls.push({ name, args });
          return {
            approval_required: true,
            action: 'create_file',
            target: args.path,
            args,
            message: `Approval required to create file: ${args.path}`,
          };
        },
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [{ name: 'create_file', description: 'Create file', parameters: {} }],
    });

    expect(result).toBe('Approval required to create file: Assets/Canvas/summary.canvas');
    expect(chatInputs.length).toBe(1);
    expect(executedCalls).toEqual([{
      name: 'create_file',
      args: {
        path: 'Assets/Canvas/summary.canvas',
        content: '{"nodes":[],"edges":[]}',
      },
    }]);
  });

  await test('query routes safe workspace write tools through WorkspaceEditService when available', async () => {
    const chatInputs: any[] = [];
    const registryCalls: any[] = [];
    const workspaceCalls: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            chatInputs.push(input);
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  {
                    id: 'call_update',
                    name: 'update_file',
                    args: {
                      path: 'Notes/source.md',
                      content: 'after',
                    },
                  },
                ],
              };
            }
            return { text: 'done' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'update_file', description: 'Update file', parameters: {} },
        ],
        execute: async (name: string, args: any) => {
          registryCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
      workspaceEditService: {
        executeWorkspaceTool: async (name: string, args: any) => {
          workspaceCalls.push({ name, args });
          return {
            success: true,
            path: args.path,
            workspaceEdit: {
              id: 'edit-1',
              action: name,
              path: args.path,
              kind: 'update',
              appliedAt: 1,
              status: 'applied',
            },
          };
        },
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [{ name: 'update_file', description: 'Update file', parameters: {} }],
    });

    expect(result).toBe('done');
    expect(registryCalls).toEqual([]);
    expect(workspaceCalls).toEqual([{
      name: 'update_file',
      args: {
        path: 'Notes/source.md',
        content: 'after',
      },
    }]);
    expect(chatInputs[1]).toEqual([{
      id: 'call_update',
      name: 'update_file',
      response: {
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
    }]);
  });

  await test('query returns a workspace warning when the write tool fails and the model still claims success', async () => {
    const chatInputs: any[] = [];
    const executedCalls: any[] = [];
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async (input: any) => {
            chatInputs.push(input);
            if (typeof input === 'string') {
              return {
                text: '',
                functionCalls: [
                  {
                    name: 'create_file',
                    args: {
                      path: '../summary.canvas',
                      content: '{"nodes":[],"edges":[]}',
                    },
                  },
                ],
              };
            }
            return { text: 'I created the canvas file.' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'create_file', description: 'Create file', parameters: {} },
        ],
        execute: async (name: string, args: any) => {
          executedCalls.push({ name, args });
          return {
            success: false,
            error: 'Unsafe vault path',
          };
        },
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'Create a canvas file',
      contextItems: [],
    });

    const result = await runtime.query(prepared);

    expect(result).toContain('No file was created or modified');
    expect(result).toContain('Unsafe vault path');
    expect(chatInputs.length).toBe(2);
    expect(executedCalls).toEqual([{
      name: 'create_file',
      args: {
        path: '../summary.canvas',
        content: '{"nodes":[],"edges":[]}',
      },
    }]);
  });

  await test('query blocks rewrite results that fail the generation quality check', async () => {
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessage: async () => ({
            text: 'Bad sentence.',
          }),
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [],
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '',
        activateSkill: () => null,
      } as any,
    });

    const result = await runtime.query({
      prompt: 'prepared prompt',
      tools: [],
      selection: 'Bad sentence.',
      generationPlan: {
        source: 'slash-edit',
        mode: 'rewrite',
        targetShape: 'replacement',
        previewRequired: true,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    } as any);

    expect(result).toContain('Generation quality check failed');
    expect(result).toContain('Generated text is too close to the original text.');
  });

  const makeContextRuntime = () => createChatRuntime({
    provider: {} as any,
    memoryManager: null,
    toolRegistry: {
      getAllDefinitions: () => [],
      execute: async () => ({}),
    } as any,
    skillRegistry: {
      resolveByIntent: () => null,
      getSkillSummaryText: () => '',
      activateSkill: () => null,
    } as any,
  });

  const ambientNote = () => ({
    id: 'active-note:Daily/2026/2026-06-24.md',
    type: 'file',
    data: 'Daily/2026/2026-06-24.md',
    summary: 'Active note: 2026-06-24',
    content: 'AI digest body that should not hijack a short confirmation.',
  });

  await test('[B] short confirmation with prior history strips ambient note context', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
      priorMessages: [
        { role: 'user', content: '日记里的链接为什么点不动' },
        { role: 'model', content: '可以改成 wikilink，要我帮你改吗' },
      ],
    } as any);

    // 当前笔记正文被剔除，模型不再被它带偏
    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.prompt.includes('Daily/2026/2026-06-24.md')).toBe(false);
    // 没有残留的环境上下文，就不该附定性说明
    expect(prepared.prompt.includes('[Context Note]')).toBe(false);
    expect(prepared.prompt.includes('User Request: 需要')).toBe(true);
  });

  await test('[B] "用第二个方法" is treated as a continuation and strips ambient context', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '用第二个方法',
      contextItems: [ambientNote()],
      priorMessages: [
        { role: 'user', content: '链接点不动' },
        { role: 'model', content: '方法一：建文件；方法二：改绝对路径' },
      ],
    } as any);

    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.prompt.includes('User Request: 用第二个方法')).toBe(true);
  });

  await test('[B] continuation detection requires prior history', async () => {
    const runtime = makeContextRuntime();

    // 没有历史时，"需要" 不应剔除上下文（可能就是针对当前笔记的首轮请求）
    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
    } as any);

    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(true);
    // 保留了环境上下文，则附上定性说明
    expect(prepared.prompt.includes('[Context Note]')).toBe(true);
  });

  await test('[B] long substantive message keeps ambient context even with history', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '需要你把当前这篇文章整体改写得更精炼一些',
      contextItems: [ambientNote()],
      priorMessages: [
        { role: 'user', content: '前面的问题' },
        { role: 'model', content: '前面的回答' },
      ],
    } as any);

    // 实质性长请求不算确认，当前笔记上下文必须保留
    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(true);
  });

  await test('[A] explicit user-selected context is never stripped on confirmation', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '好的',
      contextItems: [
        ambientNote(),
        {
          id: 'user-scope:Projects/Plan.md',
          type: 'file',
          data: 'Projects/Plan.md',
          summary: 'User added: Plan',
          content: 'Explicitly attached project plan content.',
        },
      ],
      priorMessages: [
        { role: 'user', content: 'q' },
        { role: 'model', content: 'a' },
      ],
    } as any);

    // 环境笔记被剔除
    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(false);
    // 用户显式附加的上下文必须保留
    expect(prepared.prompt.includes('Explicitly attached project plan content.')).toBe(true);
  });

  await test('[A] ambient context on a normal request carries the conversation-wins disclaimer', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '总结一下这篇文章的要点',
      contextItems: [ambientNote()],
    } as any);

    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(true);
    expect(prepared.prompt.includes('[Context Note]')).toBe(true);
    expect(prepared.prompt.includes('follow the conversation')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
