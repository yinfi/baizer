import { App, Notice, TFile, requestUrl, htmlToMarkdown } from 'obsidian';
import { Readability } from '@mozilla/readability';
import { getVideoTranscript } from '../utils/video_utils';
import { StdioMcpClient } from './mcp-client';
import { PluginSettings } from './types';
import { QueryKnowledgeExecutor } from '../knowledge/query';
import { FileBackExecutor } from '../knowledge/file-back';

export enum SchemaType {
    STRING = 'string',
    NUMBER = 'number',
    INTEGER = 'integer',
    BOOLEAN = 'boolean',
    ARRAY = 'array',
    OBJECT = 'object'
}

export class ToolManager {
    app: App;
    geminiApi: any;
    allowPluginControl: boolean;
    private mcpClients: Map<string, StdioMcpClient> = new Map();
    private settings: PluginSettings;
    private queryExecutor: QueryKnowledgeExecutor | null = null;
    private fileBackExecutor: FileBackExecutor | null = null;

    constructor(app: App, settings: PluginSettings) {
        this.app = app;
        this.settings = settings;
        this.geminiApi = null;
        this.allowPluginControl = settings.allowPluginControl;
        this.initializeMcpClients();
    }

    setKnowledgeExecutors(
        queryExecutor: QueryKnowledgeExecutor,
        fileBackExecutor: FileBackExecutor
    ): void {
        this.queryExecutor = queryExecutor;
        this.fileBackExecutor = fileBackExecutor;
    }

    async initializeMcpClients() {
        // 先清理现有的 MCP 客户端，避免进程泄漏
        await this.cleanupMcpClients();

        if (!this.settings.mcpServers) return;

        for (const [name, config] of Object.entries(this.settings.mcpServers)) {
            try {
                const client = new StdioMcpClient(config.command, config.args);
                await client.connect();
                this.mcpClients.set(name, client);
            } catch (e) {
                console.error(`Failed to initialize MCP server ${name}`, e);
            }
        }
    }

    // 添加清理 MCP 客户端的方法
    async cleanupMcpClients() {
        // 先清理现有的 MCP 客户端，确保进程被正确终止
        if (this.mcpClients && this.mcpClients.size > 0) {
            console.log(`[ToolManager] Cleaning up ${this.mcpClients.size} MCP clients...`);
            const cleanupPromises = Array.from(this.mcpClients.entries()).map(async ([name, client]) => {
                try {
                    // 断开客户端连接，这会kill子进程
                    await client.disconnect();
                    console.log(`[ToolManager] Successfully disconnected MCP client: ${name}`);
                } catch (e) {
                    console.error(`[ToolManager] Error disconnecting MCP client ${name}:`, e);
                }
            });

            // 等待所有客户端断开连接
            await Promise.allSettled(cleanupPromises);

            // 清空客户端Map
            this.mcpClients.clear();
            console.log('[ToolManager] All MCP clients have been cleaned up.');
        }
    }

    setGeminiApi(api: any) {
        this.geminiApi = api;
    }

    updateSettings(settings: PluginSettings) {
        this.settings = settings;
        this.allowPluginControl = settings.allowPluginControl;
        this.initializeMcpClients();
    }

