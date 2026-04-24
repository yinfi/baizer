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
    const historyPath = '.obsidian/obsidian-cli-memory/chat-history.json';
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

    const summaryPath = '.obsidian/obsidian-cli-memory/session-summaries.json';
    const savedSummaries = JSON.parse(writes[summaryPath] || '[]');
    expect(savedSummaries.length).toBe(1);
    expect(savedSummaries[0].summary).toContain('inbox autosave flow');
    expect(promptLog[promptLog.length - 1]).toContain('I am fixing the inbox autosave flow');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
