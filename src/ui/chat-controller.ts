import { App, MarkdownView } from 'obsidian';
import { ModelService } from '../services/model-service';
import { StreamEvent } from '../models/interfaces';
import { logger } from '../utils/logger';
import { ApprovalRequest } from './approval-card';

export interface ChatMessage {
    id: string;
    role: 'user' | 'ai' | 'system';
    content: string;
    timestamp: number;
    feedback?: 'up' | 'down' | null;
    approval?: ApprovalRequest;
}

export interface ChatControllerOptions {
    app: App;
    api: ModelService;
    onMessageAdded?: (message: ChatMessage) => void;
    onStatusChanged?: (isResponding: boolean) => void;
    onStreamEvent?: (event: StreamEvent) => void;
}

export class ChatController {
    private app: App;
    private api: ModelService;
    private messages: ChatMessage[] = [];
    // private isResponding: boolean = false; // Unused
    private onMessageAdded?: (message: ChatMessage) => void;
    private onStatusChanged?: (isResponding: boolean) => void;
    private onStreamEvent?: (event: StreamEvent) => void;

    // 文件搜索缓存
    private fileSearchCache: { term: string; results: any[]; timestamp: number } | null = null;
    private readonly FILE_SEARCH_CACHE_TTL = 5000; // 5秒缓存
    private fileSearchCacheCleanupTimer: number | null = null;

    constructor(options: ChatControllerOptions) {
        this.app = options.app;
        this.api = options.api;
        this.onMessageAdded = options.onMessageAdded;
        this.onStatusChanged = options.onStatusChanged;
        this.onStreamEvent = options.onStreamEvent;

        // 设置定时器清理过期的文件搜索缓存
        this.fileSearchCacheCleanupTimer = window.setInterval(() => {
            this.cleanupExpiredFileSearchCache();
        }, 60000); // 每60秒检查一次
    }

    public getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    public clearHistory() {
        this.messages = [];
        this.api.clearSession();
        this.addMessage('system', 'Session cleared.');
    }

    // 清理过期的文件搜索缓存
    private cleanupExpiredFileSearchCache() {
        if (this.fileSearchCache) {
            const now = Date.now();
            if (now - this.fileSearchCache.timestamp > this.FILE_SEARCH_CACHE_TTL) {
                this.fileSearchCache = null;
                console.log('[ChatController] Cleaned up expired file search cache.');
            }
        }
    }

    // 清理资源（在组件卸载时调用）
    public cleanup() {
        // 清理文件搜索缓存定时器
        if (this.fileSearchCacheCleanupTimer !== null) {
            window.clearInterval(this.fileSearchCacheCleanupTimer);
            this.fileSearchCacheCleanupTimer = null;
        }
        // 清空缓存
        this.fileSearchCache = null;
    }

    public async processCommand(query: string, context: any[] = [], selection: string = '') {
        if (!query.trim()) return;

        // 1. Handle Commands
        if (query.startsWith('/')) {
            await this.handleSlashCommand(query);
            return;
        }

        // 2. Normal Chat
        this.addMessage('user', query);
        this.setResponding(true);

        try {
            if (this.onStreamEvent) {
                let fullText = '';
                for await (const event of this.api.chatStream(query, context, selection)) {
                    this.onStreamEvent(event);
                    if (event.type === 'done') {
                        fullText = event.text;
                    } else if (event.type === 'error') {
                        this.addMessage('system', `Error: ${event.message}`);
                        return;
                    }
                }
                // 流式模式下只记录到历史，不触发 appendMessage（UI 已通过 stream 事件渲染）
                const msg: ChatMessage = {
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                    role: 'ai',
                    content: fullText,
                    timestamp: Date.now()
                };
                this.messages.push(msg);
            } else {
                const response = await this.api.chat(query, context, selection);
                this.addMessage('ai', response);
            }
        } catch (error: any) {
            this.handleError(error);
        } finally {
            this.setResponding(false);
        }
    }

