function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
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

async function runTests() {
  console.log('=== Clip protocol Tests ===');
  const {
    parseBaizerClipProtocolParams,
    BaizerClipProtocolHandler,
    registerBaizerClipProtocolHandler,
  } = await import('../src/services/clip-protocol');

  await test('parses obsidian protocol url parameter and decodes encoded WeChat links', () => {
    const params = parseBaizerClipProtocolParams({
      url: encodeURIComponent('https://mp.weixin.qq.com/s/abc123?chksm=hello&scene=21#wechat_redirect'),
    });

    expect(params).toEqual({
      url: 'https://mp.weixin.qq.com/s/abc123?chksm=hello&scene=21#wechat_redirect',
    });
  });

  await test('rejects missing or non-http urls before calling save_webpage', async () => {
    const calls: string[] = [];
    const notices: string[] = [];
    const handler = new BaizerClipProtocolHandler({
      saveUrl: async (url: string) => {
        calls.push(url);
        return { success: true, path: 'Clippings/ignored.md' };
      },
      notify: (message: string) => notices.push(message),
    });

    await handler.handle({ url: 'obsidian://open?vault=bad' });

    expect(calls).toEqual([]);
    expect(notices[0]).toContain('Invalid clip URL');
  });

  await test('saves valid protocol url through save_webpage and reports the saved path', async () => {
    const calls: string[] = [];
    const notices: string[] = [];
    const handler = new BaizerClipProtocolHandler({
      saveUrl: async (url: string) => {
        calls.push(url);
        return { success: true, path: 'Clippings/寰俊鏂囩珷.md' };
      },
      notify: (message: string) => notices.push(message),
    });

    await handler.handle({ url: encodeURIComponent('https://mp.weixin.qq.com/s/abc123') });

    expect(calls).toEqual(['https://mp.weixin.qq.com/s/abc123']);
    expect(notices[0]).toContain('Clipping');
    expect(notices[1]).toContain('Clippings/寰俊鏂囩珷.md');
  });
  await test('saves a URL extracted from encoded mobile share text', async () => {
    const calls: string[] = [];
    const handler = new BaizerClipProtocolHandler({
      saveUrl: async (url: string) => {
        calls.push(url);
        return { success: true, path: 'Clippings/mobile-share.md' };
      },
      notify: (_message: string) => undefined,
    });

    await handler.handle({
      text: encodeURIComponent('文章标题\nhttps://mp.weixin.qq.com/s/mobile123?scene=1#wechat_redirect\n来自微信'),
    });

    expect(calls).toEqual(['https://mp.weixin.qq.com/s/mobile123?scene=1#wechat_redirect']);
  });

  await test('protocol registration ignores duplicate baizer-clip action errors', () => {
    let attempts = 0;
    const warnings: string[] = [];
    const plugin = {
      registerObsidianProtocolHandler: (_action: string, _handler: (params: any) => void) => {
        attempts++;
        throw new Error('Action "baizer-clip" is already registered as a handler.');
      },
    };

    registerBaizerClipProtocolHandler(plugin, {
      saveUrl: async () => ({ success: true, path: 'Clippings/example.md' }),
      notify: () => undefined,
      warn: (message: string) => warnings.push(message),
    });

    expect(attempts).toBe(1);
    expect(warnings[0]).toContain('already registered');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

