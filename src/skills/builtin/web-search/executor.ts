import { requestUrl } from 'obsidian';
import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';

interface WebSearchDeps {
  requestUrl: typeof requestUrl;
  wait: (ms: number) => Promise<void>;
}

const defaultDeps: WebSearchDeps = {
  requestUrl: (options) => requestUrl(options),
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
};

export function createWebSearchTool(deps: WebSearchDeps = defaultDeps): Tool {
  return {
    name: 'web_search',
    description: 'Search the web for information using DuckDuckGo.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        time_range: {
          type: 'string',
          description: 'Time range: d (day), w (week), m (month), y (year)',
          enum: ['d', 'w', 'm', 'y'],
        },
      },
      required: ['query'],
    },
    async execute(args, _ctx) {
      let searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
      if (args.time_range) searchUrl += `&df=${args.time_range}`;

      try {
        let html = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await deps.requestUrl({ url: searchUrl });
          const candidate = response.text || '';
          if (response.status === 200 && candidate.length > 40) {
            html = candidate;
            break;
          }
          if (attempt < 2) {
            await deps.wait(200);
          }
        }

        if (!html) {
          return { results: [], message: 'No results found or parsing failed.' };
        }

        const results: any[] = [];
        let match;
        let count = 0;
        const regex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && count < 5) {
          results.push({
            title: match[2].replace(/<[^>]+>/g, '').trim(),
            link: match[1],
            snippet: match[3].replace(/<[^>]+>/g, '').trim(),
          });
          count++;
        }

        return results.length === 0
          ? { results: [], message: 'No results found or parsing failed.' }
          : { results };
      } catch (error: any) {
        return { error: `Search failed: ${error.message}` };
      }
    },
  };
}

const webSearchTool = createWebSearchTool();

export const executor: BuiltinExecutor = {
  async execute(args: any, ctx: ToolContext) {
    return webSearchTool.execute(args, ctx);
  },
};

export function registerTools(registry: ToolRegistry): void {
  registry.register(webSearchTool);
}
