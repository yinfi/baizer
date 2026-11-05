import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { Readability } from '@mozilla/readability';
import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import {
  NO_ASR_ENDPOINT_MESSAGE,
  ProviderConfig,
  ResolvedAsrConfig as ResolvedAsrConfigForExecutor,
  resolveAsrConfig,
} from '../../../mcp/types';
import * as videoUtils from '../../../utils/video_utils';
import { thrownMessage } from '../../../utils/thrown-message';
import { resolveSavedNotePath } from '../../../mcp/save-path';
import type { ModelService } from '../../../services/model-service';
import {
  AudioTranscriptionResult,
  createVideoTranscriptionService,
  formatTimestampedTranscript,
} from '../../../services/video-transcription';

/** 本 skill 只用到 ModelService 的无状态生成能力（main.ts 注入真 ModelService）。 */
type SummaryModel = Pick<ModelService, 'generate'>;

interface WebClipperDeps {
  getVideoTranscript: typeof videoUtils.getVideoTranscript;
  requestUrl: typeof obsidian.requestUrl;
  htmlToMarkdown: typeof obsidian.htmlToMarkdown;
  notice: (message: string) => void;
  transcribeVideoAudio: (params: {
    url: string;
    platform: 'youtube' | 'bilibili';
    provider: ProviderConfig;
    asr: ResolvedAsrConfigForExecutor;
  }) => Promise<AudioTranscriptionResult>;
}

const transcriptionService = createVideoTranscriptionService();
const defaultDeps: WebClipperDeps = {
  getVideoTranscript: (url) => videoUtils.getVideoTranscript(url),
  requestUrl: (options) => obsidian.requestUrl(options),
  htmlToMarkdown: (html) => obsidian.htmlToMarkdown(html),
  notice: (message) => {
    new obsidian.Notice(message);
  },
  transcribeVideoAudio: (params) => transcriptionService.transcribeFromVideoUrl(params),
};

/** 工具 args 是模型生成的 JSON（外部输入）：非字符串字段一律视为缺省。 */
function readStringArg(args: unknown, key: string): string {
  if (!isRecord(args)) return '';
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (word.startsWith('#') && word.length > 1) tags.push(word.substring(1));
  }
  return tags;
}

