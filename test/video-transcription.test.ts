import { DEFAULT_PROVIDERS } from '../src/mcp/types';

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
  console.log('=== video-transcription Tests ===');
  const { createVideoTranscriptionService } = await import('../src/services/video-transcription');

  await test('downloads bilibili audio and submits it to /audio/transcriptions', async () => {
    let transcriptionRequestUrl = '';
    const service = createVideoTranscriptionService({
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVaudio') {
          return {
            status: 200,
            text: '<script>window.__playinfo__={"data":{"dash":{"audio":[{"baseUrl":"https://media.example/audio.m4a"}]}}}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://media.example/audio.m4a') {
          return {
            status: 200,
            text: '',
            headers: {},
            arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
      fetchImpl: async (url: string, init: any) => {
        transcriptionRequestUrl = String(url);
        if (!init.body || !(init.body instanceof FormData)) {
          throw new Error('Expected FormData body');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: 'transcribed audio text' }),
        } as any;
      },
    });

    const result = await service.transcribeFromVideoUrl({
      url: 'https://www.bilibili.com/video/BVaudio',
      platform: 'bilibili',
      provider: DEFAULT_PROVIDERS.openai,
    });

    expect(transcriptionRequestUrl).toContain('/audio/transcriptions');
    expect(result.text).toContain('transcribed audio text');
  });

  await test('returns a clear error when the transcription endpoint fails', async () => {
    const service = createVideoTranscriptionService({
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVfail') {
          return {
            status: 200,
            text: '<script>window.__playinfo__={"data":{"dash":{"audio":[{"baseUrl":"https://media.example/fail-audio.m4a"}]}}}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://media.example/fail-audio.m4a') {
          return {
            status: 200,
            text: '',
            headers: {},
            arrayBuffer: new Uint8Array([1, 2]).buffer,
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
      fetchImpl: async (_url: string, _init: any) => {
        return {
          ok: false,
          status: 404,
          text: async () => 'not found',
        } as any;
      },
    });

    try {
      await service.transcribeFromVideoUrl({
        url: 'https://www.bilibili.com/video/BVfail',
        platform: 'bilibili',
        provider: DEFAULT_PROVIDERS.openai,
      });
      throw new Error('Expected transcription to fail');
    } catch (e: any) {
      expect(e.message).toContain('404');
    }
  });

  await test('uses Gemini inline audio input when provider type is gemini', async () => {
    let capturedParts: any[] = [];
    const service = createVideoTranscriptionService({
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVgemini') {
          return {
            status: 200,
            text: '<script>window.__playinfo__={"data":{"dash":{"audio":[{"baseUrl":"https://media.example/gemini-audio.m4a"}]}}}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://media.example/gemini-audio.m4a') {
          return {
            status: 200,
            text: '',
            headers: {},
            arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
      createGeminiModel: (_provider: any) => ({
        generateContent: async (parts: any[]) => {
          capturedParts = parts;
          return {
            response: {
              text: () => 'gemini transcript text',
            },
          };
        },
      }),
    });

    const result = await service.transcribeFromVideoUrl({
      url: 'https://www.bilibili.com/video/BVgemini',
      platform: 'bilibili',
      provider: DEFAULT_PROVIDERS.gemini,
    });

    expect(capturedParts.length).toBe(2);
    expect(capturedParts[1].inlineData.mimeType).toContain('audio');
    expect(result.text).toContain('gemini transcript text');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
