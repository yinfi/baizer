import { App, MarkdownView } from 'obsidian';
import { ModelService } from '../services/model-service';
import { StreamEvent } from '../models/interfaces';
import { logger } from '../utils/logger';
import {
    buildFileWriteFailureMessage,
    getFileWriteError,
    getFileWriteResultPath,
    isFileWriteRequest,
    isFileWriteToolName,
    isSuccessfulWriteToolResult,
} from '../utils/file-operation-contract';
import { ApprovalRequest } from './approval-card';
import { ChatMessage } from './types';

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
    private activeStreamController: AbortController | null = null;

    // 鏂囦欢鎼滅储缂撳瓨
    private fileSearchCache: { term: string; results: any[]; timestamp: number } | null = null;
    private readonly FILE_SEARCH_CACHE_TTL = 5000; // 5绉掔紦瀛?
    private fileSearchCacheCleanupTimer: number | null = null;

    constructor(options: ChatControllerOptions) {
        this.app = options.app;
        this.api = options.api;
        this.onMessageAdded = options.onMessageAdded;
        this.onStatusChanged = options.onStatusChanged;
        this.onStreamEvent = options.onStreamEvent;

        // 璁剧疆瀹氭椂鍣ㄦ竻鐞嗚繃鏈熺殑鏂囦欢鎼滅储缂撳瓨
        this.fileSearchCacheCleanupTimer = window.setInterval(() => {
            this.cleanupExpiredFileSearchCache();
        }, 60000); // 姣?0绉掓鏌ヤ竴娆?
    }

    public getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    public clearHistory() {
        this.messages = [];
        this.api.clearSession();
        this.addMessage('system', 'Session cleared.');
    }

    // 娓呯悊杩囨湡鐨勬枃浠舵悳绱㈢紦瀛?
    private cleanupExpiredFileSearchCache() {
        if (this.fileSearchCache) {
            const now = Date.now();
            if (now - this.fileSearchCache.timestamp > this.FILE_SEARCH_CACHE_TTL) {
                this.fileSearchCache = null;
                console.log('[ChatController] Cleaned up expired file search cache.');
            }
        }
    }

    // 娓呯悊璧勬簮锛堝湪缁勪欢鍗歌浇鏃惰皟鐢級
    public cleanup() {
        this.activeStreamController?.abort();
        this.activeStreamController = null;
        // 娓呯悊鏂囦欢鎼滅储缂撳瓨瀹氭椂鍣?
        if (this.fileSearchCacheCleanupTimer !== null) {
            window.clearInterval(this.fileSearchCacheCleanupTimer);
            this.fileSearchCacheCleanupTimer = null;
        }
        // 娓呯┖缂撳瓨
        this.fileSearchCache = null;
    }

    public async processCommand(query: string, context: any[] | string = [], selection: string = '') {
        if (!query.trim()) return;
        const normalizedContext = this.normalizeContextItems(context);

        // 1. Handle Commands
        if (query.startsWith('/')) {
            await this.handleSlashCommand(query);
            return;
        }

        // 2. Normal Chat
        this.addMessage('user', query);
        this.setResponding(true);
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        let fullText = '';
        let sawDone = false;

        try {
            if (this.onStreamEvent) {
                const isWriteRequest = this.isFileWriteRequest(query);
                let approvalRequest: ApprovalRequest | null = null;
                let attemptedFileWrite = false;
                let successfulFileWrite = false;
                let lastWriteError = '';
                const writeToolArgs = new Map<string, any[]>();
                const bufferedTextEvents: StreamEvent[] = [];
                for await (const event of this.api.chatStream(query, normalizedContext, selection, streamController.signal)) {
                    if (event.type === 'tool_call' && this.isFileWriteTool(event.name)) {
                        attemptedFileWrite = true;
                        const calls = writeToolArgs.get(event.name) || [];
                        calls.push(event.args || {});
                        writeToolArgs.set(event.name, calls);
                    }

                    if (event.type === 'tool_result') {
                        const args = this.shiftToolArgs(writeToolArgs, event.name);
                        if (this.isFileWriteTool(event.name)) {
                            attemptedFileWrite = true;
                            if (this.isSuccessfulToolResult(event.result)) {
                                successfulFileWrite = true;
                            } else {
                                const error = this.getWriteToolError(event.result);
                                if (error) lastWriteError = error;
                            }
                        }
                        const nextApproval = this.toApprovalRequest(event.result);
                        if (nextApproval) {
                            approvalRequest = nextApproval;
                            this.addApprovalMessage(nextApproval);
                        } else if (this.isFileWriteTool(event.name)) {
                            await this.openFileFromToolResult(event.name, event.result, args);
                            if (successfulFileWrite && bufferedTextEvents.length > 0) {
                                for (const bufferedEvent of bufferedTextEvents) {
                                    this.onStreamEvent(bufferedEvent);
                                }
                                bufferedTextEvents.length = 0;
                            }
                        }
                    }

                    if (event.type === 'text_delta') {
                        if (approvalRequest || (isWriteRequest && !successfulFileWrite)) {
                            bufferedTextEvents.push(event);
                        } else {
                            this.onStreamEvent(event);
                        }
                    } else if (event.type === 'done') {
                        if (approvalRequest || (isWriteRequest && !successfulFileWrite)) {
                            this.onStreamEvent({ ...event, text: '' });
                        } else {
                            this.onStreamEvent(event);
                        }
                    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
                        this.onStreamEvent(event);
                    } else if (event.type === 'error') {
                        this.onStreamEvent(event);
                    }

                    if (event.type === 'done') {
                        sawDone = true;
                        fullText = approvalRequest ? '' : event.text;
                    } else if (event.type === 'error') {
                        this.addMessage('system', `Error: ${event.message}`);
                        return;
                    } else if (event.type === 'text_delta') {
                        fullText += event.content;
                    }
                }
                // 娴佸紡妯″紡涓嬪彧璁板綍鍒板巻鍙诧紝涓嶈Е鍙?appendMessage锛圲I 宸查€氳繃 stream 浜嬩欢娓叉煋锛?
                if (!approvalRequest) {
                    if (isWriteRequest && !successfulFileWrite) {
                        this.addMessage(
                            'system',
                            this.getFileWriteFailureMessage(attemptedFileWrite, lastWriteError)
                        );
                    } else {
                        if (sawDone || fullText) {
                            const msg: ChatMessage = {
                                id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                                role: 'ai',
                                content: fullText,
                                timestamp: Date.now(),
                                metadata: sawDone ? undefined : { interrupted: true }
                            };
                            this.messages.push(msg);
                        }
                    }
                }
            } else {
                const response = await this.api.chat(query, normalizedContext, selection);
                this.addMessage('ai', response);
            }
        } catch (error: any) {
            if (this.isAbortError(error)) {
                this.onStreamEvent?.({ type: 'done', text: fullText, interrupted: true });
                this.addMessage('system', 'Response stopped.');
                return;
            }
            this.handleError(error);
        } finally {
            if (this.activeStreamController === streamController) {
                this.activeStreamController = null;
            }
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
                // 鍚庡彴鎵ц锛屼笉闃诲涓绘祦绋?
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

    private toApprovalRequest(result: any): ApprovalRequest | null {
        if (!result?.approval_required) return null;
        return {
            action: result.action,
            target: result.target,
            args: result.args || {},
            message: result.message || 'Approval required.',
        };
    }

    private handleStructuredResult(result: any, action?: string, args: Record<string, any> = {}) {
        const approvalRequest = this.toApprovalRequest(result);
        if (approvalRequest) {
            this.addApprovalMessage(approvalRequest);
            return;
        }

        if (result?.error) {
            this.addMessage('system', `Error: ${result.error}`);
            return;
        }

        void this.openFileFromToolResult(action || '', result, args);
        this.addMessage('system', this.formatSlashCommandResult(result));
    }

    public async approveApproval(request: ApprovalRequest) {
        this.setResponding(true);
        try {
            const result = await (this.api as any).executeApprovedAction(request.action, request.args);
            this.handleStructuredResult(result, request.action, request.args);
        } catch (error: any) {
            this.handleError(error);
        } finally {
            this.setResponding(false);
        }
    }

    public cancelApproval(request: ApprovalRequest) {
        this.addMessage('system', `Cancelled: ${request.target}`);
    }

    public cancelActiveStream(): boolean {
        if (!this.activeStreamController || this.activeStreamController.signal.aborted) {
            return false;
        }

        this.activeStreamController.abort();
        return true;
    }

    private async handleOpenFile(searchTerm: string) {
        // 妫€鏌ョ紦瀛?
        const now = Date.now();
        if (this.fileSearchCache &&
            this.fileSearchCache.term === searchTerm &&
            now - this.fileSearchCache.timestamp < this.FILE_SEARCH_CACHE_TTL) {
            // 浣跨敤缂撳瓨缁撴灉
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

        // 鎵ц鎼滅储
        const files = this.app.vault.getFiles();
        const matches = files.filter(f =>
            f.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.basename.toLowerCase().includes(searchTerm.toLowerCase())
        );

        // 缂撳瓨缁撴灉
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

    private isFileWriteRequest(message: string): boolean {
        return isFileWriteRequest(message);
    }

    private isFileWriteTool(name: string): boolean {
        return isFileWriteToolName(name);
    }

    private shiftToolArgs(toolArgs: Map<string, any[]>, name: string): any {
        const calls = toolArgs.get(name);
        if (!calls || calls.length === 0) return {};
        const args = calls.shift() || {};
        if (calls.length === 0) toolArgs.delete(name);
        return args;
    }

    private isSuccessfulToolResult(result: any): boolean {
        return isSuccessfulWriteToolResult(result);
    }

    private getResultPath(action: string, result: any, args: Record<string, any>): string {
        return getFileWriteResultPath(action, result, args);
    }

    private getWriteToolError(result: any): string {
        return getFileWriteError(result);
    }

    private getFileWriteFailureMessage(attemptedWrite: boolean, lastError?: string): string {
        return buildFileWriteFailureMessage(attemptedWrite, lastError);
    }

    private async openFileFromToolResult(action: string, result: any, args: Record<string, any> = {}) {
        if (!this.isSuccessfulToolResult(result)) return;
        const path = this.getResultPath(action, result, args);
        if (!path) return;

        try {
            const file = this.app.vault?.getAbstractFileByPath?.(path);
            if (!file) return;
            await this.app.workspace?.getLeaf?.(false)?.openFile?.(file);
        } catch (error) {
            logger.warn(`Unable to open file after write: ${path}`, 'ChatController.openFileFromToolResult', error);
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

    private isAbortError(error: any): boolean {
        return error?.name === 'AbortError';
    }

    private normalizeContextItems(context: any[] | string): any[] {
        if (Array.isArray(context)) {
            return context;
        }

        const text = typeof context === 'string' ? context.trim() : '';
        if (!text) {
            return [];
        }

        return [{
            id: 'legacy-selection-context',
            type: 'selection',
            data: 'Editor selection',
            summary: 'Editor selection',
            content: text,
        }];
    }

    /**
     * 鍚庡彴鎵ц file-back锛屼笉闃诲 UI
     * 鎵嬪姩妯″紡锛堭煈嶆寜閽級鍜岃嚜鍔ㄦā寮忓叡鐢?
     */
    private runFileBackInBackground(msgId: string) {
        const targetMsg = this.messages.find(m => m.id === msgId && m.role === 'ai');
        if (!targetMsg) return;

        const fileBackPrompt = `鐢ㄦ埛瀵逛互涓嬪洖绛旂偣璧烇紝璇峰皢鍏跺綊妗ｅ埌鐭ヨ瘑搴撱€備娇鐢?file_back_knowledge 宸ュ叿锛屾彁鍙栨爣棰樺拰鏍稿績鍐呭锛屽苟鎻愬彇鐩稿叧鐨?topics 涓婚鏍囩銆俓n\n鍥炵瓟鍐呭锛歕n${targetMsg.content}`;
        this.api.chat(fileBackPrompt, [], '').then(() => {
            this.addMessage('system', 'Archived to the knowledge wiki.');
        }).catch((error: any) => {
            logger.error('File-back failed', error, 'ChatController');
        });
    }

    /**
     * 鑷姩 file-back 宸茬Щ闄わ細鏀逛负 AI 鍦?query_knowledge 娴佺▼涓嚜涓诲垽鏂槸鍚﹁皟鐢?file_back_knowledge
     * 鎵嬪姩妯″紡淇濈暀锛氱敤鎴风偣璧烇紙馃憤锛夋椂閫氳繃 /file-back 鍛戒护瑙﹀彂
     */

    /**
     * /wiki:compile [path] 鈥?缂栬瘧绗旇鍒扮煡璇?wiki
     * 鏃犲弬鏁帮細缂栬瘧褰撳墠绗旇 + 鎵€鏈?pending
     * 鏂囦欢璺緞锛氱紪璇戞寚瀹氭枃浠?
     * 鐩綍璺緞锛氭壂鎻忕洰褰曚笅鎵€鏈?.md 娉ㄥ唽骞剁紪璇?
     */
    private async handleForget(field: string) {
        const f = field.trim().toLowerCase();
        if (!f) {
            this.addMessage('system', '鐢ㄦ硶: `/forget <field>` 鎴?`/forget all`\n\n鍙仐蹇樺瓧娈? name, profession, expertise, preferences, workflows, projects, goals, all');
            return;
        }

        const profile = this.api.getUserProfile();
        if (!profile) {
            this.addMessage('system', 'No user memory data available.');
            return;
        }

        if (f === 'all') {
            await this.api.updateProfile({
                name: '', profession: '', expertise: [],
                preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
                workflows: [],
                context: { currentProjects: [], goals: [], challenges: [] }
            });
            this.addMessage('system', 'Cleared all remembered user data.');
        } else if (f === 'name') {
            await this.api.updateProfile({ name: '' });
            this.addMessage('system', '宸查仐蹇? name');
        } else if (f === 'profession') {
            await this.api.updateProfile({ profession: '' });
            this.addMessage('system', '宸查仐蹇? profession');
        } else if (f === 'expertise') {
            await this.api.updateProfile({ expertise: [] });
            this.addMessage('system', '宸查仐蹇? expertise');
        } else if (f === 'preferences') {
            await this.api.updateProfile({ preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] } });
            this.addMessage('system', '宸查仐蹇? preferences');
        } else if (f === 'workflows') {
            await this.api.updateProfile({ workflows: [] });
            this.addMessage('system', '宸查仐蹇? workflows');
        } else if (f === 'projects') {
            await this.api.updateProfile({ context: { ...profile.context, currentProjects: [] } });
            this.addMessage('system', '宸查仐蹇? projects');
        } else if (f === 'goals') {
            await this.api.updateProfile({ context: { ...profile.context, goals: [] } });
            this.addMessage('system', '宸查仐蹇? goals');
        } else {
            this.addMessage('system', `鏈煡瀛楁: ${f}\n鍙仐蹇樺瓧娈? name, profession, expertise, preferences, workflows, projects, goals, all`);
        }
    }

    private async handleNewNote(argStr: string) {
        if (!argStr.trim()) {
            this.addMessage('system', '鐢ㄦ硶: `/new <title>` 鎴?`/new <title> <content>`');
            return;
        }
        const firstNewline = argStr.indexOf('\n');
        const title = firstNewline > 0 ? argStr.substring(0, firstNewline).trim() : argStr.trim();
        const content = firstNewline > 0 ? argStr.substring(firstNewline + 1) : '';
        const path = `${title}.md`;

        try {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing) {
                this.addMessage('system', `鏂囦欢宸插瓨鍦? ${path}`);
                return;
            }
            const file = await this.app.vault.create(path, content);
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            this.addMessage('system', `宸插垱寤哄苟鎵撳紑: [[${path}]]`);
        } catch (e: any) {
            this.addMessage('system', `鍒涘缓澶辫触: ${e.message}`);
        }
    }

    private async handleEdit(instruction: string) {
        if (!instruction.trim()) {
            this.addMessage('system', 'Usage: select some text first, then run `/edit <instruction>`.\nExample: `/edit translate to English`');
            return;
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = activeView?.editor;
        const selection = editor?.getSelection();

        if (!selection) {
            this.addMessage('system', 'Please select the text you want to edit first.');
            return;
        }

        this.setResponding(true);
        try {
            const prompt = `璇锋牴鎹互涓嬫寚浠や慨鏀规枃鏈紝鍙繑鍥炰慨鏀瑰悗鐨勬枃鏈紝涓嶈瑙ｉ噴銆俓n\n鎸囦护: ${instruction}\n\n鍘熸枃:\n${selection}`;
            const result = await this.api.chat(prompt, [], selection);
            this.addMessage('ai', result);
        } catch (e: any) {
            this.addMessage('system', `缂栬緫澶辫触: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }

    private async handleSave(url: string) {
        if (!url.trim()) {
            this.addMessage('system', '鐢ㄦ硶: `/save <url>`\n鏀寔: 缃戦〉銆乊ouTube銆丅ilibili銆佸井淇″叕浼楀彿');
            return;
        }
        this.setResponding(true);
        try {
            const prompt = `璇蜂娇鐢?save_webpage 宸ュ叿淇濆瓨杩欎釜閾炬帴: ${url.trim()}`;
            const result = await this.api.chat(prompt, [], '');
            this.addMessage('ai', result);
        } catch (e: any) {
            this.addMessage('system', `淇濆瓨澶辫触: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }

    private showHelp() {
        const localCommands = [
            { command: '/clear', description: 'Clear session history' },
            { command: '/profile', description: 'View user profile' },
            { command: '/file-back <message-id>', description: 'Archive a previous AI answer to the knowledge wiki' },
            { command: '/forget [field]', description: 'Forget user memory (name/profession/expertise/preferences/workflows/projects/goals/all)' },
            { command: '/new <title>', description: 'Create a new note' },
            { command: '/edit <instruction>', description: 'AI edit the selected text' },
            { command: '/open <file>', description: 'Open a file' },
            { command: '/tools', description: 'List available MCP tools' },
            { command: '/wiki:compile [path]', description: 'Compile notes into the knowledge wiki' },
            { command: '/wiki:index', description: 'Open the knowledge wiki index' },
            { command: '/wiki:lint', description: 'Run the knowledge wiki health check' },
            { command: '/help', description: 'Show this help message' },
        ];
        const skillCommands = typeof (this.api as any).getSkillCommands === 'function'
            ? (this.api as any).getSkillCommands()
            : [];

        let help = `## Shell Commands\n\n`;
        help += localCommands
            .map((entry) => `- \`${entry.command}\` 鈥?${entry.description}`)
            .join('\n');

        if (skillCommands.length > 0) {
            help += `\n\n## Skill Commands\n\n`;
            help += skillCommands
                .map((entry: any) => `- \`${entry.command}\` 鈥?${entry.description}`)
                .join('\n');
        }

        help += `\n\nType \`/\` to browse commands and \`@\` to mention files.`;
        this.addMessage('system', help);
    }

    private showLegacyHelp() {
        const help = `## Shell Commands

| Command | Description |
|------|------|
| \`/clear\` | Clear session history |
| \`/profile\` | View the user profile |
| \`/forget [field]\` | Forget saved user memory |
| \`/new <title>\` | Create a new note |
| \`/edit <instruction>\` | AI edit the selected text |
| \`/open <file>\` | Open a file |
| \`/save <url>\` | Save a webpage or video into the vault |
| \`/tools\` | List available tools |
| \`/wiki:compile [path]\` | Compile notes into the knowledge wiki |
| \`/wiki:index\` | Open the knowledge wiki index |
| \`/wiki:lint\` | Run the knowledge wiki health check |
| \`/help\` | Show this help |

**Tip**: Type \`/\` for command suggestions and \`@\` to mention files.`;
        this.addMessage('system', help);
    }

    private async handleWikiCompile(pathArg: string) {
        const path = pathArg.trim();
        const plugin = (this.app as any).plugins?.plugins?.['obsidian-cli'];
        const runtime = plugin?.knowledgeRuntime;

        if (!runtime) {
            this.addMessage('system', 'Knowledge system is not initialized.');
            return;
        }

        this.setResponding(true);
        try {
            if (!path) {
                // 鏃犲弬鏁帮細缂栬瘧褰撳墠绗旇 + 鎵€鏈?pending
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.addMessage('system', `缂栬瘧: ${activeFile.path}...`);
                    const r = await runtime.compileByPath(activeFile.path);
                    this.addMessage('system', `瀹屾垚: 娉ㄥ唽 ${r.registered}锛屾垚鍔?${r.success}锛屽け璐?${r.failed}`);
                }
                // 鍐嶇紪璇戞墍鏈?pending锛屽甫杩涘害鍥炶皟閬垮厤 heartbeat 璇姤
                const maxBatch = runtime.settings.knowledgeMaxCompileBatch || 50;
                const result = await runtime.compiler.compileAllPending(maxBatch, (current: number, total: number, noteId: string) => {
                    this.addMessage('system', `[${current}/${total}] 缂栬瘧: ${noteId}`);
                });
                if (result.success > 0) {
                    await runtime.indexer.rebuildIndex();
                }
                this.addMessage('system', `鎵归噺缂栬瘧瀹屾垚: ${result.success} 鎴愬姛, ${result.failed} 澶辫触`);
            } else {
                this.addMessage('system', `缂栬瘧: ${path}...`);
                const r = await runtime.compileByPath(path);
                this.addMessage('system', `瀹屾垚: 娉ㄥ唽 ${r.registered}锛屾垚鍔?${r.success}锛屽け璐?${r.failed}`);
            }
        } catch (e: any) {
            this.addMessage('system', `缂栬瘧澶辫触: ${e.message}`);
        } finally {
            this.setResponding(false);
        }
    }
}

