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

function extractBalancedJson(source: string, marker: string): any | null {
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

        const captionTracks = JSON.parse(captionsMatch[1]);
        if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
            return buildMetadataOnlyResult({
                title,
                platform: 'youtube',
                author,
                url,
                description,
            });
        }

        let selectedTrack = captionTracks.find((track: any) => track.languageCode === 'en');
        if (!selectedTrack) {
            selectedTrack = captionTracks[0];
        }

        let transcriptText = '';
        try {
            const transcriptResponse = await deps.requestUrl({
                url: selectedTrack.baseUrl,
                headers: {
                    'User-Agent': deps.userAgent,
                },
            });
            transcriptText = transcriptResponse.text;
        } catch {
            const transcriptResponse = await deps.requestUrl({ url: selectedTrack.baseUrl });
            transcriptText = transcriptResponse.text;
        }

        if (!transcriptText) {
            try {
                const jsonResponse = await deps.requestUrl({
                    url: `${selectedTrack.baseUrl}&fmt=json3`,
                    headers: {
                        'User-Agent': deps.userAgent,
                    },
                });
                const jsonData = JSON.parse(jsonResponse.text);
                const text = Array.isArray(jsonData.events)
                    ? jsonData.events
                        .map((event: any) => Array.isArray(event.segs)
                            ? event.segs.map((seg: any) => seg.utf8).join('')
                            : '')
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
    } catch (e: any) {
        console.error('Failed to get YouTube transcript', e);
        new Notice(`YouTube Transcript Error: ${e.message}`);
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
        const subtitleData = JSON.parse(subtitleResponse.text);
        const subtitles = subtitleData?.data?.subtitle?.subtitles;

        let text = '';
        if (Array.isArray(subtitles) && subtitles.length > 0) {
            const selectedSubtitle = subtitles.find((subtitle: any) => subtitle?.url) || subtitles[0];
            if (selectedSubtitle?.url) {
                const subtitleUrl = selectedSubtitle.url.startsWith('http')
                    ? selectedSubtitle.url
                    : `https:${selectedSubtitle.url}`;
                const transcriptResponse = await deps.requestUrl({ url: subtitleUrl });
                const transcriptJson = JSON.parse(transcriptResponse.text);
                if (Array.isArray(transcriptJson.body)) {
                    text = transcriptJson.body.map((item: any) => item.content).join(' ');
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
    } catch (e: any) {
        console.error('Failed to get Bilibili transcript', e);
        new Notice(`Bilibili Transcript Error: ${e.message}`);
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

export function extractJsonAssignment(source: string, marker: string): any | null {
    return extractBalancedJson(source, marker);
}
