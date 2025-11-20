"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolManager = void 0;
const generative_ai_1 = require("@google/generative-ai");
class ToolManager {
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
            // 3. Search
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
            }
        ];
        // 条件加载：如果开启了插件控制权限
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
                    // 检查文件是否已存在
                    const existingFile = this.app.vault.getAbstractFileByPath(path);
                    if (existingFile) {
                        return {
                            status: 'error',
                            message: `文件已存在: ${path}。请使用不同的文件名或先删除现有文件。`
                        };
                    }
                    // 确保父文件夹存在
                    const pathParts = path.split('/');
                    if (pathParts.length > 1) {
                        const folderPath = pathParts.slice(0, -1).join('/');
                        const folder = this.app.vault.getAbstractFileByPath(folderPath);
                        if (!folder) {
                            // 创建父文件夹（递归创建所有需要的文件夹）
                            try {
                                await this.app.vault.createFolder(folderPath);
                            }
                            catch (e) {
                                // 文件夹可能已存在，忽略错误
                                console.log('Folder creation note:', e);
                            }
                        }
                    }
                    // 创建文件
                    await this.app.vault.create(path, args.content || '');
                    return { status: 'success', message: `✓ 笔记已成功保存至 ${path}` };
                case 'search_vault':
                    // Simple fuzzy search simulation using files cache
                    const matches = this.app.vault.getFiles()
                        .filter(f => f.basename.toLowerCase().includes(args.query.toLowerCase()))
                        .map(f => f.path)
                        .slice(0, 5);
                    return { matches };
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