    private async handleSlashCommand(query: string) {
        const [cmd, ...args] = query.split(' ');
        const argStr = args.join(' ');

        this.addMessage('user', query);

        const skillCommands = typeof (this.api as any).getSkillCommands === 'function'
            ? (this.api as any).getSkillCommands()
            : [];
        const matchedSkillCommand = skillCommands.find((entry: any) => entry.command === cmd);

        if (matchedSkillCommand && typeof (this.api as any).executeSlashSkillCommand === 'function') {
            try {
                const result = await (this.api as any).executeSlashSkillCommand(cmd, argStr.trim());
                this.handleStructuredResult(result);
            } catch (error: any) {
                this.handleError(error);
            }
            return;
        }

        switch (cmd) {
            case '/clear':
                this.clearHistory();
                break;
            case '/profile':
                const profile = this.api.getUserProfile();
                if (profile) {
                    let text = '## User Profile\n\n';
                    if (profile.name) text += `**Name**: ${profile.name}\n`;
                    if (profile.profession) text += `**Profession**: ${profile.profession}\n`;
                    this.addMessage('system', text);
                } else {
                    this.addMessage('system', 'No profile data available.');
                }
                break;
            case '/tools':
                const tools = this.api.getAvailableTools();
                const toolsList = tools.map((t: any) => `- **${t.name}**: ${t.description}`).join('\n');
                this.addMessage('system', `## Available Tools\n\n${toolsList}`);
                break;
            case '/file-back':
                // 后台执行，不阻塞主流程
                this.runFileBackInBackground(argStr.trim());
                break;
            case '/wiki:compile':
                await this.handleWikiCompile(argStr);
                break;
            case '/wiki:index':
                (this.app as any).commands.executeCommandById('obsidian-cli:knowledge-open-index');
                break;
            case '/wiki:lint':
                (this.app as any).commands.executeCommandById('obsidian-cli:knowledge-lint');
                break;
            case '/forget':
                await this.handleForget(argStr);
                break;
            case '/new':
                await this.handleNewNote(argStr);
                break;
            case '/edit':
                await this.handleEdit(argStr);
                break;
            case '/save':
                await this.handleSave(argStr);
                break;
            case '/help':
                this.showHelp();
                break;
            case '/open':
                if (!argStr) {
                    this.addMessage('system', 'Usage: /open <filename>');
                    return;
                }
                await this.handleOpenFile(argStr);
                break;
            default:
                this.addMessage('system', `Unknown command: ${cmd}`);
        }
    }

    private formatSlashCommandResult(result: any): string {
        if (typeof result === 'string') return result;
        if (result?.message && typeof result.message === 'string') return result.message;
        return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    private handleStructuredResult(result: any) {
        if (result?.approval_required) {
            this.addApprovalMessage({
                action: result.action,
                target: result.target,
                args: result.args || {},
                message: result.message || 'Approval required.',
            });
            return;
        }

        if (result?.error) {
            this.addMessage('system', `Error: ${result.error}`);
            return;
        }

        this.addMessage('system', this.formatSlashCommandResult(result));
    }

    public async approveApproval(request: ApprovalRequest) {
        this.setResponding(true);
        try {
            const result = await (this.api as any).executeApprovedAction(request.action, request.args);
            this.handleStructuredResult(result);
        } catch (error: any) {
            this.handleError(error);
        } finally {
            this.setResponding(false);
        }
    }

    public cancelApproval(request: ApprovalRequest) {
        this.addMessage('system', `Cancelled: ${request.target}`);
    }

    private async handleOpenFile(searchTerm: string) {
        // 检查缓存
        const now = Date.now();
        if (this.fileSearchCache &&
            this.fileSearchCache.term === searchTerm &&
            now - this.fileSearchCache.timestamp < this.FILE_SEARCH_CACHE_TTL) {
            // 使用缓存结果
            const matches = this.fileSearchCache.results;
            if (matches.length === 0) {
                this.addMessage('system', `No files found matching "${searchTerm}"`);
            } else if (matches.length === 1) {
                await this.app.workspace.getLeaf(false).openFile(matches[0]);
                this.addMessage('system', `Opened [[${matches[0].path}]]`);
            } else {
                const list = matches.slice(0, 10).map(f => `- [[${f.path}]]`).join('\n');
                this.addMessage('system', `Found multiple files:\n${list}`);
            }
            return;
        }

        // 执行搜索
        const files = this.app.vault.getFiles();
        const matches = files.filter(f =>
            f.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.basename.toLowerCase().includes(searchTerm.toLowerCase())
        );

        // 缓存结果
        this.fileSearchCache = {
            term: searchTerm,
            results: matches,
            timestamp: now
        };

        if (matches.length === 0) {
            this.addMessage('system', `No files found matching "${searchTerm}"`);
        } else if (matches.length === 1) {
            await this.app.workspace.getLeaf(false).openFile(matches[0]);
            this.addMessage('system', `Opened [[${matches[0].path}]]`);
        } else {
            const list = matches.slice(0, 10).map(f => `- [[${f.path}]]`).join('\n');
            this.addMessage('system', `Found multiple files:\n${list}`);
        }
    }

    private addMessage(role: 'user' | 'ai' | 'system', content: string, approval?: ApprovalRequest) {
        const msg: ChatMessage = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            role,
            content,
            timestamp: Date.now(),
            approval,
        };
        this.messages.push(msg);
        if (this.onMessageAdded) {
            this.onMessageAdded(msg);
        }
    }

