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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