    getToolsDefinitions(): any[] {
        const tools = [
            {
                name: 'read_note',
                description: 'Read the content of a specific note in the vault.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The path to the note (e.g., "Folder/Note.md")' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'create_note',
                description: 'Create a new note with the specified content.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        filename: { type: SchemaType.STRING, description: 'The name/path of the new note' },
                        content: { type: SchemaType.STRING, description: 'The content to write to the note' }
                    },
                    required: ['filename', 'content']
                }
            },
            {
                name: 'update_note',
                description: 'Update the content of an existing note. Replaces the entire content.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The path to the note to update' },
                        content: { type: SchemaType.STRING, description: 'The new content for the note' }
                    },
                    required: ['path', 'content']
                }
            },
            {
                name: 'append_to_note',
                description: 'Append content to the end of an existing note.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The path to the note' },
                        content: { type: SchemaType.STRING, description: 'The content to append' }
                    },
                    required: ['path', 'content']
                }
            },
            {
                name: 'delete_note',
                description: 'Delete a note from the vault.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The path to the note to delete' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'rename_note',
                description: 'Rename or move a note.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        oldPath: { type: SchemaType.STRING, description: 'The current path of the note' },
                        newPath: { type: SchemaType.STRING, description: 'The new path/name for the note' }
                    },
                    required: ['oldPath', 'newPath']
                }
            },
            {
                name: 'list_notes',
                description: 'List notes in a specific folder or the entire vault.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        folder: { type: SchemaType.STRING, description: 'The folder to list (optional, defaults to root)' },
                        limit: { type: SchemaType.INTEGER, description: 'Maximum number of notes to return (default 20)' }
                    }
                }
            },
            {
                name: 'search_vault',
                description: 'Search for files in the vault by name.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        query: { type: SchemaType.STRING, description: 'The search query' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'open_file',
                description: 'Open a file in the Obsidian workspace.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The path or name of the file to open' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'save_webpage',
                description: 'Save a webpage or video transcript to a new note. Supports YouTube, Bilibili, and WeChat articles.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        url: { type: SchemaType.STRING, description: 'The URL of the webpage or video' },
                        filename: { type: SchemaType.STRING, description: 'Optional filename for the note' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'get_current_time',
                description: 'Get the current local time and date.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {}
                }
            }
        ];

        if (this.allowPluginControl) {
            tools.push(
                {
                    name: 'list_plugins',
                    description: 'List all installed plugins and their status.',
                    parameters: { type: SchemaType.OBJECT, properties: {} }
                },
                {
                    name: 'get_plugin_commands',
                    description: 'Get available commands for a specific plugin.',
                    parameters: {
                        type: SchemaType.OBJECT,
                        properties: {
                            pluginId: { type: SchemaType.STRING, description: 'The ID of the plugin' }
                        },
                        required: ['pluginId']
                    }
                },
                {
                    name: 'get_plugin_settings',
                    description: 'Get settings for a specific plugin.',
                    parameters: {
                        type: SchemaType.OBJECT,
                        properties: {
                            pluginId: { type: SchemaType.STRING, description: 'The ID of the plugin' }
                        },
                        required: ['pluginId']
                    }
                }
            );
        }

        // Knowledge Wiki tools
        tools.push(
            {
                name: 'query_knowledge',
                description: '从个人知识库中检索相关知识。先读取全局索引了解有哪些文章和主题，再根据需要读取具体的 summary 全文。当用户的问题可能与已积累的知识相关时使用此工具。',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        query: { type: SchemaType.STRING, description: '检索关键词或问题' },
                        max_results: { type: SchemaType.INTEGER, description: '最多返回几篇 summary，默认 3' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'file_back_knowledge',
                description: '将当前对话中产出的高质量知识回答存回知识库 Wiki，让知识库随使用不断增长。只对综合了多个知识来源、产出有价值新洞察的回答使用。',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        title: { type: SchemaType.STRING, description: '回填文章的标题' },
                        content: { type: SchemaType.STRING, description: '要归档的内容（Markdown 格式）' },
                        source_queries: {
                            type: SchemaType.ARRAY,
                            items: { type: SchemaType.STRING },
                            description: '触发这次回答的问题列表'
                        },
                        related_sources: {
                            type: SchemaType.ARRAY,
                            items: { type: SchemaType.STRING },
                            description: '引用的 knowledge_source_id 列表'
                        }
                    },
                    required: ['title', 'content', 'source_queries']
                }
            }
        );

        tools.push({
            name: 'web_search',
            description: 'Search the web for information. Use this to find up-to-date info, news, or documentation. IMPORTANT: When providing links in the output, YOU MUST use standard Markdown link syntax: [Title](URL). Do not use bare URLs.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    query: { type: SchemaType.STRING, description: 'The search query' },
                    time_range: {
                        type: SchemaType.STRING,
                        description: 'Time range for search results. Options: d (day), w (week), m (month), y (year). Default is no filter.',
                        enum: ['d', 'w', 'm', 'y']
                    }
                },
                required: ['query']
            }
        });

        // Add MCP tools
        for (const [serverName, client] of this.mcpClients) {
            try {
                // We need to make this async compatible, but getToolsDefinitions is synchronous currently.
                // This is a problem. We need to make getToolsDefinitions async or cache tools.
                // For now, let's assume we cache tools on connect, or we change getToolsDefinitions to async.
                // Changing to async might ripple through ModelService.
                // Let's check ModelService. It calls getToolsDefinitions() in startChat.
                // startChat expects ToolDefinition[].

                // Hack: We can't easily make this async without refactoring ModelService.
                // Let's assume we cache tools in initializeMcpClients?
                // But initializeMcpClients is async.
                // Let's just fetch them on demand if we can, or cache them.
                // I'll add a cache.
            } catch (e) {
                console.error(`Failed to list tools for ${serverName}`, e);
            }
        }

        return tools;
    }

    // New method to get tools async
    async getToolsDefinitionsAsync(): Promise<any[]> {
        const tools = this.getToolsDefinitions(); // Get built-in tools

        for (const [serverName, client] of this.mcpClients) {
            try {
                const mcpTools = await client.listTools();
                for (const tool of mcpTools) {
                    tools.push({
                        name: `${serverName}_${tool.name}`,
                        description: tool.description || `Tool from ${serverName}`,
                        parameters: tool.inputSchema
                    });
                }
            } catch (e) {
                console.error(`Failed to list tools for ${serverName}`, e);
            }
        }
        return tools;
    }

    async execute(name: string, args: any): Promise<any> {
        // Check if it's an MCP tool
        for (const [serverName, client] of this.mcpClients) {
            if (name.startsWith(`${serverName}_`)) {
                const toolName = name.substring(serverName.length + 1);
                return await client.callTool(toolName, args);
            }
        }

        try {
            switch (name) {
                case 'read_note':
                    const file = this.app.metadataCache.getFirstLinkpathDest(args.path, "");
                    if (!file) return { error: 'File not found' };
                    const content = await this.app.vault.read(file);
                    return { path: file.path, content: content.substring(0, 5000) }; // Limit context

                case 'create_note':
                    let path = args.filename;
                    if (!path.endsWith('.md')) path += '.md';

                    // Check if file already exists
                    const existingFile = this.app.vault.getAbstractFileByPath(path);
                    if (existingFile) {
                        return {
                            status: 'error',
                            message: `File already exists: ${path}. Use update_note to modify existing files.`
                        };
                    }

                    // Ensure parent folder exists
                    const pathParts = path.split('/');
                    if (pathParts.length > 1) {
                        const folderPath = pathParts.slice(0, -1).join('/');
                        const folder = this.app.vault.getAbstractFileByPath(folderPath);
                        if (!folder) {
                            try {
                                await this.app.vault.createFolder(folderPath);
                            } catch (e) {
                                console.log('Folder creation note:', e);
                            }
                        }
                    }

                    await this.app.vault.create(path, args.content || '');
                    return { status: 'success', message: `✅ Note created: ${path}` };

                case 'update_note':
                    const updateFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!updateFile || !(updateFile instanceof TFile)) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.modify(updateFile, args.content);
                    return { success: true, message: `✅ Updated: ${args.path}` };

                case 'append_to_note':
                    const appendFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!appendFile || !(appendFile instanceof TFile)) {
                        return { success: false, error: 'File not found' };
                    }
                    const existingContent = await this.app.vault.read(appendFile);
                    await this.app.vault.modify(appendFile, existingContent + '\n' + args.content);
                    return { success: true, message: `✅ Appended to: ${args.path}` };

                case 'delete_note':
                    const deleteFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!deleteFile) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.trash(deleteFile, true); // Move to system trash
                    return { success: true, message: `✅ Deleted: ${args.path}` };

                case 'rename_note':
                    const renameFile = this.app.vault.getAbstractFileByPath(args.oldPath);
                    if (!renameFile) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.rename(renameFile, args.newPath);
                    return { success: true, message: `✅ Renamed: ${args.oldPath} -> ${args.newPath}` };

                case 'list_notes':
                    const folderPath = args.folder || '/';
                    const limit = args.limit || 20;
                    let files = this.app.vault.getMarkdownFiles();

                    if (folderPath !== '/') {
                        files = files.filter(f => f.path.startsWith(folderPath));
                    }

                    const fileList = files
                        .slice(0, limit)
                        .map(f => ({
                            path: f.path,
                            name: f.basename,
                            size: f.stat.size,
                            modified: new Date(f.stat.mtime).toISOString()
                        }));

                    return { success: true, files: fileList, total: files.length };

                case 'search_vault':
                    const matches = this.app.vault.getFiles()
                        .filter(f => f.basename.toLowerCase().includes(args.query.toLowerCase()))
                        .map(f => f.path)
                        .slice(0, 5);
                    return { matches };

                case 'open_file':
                    const allFiles = this.app.vault.getFiles();
                    let targetFile = allFiles.find(f => f.path === args.path);
                    if (!targetFile) {
                        targetFile = allFiles.find(f => f.basename === args.path || f.basename === args.path.replace('.md', ''));
                    }
                    if (!targetFile) {
                        const fuzzyMatches = allFiles.filter(f => f.path.toLowerCase().includes(args.path.toLowerCase()));
                        if (fuzzyMatches.length === 1) {
                            targetFile = fuzzyMatches[0];
                        } else if (fuzzyMatches.length > 1) {
                            return {
                                success: false,
                                error: `Found ${fuzzyMatches.length} matches`,
                                matches: fuzzyMatches.map(f => f.path)
                            };
                        }
                    }
                    if (!targetFile) {
                        return { success: false, error: 'File not found' };
                    }
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(targetFile);
                    return { success: true, path: targetFile.path, message: `✅ Opened: ${targetFile.path}` };

                case 'save_webpage':
                    const extractTags = (text: string) => {
                        const tags: string[] = [];
                        const words = text.split(/\s+/);
                        for (const word of words) {
                            if (word.startsWith('#') && word.length > 1) {
                                tags.push(word.substring(1));
                            }
                        }
                        return tags;
                    };

                    const url = args.url;
                    console.log(`Obsidian Shell: Saving webpage ${url}`);
                    try {
                        // Check if it's a video URL
                        const videoTranscript = await getVideoTranscript(url);

                        if (videoTranscript) {
                            console.log(`Obsidian Shell: Found video info for ${videoTranscript.platform}`);

                            // Use resolved URL if available, otherwise original URL
                            const finalUrl = videoTranscript.url || url;

                            let content = "";

                            // 1. Try to get summary if text exists
                            if (videoTranscript.text && videoTranscript.text.length > 0) {
                                if (!this.geminiApi) {
                                    return { success: false, error: "Gemini API not initialized for summarization." };
                                }

                                new Notice(`🎥 Summarizing ${videoTranscript.platform} video...`);

                                const prompt = `Please summarize the following video transcript. 
Title: ${videoTranscript.title}
Transcript:
${videoTranscript.text.substring(0, 30000)}... (truncated if too long)

Task:
1. Provide a concise summary of the video content.
2. List key takeaways or bullet points.
3. Format the output in Markdown.`;

                                try {
                                    const summary = await this.geminiApi.chat(prompt, "VideoSummarization", "You are a helpful assistant that summarizes videos.");
                                    const created = new Date().toISOString();
                                    const titleTags = extractTags(videoTranscript.title);
                                    const tagString = titleTags.length > 0 ? `, ${titleTags.join(', ')}` : '';
                                    const yamlFrontmatter = `---
created: ${created}
tags: video, ${videoTranscript.platform}${tagString}
source: ${finalUrl}
author: ${videoTranscript.author || videoTranscript.platform}
---

`;
                                    content = `${yamlFrontmatter}# ${videoTranscript.title}\n\n${summary}\n\n## Transcript Excerpt\n\n${videoTranscript.text.substring(0, 1000)}...`;
                                } catch (e) {
                                    console.error("Obsidian Shell: Summarization failed", e);
                                    // Fallback to video embed if summarization fails
                                    const created = new Date().toISOString();
                                    const titleTags = extractTags(videoTranscript.title);
                                    const tagString = titleTags.length > 0 ? `, ${titleTags.join(', ')}` : '';
                                    const yamlFrontmatter = `---
created: ${created}
tags: video, ${videoTranscript.platform}${tagString}
source: ${finalUrl}
author: ${videoTranscript.author || videoTranscript.platform}
---

`;
                                    // Add mx-open link as fallback
                                    const encodedUrl = encodeURIComponent(finalUrl);
                                    content = `${yamlFrontmatter}# ${videoTranscript.title}\n\n[${videoTranscript.title}](${finalUrl})\n\n[▶️ Play with Media Extended](obsidian://mx-open?url=${encodedUrl})`;
                                }
                            } else {
                                // 2. No transcript: Save Title and URL with media-extended format
                                console.log("Obsidian Shell: No transcript text available, saving video embed.");
                                new Notice(`💾 Saving video link...`);

                                const created = new Date().toISOString();
                                const titleTags = extractTags(videoTranscript.title);
                                const tagString = titleTags.length > 0 ? `, ${titleTags.join(', ')}` : '';
                                const yamlFrontmatter = `---
created: ${created}
tags: video, ${videoTranscript.platform}${tagString}
source: ${finalUrl}
author: ${videoTranscript.author || videoTranscript.platform}
---

`;
                                // Use media-extended compatible format: ![](video_url)
                                // Also add a direct link to open with Media Extended (obsidian://mx-open)
                                const encodedUrl = encodeURIComponent(finalUrl);
                                content = `${yamlFrontmatter}# ${videoTranscript.title}\n\n[${videoTranscript.title}](${finalUrl})\n\n[▶️ Play with Media Extended](obsidian://mx-open?url=${encodedUrl})`;
                            }

                            // Save logic
                            let filename = args.filename || videoTranscript.title;
                            filename = filename.replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim();
                            if (!filename.endsWith('.md')) filename += '.md';

                            let finalPath = filename;
                            let counter = 1;
                            while (this.app.vault.getAbstractFileByPath(finalPath)) {
                                finalPath = filename.replace('.md', ` (${counter}).md`);
                                counter++;
                            }

                            await this.app.vault.create(finalPath, content);
                            return { success: true, path: finalPath, message: `✅ Video Note Saved: ${finalPath}` };
                        }

                        // Fallback to normal webpage saving
                        const response = await requestUrl({
                            url: url,
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
                            }
                        });
                        let html = response.text;
                        console.log(`Obsidian Shell: Fetched ${html.length} bytes`);

                        // Extract Title
                        let title = 'Untitled Webpage';
                        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                        if (titleMatch && titleMatch[1].trim()) {
                            title = titleMatch[1].trim();
                        } else {
                            // Try og:title
                            const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i);
                            if (ogTitleMatch && ogTitleMatch[1].trim()) {
                                title = ogTitleMatch[1].trim();
                            } else {
                                // Try h1
                                const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
                                if (h1Match && h1Match[1].trim()) {
                                    title = h1Match[1].replace(/<[^>]+>/g, '').trim();
                                }
                            }
                        }
                        // Extract Author
                        let author = '';

                        // WeChat specific author extraction
                        if (url.includes('mp.weixin.qq.com')) {
                            // 1. Try variable definition (common in older/standard templates)
                            // Matches: var nickname = "Name"; or var nickname = 'Name';
                            const varMatch = html.match(/var\s+nickname\s*=\s*["']([^"']+)["']/);
                            if (varMatch && varMatch[1]) {
                                author = varMatch[1].trim();
                            }

                            // 2. Try profile link/text (common in newer templates)
                            // Matches: <strong class="profile_nickname">Name</strong> or <a ... class="profile_nickname">Name</a>
                            if (!author) {
                                const profileMatch = html.match(/class="profile_nickname"[^>]*>([^<]+)</);
                                if (profileMatch && profileMatch[1]) {
                                    author = profileMatch[1].trim();
                                }
                            }

                            // 3. Try js_name (sometimes used)
                            if (!author) {
                                const jsNameMatch = html.match(/class="js_name"[^>]*>([^<]+)</);
                                if (jsNameMatch && jsNameMatch[1]) {
                                    author = jsNameMatch[1].trim();
                                }
                            }
                        }

                        // Generic fallback if no author found yet
                        if (!author) {
                            const authorMatch = html.match(/<meta name="author" content="([^"]*)"/i) ||
                                html.match(/<meta property="article:author" content="([^"]*)"/i) ||
                                html.match(/<meta property="og:site_name" content="([^"]*)"/i);
                            if (authorMatch && authorMatch[1]) {
                                author = authorMatch[1].trim();
                            }
                        }

                        console.log(`Obsidian Shell: Extracted title "${title}", author "${author}"`);

                        const webpageTags = extractTags(title);

                        // Sanitize Title
                        title = title.replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim();

                        // Fallback if title is still empty or just dashes
                        if (!title || title.replace(/-/g, '').trim().length === 0) {
                            const now = new Date();
                            title = `Clipping ${now.toISOString().split('T')[0]} ${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
                        }

                        // Handle WeChat Lazy Loading
                        if (url.includes('mp.weixin.qq.com')) {
                            html = html.replace(/data-src=/g, 'src=');
                        }

                        // Parse HTML for Readability
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, "text/html");

                        let markdown = "";
                        let extractionMethod = "none";

                        // Special handling for WeChat: Try #js_content first
                        if (url.includes('mp.weixin.qq.com')) {
                            const jsContent = doc.querySelector('#js_content');
                            if (jsContent) {
                                console.log("Obsidian Shell: Found #js_content for WeChat article");
                                try {
                                    // Remove scripts and styles from js_content
                                    const scripts = jsContent.querySelectorAll('script, style');
                                    scripts.forEach(s => s.remove());

                                    markdown = htmlToMarkdown(jsContent.innerHTML);
                                    extractionMethod = "wechat-js_content";
                                } catch (e) {
                                    console.error("Obsidian Shell: htmlToMarkdown failed on #js_content", e);
                                }
                            }
                        }

                        // If WeChat extraction didn't work or wasn't applicable, try Readability
                        if (!markdown) {
                            // Pre-process DOM to remove common clutter that Readability might miss
                            const clutterSelectors = [
                                'nav', 'footer', 'aside',
                                'script', 'style', 'noscript',
                                '.sidebar', '.navbar', '.nav', '.menu',
                                '#sidebar', '#nav', '#menu',
                                '.ads', '.advertisement', '.ad-container'
                            ];

                            clutterSelectors.forEach(selector => {
                                try {
                                    const elements = doc.querySelectorAll(selector);
                                    elements.forEach(el => el.remove());
                                } catch (e) {
                                    // Ignore selector errors
                                }
                            });

                            // Use Readability to extract content
                            // @ts-ignore
                            const reader = new Readability(doc);
                            const article = reader.parse();

                            if (article && article.content) {
                                console.log(`Obsidian Shell: Readability extracted content length: ${article.content.length}`);
                                // Convert extracted content to Markdown
                                try {
                                    markdown = htmlToMarkdown(article.content);
                                    extractionMethod = "readability";
                                } catch (e) {
                                    console.error("Obsidian Shell: htmlToMarkdown failed on extracted content", e);
                                    markdown = "Error: Conversion failed.";
                                }
                            } else {
                                console.warn("Obsidian Shell: Readability failed to extract content, falling back to full HTML");
                                try {
                                    markdown = htmlToMarkdown(html);
                                    extractionMethod = "fallback-full";
                                } catch (e) {
                                    console.error("Obsidian Shell: htmlToMarkdown failed on full HTML", e);
                                    markdown = "Error: Conversion failed.";
                                }
                            }
                        }

                        console.log(`Obsidian Shell: Extraction method used: ${extractionMethod}`);

                        if (!markdown || markdown.startsWith("Error:")) {
                            // Second fallback attempt if conversion failed
                            if (!markdown) markdown = "Error: Empty markdown result.";
                        }

                        // Prepare Filename
                        let filename = args.filename || title;
                        if (!filename.endsWith('.md')) filename += '.md';

                        // Check for duplicates
                        let finalPath = filename;
                        let counter = 1;
                        while (this.app.vault.getAbstractFileByPath(finalPath)) {
                            finalPath = filename.replace('.md', ` (${counter}).md`);
                            counter++;
                        }

                        const created = new Date().toISOString();
                        const webpageTagString = webpageTags.length > 0 ? `, ${webpageTags.join(', ')}` : '';
                        const yamlFrontmatter = `---
created: ${created}
source: ${url}
author: ${author}
tags: clipping${webpageTagString}
---

`;
                        const finalContent = `${yamlFrontmatter}# ${title}\n\n${markdown}`;

                        await this.app.vault.create(finalPath, finalContent);
                        return { success: true, path: finalPath, message: `✅ Webpage Saved: ${finalPath}` };

                    } catch (e) {
                        console.error("Obsidian Shell: Error saving webpage", e);
                        return { success: false, error: e.message };
                    }

                case 'list_plugins':
                    if (!this.allowPluginControl) return { error: 'Permission denied' };
                    const manifests = this.app.plugins.manifests;
                    const enabledPlugins = this.app.plugins.enabledPlugins;
                    const pluginList = Object.values(manifests).map(m => ({
                        id: m.id,
                        name: m.name,
                        version: m.version,
                        enabled: enabledPlugins.has(m.id),
                        description: m.description
                    }));
                    return { plugins: pluginList, total: pluginList.length };

                case 'get_plugin_commands':
                    if (!this.allowPluginControl) return { error: 'Permission denied' };
                    const pluginId = args.pluginId;
                    const pluginCommands = this.app.commands.listCommands()
                        .filter(c => c.id.startsWith(pluginId + ':'))
                        .map(c => ({ id: c.id, name: c.name }));

                    return {
                        pluginId,
                        commands: pluginCommands,
                        count: pluginCommands.length
                    };

                case 'get_plugin_settings':
                    if (!this.allowPluginControl) return { error: 'Permission denied' };
                    const plugin = this.app.plugins.getPlugin(args.pluginId);
                    if (!plugin) return { error: 'Plugin not found or not enabled' };
                    const settings = (plugin as any).settings || (plugin as any).data || {};
                    return {
                        pluginId: args.pluginId,
                        settings
                    };

                case 'get_current_time':
                    const now = new Date();
                    return {
                        iso: now.toISOString(),
                        local: now.toLocaleString(),
                        weekday: now.toLocaleDateString(undefined, { weekday: 'long' })
                    };

                case 'query_knowledge':
                    if (!this.queryExecutor) {
                        return { error: 'Knowledge system not initialized' };
                    }
                    return await this.queryExecutor.execute(args);

                case 'file_back_knowledge':
                    if (!this.fileBackExecutor) {
                        return { error: 'Knowledge system not initialized' };
                    }
                    return await this.fileBackExecutor.execute(args);

                case 'web_search':
                    let searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
                    if (args.time_range) {
                        searchUrl += `&df=${args.time_range}`;
                    }

                    try {
                        const response = await requestUrl({ url: searchUrl });
                        const html = response.text;

                        const results = [];
                        let match;
                        let count = 0;

                        const resultBlockRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

                        while ((match = resultBlockRegex.exec(html)) !== null && count < 5) {
                            results.push({
                                title: match[2].replace(/<[^>]+>/g, '').trim(),
                                link: match[1],
                                snippet: match[3].replace(/<[^>]+>/g, '').trim()
                            });
                            count++;
                        }

                        if (results.length === 0) {
                            return { results: [], message: "No results found or parsing failed." };
                        }

                        return { results };
                    } catch (error: any) {
                        return { error: `Search failed: ${error.message}` };
                    }

                default:
                    return { error: 'Unknown tool' };
            }
        } catch (e: any) {
            console.error(`Tool execution error [${name}]:`, e);
            return { error: e.message };
        }
    }
}
