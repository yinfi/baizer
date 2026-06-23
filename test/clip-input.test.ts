function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error('Expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error('Expected ' + expectedStr + ' but got ' + actualStr);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log('  PASS ' + name);
  } catch (e: any) {
    console.error('  FAIL ' + name + ': ' + e.message);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Clip input Tests ===');
  const {
    extractFirstHttpUrl,
    saveClipText,
  } = await import('../src/services/clip-input');

  await test('extractFirstHttpUrl reads a WeChat URL from mobile share text', () => {
    const url = extractFirstHttpUrl([
      '卡帕西引爆硅谷！',
      'https://mp.weixin.qq.com/s/abc123?chksm=hello&scene=21#wechat_redirect',
      '来自微信',
    ].join('\n'));

    expect(url).toBe('https://mp.weixin.qq.com/s/abc123?chksm=hello&scene=21#wechat_redirect');
  });

  await test('extractFirstHttpUrl trims common trailing punctuation from shared text', () => {
    const url = extractFirstHttpUrl('保存这篇：https://mp.weixin.qq.com/s/abc123）。');

    expect(url).toBe('https://mp.weixin.qq.com/s/abc123');
  });

  await test('saveClipText calls saveUrl with the first http URL', async () => {
    const calls: string[] = [];
    const result = await saveClipText({
      text: '标题\nhttps://mp.weixin.qq.com/s/abc123\n更多文字 https://example.com/later',
      saveUrl: async (url: string) => {
        calls.push(url);
        return { success: true, path: 'Clippings/article.md' };
      },
    });

    expect(calls).toEqual(['https://mp.weixin.qq.com/s/abc123']);
    expect(result).toEqual({ success: true, path: 'Clippings/article.md' });
  });

  await test('saveClipText rejects text without an http URL before saving', async () => {
    const calls: string[] = [];
    const result = await saveClipText({
      text: '没有链接',
      saveUrl: async (url: string) => {
        calls.push(url);
        return { success: true, path: 'Clippings/ignored.md' };
      },
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({ success: false, error: 'No http/https URL found.' });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
