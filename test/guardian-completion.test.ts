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
    toBeGreaterThan: (expected: number) => {
      if (!(actual > expected)) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeLessThan: (expected: number) => {
      if (!(actual < expected)) {
        throw new Error(`Expected ${actual} to be less than ${expected}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function createEditor(lines: string[], cursor: { line: number; ch: number } = { line: lines.length - 1, ch: lines[lines.length - 1].length }) {
  return {
    getCursor: () => cursor,
    getLine: (line: number) => lines[line] ?? '',
    lineCount: () => lines.length,
  };
}

function createSettings(overrides: Record<string, any> = {}) {
  return {
    enableGuardian: true,
    guardianAutoMode: true,
    guardianSensitivity: 50,
    guardianUIStyle: 'hybrid',
    ignoredFolders: '',
    systemPrompt: 'global prompt should not leak into auto completion',
    ...overrides,
  };
}

async function runTests() {
  console.log('=== Guardian Completion Tests ===');
  const {
    GuardianCompletionService,
    getGuardianAutoDelayMs,
    shouldScheduleDeepEscalation,
    GUARDIAN_ESCALATION_REASONS,
    GUARDIAN_WEAK_COMPLETION_REASON,
  } = await import('../src/ui/guardian-completion');

  await test('derives lower latency delay from higher sensitivity', () => {
    expect(getGuardianAutoDelayMs(90)).toBe(840);
    expect(getGuardianAutoDelayMs(10)).toBe(1160);
    expect(getGuardianAutoDelayMs(50)).toBe(1000);
  });

  await test('skips automatic completion in ignored folders and only one-character text at normal sensitivity', () => {
    const service = new GuardianCompletionService({
      settings: createSettings({ ignoredFolders: 'Private/\nTemplates/' }) as any,
      modelService: {} as any,
    });

    expect(service.shouldRunAuto({
      editor: createEditor(['hello world']),
      activePath: 'Private/diary.md',
    })).toEqual({ ok: false, reason: 'ignored-folder' });

    expect(service.shouldRunAuto({
      editor: createEditor(['h'], { line: 0, ch: 1 }),
      activePath: 'Notes/current.md',
    })).toEqual({ ok: false, reason: 'too-short' });

    expect(service.shouldRunAuto({
      editor: createEditor(['hi'], { line: 0, ch: 2 }),
      activePath: 'Notes/current.md',
    })).toEqual({ ok: true });
  });

  await test('builds compact markdown-aware context around the cursor', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });

    const context = await service.buildContext({
      editor: createEditor([
        '# Product Notes',
        '',
        '- existing decision',
        '- next action is to',
      ], { line: 3, ch: 19 }),
      obsidianContext: {
        activeHeading: '# Product Notes',
        tags: ['#product'],
        outgoingLinks: ['Roadmap'],
      } as any,
    });

    expect(context.markdownShape).toBe('list');
    expect(context.currentHeading).toBe('# Product Notes');
    expect(context.cursorPrefix).toBe('- next action is to');
    expect(context.localBlock).toContain('- existing decision');
    expect(context.prompt.includes('global prompt should not leak')).toBe(false);
    expect(context.prompt).toContain('[Cursor]');
  });

  await test('injects only small relevant knowledge context', async () => {
    const knowledgeCalls: string[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
      knowledgeRuntime: {
        getGuardianKnowledgeContext: async (query: string) => {
          knowledgeCalls.push(query);
          return [
            '[Knowledge Reference]',
            'From Roadmap: use progressive disclosure for adoption.',
            'From Product Notes: keep defaults lightweight.',
            'From Extra: this should be trimmed away.',
          ].join('\n');
        },
      } as any,
    });

    const context = await service.buildContext({
      editor: createEditor(['## Roadmap', 'The adoption plan should']),
      obsidianContext: {
        activeHeading: '## Roadmap',
        tags: ['#strategy'],
        outgoingLinks: ['Roadmap'],
      } as any,
    });

    expect(knowledgeCalls.length).toBe(1);
    expect(context.knowledgeContext).toContain('From Roadmap');
    expect(context.knowledgeContext).toContain('From Product Notes');
    expect(context.knowledgeContext.includes('From Extra')).toBe(false);
  });

  await test('rejects low quality suggestions before display', () => {
    const service = new GuardianCompletionService({
      settings: createSettings({ guardianSensitivity: 70 }) as any,
      modelService: {} as any,
    });
    const context = {
      currentLine: '- next action is to',
      cursorPrefix: '- next action is to',
      cursorSuffix: '',
      markdownShape: 'list',
      localBlock: '- next action is to',
    } as any;

    const mediumContinuation = 'collect three customer examples, compare the timing of each decision, and write down which signal changed the team direction most clearly.';
    const tooLongContinuation = [
      'collect three customer examples, compare the timing of each decision, write down which signal changed the team direction most clearly,',
      'then add a second paragraph explaining every stakeholder concern, implementation dependency, rollout sequence, measurement caveat, and follow-up question before sharing the note.',
    ].join(' ');

    expect(service.evaluateSuggestion('next action is to', context).ok).toBe(false);
    const medium = service.evaluateSuggestion(mediumContinuation, context);
    expect(medium.ok).toBe(true);
    expect(medium.reasons).toEqual([]);
    expect(service.evaluateSuggestion(tooLongContinuation, context).ok).toBe(false);
    const short = service.evaluateSuggestion('collect three customer examples', context);
    expect(short.ok).toBe(true);
    expect(short.reasons).toEqual([]);
  });

  await test('returns none when model response is stale after generation', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        generate: async () => '{"type":"completion","suggestion":"collect three examples"}',
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['- next action is to']),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      isStale: () => true,
    });

    expect(result).toEqual({ type: 'none', reason: 'stale' });
  });

  await test('skips automatic completion when the active model is not configured', async () => {
    let generateCalled = false;
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => false,
        generate: async () => {
          generateCalled = true;
          return '{"type":"completion","suggestion":"collect examples"}';
        },
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['- next action is to']),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(result).toEqual({ type: 'none', reason: 'model-not-configured' });
    expect(generateCalled).toBe(false);
  });

  await test('requests raw model prompt for automatic completion', async () => {
    const calls: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (...args: any[]) => {
          calls.push(args);
          return '{"type":"completion","suggestion":"collect examples"}';
        },
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['- next action is to']),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(result.type).toBe('completion');
    expect(calls[0][2]).toBe('guardian');
    expect(calls[0][5].skipGenerationPlan).toBe(true);
  });

  await test('does not cap output budget for reasoning-compatible providers', async () => {
    const calls: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (...args: any[]) => {
          calls.push(args);
          return '{"type":"completion","suggestion":"cash flow changes"}';
        },
      } as any,
    });

    await service.completeAuto({
      editor: createEditor(['profit and'], { line: 0, ch: 10 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(calls[0][5].maxTokens).toBe(undefined);
  });

  await test('does not set a provider timeout below the guardian soft timeout', async () => {
    const calls: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (...args: any[]) => {
          calls.push(args);
          return '{"type":"completion","suggestion":"cash flow changes"}';
        },
      } as any,
    });

    await service.completeAuto({
      editor: createEditor(['profit and'], { line: 0, ch: 10 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(calls[0][5].timeoutMs).toBe(undefined);
  });

  await test('prompt biases toward silence unless a continuation is genuinely confident', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });

    const context = await service.buildContext({
      editor: createEditor(['收入表反映了'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
    });

    expect(context.prompt).toContain('only when you are confident');
    expect(context.prompt).toContain('Prefer {"type":"none"}');
    expect(context.prompt).toContain('generic filler');
    expect(context.prompt).toContain('Do not output reasoning');
    expect(context.prompt).toContain('before or after the cursor');
  });

  await test('accepts clean plain text when the model ignores JSON formatting', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => '企业在一定期间内的收入、成本和利润变化',
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['收入表反映了'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(result.type).toBe('completion');
  });

  await test('skips malformed leading json and accepts the first valid completion object', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => 'draft {type:completion,suggestion:"bad"}\n{"type":"completion","suggestion":"cash flow changes"}',
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['profit and'], { line: 0, ch: 10 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(result.type).toBe('completion');
    if (result.type === 'completion') {
      // 光标前是「profit and」(以字母 d 结尾),补全首字符是字母 → 自动补前导空格,
      // 避免插入后粘连成「profit andcash」。
      expect(result.suggestion).toBe(' cash flow changes');
      expect(result.line).toBe(1);
      expect(result.ch).toBe(10);
      expect(result.quality.ok).toBe(true);
      expect(result.quality.reasons).toEqual([]);
    }
  });

  await test('reports response preview when invalid json cannot be used', async () => {
    const events: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => '{type:completion,suggestion:"cash flow"}',
      } as any,
      diagnostics: (event: any) => events.push(event),
    });

    const result = await service.completeAuto({
      editor: createEditor(['profit and'], { line: 0, ch: 10 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      requestId: 9,
    });

    expect(result).toEqual({ type: 'none', reason: 'invalid-json' });
    const parseEvent = events.find((event) => event.stage === 'response-parse-failed');
    expect(parseEvent.requestId).toBe(9);
    expect(parseEvent.responsePreview).toContain('{type:completion');
  });

  await test('reports empty response separately from invalid json', async () => {
    const events: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => '',
      } as any,
      diagnostics: (event: any) => events.push(event),
    });

    const result = await service.completeAuto({
      editor: createEditor(['profit and'], { line: 0, ch: 10 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      requestId: 10,
    });

    expect(result).toEqual({ type: 'none', reason: 'empty-response' });
    const emptyEvent = events.find((event) => event.stage === 'empty-response');
    expect(emptyEvent.requestId).toBe(10);
    expect(emptyEvent.responseLength).toBe(0);
  });

  await test('does not wait forever for guardian knowledge context', async () => {
    const events: string[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => '{"type":"completion","suggestion":"collect examples"}',
      } as any,
      knowledgeRuntime: {
        getGuardianKnowledgeContext: async () => new Promise<string>((resolve) => {
          setTimeout(() => resolve('late knowledge'), 30);
        }),
      } as any,
      knowledgeTimeoutMs: 1,
      diagnostics: (event: any) => {
        events.push(`${event.stage}:${event.requestId ?? 'na'}`);
      },
    });

    const startedAt = Date.now();
    const result = await service.completeAuto({
      editor: createEditor(['收入表反映了'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      requestId: 7,
    });

    expect(result.type).toBe('completion');
    expect(Date.now() - startedAt).toBeLessThan(20);
    expect(events.join('|')).toContain('knowledge-timeout:7');
    expect(events.join('|')).toContain('model-start:7');
    expect(events.join('|')).toContain('model-finished:7');
  });

  await test('returns timeout instead of waiting forever for the model', async () => {
    const events: string[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => new Promise<string>((resolve) => {
          setTimeout(() => resolve('late model response'), 30);
        }),
      } as any,
      completionTimeoutMs: 1,
      diagnostics: (event: any) => {
        events.push(`${event.stage}:${event.requestId ?? 'na'}`);
      },
    });

    const startedAt = Date.now();
    const result = await service.completeAuto({
      editor: createEditor(['收入表反映了'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      requestId: 8,
    });

    expect(result).toEqual({ type: 'none', reason: 'completion-timeout' });
    expect(Date.now() - startedAt).toBeLessThan(20);
    expect(events.join('|')).toContain('completion-timeout:8');
  });

  await test('truncates an over-long suggestion to a sentence boundary instead of discarding it', async () => {
    // 构造一段超过上限(灵敏度70→220字)的多句补全:
    // 第一句落在 40% 阈值之后,应被保留为完整句;其后的句子整体超限,应被截掉。
    const keptSentence = '现金流量表把企业在一段时间内的现金流入与流出情况，按照经营活动、投资活动以及筹资活动这三大类别分别加以清晰地归类和拆分开来，从而让任何一位读者都能够一眼就看清楚企业现金的真实来龙去脉与最终的净变动情况。';
    const droppedSentence = '此外它还需要逐条罗列并解释每一个利益相关者的顾虑、上下游实现依赖、灰度推出顺序、关键度量口径、风险缓解预案、回滚触发条件、监控告警阈值、数据埋点方案以及后续跟进事项等等繁多而琐碎且容易被忽略的执行细节，所有这些都必须在正式对外分享之前由专人反复核对并确认无误。';
    const longBody = keptSentence + droppedSentence;
    const service = new GuardianCompletionService({
      settings: createSettings({ guardianSensitivity: 70 }) as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => JSON.stringify({ type: 'completion', suggestion: longBody }),
      } as any,
    });

    const result = await service.completeAuto({
      editor: createEditor(['利润表之外，'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(result.type).toBe('completion');
    if (result.type === 'completion') {
      // 截断后不超过上限,且保留了完整首句(以句号结尾),而非整条被丢。
      expect(result.suggestion.length).toBeLessThan(221);
      expect(result.suggestion).toContain('净变动情况。');
      expect(result.suggestion.includes('确认无误')).toBe(false);
    }
  });

  await test('rejects filler-opening, no-substance and suffix-duplicating suggestions', () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });
    const base = {
      currentLine: '这个方案',
      cursorPrefix: '这个方案',
      cursorSuffix: '',
      markdownShape: 'paragraph',
      localBlock: '这个方案',
    } as any;

    expect(service.evaluateSuggestion('总的来说，这是一个值得关注的问题', base).reasons.join(',')).toContain('filler-opening');
    expect(service.evaluateSuggestion('……', base).reasons.join(',')).toContain('no-substance');
    expect(service.evaluateSuggestion('需要进一步评估', { ...base, cursorSuffix: '需要进一步评估后再决定' }).reasons.join(',')).toContain('duplicates-suffix');
    // 正常的实质补全不被这些规则误伤。
    const substantive = service.evaluateSuggestion('能显著降低团队的协作成本', base);
    expect(substantive.ok).toBe(true);
    expect(substantive.reasons).toEqual([]);
  });

  await test('serves a repeated identical-context request from cache without calling the model again', async () => {
    let generateCalls = 0;
    const events: string[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => {
          generateCalls += 1;
          return '{"type":"completion","suggestion":"降低团队协作成本"}';
        },
      } as any,
      diagnostics: (event: any) => events.push(event.stage),
    });

    const request = () => service.completeAuto({
      editor: createEditor(['这个方案能'], { line: 0, ch: 5 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    const first = await request();
    const second = await request();

    expect(first.type).toBe('completion');
    expect(second.type).toBe('completion');
    expect(generateCalls).toBe(1);
    expect(events.join(',')).toContain('cache-hit');
  });

  await test('does not serve from cache after the ttl expires', async () => {
    let generateCalls = 0;
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => {
          generateCalls += 1;
          return '{"type":"completion","suggestion":"降低团队协作成本"}';
        },
      } as any,
      cacheTtlMs: 1,
    });

    const request = () => service.completeAuto({
      editor: createEditor(['这个方案能'], { line: 0, ch: 5 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    await request();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await request();

    expect(generateCalls).toBe(2);
  });

  await test('injects an author voice hint built from the user profile (both modes)', async () => {
    const calls: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (...args: any[]) => {
          calls.push(args);
          return '{"type":"completion","suggestion":"降低协作成本"}';
        },
      } as any,
    });

    await service.completeAuto({
      editor: createEditor(['这个方案能'], { line: 0, ch: 5 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
      userProfile: {
        profession: '产品经理',
        expertise: ['SaaS', '增长'],
        preferences: { language: '中文', responseStyle: '简洁直接', topics: ['留存'] },
        context: { currentProjects: ['Baizer'], goals: [], challenges: [] },
      } as any,
    });

    const prompt = calls[0][0];
    expect(prompt).toContain('[Author Profile]');
    expect(prompt).toContain('简洁直接');
    expect(prompt).toContain('SaaS');
    // 画像是「镜像」而非「复述」:明确要求不要把这些事实说出来。
    expect(prompt).toContain('do not announce');
  });

  await test('omits the author profile block when no profile is available', async () => {
    const calls: any[] = [];
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (...args: any[]) => {
          calls.push(args);
          return '{"type":"completion","suggestion":"降低协作成本"}';
        },
      } as any,
    });

    await service.completeAuto({
      editor: createEditor(['这个方案能'], { line: 0, ch: 5 }),
      obsidianContext: {} as any,
      activePath: 'Notes/current.md',
    });

    expect(calls[0][0].includes('[Author Profile]')).toBe(false);
  });

  await test('deep mode reads note bodies and adds a connection intent the fast mode lacks', async () => {
    const deepCalls: string[] = [];
    const fastCalls: string[] = [];
    const runtime = {
      getGuardianKnowledgeContext: async (q: string) => { fastCalls.push(q); return '[知识库参考]\n来自《A》：\n- 核心观点：x\n'; },
      getGuardianDeepKnowledgeContext: async (q: string) => { deepCalls.push(q); return '[知识库相关笔记节选]\n《增长飞轮》：\n留存是增长的真正杠杆，远胜拉新。'; },
    };
    const promptCapture: { fast?: string; deep?: string } = {};
    const makeService = (sink: 'fast' | 'deep') => new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async (prompt: string) => { promptCapture[sink] = prompt; return '{"type":"completion","suggestion":"以留存为杠杆"}'; },
      } as any,
      knowledgeRuntime: runtime as any,
    });

    const editor = createEditor(['# 增长策略', '我们应该优先'], { line: 1, ch: 6 });
    await makeService('fast').completeAuto({ editor, obsidianContext: { activeHeading: '# 增长策略' } as any, activePath: 'Notes/g.md', mode: 'fast' });
    await makeService('deep').completeAuto({ editor, obsidianContext: { activeHeading: '# 增长策略' } as any, activePath: 'Notes/g.md', mode: 'deep' });

    // fast 走元数据检索,deep 走读正文检索。
    expect(fastCalls.length).toBe(1);
    expect(deepCalls.length).toBe(1);
    // deep prompt 含连接意图与正文节选;fast 不含连接意图。
    expect(promptCapture.deep).toContain('surfaces that connection');
    expect(promptCapture.deep).toContain('增长飞轮');
    expect((promptCapture.fast || '').includes('surfaces that connection')).toBe(false);
  });

  await test('deep escalation fires only for A+B no-result reasons (model none + quality filter)', () => {
    const fire = (reason: string) => shouldScheduleDeepEscalation({ enabled: true, reason, alreadyEscalated: false });
    // A 类:模型主动 none。B 类:质检过滤。
    expect(fire('explicit-none')).toBe(true);
    expect(fire('filler-opening')).toBe(true);
    expect(fire('duplicates-suffix')).toBe(true);
    expect(fire('low-quality')).toBe(true);
    // C 类:故障——重试无意义,不升级。
    expect(fire('completion-timeout')).toBe(false);
    expect(fire('empty-response')).toBe(false);
    expect(fire('invalid-json')).toBe(false);
    expect(fire('model-not-configured')).toBe(false);
    // D 类:失效/闸门——不升级。
    expect(fire('stale')).toBe(false);
    expect(fire('stale-after-result')).toBe(false);
    expect(fire('too-short')).toBe(false);
    expect(fire('auto-disabled')).toBe(false);
  });

  await test('deep escalation respects the opt-in switch and the once-per-anchor guard', () => {
    // 开关关:即便是合格 reason 也不升级。
    expect(shouldScheduleDeepEscalation({ enabled: false, reason: 'explicit-none', alreadyEscalated: false })).toBe(false);
    // 该锚点已升过:不重复(防昂贵死循环)。
    expect(shouldScheduleDeepEscalation({ enabled: true, reason: 'explicit-none', alreadyEscalated: true })).toBe(false);
    // 开关开 + 合格 reason + 未升过:升级。
    expect(shouldScheduleDeepEscalation({ enabled: true, reason: 'explicit-none', alreadyEscalated: false })).toBe(true);
  });

  await test('escalation reason set excludes failure and rejection reasons', () => {
    expect(GUARDIAN_ESCALATION_REASONS.has('explicit-none')).toBe(true);
    expect(GUARDIAN_ESCALATION_REASONS.has('completion-timeout')).toBe(false);
    expect(GUARDIAN_ESCALATION_REASONS.has('stale')).toBe(false);
  });

  await test('P3: flags compliant-but-hollow fast completions as weak without rejecting them', () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });
    const base = {
      currentLine: '这个方案',
      cursorPrefix: '这个方案',
      cursorSuffix: '',
      markdownShape: 'paragraph',
      localBlock: '这个方案',
      mode: 'fast',
    } as any;

    // 空泛词堆砌:硬拦截过不掉(不重复、不套话开头),但信息量低 → 标记 weak。
    const vague = service.evaluateSuggestion('这非常重要，值得关注，需要考虑方方面面', base);
    expect(vague.ok).toBe(true);
    expect(!!vague.weak).toBe(true);

    // 实质续写:引入新信息,不 weak。
    const substantive = service.evaluateSuggestion('能把上线周期从两周压缩到三天', base);
    expect(substantive.ok).toBe(true);
    expect(!!substantive.weak).toBe(false);

    // deep 模式不做 weak 判定(深补已是终点,无处再升)。
    const deepHollow = service.evaluateSuggestion('这非常重要，值得关注', { ...base, mode: 'deep' });
    expect(!!deepHollow.weak).toBe(false);
  });

  await test('P0: weak-completion is an escalation reason so mediocre fast results can escalate', () => {
    expect(GUARDIAN_WEAK_COMPLETION_REASON).toBe('weak-completion');
    expect(GUARDIAN_ESCALATION_REASONS.has(GUARDIAN_WEAK_COMPLETION_REASON)).toBe(true);
    expect(shouldScheduleDeepEscalation({ enabled: true, reason: GUARDIAN_WEAK_COMPLETION_REASON, alreadyEscalated: false })).toBe(true);
  });

  await test('P1: deep mode prompt lifts the one-sentence cap and invites development', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });
    const editor = createEditor(['我认为团队协作的关键在于']);
    const fastCtx = await service.buildContext({ editor, obsidianContext: {} as any, mode: 'fast' });
    const deepCtx = await service.buildContext({ editor, obsidianContext: {} as any, mode: 'deep' });

    // 快补 prompt 保留「一句话/60-180」约束;深补去掉它、改为允许 2-4 句并展开。
    expect(fastCtx.prompt).toContain('one complete sentence');
    expect(fastCtx.prompt.includes('2 to 4 sentences')).toBe(false);
    expect(deepCtx.prompt).toContain('2 to 4 sentences');
    expect(deepCtx.prompt.includes('60-180 characters')).toBe(false);
  });

  await test('prepends a separator so completions do not stick to the text before the cursor', async () => {
    const make = (suggestion: string) => new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {
        isGenerationConfigured: () => true,
        generate: async () => `{"type":"completion","suggestion":${JSON.stringify(suggestion)}}`,
      } as any,
    });
    const run = async (line: string, ch: number, suggestion: string) => {
      const result = await make(suggestion).completeAuto({
        editor: createEditor([line], { line: 0, ch }),
        obsidianContext: {} as any,
        activePath: 'Notes/current.md',
      });
      return result.type === 'completion' ? result.suggestion : `NONE:${(result as any).reason}`;
    };

    // 英文词衔接:光标前是字母 → 补前导空格,避免「andcash」。
    expect(await run('profit and', 10, 'cash reserves grow')).toBe(' cash reserves grow');
    // 中文段落:全角句末标点后接中文 → 不补空格(中文不用空格分词)。
    expect(await run('这个方案很好。', 7, '下一步需要评估成本')).toBe('下一步需要评估成本');
    // 英文句末标点后接新句 → 补空格。
    expect(await run('It works.', 9, 'Next we ship it')).toBe(' Next we ship it');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
