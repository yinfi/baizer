const url = 'https://www.youtube.com/watch?v=M7FIvfx5J10';

async function run() {
    console.log(`Fetching ${url}...`);
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = await res.text();
        console.log(`Fetched ${html.length} bytes.`);

        // Extract Captions
        const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
        if (!captionsMatch) {
            console.error("No captionTracks found.");
            return;
        }

        const captionTracks = JSON.parse(captionsMatch[1]);
        console.log(`Found ${captionTracks.length} caption tracks.`);

        let selectedTrack = captionTracks.find(track => track.languageCode === 'en');
        if (!selectedTrack) selectedTrack = captionTracks[0];

        console.log(`Selected track: ${selectedTrack.name.simpleText} (${selectedTrack.languageCode})`);
        console.log(`BaseURL: ${selectedTrack.baseUrl}`);

        // Fetch Transcript
        console.log("Fetching transcript XML...");
        const transcriptUrl = selectedTrack.baseUrl + '&fmt=xml';
        console.log(`Transcript URL: ${transcriptUrl}`);

        const xmlRes = await fetch(transcriptUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': url,
                'Origin': 'https://www.youtube.com'
            }
        });

        console.log(`Status: ${xmlRes.status}`);
        const xml = await xmlRes.text();
        console.log(`XML Length: ${xml.length}`);
        console.log(`XML Preview: ${xml.substring(0, 200)}`);

    } catch (e) {
        console.error("Error:", e);
    }
}

run();
