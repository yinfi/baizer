import { DEFAULT_SETTINGS } from '../src/mcp/types';

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
  console.log('=== ModelService Tests ===');
  const { ModelService } = await import('../src/services/model-service');

  await test('switchProvider flushes the active memory session before cleanup', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [];
    service.memoryManager = {
      ready: async () => { order.push('ready'); },
      clearSession: async () => { order.push('clearSession'); },
      save: async () => { order.push('save'); },
    };
    service.cleanup = () => {
      order.push('cleanup');
      service.memoryManager = null;
    };
    service.initializeProvider = () => {
      order.push('initializeProvider');
    };

    await service.switchProvider('openai');

    expect(order).toEqual([
      'ready',
      'clearSession',
      'save',
      'cleanup',
      'initializeProvider',
    ]);
  });

  await test('updateSettings flushes the active memory session before rebuilding services', async () => {
    const service: any = Object.create(ModelService.prototype);
    const order: string[] = [];

    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.modelListCache = new Map();
    service.providerChangedCallbacks = [];
    service.memoryManager = {
      ready: async () => { order.push('ready'); },
      clearSession: async () => { order.push('clearSession'); },
      save: async () => { order.push('save'); },
    };
    service.cleanup = () => {
      order.push('cleanup');
      service.memoryManager = null;
    };
    service.initializeProvider = () => {
      order.push('initializeProvider');
    };

    await service.updateSettings({
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      systemPrompt: 'updated',
    });

    expect(order).toEqual([
      'ready',
      'clearSession',
      'save',
      'cleanup',
      'initializeProvider',
    ]);
  });

  await test('getSkillCommands proxies command entries from the skill registry', async () => {
    const service: any = Object.create(ModelService.prototype);
    const commands = [
      { command: '/save', skillName: 'web-clipper', description: 'Save webpage' },
      { command: '/wiki:query', skillName: 'knowledge', description: 'Query knowledge wiki' },
    ];

    service.skillRegistry = {
      listCommandEntries: () => commands,
    };

    expect(service.getSkillCommands()).toEqual(commands);
  });

  await test('executeSlashSkillCommand dispatches to the resolved skill with normalized args', async () => {
    const service: any = Object.create(ModelService.prototype);
    const calls: any[] = [];
    const expectedResult = { success: true, message: 'saved' };

    service.app = { id: 'app' };
    service.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    service.skillRegistry = {
      resolveByCommand: (command: string) => command === '/save'
        ? {
          execute: async (args: any, ctx: any) => {
            calls.push({ args, ctx });
            return expectedResult;
          },
        }
        : null,
    };

    const result = await service.executeSlashSkillCommand('/save', 'https://example.com/article');

    expect(result).toEqual(expectedResult);
    expect(calls).toEqual([{
      args: {
        command: '/save',
        input: 'https://example.com/article',
        query: 'https://example.com/article',
        url: 'https://example.com/article',
      },
      ctx: {
        app: service.app,
        settings: service.settings,
      },
    }]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
