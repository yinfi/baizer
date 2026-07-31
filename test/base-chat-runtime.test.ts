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
        getMentalModelBlock: async () => '',
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

    // 阶段1:装饰进 systemPrompt(每轮发送不持久化);干净 userMessage 作为 prompt。
    expect(prepared.systemPrompt!.includes('[Memory Context]')).toBe(true);
    expect(prepared.systemPrompt!.includes('[Context: [Context (file): note.md]\nnote body]')).toBe(true);
    expect(prepared.systemPrompt!.includes('[Selected Text: selected line]')).toBe(true);
    expect(prepared.prompt).toBe('Explain this');
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
        getMentalModelBlock: async () => '',
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

    expect(turn.systemPrompt).toContain('[Relevant Memory]');
    expect(memoryCalls[0].type).toBe('recallForPrompt');
  });

  await test('prepareTurn activates the matched intent skill and scopes turn tools', async () => {
    const runtime = createChatRuntime({
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'search_vault', description: 'Search vault', parameters: {} },
          { name: 'save_webpage', description: 'Save webpage', parameters: {} },
          { name: 'read_skill', description: 'Read a skill', parameters: {} },
        ],
        getDefinition: (name: string) => (
          name === 'read_skill'
            ? { name: 'read_skill', description: 'Read a skill', parameters: {} }
            : undefined
        ),
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
    // 论断3:收窄到 skill 工具子集时,元能力 read_skill 必须补回——否则渐进式披露断链,
    // 模型再也读不到/切不到别的 skill(与运行中 steering 的 ActiveRunController 口径一致)。
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['save_webpage', 'read_skill']);
    expect(prepared.systemPrompt!.includes('Use save_webpage to save the requested page.')).toBe(true);
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

    expect(prepared.systemPrompt!.includes('[File Operation Contract]')).toBe(true);
    expect(prepared.systemPrompt!.includes('must call an appropriate vault write tool')).toBe(true);
    expect(prepared.systemPrompt!.includes('Do not provide copy-paste instructions')).toBe(true);
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

    expect(prepared.systemPrompt).toContain('[Slash Command Contract]');
    expect(prepared.systemPrompt).toContain('`/clear`');
    expect(prepared.systemPrompt).toContain('`/memory [overview|observations|search <query>|forget <field>]`');
    expect(prepared.systemPrompt!.includes('/profile')).toBe(false);
    expect(prepared.systemPrompt!.includes('/forget [field]')).toBe(false);
    expect(prepared.systemPrompt).toContain('`/save`');
    expect(prepared.systemPrompt).toContain('Do not mention or recommend slash commands that are not listed here');
    expect(prepared.systemPrompt).toContain('Do not invent generic commands like `/do` or `/ask`');
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
    expect(prepared.systemPrompt!.includes('[Generation Plan]')).toBe(true);
    expect(prepared.systemPrompt!.includes('Mode: rewrite')).toBe(true);
    expect(prepared.systemPrompt!.includes('Target Shape: replacement')).toBe(true);
    expect(prepared.systemPrompt!.includes('Return only the revised replacement text.')).toBe(true);
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
      hasPriorContext: true,
    } as any);

    // 当前笔记正文被剔除，模型不再被它带偏
    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.systemPrompt!.includes('Daily/2026/2026-06-24.md')).toBe(false);
    // 没有残留的环境上下文，就不该附定性说明
    expect(prepared.systemPrompt!.includes('[Context Note]')).toBe(false);
    expect(prepared.prompt).toBe('需要');
  });

  await test('[B] "用第二个方法" is treated as a continuation and strips ambient context', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '用第二个方法',
      contextItems: [ambientNote()],
      hasPriorContext: true,
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.prompt).toBe('用第二个方法');
  });

  await test('[B] continuation detection requires prior history', async () => {
    const runtime = makeContextRuntime();

    // 没有历史时(hasPriorContext 未置)，"需要" 不应剔除上下文（可能就是针对当前笔记的首轮请求）
    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(true);
    // 保留了环境上下文，则附上定性说明
    expect(prepared.systemPrompt!.includes('[Context Note]')).toBe(true);
  });

  await test('[B] long substantive message keeps ambient context even with history', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '需要你把当前这篇文章整体改写得更精炼一些',
      contextItems: [ambientNote()],
      hasPriorContext: true,
    } as any);

    // 实质性长请求不算确认，当前笔记上下文必须保留
    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(true);
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
      hasPriorContext: true,
    } as any);

    // 环境笔记被剔除
    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
    // 用户显式附加的上下文必须保留
    expect(prepared.systemPrompt!.includes('Explicitly attached project plan content.')).toBe(true);
  });

  await test('[A] ambient context on a normal request carries the conversation-wins disclaimer', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: '总结一下这篇文章的要点',
      contextItems: [ambientNote()],
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(true);
    expect(prepared.systemPrompt!.includes('[Context Note]')).toBe(true);
    expect(prepared.systemPrompt!.includes('follow the conversation')).toBe(true);
  });

  await test('[B] English continuation "go ahead with option 2" (5 words) strips ambient context', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'go ahead with option 2',
      contextItems: [ambientNote()],
      hasPriorContext: true,
    } as any);

    // "go ahead with option 2" = 5 词，命中 CONTINUATION_PATTERNS，环境上下文应被剔除
    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
    expect(prepared.prompt).toBe('go ahead with option 2');
  });

  await test('[B] English long request (>5 words) keeps ambient context even with history', async () => {
    const runtime = makeContextRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'please rewrite the entire article to be more concise and clear',
      contextItems: [ambientNote()],
      hasPriorContext: true,
    } as any);

    // 超过5词的英文实质请求，不是延续，环境上下文必须保留
    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(true);
  });

  // ── 历史存在性由 runtime 自取,不再依赖调用方注入 ──────────────────────
  //
  // 背景:hasPriorContext 原先由 ModelService 查 sessionManager 后注入,
  // 在 chat/chatStream 里各写一遍,而第三个入口 executeSlashSkillCommand
  // 漏了 —— 于是 skill 命令永远拿不到延续检测。runtime 自己就持有
  // sessionManager,该由它自己问。

  const makeRuntimeWithSession = (hasHistory: boolean) => createChatRuntime({
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
    sessionManager: {
      hasHistory: async () => hasHistory,
    } as any,
  });

  await test('[B] runtime derives prior history from sessionManager when caller omits it', async () => {
    const runtime = makeRuntimeWithSession(true);

    // 注意:没有传 hasPriorContext——这正是 skill 命令入口的情形
    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
      conversationId: 'conv-1',
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
  });

  await test('[B] runtime keeps ambient context when sessionManager reports no history', async () => {
    const runtime = makeRuntimeWithSession(false);

    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
      conversationId: 'conv-1',
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(true);
  });

  await test('[B] explicit hasPriorContext still wins over the session lookup', async () => {
    // 显式传入时不再查会话:保留这条是为了让无 conversationId 的一次性调用
    // (file-back、/edit)能按调用方的判断走。
    const runtime = makeRuntimeWithSession(false);

    const prepared = await runtime.prepareTurn({
      userMessage: '需要',
      contextItems: [ambientNote()],
      hasPriorContext: true,
    } as any);

    expect(prepared.systemPrompt!.includes('AI digest body that should not hijack')).toBe(false);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
