import { requestUrl } from 'obsidian';
import { logger } from '../utils/logger';
import { getVideoTranscript } from '../utils/video_utils';

export interface ContextItem {
    id: string;
    type: 'file' | 'image' | 'url' | 'youtube' | 'text';
    data: string;
    summary?: string;
    content?: string;
}

interface ContextManagerDeps {
    fetchWebContent: (url: string) => Promise<string>;
    fetchVideoTranscript: (url: string) => Promise<string>;
}

export class ContextManager {
    private activeContexts: ContextItem[] = [];
    private readonly MAX_ACTIVE_CONTEXTS = 50;
    private readonly deps: ContextManagerDeps;

    constructor(deps?: Partial<ContextManagerDeps>) {
        this.deps = {
            fetchWebContent: deps?.fetchWebContent ?? this.fetchWebContent.bind(this),
            fetchVideoTranscript: deps?.fetchVideoTranscript ?? this.fetchVideoTranscript.bind(this),
        };
    }

    addContext(item: ContextItem) {
        if (!this.activeContexts.find(c => c.id === item.id)) {
            this.activeContexts.push(item);

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

    public cleanup() {
        this.clearContexts();
    }

    async resolveContexts(): Promise<ContextItem[]> {
        for (const ctx of this.activeContexts) {
            if (!ctx.content) {
                if (ctx.type === 'url') {
                    ctx.content = await this.deps.fetchWebContent(ctx.data);
                } else if (ctx.type === 'youtube') {
                    ctx.content = await this.deps.fetchVideoTranscript(ctx.data);
                }
            }
        }
        return this.activeContexts;
    }

    private async fetchWebContent(url: string): Promise<string> {
        try {
            const res = await requestUrl({ url });
            if (res.status !== 200) {
                return `[Error fetching content from ${url}: HTTP ${res.status}]`;
            }
            return this.stripHtml(res.text);
        } catch (e) {
            logger.error(`Failed to fetch web content: ${url}`, e);
            return `[Error fetching content from ${url}]`;
        }
    }

    private stripHtml(html: string): string {
        return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async fetchVideoTranscript(url: string): Promise<string> {
        try {
            const transcript = await getVideoTranscript(url);
            if (!transcript) {
                return `[Error fetching transcript for ${url}]`;
            }
            if (!transcript.text) {
                return `[No transcript available for ${url}]`;
            }
            return `${transcript.title}\n\n${transcript.text.substring(0, 4000)}`;
        } catch (e) {
            logger.error(`Failed to fetch YouTube transcript: ${url}`, e);
            return `[Error fetching transcript for ${url}]`;
        }
    }
}
