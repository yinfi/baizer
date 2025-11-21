"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolManager = void 0;
const obsidian_1 = require("obsidian");
const generative_ai_1 = require("@google/generative-ai");
class ToolManager {
    app;
    allowPluginControl;
    constructor(app, allowPluginControl) {
        this.app = app;
        this.allowPluginControl = allowPluginControl;
    }
    getToolsDefinitions() {
        const tools = [
            // 1. Read Note
            {
                name: 'read_note',
                description: 'Read the full content of a specific markdown note.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        path: { type: generative_ai_1.SchemaType.STRING, description: 'The file path or wiki-link name' }
                    },
                    required: ['path']
                }
            },
            // 2. Create Note
            {
                name: 'create_note',
                description: 'Create a new note with content. Automatically creates parent folders if needed.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        filename: { type: generative_ai_1.SchemaType.STRING, description: 'Path/Filename.md (e.g., "Study/MyNote.md")' },
                        content: { type: generative_ai_1.SchemaType.STRING, description: 'Markdown content' }
                    },
                    required: ['filename', 'content']
                }
            },
            // 3. Update Note
            {
                name: 'update_note',
                description: 'Update the content of an existing note. Completely replaces the file content.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        path: { type: generative_ai_1.SchemaType.STRING, description: 'File path' },
                        content: { type: generative_ai_1.SchemaType.STRING, description: 'New content' }
                    },
                    required: ['path', 'content']
                }
            },
            // 4. Append to Note
            {
                name: 'append_to_note',
                description: 'Append content to the end of an existing note.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        path: { type: generative_ai_1.SchemaType.STRING, description: 'File path' },
                        content: { type: generative_ai_1.SchemaType.STRING, description: 'Content to append' }
                    },
                    required: ['path', 'content']
                }
            },
            // 5. Delete Note
            {
                name: 'delete_note',
                description: 'Delete a note file. Moves to trash if available.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        path: { type: generative_ai_1.SchemaType.STRING, description: 'File path to delete' }
                    },
                    required: ['path']
                }
            },
            // 6. Rename Note
            {
                name: 'rename_note',
                description: 'Rename or move a note to a different location.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        oldPath: { type: generative_ai_1.SchemaType.STRING, description: 'Current file path' },
                        newPath: { type: generative_ai_1.SchemaType.STRING, description: 'New file path' }
                    },
                    required: ['oldPath', 'newPath']
                }
            },
            // 7. List Notes
            {
                name: 'list_notes',
                description: 'List markdown files in the vault or a specific folder.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        folder: { type: generative_ai_1.SchemaType.STRING, description: 'Folder path (optional, defaults to root)' },
                        limit: { type: generative_ai_1.SchemaType.NUMBER, description: 'Max number of files to return (optional, default 20)' }
                    },
                    required: []
                }
            },
            // 8. Search
            {
                name: 'search_vault',
                description: 'Fuzzy search for files in the vault.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        query: { type: generative_ai_1.SchemaType.STRING }
                    },
                    required: ['query']
                }
            },
            // 9. Open File
            {
                name: 'open_file',
                description: 'Open a file in the Obsidian editor. Supports file path or filename.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        path: { type: generative_ai_1.SchemaType.STRING, description: 'File path or filename' }
                    },
                    required: ['path']
                }
            }
        ];
        // Conditional loading: if plugin control is enabled
        if (this.allowPluginControl) {
            tools.push({
                name: 'execute_command',
                description: 'Execute an Obsidian command ID.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        id: { type: generative_ai_1.SchemaType.STRING, description: 'The command ID to run' }
                    },
                    required: ['id']
                }
            });
            tools.push({
                name: 'list_available_commands',
                description: 'List commands matching a keyword to find their IDs.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        keyword: { type: generative_ai_1.SchemaType.STRING }
                    },
                    required: ['keyword']
                }
            });
            tools.push({
                name: 'list_plugins',
                description: 'List all installed plugins and their status (enabled/disabled).',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            });
            tools.push({
                name: 'get_plugin_commands',
                description: 'List all commands registered by a specific plugin.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        pluginId: { type: generative_ai_1.SchemaType.STRING, description: 'The ID of the plugin (e.g., "obsidian-kanban")' }
                    },
                    required: ['pluginId']
                }
            });
            tools.push({
                name: 'get_plugin_settings',
                description: 'Get the settings/configuration for a specific plugin.',
                parameters: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        pluginId: { type: generative_ai_1.SchemaType.STRING, description: 'The ID of the plugin' }
                    },
                    required: ['pluginId']
                }
            });
        }
        return tools;
    }
    async execute(name, args) {
        try {
            switch (name) {
                case 'read_note':
                    const file = this.app.metadataCache.getFirstLinkpathDest(args.path, "");
                    if (!file)
                        return { error: 'File not found' };
                    const content = await this.app.vault.read(file);
                    return { path: file.path, content: content.substring(0, 5000) }; // Limit context
                case 'create_note':
                    let path = args.filename;
                    if (!path.endsWith('.md'))
                        path += '.md';
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
                            }
                            catch (e) {
                                console.log('Folder creation note:', e);
                            }
                        }
                    }
                    await this.app.vault.create(path, args.content || '');
                    return { status: 'success', message: `鉁?Note created: ${path}` };
                case 'update_note':
                    const updateFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!updateFile || !(updateFile instanceof obsidian_1.TFile)) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.modify(updateFile, args.content);
                    return { success: true, message: `鉁?Updated: ${args.path}` };
                case 'append_to_note':
                    const appendFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!appendFile || !(appendFile instanceof obsidian_1.TFile)) {
                        return { success: false, error: 'File not found' };
                    }
                    const existingContent = await this.app.vault.read(appendFile);
                    await this.app.vault.modify(appendFile, existingContent + '\n' + args.content);
                    return { success: true, message: `鉁?Appended to: ${args.path}` };
                case 'delete_note':
                    const deleteFile = this.app.vault.getAbstractFileByPath(args.path);
                    if (!deleteFile) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.trash(deleteFile, true); // Move to system trash
                    return { success: true, message: `鉁?Deleted: ${args.path}` };
                case 'rename_note':
                    const renameFile = this.app.vault.getAbstractFileByPath(args.oldPath);
                    if (!renameFile) {
                        return { success: false, error: 'File not found' };
                    }
                    await this.app.vault.rename(renameFile, args.newPath);
                    return { success: true, message: `鉁?Renamed: ${args.oldPath} -> ${args.newPath}` };
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
                        }
                        else if (fuzzyMatches.length > 1) {
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
                    return { success: true, path: targetFile.path, message: `鉁?Opened: ${targetFile.path}` };
                case 'list_available_commands':
                    if (!this.allowPluginControl)
                        return { error: 'Permission denied' };
                    const cmds = this.app.commands.listCommands()
                        .filter(c => c.name.toLowerCase().includes(args.keyword.toLowerCase()))
                        .map(c => ({ id: c.id, name: c.name }))
                        .slice(0, 10);
                    return { commands: cmds };
                case 'execute_command':
                    if (!this.allowPluginControl)
                        return { error: 'Permission denied' };
                    const success = this.app.commands.executeCommandById(args.id);
                    return { success, command_id: args.id };
                case 'list_plugins':
                    if (!this.allowPluginControl)
                        return { error: 'Permission denied' };
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
                    if (!this.allowPluginControl)
                        return { error: 'Permission denied' };
                    const pluginId = args.pluginId;
                    // Filter commands that start with the plugin ID (standard convention)
                    // or check if the command definition belongs to the plugin (if accessible, but ID prefix is reliable enough for most)
                    const pluginCommands = this.app.commands.listCommands()
                        .filter(c => c.id.startsWith(pluginId + ':'))
                        .map(c => ({ id: c.id, name: c.name }));
                    return {
                        pluginId,
                        commands: pluginCommands,
                        count: pluginCommands.length
                    };
                case 'get_plugin_settings':
                    if (!this.allowPluginControl)
                        return { error: 'Permission denied' };
                    const plugin = this.app.plugins.getPlugin(args.pluginId);
                    if (!plugin)
                        return { error: 'Plugin not found or not enabled' };
                    // Try to access settings in common locations
                    // Most plugins store settings in 'settings' property or 'data' property
                    const settings = plugin.settings || plugin.data || {};
                    return {
                        pluginId: args.pluginId,
                        settings
                    };
                default:
                    return { error: 'Unknown tool' };
            }
        }
        catch (e) {
            console.error(`Tool execution error [${name}]:`, e);
            return { error: e.message };
        }
    }
}
exports.ToolManager = ToolManager;
