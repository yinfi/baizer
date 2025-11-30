import { requestUrl, Notice } from 'obsidian';

export interface VideoTranscript {
    text: string;
    title: string;
    platform: 'youtube' | 'bilibili';
}

export async function getVideoTranscript(url: string): Promise<VideoTranscript | null> {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        return await getYoutubeTranscript(url);
    } else if (url.includes('bilibili.com')) {
        return await getBilibiliTranscript(url);
    }
    return null;
}

async function getYoutubeTranscript(url: string): Promise<VideoTranscript | null> {
    try {
        const userAgent = navigator.userAgent;
        console.log(`Gemini Shell: Using User-Agent: ${userAgent}`);

        // 1. Fetch the video page using requestUrl (bypasses CORS)
        const response = await requestUrl({
            url: url,
            headers: {
                'User-Agent': userAgent
            }
        });
        const html = response.text;

        // 2. Extract Title
        let title = "YouTube Video";
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].replace(' - YouTube', '');
        }

        // 3. Extract Captions JSON
        // Look for "captionTracks" inside the HTML (usually in ytInitialPlayerResponse)
        const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
        if (!captionsMatch) {
            console.warn("Gemini Shell: No captionTracks found in YouTube page.");
            // Return partial result if title was found
            return { text: "", title, platform: 'youtube' };
        }

        const captionTracks = JSON.parse(captionsMatch[1]);
        if (!captionTracks || captionTracks.length === 0) {
            console.warn("Gemini Shell: Empty captionTracks.");
            return { text: "", title, platform: 'youtube' };
        }

        // Prefer English or Auto-generated English, or just the first one
        // captionTracks structure: { baseUrl: string, name: { simpleText: string }, languageCode: string, ... }
        let selectedTrack = captionTracks.find((track: any) => track.languageCode === 'en');
        if (!selectedTrack) {
            selectedTrack = captionTracks[0];
        }

        console.log(`Gemini Shell: Selected caption track: ${selectedTrack.name?.simpleText} (${selectedTrack.languageCode})`);
        console.log(`Gemini Shell: Fetching transcript from: ${selectedTrack.baseUrl}`);

        // 4. Fetch Transcript
        let transcriptResponse;
        try {
            transcriptResponse = await requestUrl({
                url: selectedTrack.baseUrl,
                headers: {
                    'User-Agent': userAgent
                }
            });
        } catch (e) {
            console.warn("Gemini Shell: Failed to fetch transcript with User-Agent, trying without...", e);
            transcriptResponse = await requestUrl({ url: selectedTrack.baseUrl });
        }

        let transcriptXml = transcriptResponse.text;
        console.log(`Gemini Shell: Transcript Response Status: ${transcriptResponse.status}`);
        console.log(`Gemini Shell: Transcript Response Headers:`, transcriptResponse.headers);

        if (!transcriptXml || transcriptXml.length === 0) {
            console.warn("Gemini Shell: Empty XML response. Trying fmt=json3...");
            try {
                const jsonUrl = selectedTrack.baseUrl + '&fmt=json3';
                const jsonResponse = await requestUrl({
                    url: jsonUrl,
                    headers: { 'User-Agent': userAgent }
                });
                const jsonText = jsonResponse.text;
                if (jsonText && jsonText.length > 0) {
                    console.log("Gemini Shell: Found JSON transcript, parsing...");
                    const jsonData = JSON.parse(jsonText);
                    // Parse JSON3 format: { events: [ { tStartMs: 1000, dDurationMs: 2000, segs: [ { utf8: "text" } ] } ] }
                    if (jsonData.events) {
                        const lines = jsonData.events.map((e: any) => e.segs ? e.segs.map((s: any) => s.utf8).join('') : '').filter((t: string) => t);
                        const text = lines.join(' ');
                        return {
                            text,
                            title,
                            platform: 'youtube'
                        };
                    }
                }
            } catch (e) {
                console.error("Gemini Shell: Failed to fetch/parse JSON3 transcript", e);
            }
        }

        console.log(`Gemini Shell: Transcript XML length: ${transcriptXml.length}`);
        if (transcriptXml.length < 100) {
            console.log(`Gemini Shell: Transcript XML preview: ${transcriptXml}`);
        }

        // 5. Parse XML to Text using DOMParser
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(transcriptXml, "text/xml");
        const textNodes = xmlDoc.getElementsByTagName("text");

        const lines = [];
        for (let i = 0; i < textNodes.length; i++) {
            const textContent = textNodes[i].textContent;
            if (textContent) {
                lines.push(textContent.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            }
        }

        const text = lines.join(' ');

        if (!text) {
            console.warn("Gemini Shell: Parsed transcript is empty. XML Preview: ", transcriptXml.substring(0, 200));
            // Return title and platform even if text is empty
            return { text: "", title, platform: 'youtube' };
        }

        return {
            text,
            title,
            platform: 'youtube'
        };

    } catch (e) {
        console.error("Failed to get YouTube transcript", e);
        new Notice(`YouTube Transcript Error: ${e.message}`);
        // Return null if we can't even get the basic page info
        return null;
    }
}

async function getBilibiliTranscript(url: string): Promise<VideoTranscript | null> {
    try {
        // 1. Fetch page to get CID and Title
        const response = await requestUrl({
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = response.text;

        // Extract Title
        let title = "Bilibili Video";
        const titleMatch = html.match(/<title data-vue-meta="true">([^<]+)<\/title>/) || html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].replace('_哔哩哔哩_bilibili', '');
        }

        // Extract CID (can be in window.__INITIAL_STATE__ or similar)
        // Regex for "cid":12345678
        const cidMatch = html.match(/"cid":(\d+)/);
        if (!cidMatch) {
            console.error("Bilibili CID not found");
            return null;
        }
        const cid = cidMatch[1];

        // Extract BVID from URL or HTML
        let bvid = '';
        const bvidMatch = url.match(/(BV\w+)/);
        if (bvidMatch) {
            bvid = bvidMatch[1];
        } else {
            const bvidHtmlMatch = html.match(/"bvid":"(BV\w+)"/);
            if (bvidHtmlMatch) bvid = bvidHtmlMatch[1];
        }

        if (!cid || !bvid) return null;

        // 2. Get Subtitle List
        const playerApiUrl = `https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`;
        const playerResponse = await requestUrl({ url: playerApiUrl });
        const playerData = playerResponse.json;

        if (!playerData.data || !playerData.data.subtitle || !playerData.data.subtitle.subtitles || playerData.data.subtitle.subtitles.length === 0) {
            console.warn("No subtitles found for Bilibili video");
            return null;
        }

        // 3. Fetch the first subtitle track
        const subtitleUrl = `https:${playerData.data.subtitle.subtitles[0].subtitle_url}`;
        const subtitleResponse = await requestUrl({ url: subtitleUrl });
        const subtitleData = subtitleResponse.json;

        // 4. Parse subtitles
        // Format: { body: [ { from: 0, to: 1, content: "text" } ] }
        if (!subtitleData.body) return null;

        const text = subtitleData.body.map((item: any) => item.content).join(' ');

        return {
            text,
            title,
            platform: 'bilibili'
        };

    } catch (e) {
        console.error("Failed to get Bilibili transcript", e);
        return null;
    }
}
