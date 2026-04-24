(global as any).window = {
  setInterval,
  clearInterval,
};

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

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
  console.log('=== ChatController Tests ===');
  const { ChatController } = await import('../src/ui/chat-controller');

  await test('processCommand routes matching slash commands through executeSlashSkillCommand first', async () => {
    const messages: any[] = [];
    const apiCalls = {
      executeSlashSkillCommand: [] as any[],
      chat: [] as any[],
    };

    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [
          { command: '/save', skillName: 'web-clipper', description: 'Save webpage to vault' },
        ],
        executeSlashSkillCommand: async (command: string, input: string) => {
          apiCalls.executeSlashSkillCommand.push({ command, input });
          return { success: true, message: 'Saved note' };
        },
        chat: async (...args: any[]) => {
          apiCalls.chat.push(args);
          return 'fallback';
        },
        chatStream: async function* () { },
        clearSession: async () => { },
        getUserProfile: () => null,
        updateProfile: async () => { },
        getAvailableTools: () => [],
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/save https://example.com');

    expect(apiCalls.executeSlashSkillCommand).toEqual([
      { command: '/save', input: 'https://example.com' },
    ]);
    expect(apiCalls.chat.length).toBe(0);
    expect(messages[messages.length - 1].content).toBe('Saved note');

    controller.cleanup();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