function sanitizeTitle(title: string): string {
  let clean = title.replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim();
  if (!clean || clean.replace(/-/g, '').trim().length === 0) {
    const now = new Date();
    clean = `Clipping ${now.toISOString().split('T')[0]} ${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
  }
  return clean;
}

/** 把任意字符串序列化为合法的 YAML 双引号标量，转义反斜杠与引号。 */
function yamlQuote(value: string): string {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildFrontmatter(opts: { source: string; author?: string; tags: string[] }): string {
  const created = new Date().toISOString();
  // source/author 可能含冒号、引号、中文等特殊字符（尤其 URL 与微信作者名），
  // 全部走双引号标量，保证生成的 frontmatter 始终是合法 YAML，
  // 避免后续 processFrontMatter 解析失败而触发 fixAndSetFrontmatter 回退路径。
  // tags 用 YAML flow 数组，逐个引号化，杜绝含逗号/冒号的标签破坏结构。
  const tags = opts.tags.map((t) => yamlQuote(t)).join(', ');
  return `---\ncreated: ${created}\nsource: ${yamlQuote(opts.source)}\nauthor: ${yamlQuote(opts.author || '')}\ntags: [${tags}]\n---\n\n`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = path.split('/');
  if (parts.length <= 1) return;
  const folder = parts.slice(0, -1).join('/');
  if (!folder || app.vault.getAbstractFileByPath(folder)) return;
  try {
    await app.vault.createFolder(folder);
  } catch (_) {
    // Folder may already exist when multiple saves race.
  }
}

function buildVideoLinkContent(
  title: string,
  finalUrl: string,
  author: string,
  tags: string[],
): string {
  const encoded = encodeURIComponent(finalUrl);
  return buildFrontmatter({ source: finalUrl, author, tags })
    + `# ${title}\n\n[${title}](${finalUrl})\n\n[Play with Media Extended](obsidian://mx-open?url=${encoded})`;
}

function splitIntoSummarySentences(text: string): string[] {
  return text
    .split(/[.!?。！？]+\s*/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function buildTranscriptFallbackSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Transcript captured, but no concise summary could be generated.';

  const sentences = splitIntoSummarySentences(normalized);
  if (sentences.length > 0) {
    return sentences.map(sentence => `- ${sentence}`).join('\n');
  }

  return `- ${normalized.substring(0, 240)}${normalized.length > 240 ? '...' : ''}`;
}

function buildMetadataFallbackSummary(title: string, description?: string): string {
  const detail = (description || title || '').replace(/\s+/g, ' ').trim();
  if (!detail) return '- Summary unavailable.';

  if (detail === title || detail.length < 80) {
    return `- ${detail}`;
  }

  const sentences = splitIntoSummarySentences(detail);
  if (sentences.length > 0) {
    return sentences.map(sentence => `- ${sentence}`).join('\n');
  }

  return `- ${detail.substring(0, 240)}${detail.length > 240 ? '...' : ''}`;
}

function buildVideoSummaryContent(opts: {
  title: string;
  finalUrl: string;
  author: string;
  tags: string[];
  summary: string;
  excerptText: string;
  excerptHeading?: string;
}): string {
  const encoded = encodeURIComponent(opts.finalUrl);
  return buildFrontmatter({ source: opts.finalUrl, author: opts.author, tags: opts.tags })
    + `# ${opts.title}\n\n[${opts.title}](${opts.finalUrl})\n\n[Play with Media Extended](obsidian://mx-open?url=${encoded})\n\n## Summary\n\n${opts.summary}\n\n## ${opts.excerptHeading || 'Transcript Excerpt'}\n\n${opts.excerptText.substring(0, 1000)}...`;
}

async function summarizeTranscript(
  modelService: SummaryModel,
  transcript: { title: string; text: string },
): Promise<string | null> {
  if (!modelService || typeof modelService.generate !== 'function') return null;

  const prompt = `Please summarize the following video transcript.
Title: ${transcript.title}
Transcript:
${transcript.text.substring(0, 30000)}...

Task:
1. Provide a concise summary.
2. List key takeaways.
3. Format in Markdown.`;

  try {
    const summary = await modelService.generate(
      prompt,
      'You are a helpful assistant that summarizes videos.',
    );
    const clean = typeof summary === 'string' ? summary.trim() : '';
    if (!clean || clean.startsWith('Error:')) return null;
    return clean;
  } catch (_) {
    return null;
  }
}

async function summarizeVideoMetadata(
  modelService: SummaryModel,
  video: { title: string; description?: string },
): Promise<string | null> {
  if (!modelService || typeof modelService.generate !== 'function') return null;

  const prompt = `Please summarize the following video using its title and description.
Title: ${video.title}
Description:
${video.description || video.title}

Task:
1. Provide a concise summary.
2. List key takeaways when possible.
3. Format in Markdown.`;

  try {
    const summary = await modelService.generate(
      prompt,
      'You are a helpful assistant that summarizes videos from metadata when no transcript is available.',
    );
    const clean = typeof summary === 'string' ? summary.trim() : '';
    if (!clean || clean.startsWith('Error:')) return null;
    return clean;
  } catch (_) {
    return null;
  }
}

/**
 * 没有转录文本可写时的落点 —— 也就是改动前「平台没给字幕」走的同一条路：
 * 有模型就让模型读标题/描述，没有就退化成纯链接笔记。
 *
 * 抽成函数是为了让「解析不出转写端点」那一支也能回到这里。门禁改动把这类用户
 * （只配了 Anthropic、又没填转写端点）从原来的元数据摘要路径上拦了下来；
 * 如果不显式回到这里，他们拿到的摘要会从「模型摘要」掉成
 * buildMetadataFallbackSummary 的句子切分 —— 而他们本来什么设置都没改。
 */
async function buildNonTranscriptContent(params: {
  transcript: videoUtils.VideoTranscript;
  finalUrl: string;
  baseTags: string[];
  modelService: SummaryModel;
  deps: WebClipperDeps;
}): Promise<string> {
  const { transcript, finalUrl, baseTags, modelService, deps } = params;

  if (modelService && (transcript.description || transcript.title)) {
    deps.notice(`Summarizing ${transcript.platform} video from metadata...`);
    const summary = await summarizeVideoMetadata(modelService, {
      title: transcript.title,
      description: transcript.description,
    });

    return buildVideoSummaryContent({
      title: transcript.title,
      finalUrl,
      author: transcript.author || transcript.platform,
      tags: baseTags,
      summary: summary || buildMetadataFallbackSummary(transcript.title, transcript.description),
      excerptText: transcript.description || transcript.title,
      excerptHeading: 'Video Description',
    });
  }

  deps.notice('Saving video link...');
  return buildVideoLinkContent(
    transcript.title,
    finalUrl,
    transcript.author || transcript.platform,
    baseTags,
  );
}

async function saveVideo(
  url: string,
  args: unknown,
  ctx: ToolContext,
  modelService: SummaryModel,
  deps: WebClipperDeps,
): Promise<any> {
  const transcript = await deps.getVideoTranscript(url);
  if (!transcript) return null;

  const finalUrl = transcript.url || url;
  const activeProvider = ctx.settings.providers[ctx.settings.activeProvider];
  const titleTags = extractTags(transcript.title);
  const baseTags = ['video', transcript.platform, ...titleTags];
  let content = '';

  if (transcript.text && transcript.text.length > 0 && modelService) {
    deps.notice(`Summarizing ${transcript.platform} video...`);
    const summary = await summarizeTranscript(modelService, transcript);

    content = buildVideoSummaryContent({
      title: transcript.title,
      finalUrl,
      author: transcript.author || transcript.platform,
      tags: baseTags,
      summary: summary || buildTranscriptFallbackSummary(transcript.text),
      excerptText: transcript.text,
      excerptHeading: 'Transcript Excerpt',
    });
  } else if (transcript.needsTranscription) {
    // 门禁从「activeProvider.type === 'openai-compatible'」改成「能否解析出转写端点」。
    // 改动的理由：只配 Anthropic 的用户此前走不进这个分支，转写能力对他们等于不存在；
    // 而「能不能转写」与「用哪个对话 provider」本来就是两件事 —— 转写端点是独立可配的。
    // 什么都没配的 OpenAI 兼容用户仍然沿用 provider 的 baseUrl/apiKey，行为不变。
    const asrConfig = resolveAsrConfig({
      asr: ctx.settings,
      provider: activeProvider,
    });

    if (!asrConfig) {
      // 做不了就说做不了：明确告知原因与去处，而不是安静地退化成「只有元数据」的笔记。
      // 但「没有转写端点」不等于「这篇笔记只能差一档」：仍然走与「平台没给字幕」
      // 完全相同的元数据摘要路径，否则这次门禁改动会顺手把这类用户的摘要质量降一级。
      deps.notice(NO_ASR_ENDPOINT_MESSAGE);
      content = await buildNonTranscriptContent({
        transcript,
        finalUrl,
        baseTags,
        modelService,
        deps,
      });
    } else {
      deps.notice(`Transcribing ${transcript.platform} audio...`);
      try {
        const transcription = await deps.transcribeVideoAudio({
          url: finalUrl,
          platform: transcript.platform,
          provider: activeProvider,
          asr: asrConfig,
        });

        // 非致命说明（例如「解码失败，已回退整轨提交」）也要让用户看见。
        for (const warning of transcription.warnings ?? []) {
          deps.notice(warning);
        }

        const summary = await summarizeTranscript(modelService, {
          title: transcript.title,
          text: transcription.text,
        });

        // 有段级结果就用带时间戳的形式落进笔记（这是本次改造的可见产出之一）；
        // 端点没回 segments 时才退回改动前的扁平文本。
        const timestamped = formatTimestampedTranscript(transcription.segments || []);

        content = buildVideoSummaryContent({
          title: transcript.title,
          finalUrl,
          author: transcript.author || transcript.platform,
          tags: baseTags,
          summary: summary || buildTranscriptFallbackSummary(transcription.text),
          excerptText: timestamped || transcription.text,
          excerptHeading: timestamped ? 'Timestamped Transcript' : 'Transcript Excerpt',
        });
      } catch (error) {
        // 改动前这里是 catch (_)：用户看到「Transcribing ...」之后拿到的是一篇
        // 既没有转录、也不说明原因的笔记。失败必须可见，且必须带原因。
        const reason = error instanceof Error && error.message ? error.message : String(error);
        deps.notice(`Transcription failed: ${reason}`);
        content = buildVideoSummaryContent({
          title: transcript.title,
          finalUrl,
          author: transcript.author || transcript.platform,
          tags: baseTags,
          summary: buildMetadataFallbackSummary(transcript.title, transcript.description),
          excerptText: `> [!warning] Audio transcription failed\n> ${reason}\n\n${transcript.description || transcript.title}`,
          excerptHeading: 'Video Description',
        });
      }
    }
  } else {
    // 既没有字幕、也没有可走的转写路径：模型读元数据，或者退化成纯链接。
    content = await buildNonTranscriptContent({
      transcript,
      finalUrl,
      baseTags,
      modelService,
      deps,
    });
  }

  let filename = sanitizeTitle(readStringArg(args, 'filename') || transcript.title);
  if (!filename.endsWith('.md')) filename += '.md';
  const finalPath = resolveSavedNotePath(
    filename,
    ctx.settings.wechatStoragePath,
    (p) => !!ctx.app.vault.getAbstractFileByPath(p),
  );
  // 中断守卫:同 saveWebpage,超时/中断已触发时不落笔记,避免状态不一致。
  if (ctx.signal?.aborted) {
    return { success: false, error: 'Aborted before saving note', aborted: true };
  }
  await ensureFolder(ctx.app, finalPath);
  await ctx.app.vault.create(finalPath, content);
  return { success: true, path: finalPath, message: `Video Note Saved: ${finalPath}` };
}

async function saveWebpage(url: string, args: unknown, ctx: ToolContext, deps: WebClipperDeps): Promise<any> {
  const response = await deps.requestUrl({
    url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (response.status !== 200) {
    throw new Error(`Failed to fetch webpage: HTTP ${response.status}`);
  }

  let html = response.text;

  let title = 'Untitled Webpage';
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) title = titleMatch[1].trim();
  else {
    const ogMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i);
    if (ogMatch?.[1]?.trim()) title = ogMatch[1].trim();
    else {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match?.[1]?.trim()) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  let author = '';
  if (url.includes('mp.weixin.qq.com')) {
    const varMatch = html.match(/var\s+nickname\s*=\s*["']([^"']+)["']/);
    if (varMatch?.[1]) author = varMatch[1].trim();
    if (!author) {
      const nicknameMatch = html.match(/class="profile_nickname"[^>]*>([^<]+)</);
      if (nicknameMatch?.[1]) author = nicknameMatch[1].trim();
    }
    if (!author) {
      const nameMatch = html.match(/class="js_name"[^>]*>([^<]+)</);
      if (nameMatch?.[1]) author = nameMatch[1].trim();
    }
  }
  if (!author) {
    const metaAuthor = html.match(/<meta name="author" content="([^"]*)"/i)
      || html.match(/<meta property="article:author" content="([^"]*)"/i)
      || html.match(/<meta property="og:site_name" content="([^"]*)"/i);
    if (metaAuthor?.[1]) author = metaAuthor[1].trim();
  }

  const webpageTags = extractTags(title);
  title = sanitizeTitle(title);
  if (url.includes('mp.weixin.qq.com')) html = html.replace(/data-src=/g, 'src=');

  let markdown = '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  if (url.includes('mp.weixin.qq.com')) {
    const jsContent = doc.querySelector('#js_content');
    if (jsContent) {
      jsContent.querySelectorAll('script, style').forEach(node => node.remove());
      try {
        markdown = deps.htmlToMarkdown(jsContent.innerHTML);
      } catch (_) {
        markdown = '';
      }
    }
  }

  if (!markdown) {
    ['nav', 'footer', 'aside', 'script', 'style', 'noscript', '.sidebar', '.navbar', '.ads', '.ad-container']
      .forEach(sel => {
        try {
          doc.querySelectorAll(sel).forEach(node => node.remove());
        } catch (_) {
          // Ignore invalid selectors for unusual HTML fragments.
        }
      });

    const reader = new Readability(doc);
    const article = reader.parse();
    if (article?.content) {
      try {
        markdown = deps.htmlToMarkdown(article.content);
      } catch (_) {
        markdown = '';
      }
    } else {
      try {
        markdown = deps.htmlToMarkdown(html);
      } catch (_) {
        markdown = '';
      }
    }
  }

  if (!markdown) {
    throw new Error('Failed to convert webpage content to Markdown');
  }

  let filename = readStringArg(args, 'filename') || title;
  if (!filename.endsWith('.md')) filename += '.md';
  const finalPath = resolveSavedNotePath(
    filename,
    ctx.settings.wechatStoragePath,
    (p) => !!ctx.app.vault.getAbstractFileByPath(p),
  );
  const content = buildFrontmatter({ source: url, author, tags: ['clipping', ...webpageTags] })
    + `# ${title}\n\n${markdown}`;
  // 中断守卫:requestUrl 无法中途取消网络请求,但可在写盘前拦截——超时/中断已触发时
  // 不落笔记,避免「上层已判失败、笔记却照样创建」的状态不一致。
  if (ctx.signal?.aborted) {
    return { success: false, error: 'Aborted before saving note', aborted: true };
  }
  await ensureFolder(ctx.app, finalPath);
  await ctx.app.vault.create(finalPath, content);
  return { success: true, path: finalPath, message: `Webpage Saved: ${finalPath}` };
}

