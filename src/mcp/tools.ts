import { App, TFile, requestUrl, htmlToMarkdown } from 'obsidian';
import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { Readability } from '@mozilla/readability';

export class ToolManager {
    constructor(private app: App, private allowPluginControl: boolean) { }

    getToolsDefinitions(): FunctionDeclaration[] {
        const tools: FunctionDeclaration[] = [
            // 1. Read Note
            {
                name: 'read_note',
                description: 'Read the full content of a specific markdown note.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'The file path or wiki-link name' }
                    },
                    required: ['path']
                }
            },
            // 2. Create Note
            {
                name: 'create_note',
                description: 'Create a new note with content. Automatically creates parent folders if needed.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        filename: { type: SchemaType.STRING, description: 'Path/Filename.md (e.g., "Study/MyNote.md")' },
                        content: { type: SchemaType.STRING, description: 'Markdown content' }
                    },
                    required: ['filename', 'content']
                }
            },
            // 3. Update Note
            {
                name: 'update_note',
                description: 'Update the content of an existing note. Completely replaces the file content.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'File path' },
                        content: { type: SchemaType.STRING, description: 'New content' }
                    },
                    required: ['path', 'content']
                }
            },
            // 4. Append to Note
            {
                name: 'append_to_note',
                description: 'Append content to the end of an existing note.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'File path' },
                        content: { type: SchemaType.STRING, description: 'Content to append' }
                    },
                    required: ['path', 'content']
                }
            },
            // 5. Delete Note
            {
                name: 'delete_note',
                description: 'Delete a note file. Moves to trash if available.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'File path to delete' }
                    },
                    required: ['path']
                }
            },
            // 6. Rename Note
            {
                name: 'rename_note',
                description: 'Rename or move a note to a different location.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        oldPath: { type: SchemaType.STRING, description: 'Current file path' },
                        newPath: { type: SchemaType.STRING, description: 'New file path' }
                    },
                    required: ['oldPath', 'newPath']
                }
            },
            // 7. List Notes
            {
                name: 'list_notes',
                description: 'List markdown files in the vault or a specific folder.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        folder: { type: SchemaType.STRING, description: 'Folder path (optional, defaults to root)' },
                        limit: { type: SchemaType.NUMBER, description: 'Max number of files to return (optional, default 20)' }
                    },
                    required: []
                }
            },
            // 8. Search
            {
                name: 'search_vault',
                description: 'Fuzzy search for files in the vault.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        query: { type: SchemaType.STRING }
                    },
                    required: ['query']
                }
            },
            // 9. Open File
            {
                name: 'open_file',
                description: 'Open a file in the Obsidian editor. Supports file path or filename.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        path: { type: SchemaType.STRING, description: 'File path or filename' }
                    },
                    required: ['path']
                }
            },
            // 10. Save Webpage
            {
                name: 'save_webpage',
                description: 'Download a webpage, convert it to Markdown, and save it to the vault. Handles WeChat articles specifically.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        url: { type: SchemaType.STRING, description: 'The URL to save' },
                        filename: { type: SchemaType.STRING, description: 'Optional filename (without extension). If not provided, page title will be used.' }
                    },
                    required: ['url']
                }
            }
        ];

        // Conditional loading: if plugin control is enabled
        if (this.allowPluginControl) {
            tools.push({
                name: 'execute_command',
                description: 'Execute an Obsidian command ID.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        id: { type: SchemaType.STRING, description: 'The command ID to run' }
                    },
                    required: ['id']
                }
            });
            tools.push({
                name: 'list_available_commands',
                description: 'List commands matching a keyword to find their IDs.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        keyword: { type: SchemaType.STRING }
                    },
                    required: ['keyword']
                }
            });
            tools.push({
                name: 'list_plugins',
                description: 'List all installed plugins and their status (enabled/disabled).',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            });
            tools.push({
                name: 'get_plugin_commands',
                description: 'List all commands registered by a specific plugin.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        pluginId: { type: SchemaType.STRING, description: 'The ID of the plugin (e.g., "obsidian-kanban")' }
                    },
                    required: ['pluginId']
                }
            });
            tools.push({
                name: 'get_plugin_settings',
                description: 'Get the settings/configuration for a specific plugin.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        pluginId: { type: SchemaType.STRING, description: 'The ID of the plugin' }
                    },
                    required: ['pluginId']
                }
            });
        }

        // Always available tools
        tools.push({
            name: 'get_current_time',
            description: 'Get the current local date and time.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {},
                required: []
            }
        });

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

        return tools;
    }

    async execute(name: string, args: any): Promise<any> {
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
                    const url = args.url;
                    console.log(`Gemini Shell: Saving webpage ${url}`);
                    try {
                        const response = await requestUrl({ url: url });
                        let html = response.text;
                        console.log(`Gemini Shell: Fetched ${html.length} bytes`);

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
                        console.log(`Gemini Shell: Extracted title "${title}"`);

                        // Sanitize Title
                        title = title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

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
                                console.log("Gemini Shell: Found #js_content for WeChat article");
                                try {
                                    // Remove scripts and styles from js_content
                                    const scripts = jsContent.querySelectorAll('script, style');
                                    scripts.forEach(s => s.remove());

                                    markdown = htmlToMarkdown(jsContent.innerHTML);
                                    extractionMethod = "wechat-js_content";
                                } catch (e) {
                                    console.error("Gemini Shell: htmlToMarkdown failed on #js_content", e);
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
                                console.log(`Gemini Shell: Readability extracted content length: ${article.content.length}`);
                                // Convert extracted content to Markdown
                                try {
                                    markdown = htmlToMarkdown(article.content);
                                    extractionMethod = "readability";
                                } catch (e) {
                                    console.error("Gemini Shell: htmlToMarkdown failed on extracted content", e);
                                    markdown = "Error: Conversion failed.";
                                }
                            } else {
                                console.warn("Gemini Shell: Readability failed to extract content, falling back to full HTML");
                                try {
                                    markdown = htmlToMarkdown(html);
                                    extractionMethod = "fallback-full";
                                } catch (e) {
                                    console.error("Gemini Shell: htmlToMarkdown failed on full HTML", e);
                                    markdown = "Error: Conversion failed.";
                                }
                            }
                        }

                        console.log(`Gemini Shell: Extraction method used: ${extractionMethod}`);

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

                        console.log(`Gemini Shell: Saving to ${finalPath}`);
                        await this.app.vault.create(finalPath, `Source: ${url}\n\n${markdown}`);
                        console.log(`Gemini Shell: Save successful`);

                        return { success: true, path: finalPath, message: `✅ Saved: ${finalPath}` };

                    } catch (error: any) {
                        console.error(`Gemini Shell: Save failed`, error);
                        return { success: false, error: `Failed to save webpage: ${error.message}` };
                    }

                case 'list_available_commands':
                    if (!this.allowPluginControl) return { error: 'Permission denied' };
                    const cmds = this.app.commands.listCommands()
                        .filter(c => c.name.toLowerCase().includes(args.keyword.toLowerCase()))
                        .map(c => ({ id: c.id, name: c.name }))
                        .slice(0, 10);
                    return { commands: cmds };

                case 'execute_command':
                    if (!this.allowPluginControl) return { error: 'Permission denied' };
                    const success = this.app.commands.executeCommandById(args.id);
                    return { success, command_id: args.id };

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
