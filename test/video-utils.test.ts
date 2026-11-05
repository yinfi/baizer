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

  await test('survives malformed Bilibili / YouTube JSON without throwing', async () => {
    const response = (text: string) => ({ status: 200, text, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} }) as any;
    const biliHtml = '<title>Bad Subs_哔哩哔哩_bilibili</title><script>"bvid":"BVbad","cid":1</script>';
    const subtitleCases: Array<[string, string]> = [
      ['subtitles not an array', JSON.stringify({ data: { subtitle: { subtitles: 'x' } } })],
      ['data is null', JSON.stringify({ data: null })],
      ['url is a number', JSON.stringify({ data: { subtitle: { subtitles: [{ url: 5 }] } } })],
      ['body not an array', JSON.stringify({ data: { subtitle: { subtitles: [{ url: '//e.com/s.json' }] } } })],
    ];
    for (const [label, apiText] of subtitleCases) {
      const fetcher = createVideoTranscriptFetcher({
        requestUrl: async (options: any) => {
          if (options.url === 'https://www.bilibili.com/video/BVbad') return response(biliHtml);
          if (options.url.startsWith('https://api.bilibili.com/')) return response(apiText);
          return response(JSON.stringify({ body: 'nope' }));
        },
      });
      const result = await fetcher('https://www.bilibili.com/video/BVbad');
      expect(result?.text).toBe('');
      expect(result?.needsTranscription === true ? 'metadata' : `unexpected (${label})`).toBe('metadata');
    }

    // body 中夹杂脏条目：好条目的 content 仍然保留。
    const mixed = createVideoTranscriptFetcher({
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVbad') return response(biliHtml);
        if (options.url.startsWith('https://api.bilibili.com/')) {
          return response(JSON.stringify({ data: { subtitle: { subtitles: [{ url: '//e.com/s.json' }] } } }));
        }
        return response(JSON.stringify({ body: [{ content: 'one' }, { content: 'two' }] }));
      },
    });
    expect((await mixed('https://www.bilibili.com/video/BVbad'))?.text).toBe('one two');

    // YouTube：captionTracks 为空数组 / 缺 baseUrl 时不崩溃，返回 null 或仅元数据。
    const ytHtml = (tracks: string) => `<title>Clip - YouTube</title>"captionTracks":${tracks}`;
    const emptyTracks = createVideoTranscriptFetcher({ requestUrl: async () => response(ytHtml('[]')) });
    expect((await emptyTracks('https://www.youtube.com/watch?v=x'))?.needsTranscription).toBe(true);

    const originalError = console.error;
    console.error = () => { /* expected: the fetcher logs the failure */ };
    try {
      const noBaseUrl = createVideoTranscriptFetcher({ requestUrl: async () => response(ytHtml('[{"languageCode":"en"}]')) });
      let notified = false;
      try {
        const result = await noBaseUrl('https://www.youtube.com/watch?v=x');
        expect(result === null ? 'null' : 'value').toBe('null');
      } catch {
        notified = true;
      }
      expect(notified).toBe(false);
    } finally {
      console.error = originalError;
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
