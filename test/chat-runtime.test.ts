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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
