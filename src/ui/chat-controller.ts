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
import { buildSelectionPreview } from './diff/change-preview';
import { ChatMessage } from './types';
import { WorkspaceEditSummary } from '../services/workspace-edit-service';
import { PLUGIN_ID } from '../mcp/types';

export interface ChatControllerOptions {
    app: App;
    api: ModelService;
    /**
     * 会话标识(= UI tab.id),用于 per-conversation session 隔离。
     * 传下给 ModelService.chat/chatStream/clearSession,使不同 tab 的跨轮上下文互不可见。
     * 缺省时退化为无持久会话(每轮内存临时会话)。
     */
    conversationId?: string;
    onMessageAdded?: (message: ChatMessage) => void;
    onStatusChanged?: (isResponding: boolean) => void;
    onStreamEvent?: (event: StreamEvent) => void;
    /** /clear 时触发:宿主清空该 tab 的可见历史(tab.state)并重渲。 */
    onClear?: () => void;
    onWorkspaceEdit?: (edit: WorkspaceEditSummary) => void;
    onWorkspaceEditUndone?: (edit: WorkspaceEditSummary) => void;
    onWorkspaceEditUndoFailed?: (message: string) => void;
}

export class ChatController {
    private app: App;
    private api: ModelService;
    private readonly conversationId?: string;
    private messages: ChatMessage[] = [];
    // private isResponding: boolean = false; // Unused
    private onMessageAdded?: (message: ChatMessage) => void;
    private onStatusChanged?: (isResponding: boolean) => void;
    private onStreamEvent?: (event: StreamEvent) => void;
    private onClear?: () => void;
    private onWorkspaceEdit?: (edit: WorkspaceEditSummary) => void;
    private onWorkspaceEditUndone?: (edit: WorkspaceEditSummary) => void;
    private onWorkspaceEditUndoFailed?: (message: string) => void;
    private activeStreamController: AbortController | null = null;

    // 鏂囦欢鎼滅储缂撳瓨
    private fileSearchCache: { term: string; results: any[]; timestamp: number } | null = null;
    private readonly FILE_SEARCH_CACHE_TTL = 5000; // 5绉掔紦瀛?
    private fileSearchCacheCleanupTimer: number | null = null;