    private addApprovalMessage(request: ApprovalRequest) {
        this.addMessage('system', request.message, request);
    }

    private setResponding(status: boolean) {
        // this.isResponding = status;
        if (this.onStatusChanged) {
            this.onStatusChanged(status);
        }
    }

    private handleError(error: any) {
        logger.error('Chat error', error, 'ChatController');
        let msg = 'Unknown error occurred.';
        if (error.message) msg = error.message;
        this.addMessage('system', `Error: ${msg}`);
    }

    /**
     * 后台执行 file-back，不阻塞 UI
     * 手动模式（👍按钮）和自动模式共用
     */
    private runFileBackInBackground(msgId: string) {
        const targetMsg = this.messages.find(m => m.id === msgId && m.role === 'ai');
        if (!targetMsg) return;

        const fileBackPrompt = `用户对以下回答点赞，请将其归档到知识库。使用 file_back_knowledge 工具，提取标题和核心内容，并提取相关的 topics 主题标签。\n\n回答内容：\n${targetMsg.content}`;
        this.api.chat(fileBackPrompt, [], '').then(() => {
            this.addMessage('system', '已归档到知识库。');
        }).catch((error: any) => {
            logger.error('File-back failed', error, 'ChatController');
        });
    }

    /**
     * 自动 file-back 已移除：改为 AI 在 query_knowledge 流程中自主判断是否调用 file_back_knowledge
     * 手动模式保留：用户点赞（👍）时通过 /file-back 命令触发
     */

