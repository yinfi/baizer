import { requestUrl, Notice } from 'obsidian';

export interface VideoTranscript {
    text: string;
    title: string;
    platform: 'youtube' | 'bilibili';
    author?: string;
    url?: string;
    description?: string;
    transcriptSource?: 'platform-subtitle' | 'audio-transcription' | 'metadata';
    needsTranscription?: boolean;
}

interface VideoTranscriptDeps {
    requestUrl: typeof requestUrl;
    userAgent: string;
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0';

const defaultDeps: VideoTranscriptDeps = {
    requestUrl: (options) => requestUrl(options),
    userAgent: DEFAULT_USER_AGENT,
};

/** 判断值是否为非 null 对象，用于收窄外部（平台页面/接口）返回的未知 JSON。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** 沿路径逐层读取未知 JSON 的字段；任一层不是对象时返回 undefined。 */
export function readPath(value: unknown, path: string[]): unknown {
    let current: unknown = value;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

function asArray(value: unknown): unknown[] | null {
    return Array.isArray(value) ? value : null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function extractBalancedJson(source: string, marker: string): unknown {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) return null;

    const braceStart = source.indexOf('{', markerIndex);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = braceStart; i < source.length; i++) {
        const ch = source[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(source.slice(braceStart, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

async function fetchText(
    deps: VideoTranscriptDeps,
    url: string,
    headers?: Record<string, string>,
): Promise<string> {
    const response = await deps.requestUrl({
        url,
        headers,
    });
    return response.text;
}

function buildMetadataOnlyResult(params: {
    title: string;
    platform: 'youtube' | 'bilibili';
    author: string;
    url: string;
    description: string;
}): VideoTranscript {
    return {
        text: '',
        title: params.title,
        platform: params.platform,
        author: params.author,
        url: params.url,
        description: params.description,
        transcriptSource: 'metadata',
        needsTranscription: true,
    };
}

async function getYoutubeTranscript(url: string, deps: VideoTranscriptDeps): Promise<VideoTranscript | null> {
    try {
        const html = await fetchText(deps, url, {
            'User-Agent': deps.userAgent,
        });

        let title = 'YouTube Video';
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        if (titleMatch?.[1]) {
            title = titleMatch[1].replace(' - YouTube', '');
        }

        let author = 'YouTube';
        const authorMatch = html.match(/<link itemprop="name" content="(.*?)">/)
            || html.match(/<meta name="author" content="(.*?)">/);
        if (authorMatch?.[1]) {
            author = authorMatch[1];
        }

        const descriptionMatch = html.match(/<meta name="description" content="([^"]*)"/i);
        const description = descriptionMatch?.[1]?.trim() || title;

        const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
        if (!captionsMatch) {
            return buildMetadataOnlyResult({
                title,
                platform: 'youtube',
                author,
                url,
                description,
            });
        }

        const captionTracks = asArray(JSON.parse(captionsMatch[1]));
        if (!captionTracks || captionTracks.length === 0) {
            return buildMetadataOnlyResult({
                title,
                platform: 'youtube',
                author,
                url,
                description,
            });
        }

        let selectedTrack: unknown = captionTracks.find((track) => isRecord(track) && track.languageCode === 'en');
        if (!selectedTrack) {
            selectedTrack = captionTracks[0];
        }
        const trackBaseUrl = readPath(selectedTrack, ['baseUrl']);
        if (typeof trackBaseUrl !== 'string') {
            throw new Error('YouTube caption track has no baseUrl');
        }

        let transcriptText = '';
        try {
            const transcriptResponse = await deps.requestUrl({
                url: trackBaseUrl,
                headers: {
                    'User-Agent': deps.userAgent,
                },
            });
            transcriptText = transcriptResponse.text;
        } catch {
            const transcriptResponse = await deps.requestUrl({ url: trackBaseUrl });
            transcriptText = transcriptResponse.text;
        }

        if (!transcriptText) {
            try {
                const jsonResponse = await deps.requestUrl({
                    url: `${trackBaseUrl}&fmt=json3`,
                    headers: {
                        'User-Agent': deps.userAgent,
                    },
                });
                const events = asArray(readPath(JSON.parse(jsonResponse.text), ['events']));
                const text = events
                    ? events
                        .map((event) => {
                            const segs = asArray(readPath(event, ['segs']));
                            return segs ? segs.map((seg) => readPath(seg, ['utf8'])).join('') : '';
                        })
                        .filter(Boolean)
                        .join(' ')
                    : '';
                if (text) {
                    return {
                        text,
                        title,
                        platform: 'youtube',
                        author,
                        url,
                        description,
                        transcriptSource: 'platform-subtitle',
                        needsTranscription: false,
                    };
                }
            } catch {
                // Fall through to XML parsing / metadata fallback.
            }
        }

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(transcriptText, 'text/xml');
        const textNodes = xmlDoc.getElementsByTagName('text');
        const lines: string[] = [];
        for (let i = 0; i < textNodes.length; i++) {
            const textContent = textNodes[i].textContent;
            if (textContent) {
                lines.push(
                    textContent
                        .replace(/&#39;/g, "'")
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&')
                );
            }
        }

        const text = lines.join(' ');
        if (!text) {
            return buildMetadataOnlyResult({
                title,
                platform: 'youtube',
                author,
                url,
                description,
            });
        }

        return {
            text,
            title,
            platform: 'youtube',
            author,
            url,
            description,
            transcriptSource: 'platform-subtitle',
            needsTranscription: false,
        };
    } catch (e) {
        console.error('Failed to get YouTube transcript', e);
        new Notice(`YouTube Transcript Error: ${errorMessage(e)}`);
        return null;
    }
}

async function getBilibiliTranscript(url: string, deps: VideoTranscriptDeps): Promise<VideoTranscript | null> {
    try {
        const html = await fetchText(deps, url, {
            'User-Agent': deps.userAgent,
        });

        let title = 'Bilibili Video';
        const titleMatch = html.match(/<title data-vue-meta="true">([^<]+)<\/title>/)
            || html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch?.[1]) {
            title = titleMatch[1].replace('_哔哩哔哩_bilibili', '');
        }

        let author = 'Bilibili';
        const authorMatch = html.match(/<meta name="author" content="(.*?)">/)
            || html.match(/<meta name="author" content="(.*?)" \/>/);
        if (authorMatch?.[1]) {
            author = authorMatch[1];
        }

        const descriptionMatch = html.match(/"desc":"([^"]+)"/)
            || html.match(/<meta name="description" content="([^"]*)"/);
        const description = descriptionMatch?.[1]
            ? descriptionMatch[1].replace(/\\n/g, ' ').trim()
            : title;

        const cidMatch = html.match(/"cid":(\d+)/);
        if (!cidMatch) {
          console.error('Bilibili CID not found');
          return null;
        }
        const cid = cidMatch[1];

        let bvid = '';
        const bvidMatch = url.match(/(BV\w+)/);
        if (bvidMatch) {
            bvid = bvidMatch[1];
        } else {
            const htmlBvidMatch = html.match(/"bvid":"(BV\w+)"/);
            if (htmlBvidMatch) {
                bvid = htmlBvidMatch[1];
            }
        }

        if (!bvid) {
            console.error('Bilibili BVID not found');
            return null;
        }

        const subtitleResponse = await deps.requestUrl({
            url: `https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`,
            headers: {
                'User-Agent': deps.userAgent,
            },
        });
        const subtitles = asArray(readPath(JSON.parse(subtitleResponse.text), ['data', 'subtitle', 'subtitles']));

        let text = '';
        if (subtitles && subtitles.length > 0) {
            const selectedSubtitle = subtitles.find((subtitle) => readPath(subtitle, ['url'])) || subtitles[0];
            const rawSubtitleUrl = readPath(selectedSubtitle, ['url']);
            if (typeof rawSubtitleUrl === 'string' && rawSubtitleUrl) {
                const subtitleUrl = rawSubtitleUrl.startsWith('http')
                    ? rawSubtitleUrl
                    : `https:${rawSubtitleUrl}`;
                const transcriptResponse = await deps.requestUrl({ url: subtitleUrl });
                const body = asArray(readPath(JSON.parse(transcriptResponse.text), ['body']));
                if (body) {
                    text = body.map((item) => readPath(item, ['content'])).join(' ');
                }
            }
        }

        let queryParams = '';
        if (url.includes('?')) {
            const urlObj = new URL(url);
            const p = urlObj.searchParams.get('p');
            if (p) {
                queryParams = `?p=${p}`;
            }
        }

        const canonicalUrl = `https://www.bilibili.com/video/${bvid}${queryParams}`;
        if (!text) {
            return {
                text: '',
                title,
                platform: 'bilibili',
                author,
                url: canonicalUrl,
                description,
                transcriptSource: 'metadata',
                needsTranscription: true,
            };
        }

        return {
            text,
            title,
            platform: 'bilibili',
            author,
            url: canonicalUrl,
            description,
            transcriptSource: 'platform-subtitle',
            needsTranscription: false,
        };
    } catch (e) {
        console.error('Failed to get Bilibili transcript', e);
        new Notice(`Bilibili Transcript Error: ${errorMessage(e)}`);
        return null;
    }
}

export function createVideoTranscriptFetcher(partialDeps: Partial<VideoTranscriptDeps> = {}) {
    const deps: VideoTranscriptDeps = {
        ...defaultDeps,
        ...partialDeps,
    };

    return async (url: string): Promise<VideoTranscript | null> => {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            return await getYoutubeTranscript(url, deps);
        }
        if (url.includes('bilibili.com') || url.includes('b23.tv')) {
            return await getBilibiliTranscript(url, deps);
        }
        return null;
    };
}

export const getVideoTranscript = createVideoTranscriptFetcher();

export function extractJsonAssignment(source: string, marker: string): unknown {
    return extractBalancedJson(source, marker);
}
