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

  await test('transcribes through the OpenAI-compatible endpoint of the configured provider', async () => {
    // 自定义网关：端点必须是「该 provider 的 baseUrl + /audio/transcriptions」，
    // 而不是硬编码的 OpenAI 官方地址（旧的 Gemini inlineData 旁路已随协议移除）。
    let transcriptionRequestUrl = '';
    const service = createVideoTranscriptionService({
      requestUrl: async (options: any) => {
        if (options.url === 'https://www.bilibili.com/video/BVgateway') {
          return {
            status: 200,
            text: '<script>window.__playinfo__={"data":{"dash":{"audio":[{"baseUrl":"https://media.example/gw-audio.m4a"}]}}}</script>',
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {},
          };
        }
        if (options.url === 'https://media.example/gw-audio.m4a') {
          return {
            status: 200,
            text: '',
            headers: {},
            arrayBuffer: new Uint8Array([5, 5]).buffer,
            json: {},
          };
        }
        throw new Error(`Unexpected URL ${options.url}`);
      },
      fetchImpl: async (url: string, _init: any) => {
        transcriptionRequestUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: 'gateway transcript text' }),
        } as any;
      },
    });

    const result = await service.transcribeFromVideoUrl({
      url: 'https://www.bilibili.com/video/BVgateway',
      platform: 'bilibili',
      provider: {
        type: 'openai-compatible',
        label: 'Gateway',
        apiKey: 'sk-gw',
        baseUrl: 'https://gw.example.com/v1/',
        model: 'whisper-1',
      },
    });

    expect(transcriptionRequestUrl).toBe('https://gw.example.com/v1/audio/transcriptions');
    expect(result.text).toContain('gateway transcript text');
  });

  await test('has no Gemini / Google inline-audio path left', async () => {
    // 协议移除后这里只剩 Whisper 一条路。若有人把 google SDK 分支加回来，
    // 这条断言会连同 bundle-size 里的「Google SDK 不在包里」一起变红。
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/services/video-transcription.ts', 'utf8');
    // 只看代码：该文件头部仍会说明「历史上有一条 Gemini 分支，已随协议移除」，
    // 那是变更记录，不是可达路径。故块注释与行注释都要先去掉。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');

    for (const forbidden of ['gemini', 'generative-ai', 'inlineData', 'generateContent', 'toBase64']) {
      expect(code.toLowerCase().includes(forbidden.toLowerCase())).toBe(false);
    }
    // 依赖面里也不该再有注入 Gemini 模型的口子。
    expect(code.includes('createGeminiModel')).toBe(false);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