export function createSaveWebpageTool(modelService: SummaryModel, deps: WebClipperDeps = defaultDeps): Tool {
  return {
    name: 'save_webpage',
    description: 'Save a webpage or video transcript to a new note.',
    executionMode: 'sequential',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the webpage or video' },
        filename: { type: 'string', description: 'Optional filename for the note' },
      },
      required: ['url'],
    },
    async execute(args, ctx) {
      // 入口即检查:已中断(上游超时/用户取消)则不发起任何网络请求或写盘。
      if (ctx.signal?.aborted) {
        return { success: false, error: 'Aborted before saving note', aborted: true };
      }
      const url = readStringArg(args, 'url');
      try {
        const videoResult = await saveVideo(url, args, ctx, modelService, deps);
        if (videoResult) return videoResult;
        return await saveWebpage(url, args, ctx, deps);
      } catch (e: unknown) {
        return { success: false, error: thrownMessage(e) || String(e) };
      }
    },
  };
}

export function createExecutor(modelService: SummaryModel): BuiltinExecutor {
  const tool = createSaveWebpageTool(modelService);
  return {
    async execute(args: any, ctx: ToolContext) {
      return tool.execute(args, ctx);
    },
  };
}

export function registerTools(registry: ToolRegistry, modelService: SummaryModel): void {
  registry.register(createSaveWebpageTool(modelService));
}
