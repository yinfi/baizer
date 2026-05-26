import { App } from 'obsidian';
import { MemoryManager } from '../src/memory/memory-manager';
import { IChatSession, IModelProvider, ToolDefinition } from '../src/models/interfaces';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}"`);
      }
    },
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected string not to contain "${expected}"`);
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class MockChatSession implements IChatSession {
  async sendMessage(_text: string | any[]) {
    return { text: 'ok' };
  }

  async *sendMessageStream(_text: string | any[]) {
    yield { type: 'done' as const, text: 'ok' };
  }

  async getHistory() {
    return [];
  }

  async clearHistory() {
    return;
  }
}

function createModelProvider(promptLog: string[]): IModelProvider {
  return {
    id: 'mock',
    name: 'Mock Provider',
    configure: (_config: any) => undefined,
    checkAvailability: async () => true,
    generateContent: async (prompt: string) => {
      promptLog.push(prompt);
      if (prompt.includes('I am fixing the inbox autosave flow')) {
        return { text: 'summary includes inbox autosave flow' };
      }
      if (prompt.includes('Analyze the following user message')
        || prompt.includes('No profile information yet.')) {
        return { text: '{}' };
      }
      return { text: 'summary missing session transcript' };
    },
    startChat: (_tools?: ToolDefinition[]) => new MockChatSession(),
  };
}

function createApp(adapterOverrides: Record<string, any> = {}) {
  const writes: Record<string, string> = {};
  const adapter = {
    exists: async (_path: string) => false,
    read: async (_path: string) => '',
    write: async (path: string, content: string) => {
      writes[path] = content;
    },
    mkdir: async (_path: string) => undefined,
    ...adapterOverrides,
  };

  return {
    app: {
      vault: { adapter },
    } as unknown as App,
    writes,
  };
}

async function runTests() {
  console.log('=== MemoryManager Tests ===');

  await test('does not let delayed disk loads overwrite newly recorded messages', async () => {
    const historyPath = '.obsidian/baizer-memory/chat-history.json';
    const { app } = createApp({
      exists: async (path: string) => path === historyPath,
      read: async (path: string) => {
        if (path === historyPath) {
          await delay(30);
          return JSON.stringify([{ role: 'user', content: 'old history', timestamp: 1 }]);
        }
        return '';
      },
    });

    const promptLog: string[] = [];
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.recordMessage('user', 'new history');
    await delay(60);

    expect(memory.chatHistory[memory.chatHistory.length - 1].content).toBe('new history');
  });

  await test('does not load chat history from the previous plugin memory directory', async () => {
    const previousMemoryDir = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');
    const legacyHistoryPath = `${previousMemoryDir}/chat-history.json`;
    const { app } = createApp({
      exists: async (path: string) => path === legacyHistoryPath,
      read: async (path: string) => {
        if (path === legacyHistoryPath) {
          return JSON.stringify([{ role: 'user', content: 'old brand history', timestamp: 1 }]);
        }
        return '';
      },
    });

    const promptLog: string[] = [];
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    expect(memory.chatHistory.length).toBe(0);
  });

  await test('imports profile and summaries from the previous plugin memory directory before loading context', async () => {
    const previousMemoryDir = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');
    const files: Record<string, string> = {
      [`${previousMemoryDir}/user-profile.json`]: JSON.stringify({
        profession: 'Previous plugin engineer',
        expertise: ['legacy memory'],
        preferences: { language: 'zh-CN', responseStyle: 'concise', topics: ['plugins'] },
        workflows: [],
        context: { currentProjects: ['Profile migration'], goals: ['keep profile'], challenges: [] },
        metadata: { createdAt: 1, updatedAt: 2, totalInteractions: 3, lastProfileUpdate: 2 },
      }),
      [`${previousMemoryDir}/session-summaries.json`]: JSON.stringify([
        { timestamp: 10, messageCount: 2, summary: 'Legacy summary imported.' },
      ]),
    };
    const { app } = createApp({
      exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
      read: async (path: string) => files[path],
      write: async (path: string, content: string) => {
        files[path] = content;
      },
      mkdir: async (path: string) => {
        files[path] = '';
      },
    });

    const memory = new MemoryManager(app, createModelProvider([]));
    await memory.ready();

    const context = memory.buildContext();
    expect(context).toContain('Previous plugin engineer');
    expect(context).toContain('Legacy summary imported.');
    expect(files['.obsidian/baizer-memory/user-profile.json']).toContain('Previous plugin engineer');
    expect(files['.obsidian/baizer-memory/session-summaries.json']).toContain('Legacy summary imported.');
  });

  await test('exposes ready() and uses current session transcript when summarizing', async () => {
    const promptLog: string[] = [];
    const { app, writes } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    const readyFn = (memory as any).ready;

    if (typeof readyFn !== 'function') {
      throw new Error('ready() missing');
    }

    await readyFn.call(memory);
    await memory.recordMessage('user', 'I am fixing the inbox autosave flow');
    await memory.recordMessage('model', 'Let us add a queue and merge-safe rewrite');
    await memory.clearSession();

    const summaryPath = '.obsidian/baizer-memory/session-summaries.json';
    const savedSummaries = JSON.parse(writes[summaryPath] || '[]');
    expect(savedSummaries.length).toBe(1);
    expect(savedSummaries[0].summary).toContain('inbox autosave flow');
    expect(promptLog[promptLog.length - 1]).toContain('I am fixing the inbox autosave flow');
  });

  await test('buildContext applies a budget to long profile and summary blocks', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    (memory as any).userProfile = {
      name: 'User',
      profession: 'Engineer',
      expertise: ['x'.repeat(1500)],
      preferences: { responseStyle: 'balanced' },
      workflows: [],
      context: { currentProjects: ['p'.repeat(1500)], goals: ['g'.repeat(1500)], challenges: [] },
      metadata: { totalInteractions: 1, updatedAt: Date.now(), lastProfileUpdate: Date.now() },
    };
    (memory as any).sessionSummaries = [
      { timestamp: Date.now(), messageCount: 5, summary: 's'.repeat(3000) },
      { timestamp: Date.now(), messageCount: 6, summary: 't'.repeat(3000) },
    ];

    const context = memory.buildContext();

    expect(context.length <= 4500).toBe(true);
    expect(context).toContain('[User Profile]');
    expect(context).toContain('[Recent Context]');
  });

  await test('recallForPrompt returns relevant hindsight memories', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'We will keep memory local.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'How should Baizer memory work?',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toContain('[Relevant Memory]');
    expect(promptBlock).toContain('local-first');
  });

  await test('getMemoryView returns stats and sections for command and settings UI', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'Acknowledged the local-first preference.',
      source: 'shell',
      now: 1000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'overview', limit: 5, now: 2000 });

    expect(view.stats.total).toBe(2);
    expect(view.stats.world).toBe(1);
    expect(view.stats.experience).toBe(1);
    expect(view.sections.facts.length).toBe(1);
    expect(view.privacyMode).toBe(false);
  });

  await test('deleteMemoryById removes one retained memory', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'My project LaunchPlan needs memory row deletion.',
      assistantMessage: 'Captured LaunchPlan deletion need.',
      source: 'shell',
      now: 1000,
    });
    const before = await (memory as any).getMemoryView({ mode: 'raw' });
    const targetId = before.sections.raw[0].id;

    const result = await (memory as any).deleteMemoryById(targetId);
    const after = await (memory as any).getMemoryView({ mode: 'raw' });

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(after.sections.raw.some((record: any) => record.id === targetId)).toBe(false);
  });

  await test('privacy mode prevents retaining new turn memories', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog), { privacyMode: true } as any);
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that my project is private.',
      assistantMessage: 'Acknowledged.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'private project',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toBe('');
  });

  await test('forgetMemory all removes retained hindsight memories from recall and disk', async () => {
    const promptLog: string[] = [];
    const { app, writes } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that my project is LaunchPlan and I prefer weekly summaries.',
      assistantMessage: 'I will remember the LaunchPlan preference.',
      source: 'shell',
      now: 1000,
    });

    await (memory as any).forgetMemory('all');

    const promptBlock = await (memory as any).recallForPrompt({
      query: 'LaunchPlan weekly summaries',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toBe('');
    expect(writes['.obsidian/baizer-memory/memories.json'] || '').notToContain('LaunchPlan');
  });

  await test('retainTurn redacts secrets before writing hindsight memories', async () => {
    const promptLog: string[] = [];
    const { app, writes } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'Remember that I prefer concise answers. My API key is sk-test-secret.',
      assistantMessage: 'Use token ghp_secret1234567890 when calling the service.',
      source: 'shell',
      now: 1000,
    });

    const saved = writes['.obsidian/baizer-memory/memories.json'] || '';
    expect(saved).toContain('[REDACTED]');
    expect(saved).notToContain('sk-test-secret');
    expect(saved).notToContain('ghp_secret1234567890');
  });

  await test('forgetMemory field deletes natural language profession name and expertise memories', async () => {
    const cases = [
      { field: 'profession', message: 'I am a frontend engineer named Alice.', query: 'frontend engineer Alice' },
      { field: 'profession', message: "I'm a backend engineer working on Obsidian plugins.", query: 'backend engineer Obsidian' },
      { field: 'profession', message: '我是产品经理，负责知识库体验。', query: '产品经理 知识库体验' },
      { field: 'expertise', message: 'I am expert in TypeScript plugin architecture.', query: 'TypeScript plugin architecture' },
      { field: 'expertise', message: '我擅长知识图谱整理和检索体验。', query: '知识图谱 检索体验' },
      { field: 'name', message: 'I am named Riley in this workspace.', query: 'Riley workspace' },
      { field: 'name', message: 'Please call me Morgan when answering.', query: 'Morgan answering' },
    ];

    for (const item of cases) {
      const promptLog: string[] = [];
      const { app } = createApp();
      const memory = new MemoryManager(app, createModelProvider(promptLog));
      await memory.ready();

      await (memory as any).retainTurn({
        userMessage: item.message,
        assistantMessage: 'Acknowledged.',
        source: 'shell',
        now: 1000,
      });

      await (memory as any).forgetMemory(item.field);

      const promptBlock = await (memory as any).recallForPrompt({
        query: item.query,
        maxChars: 500,
        now: 2000,
      });

      expect(promptBlock).toBe('');
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
