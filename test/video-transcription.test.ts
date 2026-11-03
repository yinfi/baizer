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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** 假的已解码音频：恒定幅度 = 没有静音段，切点只能落在 45 s 上限上，窗口可手算。 */
function fakeDecoded(seconds: number, sampleRate: number, amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * sampleRate)).fill(amplitude);
  return {
    sampleRate,
    length: samples.length,
    channelCount: 1,
    getChannelData: () => samples,
  };
}

function bilibiliAudioStub(html: string, audioBytes: number[]) {
  return async (options: any) => {
    if (options.url === html) {
      return {
        status: 200,
        text: '<script>window.__playinfo__={"data":{"dash":{"audio":[{"baseUrl":"https://media.example/long.m4s"}]}}}</script>',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
      };
    }
    if (options.url === 'https://media.example/long.m4s') {
      return {
        status: 200,
        text: '',
        headers: {},
        arrayBuffer: new Uint8Array(audioBytes).buffer,
        json: {},
      };
    }
    throw new Error(`Unexpected URL ${options.url}`);
  };
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
  await test('splits long audio into bounded chunks and offsets every segment onto the whole track', async () => {
    const requests: Array<{ url: string; form: any; headers: any }> = [];
    const service = createVideoTranscriptionService({
      requestUrl: bilibiliAudioStub('https://www.bilibili.com/video/BVchunked', [9, 9, 9]),
      // 100 s @ 1 kHz：帧长 20 个样本，恒定 0.5 幅度下没有任何静音段。
      decodeAudio: async () => fakeDecoded(100, 100),
      fetchImpl: async (url: any, init: any) => {
        requests.push({ url: String(url), form: init.body, headers: init.headers });
        const payloads = [
          { text: 'alpha', segments: [{ start: 0, end: 5, text: 'alpha' }] },
          { text: 'beta', segments: [{ start: 1, end: 6, text: 'beta' }] },
          { text: 'gamma', segments: [{ start: 0, end: 2, text: 'gamma' }] },
        ];
        return { ok: true, status: 200, json: async () => payloads[requests.length - 1] } as any;
      },
    });

    const result = await service.transcribeFromVideoUrl({
      url: 'https://www.bilibili.com/video/BVchunked',
      platform: 'bilibili',
      provider: DEFAULT_PROVIDERS.openai,
      asr: {
        baseUrl: 'http://localhost:9000/v1',
        apiKey: '',
        model: 'custom-asr-model',
        language: 'zh',
        source: 'settings',
      },
    });

    assert(result.mode === 'chunked', `expected chunked mode, got ${result.mode}`);
    assert(result.chunkCount === 3, `expected 3 chunks, got ${result.chunkCount}`);
    assert(result.durationSec === 100, `expected 100 s, got ${result.durationSec}`);
    assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(' | ')}`);
    // 分片的 start/end 是相对该片的，必须把窗口起点加回去：0 / 45+1 / 90+0。
    assert(
      result.segments.map((segment) => segment.start).join(',') === '0,46,90',
      `segment offsets: ${result.segments.map((segment) => segment.start).join(',')}`,
    );
    assert(result.text === 'alpha beta gamma', `text: ${result.text}`);

    assert(requests.length === 3, `expected 3 requests, got ${requests.length}`);
    assert(
      requests.every((request) => request.url === 'http://localhost:9000/v1/audio/transcriptions'),
      'endpoint must come from the configured ASR base URL',
    );
    assert(requests.every((request) => request.form.get('model') === 'custom-asr-model'), 'model form field');
    assert(requests.every((request) => request.form.get('language') === 'zh'), 'language form field');
    assert(requests.every((request) => request.form.get('response_format') === 'verbose_json'), 'response_format');
    assert(
      requests.every((request) => !request.headers || !request.headers.Authorization),
      'no Authorization header should be sent when no key is configured',
    );

    // 单片体积上限：45 s * 100 Hz * 2 B + 44 B WAV 头 = 9044 B。
    for (const request of requests) {
      const file = request.form.get('file');
      assert(file && typeof file.size === 'number', 'file part missing from the multipart body');
      assert(file.size <= 9044, `chunk is ${file.size} B, over the 9044 B bound`);
    }
  });

  await test('falls back to one whole-track request and reports it when the audio cannot be decoded', async () => {
    let postedBody: any = null;
    const service = createVideoTranscriptionService({
      requestUrl: bilibiliAudioStub('https://www.bilibili.com/video/BVnodecode', [1, 2, 3, 4]),
      // 刻意不注入 decodeAudio：Node 里没有 Web Audio，默认解码器必然抛错。
      fetchImpl: async (_url: any, init: any) => {
        postedBody = init.body;
        return { ok: true, status: 200, json: async () => ({ text: 'whole track text' }) } as any;
      },
    });

    const result = await service.transcribeFromVideoUrl({
      url: 'https://www.bilibili.com/video/BVnodecode',
      platform: 'bilibili',
      provider: DEFAULT_PROVIDERS.openai,
    });

    assert(result.mode === 'single', `expected single mode, got ${result.mode}`);
    assert(result.chunkCount === 1, 'single mode must report one request');
    assert(result.warnings.length === 1, `expected exactly one warning, got ${result.warnings.length}`);
    assert(
      result.warnings[0].includes('could not be decoded'),
      `warning must explain the fallback: ${result.warnings[0]}`,
    );
    assert(result.text === 'whole track text', `text: ${result.text}`);
    assert(postedBody.get('file').size === 4, 'fallback must post the original container bytes');
    assert(postedBody.get('file').type === 'audio/mp4', 'fallback must keep the original MIME type');
  });

  await test('names the failing chunk and the endpoint response when one chunk request fails', async () => {
    let calls = 0;
    const service = createVideoTranscriptionService({
      requestUrl: bilibiliAudioStub('https://www.bilibili.com/video/BVchunkfail', [7, 7]),
      decodeAudio: async () => fakeDecoded(100, 100),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 2) {
          return { ok: false, status: 500, text: async () => 'upstream exploded' } as any;
        }
        return { ok: true, status: 200, json: async () => ({ text: 'ok' }) } as any;
      },
    });

    try {
      await service.transcribeFromVideoUrl({
        url: 'https://www.bilibili.com/video/BVchunkfail',
        platform: 'bilibili',
        provider: DEFAULT_PROVIDERS.openai,
      });
      throw new Error('Expected transcription to fail');
    } catch (e: any) {
      assert(e.message.includes('chunk 2/3'), `must name the chunk: ${e.message}`);
      assert(e.message.includes('00:45-01:30'), `must name the window: ${e.message}`);
      assert(e.message.includes('500'), `must carry the status: ${e.message}`);
      assert(e.message.includes('upstream exploded'), `must carry the body: ${e.message}`);
    }
  });

  await test('refuses to post to a chat provider endpoint and explains why', async () => {
    const service = createVideoTranscriptionService({
      requestUrl: async () => {
        throw new Error('must not fetch the page without a transcription endpoint');
      },
      fetchImpl: async () => {
        throw new Error('must not post anywhere');
      },
    });

    try {
      await service.transcribeFromVideoUrl({
        url: 'https://www.bilibili.com/video/BVnoendpoint',
        platform: 'bilibili',
        provider: DEFAULT_PROVIDERS.anthropic,
      });
      throw new Error('Expected transcription to fail');
    } catch (e: any) {
      assert(
        e.message.includes('No transcription endpoint is configured'),
        `message must explain the missing endpoint: ${e.message}`,
      );
    }
  });

  await test('resolves the transcription endpoint from settings, from the provider, or not at all', async () => {
    const { resolveAsrConfig, DEFAULT_ASR_MODEL } = await import('../src/mcp/types');

    const explicit = resolveAsrConfig({
      asr: {
        asrBaseUrl: 'http://127.0.0.1:8080/v1',
        asrApiKey: 'local-key',
        asrModel: 'sensevoice-small',
        asrLanguage: 'zh',
      },
      provider: DEFAULT_PROVIDERS.openai,
    });
    assert(!!explicit, 'explicit config must resolve');
    assert(explicit!.baseUrl === 'http://127.0.0.1:8080/v1', 'explicit baseUrl wins');
    assert(explicit!.apiKey === 'local-key', 'explicit key wins');
    assert(explicit!.model === 'sensevoice-small', 'explicit model wins');
    assert(explicit!.language === 'zh', 'explicit language wins');
    assert(explicit!.source === 'settings', 'source must be settings');

    const inherited = resolveAsrConfig({
      provider: { ...DEFAULT_PROVIDERS.openai, apiKey: 'sk-x', baseUrl: 'https://gw.example.com/v1' },
    });
    assert(!!inherited, 'provider fallback must resolve for openai-compatible');
    assert(inherited!.baseUrl === 'https://gw.example.com/v1', 'inherited baseUrl');
    assert(inherited!.apiKey === 'sk-x', 'inherited key');
    assert(inherited!.model === DEFAULT_ASR_MODEL, 'inherited model must be the historical default');
    assert(inherited!.source === 'provider', 'source must be provider');

    // Anthropic 的 baseUrl 上没有 /audio/transcriptions：回退过去只会得到 404，
    // 而真正的原因是「没配转写端点」，所以这里必须返回 null 而不是一个假端点。
    assert(resolveAsrConfig({ provider: DEFAULT_PROVIDERS.anthropic }) === null, 'anthropic must not be reused');
    assert(resolveAsrConfig({}) === null, 'no provider and no settings must not resolve');
    assert(
      resolveAsrConfig({ provider: { ...DEFAULT_PROVIDERS.openai, baseUrl: '   ' } }) === null,
      'blank base URL must not resolve',
    );
  });

  await test('formats segment timestamps as mm:ss and h:mm:ss', async () => {
    const { formatTimestamp, formatTimestampedTranscript } = await import('../src/services/video-transcription');

    assert(formatTimestamp(0) === '00:00', formatTimestamp(0));
    assert(formatTimestamp(65) === '01:05', formatTimestamp(65));
    assert(formatTimestamp(3725) === '1:02:05', formatTimestamp(3725));

    const rendered = formatTimestampedTranscript([
      { start: 0, end: 3, text: 'hello' },
      { start: 65, end: 68, text: '  world  ' },
      { start: 70, end: 71, text: '   ' },
    ]);
    assert(rendered === '[00:00] hello\n[01:05] world', JSON.stringify(rendered));
    assert(formatTimestampedTranscript([]) === '', 'no segments must render as an empty string');
  });

  await test('explains an empty transcription instead of reporting success', async () => {
    const service = createVideoTranscriptionService({
      requestUrl: bilibiliAudioStub('https://www.bilibili.com/video/BVempty', [3, 3]),
      decodeAudio: async () => fakeDecoded(100, 100),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ text: '' }) }) as any,
    });

    try {
      await service.transcribeFromVideoUrl({
        url: 'https://www.bilibili.com/video/BVempty',
        platform: 'bilibili',
        provider: DEFAULT_PROVIDERS.openai,
      });
      throw new Error('Expected transcription to fail');
    } catch (e: any) {
      assert(e.message.includes('empty text'), `message: ${e.message}`);
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
