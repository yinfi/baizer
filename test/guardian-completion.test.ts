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
    expect(service.evaluateSuggestion(mediumContinuation, context)).toEqual({ ok: true, reasons: [] });
    expect(service.evaluateSuggestion(tooLongContinuation, context).ok).toBe(false);
    expect(service.evaluateSuggestion('collect three customer examples', context)).toEqual({ ok: true, reasons: [] });
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

  await test('prompt biases toward a completion instead of returning none by default', async () => {
    const service = new GuardianCompletionService({
      settings: createSettings() as any,
      modelService: {} as any,
    });

    const context = await service.buildContext({
      editor: createEditor(['收入表反映了'], { line: 0, ch: 6 }),
      obsidianContext: {} as any,
    });

    expect(context.prompt).toContain('Default to returning a completion');
    expect(context.prompt).toContain('half to one sentence');
    expect(context.prompt).toContain('Use {"type":"none"} only');
    expect(context.prompt).toContain('Do not output reasoning');
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

    expect(result).toEqual({
      type: 'completion',
      suggestion: 'cash flow changes',
      line: 1,
      ch: 10,
      quality: { ok: true, reasons: [] },
    });
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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
