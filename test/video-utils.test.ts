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
  console.log('=== video-utils Tests ===');
  const { createVideoTranscriptFetcher } = await import('../src/utils/video_utils');

  await test('returns platform subtitle text when Bilibili subtitles are available', async () => {
    const fetcher = createVideoTranscriptFetcher({
      userAgent: 'TestAgent',
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVdemo') {
          return {
            status: 200,
            text: '<title>Demo Bilibili Video_哔哩哔哩_bilibili</title><meta name="author" content="Uploader"><script>window.__INITIAL_STATE__={"bvid":"BVdemo","cid":123}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://api.bilibili.com/x/player/v2?cid=123&bvid=BVdemo') {
          return {
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: {
                subtitle: {
                  subtitles: [{ url: '//example.com/subtitle.json' }],
                },
              },
            }),
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://example.com/subtitle.json') {
          return {
            status: 200,
            text: JSON.stringify({
              body: [
                { content: 'first sentence' },
                { content: 'second sentence' },
              ],
            }),
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
    });

    const result = await fetcher('https://www.bilibili.com/video/BVdemo');
    expect(result?.text).toContain('first sentence');
    expect(result?.transcriptSource).toBe('platform-subtitle');
    expect(result?.needsTranscription).toBe(false);
  });

  await test('marks Bilibili videos for transcription when subtitles are missing', async () => {
    const fetcher = createVideoTranscriptFetcher({
      userAgent: 'TestAgent',
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVnosub') {
          return {
            status: 200,
            text: '<title>No Subtitle Video_哔哩哔哩_bilibili</title><meta name="author" content="Uploader"><script>window.__INITIAL_STATE__={"bvid":"BVnosub","cid":456,"desc":"Video description here"}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://api.bilibili.com/x/player/v2?cid=456&bvid=BVnosub') {
          return {
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: {
                need_login_subtitle: true,
                subtitle: {
                  subtitles: [],
                },
              },
            }),
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
    });

    const result = await fetcher('https://www.bilibili.com/video/BVnosub');
    expect(result?.title).toContain('No Subtitle Video');
    expect(result?.description).toContain('Video description');
    expect(result?.text).toBe('');
    expect(result?.needsTranscription).toBe(true);
    expect(result?.transcriptSource).toBe('metadata');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
