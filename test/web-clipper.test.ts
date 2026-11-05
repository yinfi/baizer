import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

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
    notToContain: (expected: string) => {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected string not to contain "${expected}"`);
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

function createMockApp(noteStore: Record<string, string>) {
  return {
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (path === 'Clippings') return { path };
        if (noteStore[path]) return { path };
        return null;
      },
      createFolder: async (_path: string) => undefined,
      create: async (path: string, content: string) => {
        noteStore[path] = content;
        return { path, basename: path.replace(/\.md$/, '') };
      },
    },
  } as unknown as App;
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function runTests() {
  console.log('=== web-clipper Tests ===');

  const obsidian = await import('obsidian');
  let requestUrlImpl = async (_options: any) => ({
    status: 200,
    text: '',
    headers: {},
  });
  const { createSaveWebpageTool } = await import('../src/skills/builtin/web-clipper/executor');
  let transcriptImpl = async (_url: string) => null as any;
  const deps = {
    getVideoTranscript: (url: string) => transcriptImpl(url),
    requestUrl: (options: any) => requestUrlImpl(options),
    htmlToMarkdown: (html: string) => html,
    notice: (_message: string) => undefined,
    transcribeVideoAudio: async (_params: any) => {
      throw new Error('No transcription stub configured');
    },
  };

  await test('uses stateless generate() for video summaries instead of chat()', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: 'Transcript body for testing the summary path.',
      title: 'Demo Video',
      platform: 'youtube',
      author: 'Tester',
      url,
    });

    const modelService = {
      generate: async () => '## Summary\n\n- key point',
      chat: async () => 'Error: chat() should not be used here',
    };

    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://youtu.be/demo-video' },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(true);
    const saved = notes[result.path];
    expect(saved).toContain('[Demo Video](https://youtu.be/demo-video)');
    expect(saved).toContain('## Summary');
    expect(saved).toContain('## Transcript Excerpt');
    expect(saved).notToContain('Error: chat() should not be used here');
  });

  await test('falls back to transcript-based summary and still keeps the link when AI summarization fails', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: 'First useful sentence. Second useful sentence. Third useful sentence with context.',
      title: 'Broken Summary Video',
      platform: 'youtube',
      author: 'Tester',
      url,
    });

    const modelService = {
      generate: async () => {
        throw new Error('summary failed');
      },
      chat: async () => 'Error: chat() should not be used here either',
    };

    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://youtu.be/broken-summary' },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(true);
    const saved = notes[result.path];
    expect(saved).toContain('[Broken Summary Video](https://youtu.be/broken-summary)');
    expect(saved).toContain('## Summary');
    expect(saved).toContain('First useful sentence');
    expect(saved).toContain('Play with Media Extended');
    expect(saved).notToContain('Error: chat() should not be used here either');
  });

  await test('builds a metadata-based summary when a video has no transcript text', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: '',
      title: 'No Subtitle Video',
      description: 'A parenting video about what to do when children are bullied at school.',
      platform: 'bilibili',
      author: 'Tester',
      url,
    });

    const modelService = {
      generate: async () => '## Summary\n\n- Discusses practical responses for parents and children.',
      chat: async () => 'Error: chat() should not be used for metadata fallback either',
    };

    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://www.bilibili.com/video/BV1CQQRBoEax' },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(true);
    const saved = notes[result.path];
    expect(saved).toContain('[No Subtitle Video](https://www.bilibili.com/video/BV1CQQRBoEax)');
    expect(saved).toContain('## Summary');
    expect(saved).toContain('Discusses practical responses');
    expect(saved).notToContain('Error: chat() should not be used for metadata fallback either');
  });

  await test('uses audio transcription fallback when platform subtitles are missing', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: '',
      title: 'Needs Audio Transcription',
      description: 'Metadata is available but platform subtitles are not.',
      platform: 'bilibili',
      author: 'Tester',
      url,
      needsTranscription: true,
      transcriptSource: 'metadata',
    });
    deps.transcribeVideoAudio = async () => ({
      text: 'Audio transcript sentence one. Audio transcript sentence two.',
      audioUrl: 'https://media.example/audio.m4a',
    });

    const modelService = {
      generate: async (prompt: string) => {
        if (prompt.includes('Audio transcript sentence one')) {
          return '## Summary\n\n- Summarized from fallback audio transcription.';
        }
        return '## Summary\n\n- Unexpected prompt';
      },
    };

    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://www.bilibili.com/video/BVaudiofallback' },
      {
        app,
        settings: {
          ...DEFAULT_SETTINGS,
          activeProvider: 'openai',
        },
      } as any,
    );

    expect(result.success).toBe(true);
    const saved = notes[result.path];
    expect(saved).toContain('Summarized from fallback audio transcription');
    expect(saved).toContain('Audio transcript sentence one');
    expect(saved).toContain('[Needs Audio Transcription](https://www.bilibili.com/video/BVaudiofallback)');
  });

  await test('returns an error instead of saving a non-200 webpage response', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (_url: string) => null;
    requestUrlImpl = async (_options: any) => ({
      status: 403,
      text: '<html><title>Forbidden</title><body>Forbidden</body></html>',
      headers: {},
    });

    const tool = createSaveWebpageTool(null, deps);
    const result = await tool.execute(
      { url: 'https://example.com/forbidden' },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
  });

  // 论断6:requestUrl 无法中途取消,但写盘前必须检查中断信号——超时/中断已触发时
  // 不落笔记,避免「上层判失败、笔记却照样创建」的状态不一致。
  await test('does not write the note when the abort signal fired before saving', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (_url: string) => null;
    requestUrlImpl = async (_options: any) => ({
      status: 200,
      text: '<html><head><title>Article</title></head><body>Body text</body></html>',
      headers: {},
    });

    const controller = new AbortController();
    controller.abort(); // 模拟请求返回后、写盘前已超时/中断。

    const tool = createSaveWebpageTool(null, deps);
    const result = await tool.execute(
      { url: 'https://example.com/article' },
      { app, settings: DEFAULT_SETTINGS, signal: controller.signal } as any,
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
    // 关键:笔记未被创建(副作用被拦下)。
    expect(Object.keys(notes).length).toBe(0);
  });
  // 门禁改动：转写此前要求 activeProvider.type === 'openai-compatible'，
  // 只配 Anthropic 的用户因此完全无法转写。现在门禁是「能否解析出转写端点」。
  await test('transcribes an Anthropic-configured vault once a transcription endpoint is set', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: '',
      title: 'Anthropic Vault Video',
      description: 'Subtitles are missing, so audio transcription is required.',
      platform: 'bilibili',
      author: 'Tester',
      url,
      needsTranscription: true,
      transcriptSource: 'metadata',
    });

    let captured: any = null;
    deps.transcribeVideoAudio = async (params: any) => {
      captured = params;
      return {
        text: 'hello world',
        segments: [
          { start: 0, end: 3, text: 'hello' },
          { start: 65, end: 68, text: 'world' },
        ],
        audioUrl: 'https://media.example/audio.m4a',
        mode: 'chunked',
        chunkCount: 2,
        durationSec: 68,
        warnings: [],
      };
    };

    const modelService = { generate: async () => '## Summary\n\n- From the transcription.' };
    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://www.bilibili.com/video/BVanthropic' },
      {
        app,
        settings: {
          ...DEFAULT_SETTINGS,
          activeProvider: 'anthropic',
          asrBaseUrl: 'http://127.0.0.1:8080/v1',
        },
      } as any,
    );

    expect(result.success).toBe(true);
    check(!!captured, 'transcription must have been attempted');
    check(captured.provider.type === 'anthropic', 'the chat provider is still the Anthropic one');
    check(captured.asr.baseUrl === 'http://127.0.0.1:8080/v1', 'the configured ASR endpoint must be passed down');

    const saved = notes[result.path];
    expect(saved).toContain('## Timestamped Transcript');
    expect(saved).toContain('[00:00] hello');
    expect(saved).toContain('[01:05] world');
  });

  await test('says why it skipped transcription when no endpoint can be resolved', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: '',
      title: 'No Endpoint Video',
      description: 'Metadata only.',
      platform: 'bilibili',
      author: 'Tester',
      url,
      needsTranscription: true,
      transcriptSource: 'metadata',
    });

    let attempted = false;
    deps.transcribeVideoAudio = async () => {
      attempted = true;
      throw new Error('must not be called without an endpoint');
    };

    const notices: string[] = [];
    deps.notice = (message: string) => {
      notices.push(message);
    };

    const modelService = { generate: async () => '## Summary\n\n- Metadata summary.' };
    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://www.bilibili.com/video/BVnoendpoint' },
      { app, settings: { ...DEFAULT_SETTINGS, activeProvider: 'anthropic' } } as any,
    );

    expect(result.success).toBe(true);
    check(!attempted, 'no request may be attempted without a resolvable endpoint');
    check(
      notices.some((message) => message.includes('No transcription endpoint is configured')),
      `expected an explanatory notice, got: ${JSON.stringify(notices)}`,
    );
    // 仍然落一篇笔记（元数据摘要），只是明确说明了没有转录。
    expect(notes[result.path]).toContain('## Summary');
    // 而且必须仍然走「模型读元数据」那条路：门禁改动不该顺手把这类用户的摘要
    // 降级成 buildMetadataFallbackSummary 的句子切分。
    expect(notes[result.path]).toContain('- Metadata summary.');
    check(
      notices.some((message) => message.includes('from metadata')),
      `expected the metadata summarisation notice, got: ${JSON.stringify(notices)}`,
    );
  });

  await test('surfaces a transcription failure instead of swallowing it', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: '',
      title: 'Failing Transcription Video',
      description: 'The endpoint is going to reject us.',
      platform: 'bilibili',
      author: 'Tester',
      url,
      needsTranscription: true,
      transcriptSource: 'metadata',
    });

    deps.transcribeVideoAudio = async () => {
      throw new Error('HTTP 500 - upstream exploded');
    };

    const notices: string[] = [];
    deps.notice = (message: string) => {
      notices.push(message);
    };

    const modelService = { generate: async () => '## Summary\n\n- Metadata summary.' };
    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://www.bilibili.com/video/BVfailing' },
      { app, settings: { ...DEFAULT_SETTINGS, activeProvider: 'openai' } } as any,
    );

    expect(result.success).toBe(true);
    check(
      notices.some((message) => message.includes('Transcription failed') && message.includes('upstream exploded')),
      `the failure must be announced with its reason, got: ${JSON.stringify(notices)}`,
    );
    const saved = notes[result.path];
    // 改动前这里是 catch (_)：笔记里既没有转录也不说明原因。
    expect(saved).toContain('Audio transcription failed');
    expect(saved).toContain('upstream exploded');
  });

  // 工具 args 是模型给的 JSON（外部输入）：非字符串 filename 不能把工具体打崩，也不能当文件名。
  await test('falls back to the video title when the filename argument is not a string', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: 'Transcript body for testing the filename fallback.',
      title: 'Typed Filename Video',
      platform: 'youtube',
      author: 'Tester',
      url,
    });

    const modelService = { generate: async () => '## Summary\n\n- key point' };
    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://youtu.be/typed-filename', filename: 42 },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(true);
    expect(result.path).toBe('Clippings/Typed Filename Video.md');
    expect(notes[result.path]).toContain('# Typed Filename Video');
  });

  await test('honors a string filename argument as the note name', async () => {
    const notes: Record<string, string> = {};
    const app = createMockApp(notes);
    transcriptImpl = async (url: string) => ({
      text: 'Transcript body for testing a custom filename.',
      title: 'Ignored Title',
      platform: 'youtube',
      author: 'Tester',
      url,
    });

    const modelService = { generate: async () => '## Summary\n\n- key point' };
    const tool = createSaveWebpageTool(modelService, deps);
    const result = await tool.execute(
      { url: 'https://youtu.be/custom-filename', filename: 'Custom Name' },
      { app, settings: DEFAULT_SETTINGS } as any,
    );

    expect(result.success).toBe(true);
    expect(result.path).toBe('Clippings/Custom Name.md');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
