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

async function runTests() {
  console.log('=== ChatRuntime Tests ===');
  const { createChatRuntime } = await import('../src/runtime/runtime-factory');

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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
