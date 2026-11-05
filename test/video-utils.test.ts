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

  await test('skips malformed Bilibili subtitle entries instead of failing the whole clip', async () => {
    const fetcher = createVideoTranscriptFetcher({
      userAgent: 'TestAgent',
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVmalformed') {
          return {
            status: 200,
            text: '<title>Malformed Bilibili Video_哔哩哔哩_bilibili</title><script>window.__INITIAL_STATE__={"bvid":"BVmalformed","cid":789}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://api.bilibili.com/x/player/v2?cid=789&bvid=BVmalformed') {
          return {
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: {
                subtitle: {
                  subtitles: [
                    null,
                    'not-an-object',
                    { url: 42 },
                    { url: '' },
                    { url: '//example.com/malformed-subtitle.json' },
                  ],
                },
              },
            }),
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://example.com/malformed-subtitle.json') {
          return {
            status: 200,
            text: JSON.stringify({
              body: [{ content: 'first sentence' }, null, { content: 42 }, { content: 'second sentence' }],
            }),
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
    });

    const result = await fetcher('https://www.bilibili.com/video/BVmalformed');
    // 坏条目（null / 非对象 / 非字符串 url / 非字符串 content）被跳过，好条目照常拼出文本。
    expect(result?.text).toContain('first sentence');
    expect(result?.text).toContain('second sentence');
    expect(result?.transcriptSource).toBe('platform-subtitle');
  });

  await test('falls back to metadata when YouTube caption tracks are malformed', async () => {
    const fetcher = createVideoTranscriptFetcher({
      userAgent: 'TestAgent',
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.youtube.com/watch?v=malformed') {
          return {
            status: 200,
            text: '<title>Demo - YouTube</title><script>"captionTracks":[null,{"languageCode":"en"}]</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
    });

    const result = await fetcher('https://www.youtube.com/watch?v=malformed');
    // 唯一字幕轨没有 baseUrl：不能拿着坏 URL 发请求，退回 metadata（由上层触发音频转写）。
    expect(result?.title).toBe('Demo');
    expect(result?.text).toBe('');
    expect(result?.transcriptSource).toBe('metadata');
    expect(result?.needsTranscription).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