    /**
     * /wiki:compile [path] — 编译笔记到知识 wiki
     * 无参数：编译当前笔记 + 所有 pending
     * 文件路径：编译指定文件
     * 目录路径：扫描目录下所有 .md 注册并编译
     */
    private async handleForget(field: string) {
        const f = field.trim().toLowerCase();
        if (!f) {
            this.addMessage('system', '用法: `/forget <field>` 或 `/forget all`\n\n可遗忘字段: name, profession, expertise, preferences, workflows, projects, goals, all');
            return;
        }

        const profile = this.api.getUserProfile();
        if (!profile) {
            this.addMessage('system', '暂无用户记忆数据。');
            return;
        }

        if (f === 'all') {
            await this.api.updateProfile({
                name: '', profession: '', expertise: [],
                preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
                workflows: [],
                context: { currentProjects: [], goals: [], challenges: [] }
            });
            this.addMessage('system', '已清除所有用户记忆。');
        } else if (f === 'name') {
            await this.api.updateProfile({ name: '' });
            this.addMessage('system', '已遗忘: name');
        } else if (f === 'profession') {
            await this.api.updateProfile({ profession: '' });
            this.addMessage('system', '已遗忘: profession');
        } else if (f === 'expertise') {
            await this.api.updateProfile({ expertise: [] });
            this.addMessage('system', '已遗忘: expertise');
        } else if (f === 'preferences') {
            await this.api.updateProfile({ preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] } });
            this.addMessage('system', '已遗忘: preferences');
        } else if (f === 'workflows') {
            await this.api.updateProfile({ workflows: [] });
            this.addMessage('system', '已遗忘: workflows');
        } else if (f === 'projects') {
            await this.api.updateProfile({ context: { ...profile.context, currentProjects: [] } });
            this.addMessage('system', '已遗忘: projects');
        } else if (f === 'goals') {
            await this.api.updateProfile({ context: { ...profile.context, goals: [] } });
            this.addMessage('system', '已遗忘: goals');
        } else {
            this.addMessage('system', `未知字段: ${f}\n可遗忘字段: name, profession, expertise, preferences, workflows, projects, goals, all`);
        }
    }

    private async handleNewNote(argStr: string) {
        if (!argStr.trim()) {
            this.addMessage('system', '用法: `/new <title>` 或 `/new <title> <content>`');
            return;
        }
        const firstNewline = argStr.indexOf('\n');
        const title = firstNewline > 0 ? argStr.substring(0, firstNewline).trim() : argStr.trim();
        const content = firstNewline > 0 ? argStr.substring(firstNewline + 1) : '';
        const path = `${title}.md`;

        try {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing) {
                this.addMessage('system', `文件已存在: ${path}`);
                return;
            }
            const file = await this.app.vault.create(path, content);
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            this.addMessage('system', `已创建并打开: [[${path}]]`);
        } catch (e: any) {
            this.addMessage('system', `创建失败: ${e.message}`);
        }
    }

    private async handleEdit(instruction: string) {
        if (!instruction.trim()) {
            this.addMessage('system', '用法: 先在编辑器中选中文本，然后 `/edit <指令>`\n例: `/edit 翻译成英文`');
            return;
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = activeView?.editor;
        const selection = editor?.getSelection();

        if (!selection) {
            this.addMessage('system', '请先在编辑器中选中要编辑的文本。');
            return;
        }

        this.setResponding(true);
        try {
            const prompt = `请根据以下指令修改文本，只返回修改后的文本，不要解释。\n\n指令: ${instruction}\n\n原文:\n${selection}`;
            const result = await this.api.chat(prompt, [], selection);
            this.addMessage('ai', result);
        } catch (e: any) {
            this.addMessage('system', `编辑失败: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }

    private async handleSave(url: string) {
        if (!url.trim()) {
            this.addMessage('system', '用法: `/save <url>`\n支持: 网页、YouTube、Bilibili、微信公众号');
            return;
        }
        this.setResponding(true);
        try {
            const prompt = `请使用 save_webpage 工具保存这个链接: ${url.trim()}`;
            const result = await this.api.chat(prompt, [], '');
            this.addMessage('ai', result);
        } catch (e: any) {
            this.addMessage('system', `保存失败: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }

    private showHelp() {
        const help = `## Shell Commands

| 命令 | 说明 |
|------|------|
| \`/clear\` | 清除会话历史 |
| \`/profile\` | 查看用户画像 |
| \`/forget [field]\` | 遗忘用户记忆 (name/profession/expertise/preferences/workflows/projects/goals/all) |
| \`/new <title>\` | 创建新笔记 |
| \`/edit <指令>\` | AI 编辑选中文本 |
| \`/open <file>\` | 打开文件 |
| \`/save <url>\` | 保存网页/视频到 vault |
| \`/tools\` | 列出可用工具 |
| \`/wiki:compile [path]\` | 编译笔记到知识 wiki |
| \`/wiki:index\` | 打开知识索引 |
| \`/wiki:lint\` | 知识库健康检查 |
| \`/help\` | 显示本帮助 |

**提示**: 输入 \`/\` 查看命令自动补全，输入 \`@\` 引用文件。`;
        this.addMessage('system', help);
    }

    private async handleWikiCompile(pathArg: string) {
        const path = pathArg.trim();
        const plugin = (this.app as any).plugins?.plugins?.['obsidian-cli'];
        const runtime = plugin?.knowledgeRuntime;

        if (!runtime) {
            this.addMessage('system', 'Knowledge 系统未初始化。');
            return;
        }

        this.setResponding(true);
        try {
            if (!path) {
                // 无参数：编译当前笔记 + 所有 pending
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.addMessage('system', `编译: ${activeFile.path}...`);
                    const r = await runtime.compileByPath(activeFile.path);
                    this.addMessage('system', `完成: 注册 ${r.registered}，成功 ${r.success}，失败 ${r.failed}`);
                }
                // 再编译所有 pending，带进度回调避免 heartbeat 误报
                const maxBatch = runtime.settings.knowledgeMaxCompileBatch || 50;
                const result = await runtime.compiler.compileAllPending(maxBatch, (current: number, total: number, noteId: string) => {
                    this.addMessage('system', `[${current}/${total}] 编译: ${noteId}`);
                });
                if (result.success > 0) {
                    await runtime.indexer.rebuildIndex();
                }
                this.addMessage('system', `批量编译完成: ${result.success} 成功, ${result.failed} 失败`);
            } else {
                this.addMessage('system', `编译: ${path}...`);
                const r = await runtime.compileByPath(path);
                this.addMessage('system', `完成: 注册 ${r.registered}，成功 ${r.success}，失败 ${r.failed}`);
            }
        } catch (e: any) {
            this.addMessage('system', `编译失败: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }
}
