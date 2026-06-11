import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { Readability } from '@mozilla/readability';
import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import { ProviderConfig } from '../../../mcp/types';
import * as videoUtils from '../../../utils/video_utils';
import { resolveSavedNotePath } from '../../../mcp/save-path';
import { createVideoTranscriptionService } from '../../../services/video-transcription';

interface WebClipperDeps {
  getVideoTranscript: typeof videoUtils.getVideoTranscript;
  requestUrl: typeof obsidian.requestUrl;
  htmlToMarkdown: typeof obsidian.htmlToMarkdown;
  notice: (message: string) => void;
  transcribeVideoAudio: (params: {
    url: string;
    platform: 'youtube' | 'bilibili';
    provider: ProviderConfig;
  }) => Promise<{ text: string; audioUrl: string }>;
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

function buildFrontmatter(opts: { source: string; author?: string; tags: string[] }): string {
  const created = new Date().toISOString();
  return `---\ncreated: ${created}\nsource: ${opts.source}\nauthor: ${opts.author || ''}\ntags: ${opts.tags.join(', ')}\n---\n\n`;
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
  modelService: any,
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
  modelService: any,
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

async function saveVideo(
  url: string,
  args: any,
  ctx: ToolContext,
  modelService: any,
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
  } else if (transcript.needsTranscription && activeProvider?.type === 'openai-compatible') {
    deps.notice(`Transcribing ${transcript.platform} audio...`);
    try {
      const transcription = await deps.transcribeVideoAudio({
        url: finalUrl,
        platform: transcript.platform,
        provider: activeProvider,
      });
      const summary = await summarizeTranscript(modelService, {
        title: transcript.title,
        text: transcription.text,
      });

      content = buildVideoSummaryContent({
        title: transcript.title,
        finalUrl,
        author: transcript.author || transcript.platform,
        tags: baseTags,
        summary: summary || buildTranscriptFallbackSummary(transcription.text),
        excerptText: transcription.text,
        excerptHeading: 'Transcript Excerpt',
      });
    } catch (_) {
      content = buildVideoSummaryContent({
        title: transcript.title,
        finalUrl,
        author: transcript.author || transcript.platform,
        tags: baseTags,
        summary: buildMetadataFallbackSummary(transcript.title, transcript.description),
        excerptText: transcript.description || transcript.title,
        excerptHeading: 'Video Description',
      });
    }
  } else if (modelService && (transcript.description || transcript.title)) {
    deps.notice(`Summarizing ${transcript.platform} video from metadata...`);
    const summary = await summarizeVideoMetadata(modelService, {
      title: transcript.title,
      description: transcript.description,
    });

    content = buildVideoSummaryContent({
      title: transcript.title,
      finalUrl,
      author: transcript.author || transcript.platform,
      tags: baseTags,
      summary: summary || buildMetadataFallbackSummary(transcript.title, transcript.description),
      excerptText: transcript.description || transcript.title,
      excerptHeading: 'Video Description',
    });
  } else {
    deps.notice('Saving video link...');
    content = buildVideoLinkContent(
      transcript.title,
      finalUrl,
      transcript.author || transcript.platform,
      baseTags,
    );
  }

  let filename = sanitizeTitle(args.filename || transcript.title);
  if (!filename.endsWith('.md')) filename += '.md';
  const finalPath = resolveSavedNotePath(
    filename,
    ctx.settings.wechatStoragePath,
    (p) => !!ctx.app.vault.getAbstractFileByPath(p),
  );
  await ensureFolder(ctx.app, finalPath);
  await ctx.app.vault.create(finalPath, content);
  return { success: true, path: finalPath, message: `Video Note Saved: ${finalPath}` };
}

async function saveWebpage(url: string, args: any, ctx: ToolContext, deps: WebClipperDeps): Promise<any> {
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

  let filename = args.filename || title;
  if (!filename.endsWith('.md')) filename += '.md';
  const finalPath = resolveSavedNotePath(
    filename,
    ctx.settings.wechatStoragePath,
    (p) => !!ctx.app.vault.getAbstractFileByPath(p),
  );
  const content = buildFrontmatter({ source: url, author, tags: ['clipping', ...webpageTags] })
    + `# ${title}\n\n${markdown}`;
  await ensureFolder(ctx.app, finalPath);
  await ctx.app.vault.create(finalPath, content);
  return { success: true, path: finalPath, message: `Webpage Saved: ${finalPath}` };
}

export function createSaveWebpageTool(modelService: any, deps: WebClipperDeps = defaultDeps): Tool {
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
      try {
        const videoResult = await saveVideo(args.url, args, ctx, modelService, deps);
        if (videoResult) return videoResult;
        return await saveWebpage(args.url, args, ctx, deps);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },
  };
}

export function createExecutor(modelService: any): BuiltinExecutor {
  const tool = createSaveWebpageTool(modelService);
  return {
    async execute(args: any, ctx: ToolContext) {
      return tool.execute(args, ctx);
    },
  };
}

export function registerTools(registry: ToolRegistry, modelService: any): void {
  registry.register(createSaveWebpageTool(modelService));
}
