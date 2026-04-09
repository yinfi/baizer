import { requestUrl, Notice } from 'obsidian';
import { logger } from '../utils/logger';

export interface ContextItem {
    id: string;
    type: 'file' | 'image' | 'url' | 'youtube' | 'text';
    data: string; // File path, Image base64/URL, Web URL, or raw text
    summary?: string; // Optional summary or title
    content?: string; // The actual content (fetched text, transcript, etc.)
}

export class ContextManager {
    private activeContexts: ContextItem[] = [];
    // 限制活动上下文的数量，防止内存泄漏
    private readonly MAX_ACTIVE_CONTEXTS = 50; // 最多保留50个活动上下文

    constructor() { }

    addContext(item: ContextItem) {
        // Avoid duplicates
        if (!this.activeContexts.find(c => c.id === item.id)) {
            this.activeContexts.push(item);

            // 如果达到上限，清理最旧的上下文
            if (this.activeContexts.length > this.MAX_ACTIVE_CONTEXTS) {
                const removed = this.activeContexts.splice(0, this.activeContexts.length - this.MAX_ACTIVE_CONTEXTS);
                console.log(`[ContextManager] Removed ${removed.length} old contexts to prevent memory leak. Keeping ${this.MAX_ACTIVE_CONTEXTS} most recent contexts.`);
            }
        }
    }

    removeContext(id: string) {
        this.activeContexts = this.activeContexts.filter(c => c.id !== id);
    }

    getContexts(): ContextItem[] {
        return this.activeContexts;
    }

    clearContexts() {
        this.activeContexts = [];
    }

    // 清理资源
    public cleanup() {
        this.clearContexts();
    }

    async resolveContexts(): Promise<ContextItem[]> {
        // Fetch content for URLs if not already fetched
        for (const ctx of this.activeContexts) {
            if (!ctx.content) {
                if (ctx.type === 'url') {
                    ctx.content = await this.fetchWebContent(ctx.data);
                } else if (ctx.type === 'youtube') {
                    ctx.content = await this.fetchYouTubeTranscript(ctx.data);
                }
            }
        }
        return this.activeContexts;
    }

    private async fetchWebContent(url: string): Promise<string> {
        try {
            const res = await requestUrl({ url });
            // Simple HTML to Text/Markdown conversion (very basic for now)
            // In a real app, use TurndownService or Readability
            const html = res.text;
            // Strip tags for now or return raw HTML if the model can handle it.
            // Let's return a simplified version.
            return this.stripHtml(html);
        } catch (e) {
            logger.error(`Failed to fetch web content: ${url}`, e);
            return `[Error fetching content from ${url}]`;
        }
    }

    private stripHtml(html: string): string {
        // Basic stripping
        return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async fetchYouTubeTranscript(url: string): Promise<string> {
        try {
            const res = await requestUrl({
                url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const html = res.text;

            const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
            if (!captionsMatch) {
                return "[No captions found for this video]";
            }

            const captionTracks = JSON.parse(captionsMatch[1]);
            let selectedTrack = captionTracks.find((track: any) => track.languageCode === 'en');
            if (!selectedTrack) selectedTrack = captionTracks[0];

            if (!selectedTrack) return "[No suitable caption track found]";

            const transcriptUrl = selectedTrack.baseUrl + '&fmt=xml';
            const xmlRes = await requestUrl({
                url: transcriptUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            const xml = xmlRes.text;
            // Parse XML to text
            // XML format: <text start="0.0" dur="1.0">Hello</text>
            const text = xml.replace(/<text[^>]*>/g, '\n').replace(/<\/text>/g, '').replace(/&amp;#39;/g, "'").replace(/&amp;quot;/g, '"');
            return `YouTube Transcript for ${url}:\n\n${text}`;

        } catch (e) {
            logger.error(`Failed to fetch YouTube transcript: ${url}`, e);
            return `[Error fetching transcript for ${url}]`;
        }
    }
}
