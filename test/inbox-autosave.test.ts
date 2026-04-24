import { App, TFile } from 'obsidian';

function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}"`);
      }
    },
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected "${expected}" but got "${actual}"`);
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

async function runTests() {
  console.log('=== Inbox autosave Tests ===');
  const {
    extractRawUrlMatches,
    InboxAutosaveCoordinator,
  } = await import('../src/services/inbox-autosave');

  await test('extractRawUrlMatches ignores wiki links and markdown links', async () => {
    const matches = extractRawUrlMatches(
      '[[Saved]] [Read later](https://b.com) https://a.com\nanother https://c.com',
    );

    expect(matches.map((m: any) => m.url)).toEqual([
      'https://a.com',
      'https://c.com',
    ]);
  });

  await test('serializes repeated file processing and rewrites the latest content snapshot', async () => {
    let content = 'https://a.com';
    const file = { path: 'Inbox.md' } as TFile;
    let saveCalls = 0;

    const app = {
      vault: {
        read: async (_file: TFile) => content,
        modify: async (_file: TFile, nextContent: string) => {
          content = nextContent;
        },
      },
    } as unknown as App;

    const coordinator = new InboxAutosaveCoordinator({
      app,
      getInboxPath: () => 'Inbox.md',
      saveUrl: async (url: string) => {
        saveCalls++;
        await delay(20);
        return { success: true, path: `Clippings/${url.split('/').pop()}.md` };
      },
      notify: (_message: string) => undefined,
    });

    const firstRun = coordinator.handleFileModify(file);
    await delay(5);
    content = `prefix\n${content}\nsuffix`;
    const secondRun = coordinator.handleFileModify(file);

    await Promise.all([firstRun, secondRun]);

    expect(saveCalls).toBe(1);
    expect(content).toContain('prefix');
    expect(content).toContain('suffix');
    expect(content).toContain('[[Clippings/a.com.md|Saved: a.com]]');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
