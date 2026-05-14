function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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

function createContext(overrides: Record<string, any> = {}) {
  return {
    activeNote: { path: 'Projects/Native AI.md', title: 'Native AI' },
    selection: null,
    activeHeading: '## Draft',
    frontmatter: {},
    tags: ['#project/native-ai'],
    outgoingLinks: ['[[Roadmap]]'],
    backlinks: [],
    recentNotes: [{ path: 'Daily/2026-05-13.md', title: '2026-05-13' }],
    explicitScopes: [],
    contextItems: [],
    ...overrides,
  };
}

async function runTests() {
  console.log('=== GenerationStrategyService Tests ===');
  const {
    GenerationStrategyService,
  } = await import('../src/services/generation-strategy-service');

  await test('resolvePlan marks selection rewrites as replacement previews', () => {
    const service = new GenerationStrategyService();

    const plan = service.resolvePlan({
      userMessage: '把这段话改写得更清晰',
      source: 'selection-menu',
      context: createContext({
        selection: { text: '原始段落', from: 10, to: 14 },
      }),
    });

    expect(plan).toEqual({
      source: 'selection-menu',
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
  });

  await test('resolvePlan derives structure and writing profile hints from note context', () => {
    const service = new GenerationStrategyService();

    const plan = service.resolvePlan({
      userMessage: '请按 Obsidian 大纲结构重组这篇笔记',
      source: 'shell',
      context: createContext({
        contextItems: [
          {
            id: 'active-note:Projects/Native AI.md',
            type: 'file',
            data: 'Projects/Native AI.md',
            content: '# Native AI\n\n- [ ] next step\n\n```ts\nconst x = 1;\n```',
          },
        ],
      }),
      profile: {
        name: 'Ada',
        profession: 'Engineer',
        expertise: ['TypeScript'],
        preferences: {
          language: 'zh-CN',
          responseStyle: 'detailed',
          topics: ['pkm'],
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
    });

    expect(plan).toEqual({
      source: 'shell',
      mode: 'structure',
      targetShape: 'outline',
      previewRequired: false,
      mustPreserveVoice: true,
      mustUseObsidianMarkdown: true,
      qualityChecklist: [
        'Produce a scan-friendly outline with meaningful headings or bullet groups.',
        'Keep markdown valid for Obsidian, including task lists and links.',
        'Do not drop concrete details that anchor the note context.',
      ],
    });

    expect(service.buildWritingProfile(createContext({
      contextItems: [
        {
          id: 'active-note:Projects/Native AI.md',
          type: 'file',
          data: 'Projects/Native AI.md',
          content: '# Native AI\n\n- [ ] next step\n\n```ts\nconst x = 1;\n```',
        },
      ],
    }), {
      name: 'Ada',
      profession: 'Engineer',
      expertise: ['TypeScript'],
      preferences: {
        language: 'zh-CN',
        responseStyle: 'detailed',
        topics: ['pkm'],
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
    })).toEqual({
      responseStyle: 'detailed',
      prefersLists: true,
      headingDensity: 'medium',
      noteTone: 'technical',
      bannedPhrases: ['作为 AI', 'As an AI'],
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
