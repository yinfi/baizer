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
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