    constructor(options: ChatControllerOptions) {
        this.app = options.app;
        this.api = options.api;
        this.conversationId = options.conversationId;
        this.onMessageAdded = options.onMessageAdded;
        this.onStatusChanged = options.onStatusChanged;
        this.onStreamEvent = options.onStreamEvent;
        this.onClear = options.onClear;
        this.onWorkspaceEdit = options.onWorkspaceEdit;
        this.onWorkspaceEditUndone = options.onWorkspaceEditUndone;
        this.onWorkspaceEditUndoFailed = options.onWorkspaceEditUndoFailed;

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
        void this.api.clearSession(this.conversationId);
        // 先让宿主清空该 tab 的可见历史(tab.state)并重渲,再追加「已清空」提示,
        // 否则 tab.state 里的旧消息仍会留在屏幕上(/clear 不清屏的根因)。
        this.onClear?.();
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

    public async processCommand(
        query: string,
        context: any[] | string = [],
        selection: string = '',
        source: 'shell' | 'selection-menu' = 'shell',
    ) {
        if (!query.trim()) return;
        const normalizedContext = this.normalizeContextItems(context);

        // 1. Handle Commands
        if (query.startsWith('/')) {
            await this.handleSlashCommand(query);
            return;
        }

        // 2. Normal Chat
        this.addMessage('user', query);
        // 阶段B:记住本轮 user 消息 id,done 事件带回 entryIds 后回填 sessionEntryId 锚定。
        const userMessageId = this.messages[this.messages.length - 1]?.id;
        this.setResponding(true);
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        let fullText = '';
        let sawDone = false;
        let turnEntryIds: { userEntryId?: string; assistantEntryId?: string } | undefined;

        try {
            if (this.onStreamEvent) {
                const isWriteRequest = this.isFileWriteRequest(query);
                let approvalRequest: ApprovalRequest | null = null;
                let attemptedFileWrite = false;
                let successfulFileWrite = false;
                let lastWriteError = '';
                const writeToolArgs = new Map<string, any[]>();
                const bufferedTextEvents: StreamEvent[] = [];
                // 阶段1:跨轮上下文由 Harness session 维护,UI 不再回灌 priorMessages。
                const stream = source === 'shell'
                    ? this.api.chatStream(query, normalizedContext, selection, 'shell', undefined, undefined, streamController.signal, this.conversationId)
                    : this.api.chatStream(query, normalizedContext, selection, source, undefined, undefined, streamController.signal, this.conversationId);
                for await (const event of stream) {
                    if (event.type === 'tool_call' && this.isFileWriteTool(event.name)) {
                        attemptedFileWrite = true;
                        const calls = writeToolArgs.get(event.name) || [];
                        calls.push(event.args || {});
                        writeToolArgs.set(event.name, calls);
                    }

                    if (event.type === 'tool_result') {
                        const args = this.shiftToolArgs(writeToolArgs, event.name);
                        this.handleWorkspaceEditResult(event.result);
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
                            if (!event.result?.workspaceEdit) {
                                await this.openFileFromToolResult(event.name, event.result, args);
                            }
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
                    } else if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'step_boundary') {
                        this.onStreamEvent(event);
                    } else if (event.type === 'error') {
                        this.onStreamEvent(event);
                    }

                    if (event.type === 'done') {
                        sawDone = true;
                        fullText = approvalRequest ? '' : event.text;
                        turnEntryIds = event.entryIds;
                        // 回填 user 消息的 entry 锚定(ai 消息在下方创建时一并打)。
                        if (turnEntryIds?.userEntryId && userMessageId) {
                            const userMsg = this.messages.find(m => m.id === userMessageId);
                            if (userMsg) userMsg.sessionEntryId = turnEntryIds.userEntryId;
                        }
                    } else if (event.type === 'error') {
                        this.addMessage('system', `Error: ${event.message}`);
                        return;
                    } else if (event.type === 'text_delta') {
                        fullText += event.content;
                    } else if (event.type === 'tool_call') {
                        // 与底层 runtime 对齐:工具调用前的正文是该步过程叙述,
                        // 不属于最终答案。重置 abort 兜底用的 fullText,使中断时
                        // 回填的也是「末轮回复」而非夹带叙述。
                        fullText = '';
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
                                sessionEntryId: turnEntryIds?.assistantEntryId,
                                metadata: sawDone ? undefined : { interrupted: true }
                            };
                            this.messages.push(msg);
                        }
                    }
                }
            } else {
                // 阶段1:跨轮上下文由 Harness session 维护,UI 不再回灌 priorMessages。
                const response = source === 'shell'
                    ? await this.api.chat(query, normalizedContext, selection, 'shell', undefined, undefined, undefined, this.conversationId)
                    : await this.api.chat(query, normalizedContext, selection, source, undefined, undefined, undefined, this.conversationId);
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
            case '/memory':
                await this.handleMemory(argStr);
                break;
            case '/profile':
                await this.handleMemory(argStr || 'overview', '/profile');
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
                (this.app as any).commands.executeCommandById(`${PLUGIN_ID}:knowledge-open-index`);
                break;
            case '/wiki:lint':
                (this.app as any).commands.executeCommandById(`${PLUGIN_ID}:knowledge-lint`);
                break;
            case '/forget':
                await this.handleForget(argStr, '/forget');
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
                await this.handleUserCommandOrUnknown(cmd, argStr);
        }
    }

    /**
     * 内置命令未命中时,尝试用户自定义命令(.obsidian/baizer-commands/*.md)。
     * 命中则把模板展开成 prompt 当作普通对话轮执行;未命中才报「未知命令」。
     * 内置命令优先(本方法只在 switch 落到 default 时才调),满足冲突时内置优先的约定。
     */
    private async handleUserCommandOrUnknown(cmd: string, argStr: string) {
        const execUser = (this.api as any).executeUserCommand;
        if (typeof execUser === 'function') {
            this.setResponding(true);
            try {
                const result = await execUser.call(this.api, cmd, argStr.trim());
                if (result?.handled) {
                    this.addMessage('ai', result.message ?? '');
                    return;
                }
            } catch (error: any) {
                this.handleError(error);
                return;
            } finally {
                this.setResponding(false);
            }
        }
        this.addMessage('system', `Unknown command: ${cmd}`);
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
            preview: result.preview,
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

    /**
     * 运行中补话：长任务正在跑（有 activeStream）时，把用户补充指令排队，
     * 不打断当前流，由正在运行的 agentLoop 在下一轮纳入。
     * 同时把这条补话渲染为一条用户消息，保持对话可见性。
     * @returns 是否成功排队（无活动流或 API 不支持时返回 false）。
     */
    public steerActiveRun(text: string): boolean {
        const trimmed = text?.trim();
        if (!trimmed) return false;
        if (!this.activeStreamController || this.activeStreamController.signal.aborted) {
            return false;
        }
        const steer = (this.api as any).steerActiveRun;
        if (typeof steer !== 'function') return false;

        steer.call(this.api, trimmed);
        this.addMessage('user', trimmed);
        return true;
    }

    /** 是否正在运行一个可被补话的流。供 UI 决定补话入口的可用态。 */
    public isRunActive(): boolean {
        return !!this.activeStreamController && !this.activeStreamController.signal.aborted;
    }

    public async undoWorkspaceEdit(editId: string): Promise<any> {
        const undo = (this.api as any).undoWorkspaceEdit;
        if (typeof undo !== 'function') {
            const message = 'Workspace edit undo is not available.';
            this.onWorkspaceEditUndoFailed?.(message);
            return { success: false, error: message };
        }

        try {
            const result = await undo.call(this.api, editId);
            if (result?.success && result?.edit) {
                this.onWorkspaceEditUndone?.(result.edit);
            } else {
                this.onWorkspaceEditUndoFailed?.(result?.error || 'Unable to undo workspace edit.');
            }
            return result;
        } catch (error: any) {
            const message = error?.message || 'Unable to undo workspace edit.';
            this.onWorkspaceEditUndoFailed?.(message);
            return { success: false, error: message };
        }
    }

    public async undoAllWorkspaceEdits(editIds?: string[]): Promise<any[]> {
        if (editIds?.length) {
            const results: any[] = [];
            for (const editId of editIds) {
                results.push(await this.undoWorkspaceEdit(editId));
            }
            return results;
        }

        const undoAll = (this.api as any).undoAllWorkspaceEdits;
        if (typeof undoAll !== 'function') {
            const message = 'Workspace edit undo is not available.';
            this.onWorkspaceEditUndoFailed?.(message);
            return [{ success: false, error: message }];
        }

        try {
            const results = await undoAll.call(this.api);
            for (const result of results || []) {
                if (result?.success && result?.edit) {
                    this.onWorkspaceEditUndone?.(result.edit);
                } else if (result?.error) {
                    this.onWorkspaceEditUndoFailed?.(result.error);
                }
            }
            return results || [];
        } catch (error: any) {
            const message = error?.message || 'Unable to undo workspace edits.';
            this.onWorkspaceEditUndoFailed?.(message);
            return [{ success: false, error: message }];
        }
    }

    public buildSelectionRewritePreview(selectionText: string) {
        const lastAiMessage = [...this.messages].reverse().find(message => message.role === 'ai');
        if (!lastAiMessage) return null;

        return buildSelectionPreview({
            target: 'current-selection',
            oldContent: selectionText,
            newContent: lastAiMessage.content,
        });
    }

    public async applyPreviewedChange(options: {
        action: string;
        target: string;
        previousContent?: string;
        undoable?: boolean;
        apply: () => void | Promise<void>;
    }) {
        await options.apply();
        const recordDirectWrite = (this.api as any).recordDirectWrite;
        if (typeof recordDirectWrite === 'function') {
            await recordDirectWrite.call(this.api, {
                action: options.action,
                target: options.target,
                previousContent: options.previousContent,
                undoable: options.undoable ?? true,
            });
        }
    }

    public async archiveMessage(messageId: string) {
        await this.runFileBackInBackground(messageId);
    }

    /**
     * 正反馈(点赞):用户认可该回答 → 归档到知识 wiki。等价于 file-back。
     */
    public async recordPositiveFeedback(messageId: string) {
        await this.runFileBackInBackground(messageId);
    }

    /**
     * 负反馈(点踩):用户不满意该回答。
     * 1. 把「被否定的回答 + 用户原因」提炼成「应避免」教训写入长期记忆(影响未来相似提问);
     * 2. 带着这条原因当场重新生成一版回答(即时进化,不必等下一轮召回)。
     * @param messageId 被点踩的 AI 消息 id
     * @param reason    用户给出的「哪里不好」
     */
    public async recordNegativeFeedback(messageId: string, reason: string) {
        const targetMsg = this.messages.find(m => m.id === messageId && m.role === 'ai');
        if (!targetMsg) return;

        const userInput = this.deriveFileBackSourceQuery(messageId);
        const trimmedReason = reason.trim();

        // 1. 存教训(失败不应阻断重答,仅记日志)。
        const retainLesson = (this.api as any).retainLesson;
        if (typeof retainLesson === 'function' && trimmedReason) {
            try {
                await retainLesson.call(this.api, {
                    userInput,
                    rejectedOutput: targetMsg.content,
                    reason: trimmedReason,
                    source: 'shell',
                });
            } catch (error: any) {
                logger.error('Retain lesson failed', error, 'ChatController');
            }
        }

        // 2. 当场重答:把原始问题与用户反馈拼成 steering 指令,复用正常流式通道。
        //    不直接复述被否定的长回答,只give模型「上次哪里不好 + 重答」的约束。
        const steeringQuery = trimmedReason
            ? `${userInput}\n\n[反馈] 上次的回答我不满意:${trimmedReason}。请据此改进,重新回答。`
            : `${userInput}\n\n[反馈] 上次的回答我不满意,请换一种方式重新回答。`;

        await this.processCommand(steeringQuery);
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

    private handleWorkspaceEditResult(result: any): void {
        if (!result?.workspaceEdit) return;
        this.onWorkspaceEdit?.(result.workspaceEdit);
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
    private async runFileBackInBackground(msgId: string) {
        const targetMsg = this.messages.find(m => m.id === msgId && m.role === 'ai');
        if (!targetMsg) return;

        const toolRegistry = (this.app as any).plugins?.plugins?.[PLUGIN_ID]?.toolRegistry;
        if (toolRegistry?.execute) {
            try {
                const result = await toolRegistry.execute('file_back_knowledge', this.buildFileBackArgs(targetMsg));
                if (result?.success) {
                    const suffix = result.path ? `: ${result.path}` : '.';
                    this.addMessage('system', `Archived to the knowledge wiki${suffix}`);
                } else {
                    this.addMessage('system', `Archive failed: ${result?.error || 'Unknown error'}`);
                }
                return;
            } catch (error: any) {
                logger.error('File-back failed', error, 'ChatController');
                this.addMessage('system', `Archive failed: ${error?.message || 'Unknown error'}`);
                return;
            }
        }

        const fileBackPrompt = `鐢ㄦ埛瀵逛互涓嬪洖绛旂偣璧烇紝璇峰皢鍏跺綊妗ｅ埌鐭ヨ瘑搴撱€備娇鐢?file_back_knowledge 宸ュ叿锛屾彁鍙栨爣棰樺拰鏍稿績鍐呭锛屽苟鎻愬彇鐩稿叧鐨?topics 涓婚鏍囩銆俓n\n鍥炵瓟鍐呭锛歕n${targetMsg.content}`;
        this.api.chat(fileBackPrompt, [], '').then(() => {
            this.addMessage('system', 'Archived to the knowledge wiki.');
        }).catch((error: any) => {
            logger.error('File-back failed', error, 'ChatController');
        });
    }

    private buildFileBackArgs(targetMsg: ChatMessage) {
        return {
            title: this.deriveFileBackTitle(targetMsg.content),
            content: targetMsg.content,
            topics: [],
            source_queries: [this.deriveFileBackSourceQuery(targetMsg.id)],
        };
    }

    private deriveFileBackSourceQuery(messageId: string) {
        const targetIndex = this.messages.findIndex((message) => message.id === messageId);
        if (targetIndex > 0) {
            for (let index = targetIndex - 1; index >= 0; index--) {
                const message = this.messages[index];
                if (message.role === 'user' && message.content.trim()) {
                    return message.content.trim();
                }
            }
        }

        return `Archived from AI message ${messageId}`;
    }

    private deriveFileBackTitle(content: string) {
        const headingMatch = content.match(/^#{1,6}\s+(.+)$/m);
        const rawTitle = headingMatch?.[1] || content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean)
            || 'Knowledge Archive';
        const normalized = rawTitle
            .replace(/[*_`>#-]/g, ' ')
            .replace(/\[\[|\]\]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized.slice(0, 80) || 'Knowledge Archive';
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
    private async handleMemory(input: string, legacyCommand?: '/profile') {
        const trimmed = input.trim();
        const [rawMode = 'overview', ...rest] = trimmed ? trimmed.split(/\s+/) : ['overview'];
        const mode = rawMode.toLowerCase();
        const note = legacyCommand
            ? `Compatibility note: \`${legacyCommand}\` is now \`/memory\`.\n\n`
            : '';

        if (mode === 'forget') {
            await this.handleForget(rest.join(' '));
            return;
        }

        if (mode === 'search') {
            const query = rest.join(' ').trim();
            if (!query) {
                this.addMessage('system', 'Usage: `/memory search <query>`');
                return;
            }
            await this.renderMemoryView({ mode: 'search', query, limit: 10 }, note);
            return;
        }

        if (mode === 'observations') {
            await this.renderMemoryView({ mode: 'observations', limit: 10 }, note);
            return;
        }

        if (mode === 'overview' || mode === 'raw') {
            await this.renderMemoryView({ mode: mode as 'overview' | 'raw', limit: 10 }, note);
            return;
        }

        if (legacyCommand === '/profile') {
            await this.renderMemoryView({ mode: 'overview', limit: 10 }, note);
            return;
        }

        this.addMessage('system', 'Usage: `/memory [overview|observations|search <query>|forget <field|all>]`');
    }

    private async renderMemoryView(request: any, prefix: string = '') {
        const getMemoryView = (this.api as any).getMemoryView;
        if (typeof getMemoryView !== 'function') {
            this.addMessage('system', this.formatLegacyProfile(prefix));
            return;
        }

        const view = await getMemoryView.call(this.api, request);
        if (!view) {
            this.addMessage('system', `${prefix}No memory data available.`);
            return;
        }

        this.addMessage('system', `${prefix}${this.formatMemoryView(view, request)}`);
    }

    private formatLegacyProfile(prefix: string): string {
        const profile = this.api.getUserProfile();
        if (!profile) return `${prefix}No profile data available.`;

        let text = `${prefix}## User Profile\n\n`;
        if (profile.name) text += `**Name**: ${profile.name}\n`;
        if (profile.profession) text += `**Profession**: ${profile.profession}\n`;
        if (profile.expertise?.length) text += `**Expertise**: ${profile.expertise.join(', ')}\n`;
        if (profile.context?.currentProjects?.length) {
            text += `**Projects**: ${profile.context.currentProjects.join(', ')}\n`;
        }
        return text.trim();
    }

    private formatMemoryView(view: any, request: any): string {
        const stats = view.stats || {};
        const lines = [
            '## Hindsight Memory',
            '',
            `Privacy Mode: ${view.privacyMode ? 'On' : 'Off'}`,
            `Total: ${stats.total ?? 0} | Facts: ${stats.world ?? 0} | Experiences: ${stats.experience ?? 0} | Observations: ${stats.observation ?? 0}`,
        ];

        if (request.mode === 'observations') {
            this.appendMemoryRecords(lines, 'Observations', view.sections?.observations || [], true);
            return lines.join('\n');
        }

        if (request.mode === 'search') {
            lines.push('', `Search: ${request.query}`);
            this.appendMemoryRecords(lines, 'Search Results', view.sections?.searchResults || [], true);
            return lines.join('\n');
        }

        if (request.mode === 'raw') {
            this.appendMemoryRecords(lines, 'Raw Memory', view.sections?.raw || [], true);
            return lines.join('\n');
        }

        this.appendMemoryRecords(lines, 'Top Observations', view.sections?.observations || [], true);
        this.appendMemoryRecords(lines, 'Facts', view.sections?.facts || [], false);
        this.appendMemoryRecords(lines, 'Recent Experiences', view.sections?.recent || [], false);
        return lines.join('\n');
    }

    private appendMemoryRecords(lines: string[], title: string, records: any[], showMeta: boolean) {
        lines.push('', `### ${title}`);
        if (!records || records.length === 0) {
            lines.push('- No matching memories.');
            return;
        }

        for (const record of records) {
            const text = this.truncateMemoryText(record.text || '', 220);
            const meta = showMeta
                ? ` _(id: ${record.id}, type: ${record.type}, confidence: ${Number(record.confidence || 0).toFixed(2)})_`
                : '';
            lines.push(`- ${text}${meta}`);
        }
    }

    private truncateMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }

    private async handleForget(field: string, legacyCommand?: '/forget') {
        const f = field.trim().toLowerCase();
        const compatibilityNote = legacyCommand === '/forget'
            ? 'Compatibility note: `/forget` is now `/memory forget`.\n\n'
            : '';
        if (!f) {
            const command = legacyCommand === '/forget' ? '/forget' : '/memory forget';
            this.addMessage('system', `${compatibilityNote}Usage: \`${command} <field>\` or \`${command} all\`\n\nForgettable fields: name, profession, expertise, preferences, workflows, projects, goals, all`);
            return;
        }

        const profile = this.api.getUserProfile();
        const forgetHindsight = typeof (this.api as any).forgetMemory === 'function'
            ? (forgetField: string) => (this.api as any).forgetMemory(forgetField)
            : async (_forgetField: string) => undefined;

        if (!profile && typeof (this.api as any).forgetMemory !== 'function') {
            this.addMessage('system', `${compatibilityNote}No user memory data available.`);
            return;
        }

        if (f === 'all') {
            if (profile) await this.api.updateProfile({
                name: '', profession: '', expertise: [],
                preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
                workflows: [],
                context: { currentProjects: [], goals: [], challenges: [] }
            });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Cleared all remembered user data.'}`);
        } else if (f === 'name') {
            if (profile) await this.api.updateProfile({ name: '' });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: name'}`);
        } else if (f === 'profession') {
            if (profile) await this.api.updateProfile({ profession: '' });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: profession'}`);
        } else if (f === 'expertise') {
            if (profile) await this.api.updateProfile({ expertise: [] });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: expertise'}`);
        } else if (f === 'preferences') {
            if (profile) await this.api.updateProfile({ preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] } });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: preferences'}`);
        } else if (f === 'workflows') {
            if (profile) await this.api.updateProfile({ workflows: [] });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: workflows'}`);
        } else if (f === 'projects') {
            if (profile) await this.api.updateProfile({ context: { ...profile.context, currentProjects: [] } });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: projects'}`);
        } else if (f === 'goals') {
            if (profile) await this.api.updateProfile({ context: { ...profile.context, goals: [] } });
            const result = await forgetHindsight(f);
            this.addMessage('system', `${compatibilityNote}${result?.message || 'Forgot memory field: goals'}`);
        } else {
            this.addMessage('system', `${compatibilityNote}Unknown field: ${f}\nForgettable fields: name, profession, expertise, preferences, workflows, projects, goals, all`);
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
            const result = await this.api.chat(
                instruction,
                [],
                selection,
                'slash-edit',
            );
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
            { command: '/memory [overview|observations|search <query>|forget <field>]', description: 'View, search, and forget Hindsight memory' },
            { command: '/file-back <message-id>', description: 'Archive a previous AI answer to the knowledge wiki' },
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

        // 用户自定义命令(.obsidian/baizer-commands/*.md)。同步快照,启动预热后有值。
        const userCommands = typeof (this.api as any).getUserCommandsSync === 'function'
            ? (this.api as any).getUserCommandsSync()
            : [];
        if (userCommands.length > 0) {
            help += `\n\n## User Commands\n\n`;
            help += userCommands
                .map((entry: any) => `- \`${entry.command}\` - ${entry.description}`)
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
| \`/memory\` | View Hindsight memory |
| \`/memory search <query>\` | Search Hindsight memory |
| \`/memory forget <field>\` | Forget saved memory |
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
        const plugin = (this.app as any).plugins?.plugins?.[PLUGIN_ID];
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

