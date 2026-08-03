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

  // ADR-0002:关键词命中(猜)与斜杠强制激活(用户明说)分道——前者只提示,后者才收窄。
  const makeSkillRoutingRuntime = () => createChatRuntime({
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

  await test('[ADR-0002] a keyword match only hints: full tools, full skill list, no scoping', async () => {
    const runtime = makeSkillRoutingRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'Please save this webpage',
      contextItems: [],
    });

    // 猜中不等于用户点名:本轮不声明 active skill,下游 pi-tool-adapter 的硬门因此不闭合。
    expect((prepared as any).activeSkillName).toBe(undefined);
    expect((prepared as any).allowedToolNames).toBe(undefined);
    // 全量工具集保留:提问 vault 的请求不会因命中 web 类 skill 而失去读笔记的能力。
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['search_vault', 'save_webpage', 'read_skill']);
    // skill 清单保留,模型仍能发现比关键词猜测更合适的 skill。
    expect(prepared.systemPrompt).toContain('- web-clipper: Save webpages');
    expect(prepared.systemPrompt!.includes('Use save_webpage to save the requested page.')).toBe(false);
    // 命中的 skill 以「可忽略的建议」形式点名给模型。
    expect(prepared.systemPrompt).toContain('[Skill Hint]');
    expect(prepared.systemPrompt).toContain('"web-clipper" skill');
    expect(prepared.systemPrompt).toContain('otherwise ignore it');
  });

  await test('[ADR-0002] slash-command force-activation injects instructions and narrows tools', async () => {
    const runtime = makeSkillRoutingRuntime();

    const prepared = await runtime.prepareTurn({
      userMessage: 'https://example.com',
      contextItems: [],
      forcedSkillName: 'web-clipper',
    } as any);

    expect((prepared as any).activeSkillName).toBe('web-clipper');
    expect((prepared as any).allowedToolNames).toEqual(['save_webpage']);
    // 收窄到 skill 工具子集时,元能力 read_skill 必须补回——否则渐进式披露断链,
    // 模型再也读不到/切不到别的 skill(与运行中 steering 的 ActiveRunController 口径一致)。
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['save_webpage', 'read_skill']);
    expect(prepared.systemPrompt!.includes('Use save_webpage to save the requested page.')).toBe(true);
    // 强制激活时清单被完整指令取代,也不该再出现关键词提示。
    expect(prepared.systemPrompt!.includes('- web-clipper: Save webpages')).toBe(false);
    expect(prepared.systemPrompt!.includes('[Skill Hint]')).toBe(false);
  });

  // 空 tools 声明在 pi-skill-source 里的语义是「不限制」(手写 skill 省掉 tools 字段即如此)。
  // 工具清单与下游硬门必须对这一点给出同一个答案,否则模型看得到全量工具却一个也调不动。
  await test('force-activating a skill that declares no tools does not close the hard gate', async () => {
    const runtime = createChatRuntime({
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [
          { name: 'search_vault', description: 'Search vault', parameters: {} },
          { name: 'read_skill', description: 'Read a skill', parameters: {} },
        ],
        getDefinition: () => undefined,
        execute: async () => ({}),
      } as any,
      skillRegistry: {
        resolveByIntent: () => null,
        getSkillSummaryText: () => '- freeform: Anything',
        activateSkill: () => ({
          skill: { name: 'freeform' },
          instructions: 'Do whatever the request needs.',
          tools: [],
        }),
      } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'go',
      contextItems: [],
      forcedSkillName: 'freeform',
    } as any);

    // 指令照常注入——用户点名了这个 skill。
    expect(prepared.systemPrompt!.includes('Do whatever the request needs.')).toBe(true);
    // 但工具没有被收窄,故不能声明白名单:非 null 的白名单会让硬门闭合到只剩 read_skill。
    expect(prepared.tools.map((tool: any) => tool.name)).toEqual(['search_vault', 'read_skill']);
    expect((prepared as any).allowedToolNames).toBe(undefined);
    expect((runtime as any).createSkillScope(prepared).allowedToolNames).toBe(null);
  });

  // 硬门只看白名单是否为空,不看它是 undefined 还是空数组——runtime-types 允许两者,
  // 只挡住 undefined 就等于把这道防线的有效性押在「生产者恰好没给空数组」上。
  await test('an empty allowed-tool list leaves the hard gate open, like an absent one', async () => {
    const runtime = makeSkillRoutingRuntime();

    const scope = (runtime as any).createSkillScope({
      activeSkillName: 'freeform',
      allowedToolNames: [],
    });

    expect(scope.allowedToolNames).toBe(null);
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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
