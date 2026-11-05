import { requestUrl, Notice } from 'obsidian';
import { asArray, asString, prop } from './narrow';

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

/** 读取 catch 到的值的 `.message`;保持原 `e.message` 的取值语义(缺失时为 "undefined")。 */
function errorMessageOf(error: unknown): string {
    return String(prop(error, 'message'));
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

        const captionTracks = asArray(JSON.parse(captionsMatch[1]) as unknown);
        if (!captionTracks || captionTracks.length === 0) {
            return buildMetadataOnlyResult({
                title,
                platform: 'youtube',
                author,
                url,
                description,
            });
        }

        let selectedTrack: unknown = captionTracks.find((track) => prop(track, 'languageCode') === 'en');
        if (!selectedTrack) {
            selectedTrack = captionTracks[0];
        }
        const trackBaseUrl = asString(prop(selectedTrack, 'baseUrl')) ?? '';

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
                const jsonData = JSON.parse(jsonResponse.text) as unknown;
                const events = asArray(prop(jsonData, 'events'));
                const text = events
                    ? events
                        .map((event) => {
                            const segs = asArray(prop(event, 'segs'));
                            return segs
                                ? segs.map((seg) => prop(seg, 'utf8')).join('')
                                : '';
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
    } catch (e: unknown) {
        console.error('Failed to get YouTube transcript', e);
        new Notice(`YouTube Transcript Error: ${errorMessageOf(e)}`);
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
        const subtitleData = JSON.parse(subtitleResponse.text) as unknown;
        const subtitles = prop(prop(prop(subtitleData, 'data'), 'subtitle'), 'subtitles');

        let text = '';
        if (Array.isArray(subtitles) && subtitles.length > 0) {
            const subtitleList = subtitles as unknown[];
            const selectedSubtitle: unknown = subtitleList.find((subtitle) => prop(subtitle, 'url')) || subtitleList[0];
            const selectedUrl = prop(selectedSubtitle, 'url');
            if (selectedUrl) {
                const selectedUrlText = asString(selectedUrl);
                if (selectedUrlText === undefined) {
                    // 与原行为一致:非字符串 url 在 startsWith 处抛 TypeError,由外层 catch 处理。
                    throw new TypeError('selectedSubtitle.url.startsWith is not a function');
                }
                const subtitleUrl = selectedUrlText.startsWith('http')
                    ? selectedUrlText
                    : `https:${selectedUrlText}`;
                const transcriptResponse = await deps.requestUrl({ url: subtitleUrl });
                const transcriptJson = JSON.parse(transcriptResponse.text) as unknown;
                const body = asArray(prop(transcriptJson, 'body'));
                if (body) {
                    text = body.map((item) => prop(item, 'content')).join(' ');
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
    } catch (e: unknown) {
        console.error('Failed to get Bilibili transcript', e);
        new Notice(`Bilibili Transcript Error: ${errorMessageOf(e)}`);
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
