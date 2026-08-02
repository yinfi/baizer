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
    toBeTruthy: () => {
      if (!actual) {
        throw new Error(`Expected value to be truthy but got ${actual}`);
      }
    },
    toBeFalsy: () => {
      if (actual) {
        throw new Error(`Expected value to be falsy but got ${actual}`);
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

function createFile(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const basenameWithExt = parts[parts.length - 1];
  const extension = basenameWithExt.includes('.') ? basenameWithExt.split('.').pop() || 'md' : 'md';
  const basename = basenameWithExt.replace(/\.[^.]+$/, '');
  const file = new TFile();
  file.path = normalized;
  file.basename = basename;
  file.extension = extension;
  return file;
}

async function runTests() {
  console.log('=== ObsidianContextService Tests ===');
  const { ObsidianContextService } = await import('../src/services/obsidian-context-service');

  await test('collect returns active note semantics, scoped section excerpt, backlinks summaries, and recent notes', async () => {
    const activeFile = createFile('Projects/Native AI.md');
    const backlinkA = createFile('Notes/Product Strategy.md');
    const backlinkB = createFile('Daily/2026-05-13.md');

    const fileContents = new Map<string, string>([
      [activeFile.path, [
        '---',
        'status: draft',
        'owner: team-ai',
        '---',
        '# Native AI',
        'Intro paragraph.',
        '## 背景',
        'This paragraph explains the current problem.',
        'selected text',
        'More detail below.',
        '## 方案',
        'Solution section.',
        '## Appendix',
        'Ignore this appendix section.',
      ].join('\n')],
      [backlinkA.path, 'This note links the design to product workflow migration and team conventions.'],
      [backlinkB.path, 'Daily note that references the rollout concerns and execution timing.'],
    ]);

    const activeContent = fileContents.get(activeFile.path)!;
    const selectedText = 'selected text';
    const selectionLine = activeContent.split('\n').findIndex((line) => line === selectedText);

    const app = {
      workspace: {
        getActiveFile: () => activeFile,
        getMostRecentLeaf: () => ({
          view: {
            editor: {
              getSelection: () => selectedText,
              getCursor: (_which?: string) => ({ line: selectionLine, ch: 0 }),
            },
          },
        }),
        getLastOpenFiles: () => [
          activeFile.path,
          backlinkA.path,
          backlinkB.path,
        ],
      },
      vault: {
        read: async (file: any) => fileContents.get(file.path) || '',
        getAbstractFileByPath: (path: string) => createFile(path),
      },
      metadataCache: {
        getFileCache: (file: any) => {
          if (file.path !== activeFile.path) return {};
          return {
            frontmatter: {
              status: 'draft',
              owner: 'team-ai',
            },
            tags: [
              { tag: '#ai' },
              { tag: '#obsidian/native' },
            ],
            links: [
              { link: 'Knowledge/Context Graph' },
              { link: 'Notes/Product Strategy' },
            ],
          };
        },
        getBacklinksForFile: (_file: any) => new Map([
          [backlinkA.path, { data: {} }],
          [backlinkB.path, { data: {} }],
        ]),
      },
    } as any;

    const service = new ObsidianContextService(app);
    const result = await service.collect({
      includeBacklinks: true,
      explicitScopes: ['current', 'backlinks'],
    });

    expect(result.activeNote?.path).toBe(activeFile.path);
    expect(result.activeNote?.title).toBe('Native AI');
    expect(result.selection?.text).toBe(selectedText);
    expect(result.activeHeading).toBe('## 背景');
    expect(result.frontmatter.owner).toBe('team-ai');
    expect(result.tags).toEqual(['#ai', '#obsidian/native']);
    expect(result.outgoingLinks).toEqual(['Knowledge/Context Graph', 'Notes/Product Strategy']);
    expect(result.backlinks.length).toBe(2);
    expect(result.backlinks[0].path).toBe(backlinkA.path);
    expect(result.recentNotes.map((note: any) => note.path)).toEqual([
      activeFile.path,
      backlinkA.path,
      backlinkB.path,
    ]);
    expect(result.explicitScopes).toEqual(['current', 'backlinks']);

    const activeItem = result.contextItems.find((item: any) => item.id === `active-note:${activeFile.path}`);
    expect(activeItem).toBeTruthy();
    expect(activeItem.content).toContain('## 背景');
    expect(activeItem.content).toContain(selectedText);
    expect(activeItem.content.includes('## Appendix')).toBeFalsy();

    const backlinksItem = result.contextItems.find((item: any) => item.id === `backlinks:${activeFile.path}`);
    expect(backlinksItem).toBeTruthy();
    expect(backlinksItem.data).toContain('Backlinks summary');
    expect(backlinksItem.content).toContain(backlinkA.path);
    expect(backlinksItem.content).toContain('product workflow migration');
  });

  await test('collect returns safe defaults when there is no active note', async () => {
    const app = {
      workspace: {
        getActiveFile: () => null,
        getMostRecentLeaf: () => null,
        getLastOpenFiles: () => [],
      },
      vault: {
        read: async () => '',
        getAbstractFileByPath: () => null,
      },
      metadataCache: {
        getFileCache: () => null,
      },
    } as any;

    const { ObsidianContextService } = await import('../src/services/obsidian-context-service');
    const service = new ObsidianContextService(app);
    const result = await service.collect();

    expect(result.activeNote).toBe(null);
    expect(result.selection).toBe(null);
    expect(result.activeHeading).toBe(null);
    expect(result.tags).toEqual([]);
    expect(result.outgoingLinks).toEqual([]);
    expect(result.backlinks).toEqual([]);
    expect(result.recentNotes).toEqual([]);
    expect(result.contextItems).toEqual([]);
  });

  await test('collect can skip current note and selection while preserving scope metadata', async () => {
    const activeFile = createFile('Projects/Native AI.md');
    let readCount = 0;
    const app = {
      workspace: {
        getActiveFile: () => activeFile,
        getMostRecentLeaf: () => ({
          view: {
            editor: {
              getSelection: () => 'selected text',
              getCursor: () => ({ line: 0, ch: 0 }),
            },
          },
        }),
        getLastOpenFiles: () => [activeFile.path],
      },
      vault: {
        read: async () => {
          readCount += 1;
          return '# Native AI';
        },
        getAbstractFileByPath: () => null,
      },
      metadataCache: {
        getFileCache: () => ({}),
        getBacklinksForFile: () => new Map(),
      },
    } as any;

    const service = new ObsidianContextService(app);
    const result = await service.collect({
      includeCurrent: false,
      includeBacklinks: false,
      explicitScopes: [],
    });

    expect(readCount).toBe(0);
    expect(result.activeNote?.path).toBe(activeFile.path);
    expect(result.selection).toBe(null);
    expect(result.contextItems).toEqual([]);
    expect(result.explicitScopes).toEqual([]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
import { TFile } from 'obsidian';
