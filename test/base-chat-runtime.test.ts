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
  console.log('=== BaseChatRuntime Prepare-Layer Tests ===');
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
      memoryManager: {
        ready: async () => { },
        buildContext: () => '[Memory Context]',
        recallForPrompt: async () => '[Memory Context]',
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

  await test('runtime recalls relevant memory during prepareTurn', async () => {
    const memoryCalls: any[] = [];
    const runtime = createChatRuntime({
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

    expect(turn.prompt).toContain('[Relevant Memory]');
    expect(memoryCalls[0].type).toBe('recallForPrompt');
  });

  await test('prepareTurn activates the matched intent skill and scopes turn tools', async () => {
    const runtime = createChatRuntime({
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
    // B 方案：use_skill 元工具已移除，激活 skill 时工具集只含该 skill 的工具子集。
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['save_webpage']);
    expect(prepared.prompt.includes('Use save_webpage to save the requested page.')).toBe(true);
  });

  await test('prepareTurn adds a file-operation contract for write requests', async () => {
    const runtime = createChatRuntime({
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

  const makeContextRuntime = () => createChatRuntime({
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

  await test('[B] English continuation "go ahead with option 2" (5 words) strips ambient context', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'go ahead with option 2',
      contextItems: [ambientNote()],
      priorMessages: [
        { role: 'user', content: 'how do I fix the links?' },
        { role: 'model', content: 'Option 1: wikilink. Option 2: absolute path.' },
      ],
    } as any);

    // "go ahead with option 2" = 5 词，命中 CONTINUATION_PATTERNS，环境上下文应被剔除
    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.prompt.includes('User Request: go ahead with option 2')).toBe(true);
  });

  await test('[B] English long request (>5 words) keeps ambient context even with history', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'please rewrite the entire article to be more concise and clear',
      contextItems: [ambientNote()],
      priorMessages: [
        { role: 'user', content: 'previous question' },
        { role: 'model', content: 'previous answer' },
      ],
    } as any);

    // 超过5词的英文实质请求，不是延续，环境上下文必须保留
    expect(prepared.prompt.includes('AI digest body that should not hijack')).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
