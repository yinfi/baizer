
const fs = require('fs');

async function testSearch(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    console.log(`Fetching ${searchUrl}...`);

    try {
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = await response.text();
        console.log(`Received HTML length: ${html.length}`);

        // Save to file for inspection
        fs.writeFileSync('ddg.html', html);
        console.log('Saved HTML to ddg.html');

        // The regex from the codebase (UPDATED)
        const resultBlockRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

        const results = [];
        let match;
        let count = 0;

        while ((match = resultBlockRegex.exec(html)) !== null && count < 5) {
            results.push({
                title: match[2].replace(/<[^>]+>/g, '').trim(),
                link: match[1],
                snippet: match[3].replace(/<[^>]+>/g, '').trim()
            });
            count++;
        }

        console.log(`Found ${results.length} results.`);
        if (results.length > 0) {
            console.log('First result:', results[0]);
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

testSearch('latest AI news');
