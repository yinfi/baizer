import { App, MarkdownView, TFile } from 'obsidian';
import { ModelService } from '../services/model-service';
import { ChatTurnOutcome, StreamEvent } from '../models/interfaces';
import { logger } from '../utils/logger';
import { t } from '../i18n/zh';
import {
    buildFileWriteFailureMessage,
    getFileWriteError,
    getFileWriteResultPath,
    isFileWriteRequest,
    isFileWriteToolName,
    isSuccessfulWriteToolResult,
} from '../utils/file-operation-contract';
import { ApprovalRequest } from './approval-card';
import {
    ApprovalExecutionOutcome,
    ApprovalOutcome,
    ApprovalState,
} from '../services/approval-execution';
import { buildSelectionPreview } from './diff/change-preview';
import { ChatMessage } from './types';
import { WorkspaceEditResult, WorkspaceEditSummary } from '../services/workspace-edit-service';
import { PLUGIN_ID } from '../mcp/types';
import { ChatContextItem } from '../models/interfaces';
import { MemoryStats, MemoryView, MemoryViewRequest } from '../memory/types';
import { MemoryRecord } from '../memory/hindsight-types';
import { KnowledgeRuntime } from '../knowledge/runtime';
import { ToolRegistry } from '../skills/tool-registry';
import { ChangePreview } from './diff/change-preview';
import { thrownMessage } from '../utils/thrown-message';

/** 工具/命令结果的松散公共字段。现有工具契约未导出统一类型,这里只声明 UI 实际消费的成员。 */
interface ToolResultPayload {
    approval_required?: boolean;
    requestId?: string;
    action: string;
    target: string;
    args: Record<string, unknown>;
    message?: string;
    preview?: ChangePreview;
    error?: string;
    success?: boolean;
    status?: string;
    path?: string;
    kind?: never;
    detail?: string;
    completedAt?: number;
    retryable?: boolean;
    result?: unknown;
    workspaceEdit?: WorkspaceEditSummary;
}

/**
 * 流事件里的 tool_result.result 类型为 unknown(可能是 null/字符串/对象)。
 * 非对象一律视为空对象:所有消费点都只读可选字段,与此前对 null/原始值的 `?.` 读取等价。
 */
function asToolResultPayload(value: unknown): ToolResultPayload {
    return (typeof value === 'object' && value !== null ? value : {}) as ToolResultPayload;
}

/** Obsidian App 上未在公开 d.ts 暴露的内部命令 API。 */
type AppWithCommands = App & {
    commands: { executeCommandById(commandId: string): boolean };
};

/** Obsidian App 上未在公开 d.ts 暴露的插件宿主 API(只取 UI 实际用到的插件成员)。 */
type AppWithPluginHost = App & {
    plugins?: {
        plugins?: Record<string, {
            toolRegistry?: ToolRegistry;
            knowledgeRuntime?: KnowledgeRuntime;
        }>;
    };
};

/** 记录一条消息时告知宿主的事实(ADR 0002:记录与绘制分离)。 */
export interface MessageAddedOptions {
    /** 该消息已随 stream 事件上屏,宿主只记录、不重画。 */
    alreadyRendered?: boolean;
}

/**
 * 一轮请求的完整现场:原文、上下文(含文件/图片附件)、选区。
 * 失败/取消后据此恢复草稿并按原请求重试;不把「用户等待期间的新输入」覆盖掉。
 */
export interface ChatTurnRequest {
    query: string;
    context: ChatContextItem[];
    selection: string;
    source: 'shell' | 'selection-menu';
    /** 失败/取消时记下的 AI 消息 id,重试时用于原地替换它。 */
    messageId?: string;
}

export interface ChatControllerOptions {
    app: App;
    api: ModelService;
    /**
     * 会话标识(= UI tab.id),用于 per-conversation session 隔离。
     * 传下给 ModelService.chat/chatStream/clearSession,使不同 tab 的跨轮上下文互不可见。
     * 缺省时退化为无持久会话(每轮内存临时会话)。
     */
    conversationId?: string;
    /** 消息已记入本控制器的列表(唯一作者)。宿主据此更新自己的只读投影。 */
    onMessageAdded?: (message: ChatMessage, options?: MessageAddedOptions) => void;
    /** 消息已从本控制器的列表移除(重试替换失败消息时)。宿主同步删投影。 */
    onMessageRemoved?: (messageId: string) => void;
    /** 已存在消息的字段被更新(审批状态流转)。宿主据此同步投影并原位重画卡片。 */
    onMessageUpdated?: (message: ChatMessage) => void;
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
    private onMessageAdded?: (message: ChatMessage, options?: MessageAddedOptions) => void;
    private onMessageRemoved?: (messageId: string) => void;
    private onMessageUpdated?: (message: ChatMessage) => void;
    private onStatusChanged?: (isResponding: boolean) => void;
    private onStreamEvent?: (event: StreamEvent) => void;
    private onClear?: () => void;
    private onWorkspaceEdit?: (edit: WorkspaceEditSummary) => void;
    private onWorkspaceEditUndone?: (edit: WorkspaceEditSummary) => void;
    private onWorkspaceEditUndoFailed?: (message: string) => void;
    private activeStreamController: AbortController | null = null;
    /**
     * 失败/取消的请求现场,按落下的 AI 消息 id 索引。
     * 重试按原请求与上下文恢复;只在内存里保留最近若干条,刷新后由 UI 从相邻
     * user 消息回退推导(上下文不可恢复时至少原文可重试)。
     */
    private retryRequests = new Map<string, ChatTurnRequest>();

    // 文件搜索缓存
    private fileSearchCache: { term: string; results: TFile[]; timestamp: number } | null = null;
    private readonly FILE_SEARCH_CACHE_TTL = 5000; // 5绉掔紦瀛?
    private fileSearchCacheCleanupTimer: number | null = null;

    constructor(options: ChatControllerOptions) {
        this.app = options.app;
        this.api = options.api;
        this.conversationId = options.conversationId;
        this.onMessageAdded = options.onMessageAdded;
        this.onMessageRemoved = options.onMessageRemoved;
        this.onMessageUpdated = options.onMessageUpdated;
        this.onStatusChanged = options.onStatusChanged;
        this.onStreamEvent = options.onStreamEvent;
        this.onClear = options.onClear;
        this.onWorkspaceEdit = options.onWorkspaceEdit;
        this.onWorkspaceEditUndone = options.onWorkspaceEditUndone;
        this.onWorkspaceEditUndoFailed = options.onWorkspaceEditUndoFailed;

        // 设置定时器清理过期的文件搜索缓存
        this.fileSearchCacheCleanupTimer = window.setInterval(() => {
            this.cleanupExpiredFileSearchCache();
        }, 60000); // 每 60 秒检查一次
    }

    public getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    /** 宿主替换流事件回调(选择浮窗复用同一控制器实例时用)。 */
    public setStreamEventHook(hook?: (event: StreamEvent) => void) {
        this.onStreamEvent = hook;
    }

    /** 宿主替换「消息已记录」回调。 */
    public setMessageAddedHook(hook?: (message: ChatMessage, options?: MessageAddedOptions) => void) {
        this.onMessageAdded = hook;
    }

    /** 宿主替换「忙碌状态」回调。 */
    public setStatusChangedHook(hook?: (isResponding: boolean) => void) {
        this.onStatusChanged = hook;
    }

    /**
     * 接管一批宿主投影里已有的消息(从持久会话恢复、分支投影重建)。
     *
     * 这些消息不是本轮经 onMessageAdded 新建的,但宿主已持有同一批投影,所以这里
     * 不回调、不重画,只把所有权收归本列表,避免出现「投影有、owner 没有」的分叉。
     * 不接管的话,恢复会话后 👍/👎 按 id 回查必然落空,又回到静默空操作(ADR 0002)。
     */
    public adoptMessages(messages: ChatMessage[]) {
        this.messages = messages.map(message => this.normalizeAdoptedApproval(message));
        // 视图销毁/应用重启可能留下 status=running 的审批：用执行登记表/审计记录
        // 把「还在跑」「已结束」「未知」区分开，绝不在恢复时盲目重放写入。
        void this.reconcileRunningApprovals();
    }

    /**
     * 旧会话快照里的审批请求没有 id（本票之前的结构）。恢复时补一个稳定身份，
     * 否则执行登记表无法去重，重挂载后的第二次点击可能重复写盘。
     */
    private normalizeAdoptedApproval(message: ChatMessage): ChatMessage {
        if (!message.approval || message.approval.id) return { ...message };
        const next: ChatMessage = {
            ...message,
            approval: {
                ...message.approval,
                id: createApprovalRequestId(),
                conversationId: message.approval.conversationId ?? this.conversationId,
            },
        };
        this.onMessageUpdated?.(next);
        return next;
    }

    public clearHistory() {
        this.messages = [];
        void this.api.clearSession(this.conversationId);
        // 先让宿主清空该 tab 的可见历史(tab.state)并重渲,再追加「已清空」提示,
        // 否则 tab.state 里的旧消息仍会留在屏幕上(/clear 不清屏的根因)。
        this.onClear?.();
        this.addMessage('system', 'Session cleared.');
    }

        // 清理过期的文件搜索缓存
    private cleanupExpiredFileSearchCache() {
        if (this.fileSearchCache) {
            const now = Date.now();
            if (now - this.fileSearchCache.timestamp > this.FILE_SEARCH_CACHE_TTL) {
                this.fileSearchCache = null;
                logger.debug('Cleaned up expired file search cache.', 'ChatController');
            }
        }
    }

        // 清理资源（在组件卸载时调用）
    public cleanup() {
        this.activeStreamController?.abort();
        this.activeStreamController = null;
        // 清理文件搜索缓存定时器
        if (this.fileSearchCacheCleanupTimer !== null) {
            window.clearInterval(this.fileSearchCacheCleanupTimer);
            this.fileSearchCacheCleanupTimer = null;
        }
        // 清空缓存
        this.fileSearchCache = null;
    }

    public async processCommand(
        query: string,
        context: ChatContextItem[] | string = [],
        selection: string = '',
        source: 'shell' | 'selection-menu' = 'shell',
        displayText?: string,
    ): Promise<ChatTurnOutcome | undefined> {
        if (!query.trim()) return undefined;
        const normalizedContext = this.normalizeContextItems(context);

        // 1. Handle Commands
        if (query.startsWith('/')) {
            await this.handleSlashCommand(query);
            return undefined;
        }

        // 2. Normal Chat
        return this.runTurn(query, normalizedContext, selection, source, displayText ?? query, true);
    }

    /**
     * 按原请求重试一次失败/取消的轮次。
     * - 不重复插入 user 消息:同一请求只应出现一次;
     * - 先移除失败/取消时落下的 AI 消息,让新答案原地替换它;
     * - 处理中调用直接返回(幂等),双击不会产生两个在途请求。
     */
    public async retryTurn(request: ChatTurnRequest): Promise<ChatTurnOutcome | undefined> {
        if (this.isRunActive()) return undefined;
        if (request.messageId) {
            this.retryRequests.delete(request.messageId);
            if (this.messages.some(message => message.id === request.messageId)) {
                this.removeMessage(request.messageId);
            }
        }
        return this.runTurn(
            request.query,
            this.normalizeContextItems(request.context),
            request.selection,
            request.source,
            undefined,
            false,
        );
    }

    /** 取某条失败/取消消息对应的原请求现场(含附件上下文)。无记录时返回 null。 */
    public getRetryRequest(messageId: string): ChatTurnRequest | null {
        const request = this.retryRequests.get(messageId);
        if (!request) return null;
        return { ...request, context: request.context.map(item => ({ ...item })) };
    }

    /** 记下失败/取消请求现场,供失败卡片的「重试 / 恢复草稿」使用。 */
    private rememberRetryRequest(messageId: string, request: ChatTurnRequest) {
        this.retryRequests.set(messageId, {
            ...request,
            context: request.context.map(item => ({ ...item })),
            messageId,
        });
        // 只保留最近 20 条,避免长会话里失败记录无限增长。
        while (this.retryRequests.size > 20) {
            const oldest = this.retryRequests.keys().next().value;
            if (oldest === undefined) break;
            this.retryRequests.delete(oldest);
        }
    }

    /** 从唯一作者列表移除一条消息,并通知宿主同步投影(重试替换失败消息时用)。 */
    private removeMessage(messageId: string) {
        const index = this.messages.findIndex(message => message.id === messageId);
        if (index < 0) return;
        this.messages.splice(index, 1);
        this.onMessageRemoved?.(messageId);
    }

    /**
     * 单轮流式执行。processCommand 与 retryTurn 共用同一实现,保证终态记录、
     * 错误处理与 ADR 0002 的「先记录后发 done」顺序只有一份。
     * @param recordUserMessage 重试时为 false:原 user 消息已在列表里,不再重复插入。
     */
    private async runTurn(
        query: string,
        normalizedContext: ChatContextItem[],
        selection: string,
        source: 'shell' | 'selection-menu',
        displayText: string | undefined,
        recordUserMessage: boolean,
    ): Promise<ChatTurnOutcome> {
        if (recordUserMessage) {
            // 显示层与 prompt 层分离:query 是发给模型的完整 prompt(可能已装配上下文),
            // displayText 是给用户看的干净意图(如「解释:xxx」)。缺省时二者一致(shell 场景)。
            this.addMessage('user', displayText ?? query);
        }
        // 阶段B:记住本轮 user 消息 id,done 事件带回 entryIds 后回填 sessionEntryId 锚定。
        const userMessageId = recordUserMessage ? this.messages[this.messages.length - 1]?.id : undefined;
        this.setResponding(true);
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        const request: ChatTurnRequest = { query, context: normalizedContext, selection, source };
        let fullText = '';
        let turnEntryIds: { userEntryId?: string; assistantEntryId?: string } | undefined;
        // 本轮是否已记过 ai 回复。正常收尾在 done 时记,中断/失败在 catch 里记,二者互斥。
        let assistantRecorded = false;
        // 正文是否被缓冲(待审批 / 写请求未落地),即屏幕上还没显示过。
        // 必须提到与 fullText 同一作用域:catch 里的中断路径也要读它,
        // 否则会记下一条用户从未见过的回复(它标 alreadyRendered,宿主不画,
        // 于是只在切 tab 重渲时凭空出现)。
        let textWithheld = false;
        // 本轮终态:唯一来源是 runtime 的 done/error 事件;异常路径在此显式收口。
        let turnOutcome: ChatTurnOutcome = 'completed';

        try {
            if (this.onStreamEvent) {
                const isWriteRequest = this.isFileWriteRequest(query);
                let approvalRequest: ApprovalRequest | null = null;
                let attemptedFileWrite = false;
                let successfulFileWrite = false;
                let lastWriteError = '';
                const writeToolArgs = new Map<string, Record<string, unknown>[]>();
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
                        const toolResult = asToolResultPayload(event.result);
                        this.handleWorkspaceEditResult(toolResult);
                        if (this.isFileWriteTool(event.name)) {
                            attemptedFileWrite = true;
                            if (this.isSuccessfulToolResult(toolResult)) {
                                successfulFileWrite = true;
                            } else {
                                const error = this.getWriteToolError(toolResult);
                                if (error) lastWriteError = error;
                            }
                        }
                        const nextApproval = this.toApprovalRequest(toolResult);
                        if (nextApproval) {
                            approvalRequest = nextApproval;
                            this.addApprovalMessage(nextApproval);
                        } else if (this.isFileWriteTool(event.name)) {
                            if (!toolResult.workspaceEdit) {
                                await this.openFileFromToolResult(event.name, toolResult, args);
                            }
                            if (successfulFileWrite && bufferedTextEvents.length > 0) {
                                for (const bufferedEvent of bufferedTextEvents) {
                                    this.onStreamEvent(bufferedEvent);
                                }
                                bufferedTextEvents.length = 0;
                                // 缓冲的正文补发上屏了,不再算「未显示」。
                                textWithheld = false;
                            }
                        }
                    }

                    if (event.type === 'text_delta') {
                        if (approvalRequest || (isWriteRequest && !successfulFileWrite)) {
                            bufferedTextEvents.push(event);
                            textWithheld = true;
                        } else {
                            this.onStreamEvent(event);
                        }
                    } else if (event.type === 'done') {
                        const suppressed = !!approvalRequest || (isWriteRequest && !successfulFileWrite);
                        fullText = approvalRequest ? '' : event.text;
                        turnEntryIds = event.entryIds;
                        turnOutcome = event.outcome ?? (event.interrupted ? 'cancelled' : 'completed');
                        // 回填 user 消息的 entry 锚定(ai 消息紧随其后创建时一并打)。
                        if (turnEntryIds?.userEntryId && userMessageId) {
                            const userMsg = this.messages.find(m => m.id === userMessageId);
                            if (userMsg) userMsg.sessionEntryId = turnEntryIds.userEntryId;
                        }
                        // ADR 0002:宿主在处理 done 时用投影里的真实 ai 消息渲染操作栏,
                        // 所以记录必须先于 done 事件发出,否则它只能拿到上一轮的消息。
                        // 抑制态(待审批 / 写请求未落地)不落 ai 消息:审批由卡片承载,
                        // 写失败在循环后落一条 system 警告。
                        // 空正文的取消也要落:否则回放时看不到「已停止,答案不完整」的终态。
                        const cancelled = turnOutcome === 'cancelled';
                        if (!suppressed && (fullText || cancelled)) {
                            const messageId = this.recordStreamedReply(fullText, {
                                assistantEntryId: turnEntryIds?.assistantEntryId,
                                outcome: turnOutcome,
                                interrupted: cancelled,
                            });
                            assistantRecorded = true;
                            if (cancelled) this.rememberRetryRequest(messageId, request);
                        }
                        this.onStreamEvent(suppressed ? { ...event, text: '' } : event);
                    } else if (event.type === 'error') {
                        // 失败终态:即使首 token 前失败、没有任何正文,也落一条 ai 消息,
                        // 让回放/切会话后仍有「失败原因 + 重试」入口,而不是永久 Thinking。
                        if (!assistantRecorded) {
                            const messageId = this.recordStreamedReply(textWithheld ? '' : fullText, {
                                outcome: 'failed',
                                failureReason: event.message,
                            });
                            assistantRecorded = true;
                            this.rememberRetryRequest(messageId, request);
                        }
                        this.onStreamEvent(event);
                        turnOutcome = 'failed';
                        // shell 由失败卡承载原因;其他宿主没有卡片时保留旧提示。
                        if (source !== 'shell') this.addMessage('system', `Error: ${event.message}`);
                        break;
                    } else if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'step_boundary') {
                        this.onStreamEvent(event);
                    }

                    if (event.type === 'text_delta') {
                        fullText += event.content;
                    } else if (event.type === 'tool_call') {
                        // 与底层 runtime 对齐:工具调用前的正文是该步过程叙述,
                        // 不属于最终答案。重置 abort 兜底用的 fullText,使中断时
                        // 回填的也是「末轮回复」而非夹带叙述。
                        fullText = '';
                    }
                }
                if (turnOutcome !== 'failed' && !approvalRequest) {
                    if (isWriteRequest && !successfulFileWrite) {
                        this.addMessage(
                            'system',
                            this.getFileWriteFailureMessage(attemptedFileWrite, lastWriteError)
                        );
                    } else if (!assistantRecorded && fullText && !textWithheld) {
                        // 流正常收尾但没有 done 事件(runtime 提前结束):按「不完整」处理,
                        // 记一条取消终态的回复,不伪装成成功完成。
                        const messageId = this.recordStreamedReply(fullText, {
                            outcome: 'cancelled',
                            interrupted: true,
                        });
                        assistantRecorded = true;
                        this.rememberRetryRequest(messageId, request);
                        turnOutcome = 'cancelled';
                        // 没有 done 事件时也要通知宿主收尾,否则流容器停在半路、
                        // 不渲染终态卡片,输入区也不会恢复。
                        this.onStreamEvent?.({
                            type: 'done',
                            text: fullText,
                            outcome: 'cancelled',
                            interrupted: true,
                        });
                    }
                }
            } else {
                // 阶段1:跨轮上下文由 Harness session 维护,UI 不再回灌 priorMessages。
                const response = source === 'shell'
                    ? await this.api.chat(query, normalizedContext, selection, 'shell', undefined, undefined, undefined, this.conversationId)
                    : await this.api.chat(query, normalizedContext, selection, source, undefined, undefined, undefined, this.conversationId);
                this.addMessage('ai', response);
            }
        } catch (error: unknown) {
            // 用户中止时 SDK 可能抛 APIUserAbortError(name 不是 'AbortError'),
            // 但 controller 自己的 signal 一定已 aborted —— 以它为准,别把取消记成失败。
            if (this.isAbortError(error) || streamController.signal.aborted) {
                // 中断路径走同一个记录入口(ADR 0002),并显式标 cancelled 终态。
                // textWithheld 时不记正文:那段内容还在缓冲里、屏幕上从没出现过,
                // 记下来就成了一条只在重渲时冒出来的幽灵回复。
                if (!assistantRecorded) {
                    const messageId = this.recordStreamedReply(textWithheld ? '' : fullText, {
                        outcome: 'cancelled',
                        interrupted: true,
                    });
                    assistantRecorded = true;
                    this.rememberRetryRequest(messageId, request);
                }
                // done.text 同样要挡:宿主的 finalizeStream 会把它渲染进流容器。
                this.onStreamEvent?.({
                    type: 'done',
                    text: textWithheld ? '' : fullText,
                    outcome: 'cancelled',
                    interrupted: true,
                });
                turnOutcome = 'cancelled';
                return turnOutcome;
            }
            // 非中止异常:显式失败终态 + 失败原因。shell 由失败卡呈现,不再叠加 system 行。
            const failureMessage = thrownMessage(error) || 'Unknown error occurred.';
            if (!assistantRecorded) {
                const messageId = this.recordStreamedReply(textWithheld ? '' : fullText, {
                    outcome: 'failed',
                    failureReason: failureMessage,
                });
                assistantRecorded = true;
                this.rememberRetryRequest(messageId, request);
                // 与流内 error 事件一致:通知宿主收尾并渲染失败卡。
                this.onStreamEvent?.({ type: 'error', message: failureMessage, outcome: 'failed' });
            }
            logger.error('Chat error', error, 'ChatController');
            if (source !== 'shell') this.addMessage('system', `Error: ${failureMessage}`);
            turnOutcome = 'failed';
        } finally {
            if (this.activeStreamController === streamController) {
                this.activeStreamController = null;
            }
            this.setResponding(false);
        }
        return turnOutcome;
    }

    private async handleSlashCommand(query: string) {
        const [cmd, ...args] = query.split(' ');
        const argStr = args.join(' ');

        this.addMessage('user', query);

        const skillCommands = typeof this.api.getSkillCommands === 'function'
            ? this.api.getSkillCommands()
            : [];
        const matchedSkillCommand = skillCommands.find(entry => entry.command === cmd);

        if (matchedSkillCommand && typeof this.api.executeSlashSkillCommand === 'function') {
            try {
                const result: unknown = await this.api.executeSlashSkillCommand(cmd, argStr.trim(), this.conversationId);
                if (typeof result === 'string') {
                    this.addMessage('system', result);
                } else {
                    this.handleStructuredResult(asToolResultPayload(result));
                }
            } catch (error: unknown) {
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
                const toolsList = tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
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
                (this.app as AppWithCommands).commands.executeCommandById(`${PLUGIN_ID}:knowledge-open-index`);
                break;
            case '/wiki:lint':
                (this.app as AppWithCommands).commands.executeCommandById(`${PLUGIN_ID}:knowledge-lint`);
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
        if (typeof this.api.executeUserCommand === 'function') {
            this.setResponding(true);
            try {
                const result = await this.api.executeUserCommand(cmd, argStr.trim());
                if (result?.handled) {
                    this.addMessage('ai', result.message ?? '');
                    return;
                }
            } catch (error: unknown) {
                this.handleError(error);
                return;
            } finally {
                this.setResponding(false);
            }
        }
        this.addMessage('system', `Unknown command: ${cmd}`);
    }

    private formatSlashCommandResult(result: ToolResultPayload | string): string {
        if (typeof result === 'string') return result;
        if (result?.message && typeof result.message === 'string') return result.message;
        return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    private toApprovalRequest(result: ToolResultPayload): ApprovalRequest | null {
        if (!result?.approval_required) return null;
        return {
            id: typeof result.requestId === 'string' && result.requestId
                ? result.requestId
                : createApprovalRequestId(),
            conversationId: this.conversationId,
            action: result.action,
            target: result.target,
            args: result.args || {},
            message: result.message || 'Approval required.',
            preview: result.preview,
        };
    }

    private handleStructuredResult(result: ToolResultPayload, action?: string, args: Record<string, unknown> = {}) {
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

    /**
     * 批准一条审批消息。
     *
     * 按消息 id（而不是卡片 DOM）定位请求：消息里的 request.id 是执行登记表的键，
     * 所以双击、键盘重复触发、重挂载后的第二次点击都只会执行一次。
     */
    public async approveApproval(messageId: string) {
        await this.runApproval(messageId, false);
    }

    /** 失败后的显式重试；只允许 failed 且 retryable 的终态。 */
    public async retryApproval(messageId: string) {
        await this.runApproval(messageId, true);
    }

    /**
     * 拒绝：不执行任何工具调用，只把请求标记为 rejected 并留在消息流里。
     */
    public rejectApproval(messageId: string) {
        const message = this.findApprovalMessage(messageId);
        if (!message) return;
        const state = message.approvalState ?? { status: 'pending' };
        if (state.status !== 'pending') return;

        this.updateApprovalState(messageId, {
            status: 'rejected',
            outcome: {
                status: 'rejected',
                detail: t('No write was performed.'),
                target: message.approval?.target,
                completedAt: Date.now(),
            },
        });
    }

    /**
     * 结果未知时先核实，不直接重放写入。
     * 执行登记表里还有 in-flight Promise 就等它；否则查审计记录判断「是否执行过」。
     */
    public async recheckApproval(messageId: string) {
        const message = this.findApprovalMessage(messageId);
        const request = message?.approval;
        if (!message || !request) return;
        const state = message.approvalState ?? { status: 'pending' };
        if (state.status !== 'unknown') return;

        if (typeof this.api.reconcileApprovedAction !== 'function') {
            this.updateApprovalState(messageId, {
                ...state,
                status: 'unknown',
                outcome: {
                    ...state.outcome,
                    status: 'unknown',
                    detail: t('Cannot verify the result automatically. Check the target manually.'),
                    retryable: false,
                    completedAt: Date.now(),
                },
            });
            return;
        }

        this.setResponding(true);
        try {
            const outcome = await this.api.reconcileApprovedAction(
                request.id,
                request.action,
                request.args,
                this.conversationId,
                // 消息创建时间用于区分「记录已过期」：审计状态被上限淘汰后不能再假设「没执行过」。
                { requestedAt: message.timestamp },
            );
            this.applyExecutionOutcome(messageId, request, outcome);
        } catch (error: unknown) {
            this.updateApprovalState(messageId, {
                status: 'unknown',
                outcome: {
                    status: 'unknown',
                    error: thrownMessage(error) || String(error),
                    detail: t('Could not verify the result. Check the target manually.'),
                    retryable: false,
                    completedAt: Date.now(),
                },
            });
        } finally {
            this.setResponding(false);
        }
    }

    private async runApproval(messageId: string, retry: boolean) {
        const message = this.findApprovalMessage(messageId);
        const request = message?.approval;
        if (!message || !request) return;

        const state = message.approvalState ?? { status: 'pending' };
        const allowed = retry
            ? state.status === 'failed' && state.outcome?.retryable !== false
            : state.status === 'pending';
        if (!allowed) return;

        if (!this.approvalBelongsToThisConversation(request)) {
            this.updateApprovalState(messageId, {
                status: 'failed',
                outcome: {
                    status: 'failed',
                    detail: t('This approval belongs to another conversation, so it was not executed.'),
                    retryable: false,
                    completedAt: Date.now(),
                },
            });
            return;
        }

        // 先落 running 再执行：即使视图随后被销毁，重新挂载时也不会把 pending 当成可再次点击。
        this.updateApprovalState(messageId, { status: 'running' });
        this.setResponding(true);
        try {
            // 传 conversationId:批准后的真实结果由 ModelService 回灌进该会话的 pi session,
            // 使下一轮模型看到动作已执行而非停留在审批占位上失忆。
            const result = await this.api.executeApprovedAction(
                request.action,
                request.args,
                this.conversationId,
                { requestId: request.id, retry },
            );
            this.applyExecutionOutcome(messageId, request, result);
        } catch (error: unknown) {
            this.updateApprovalState(messageId, {
                status: 'unknown',
                outcome: {
                    status: 'unknown',
                    error: thrownMessage(error) || String(error),
                    detail: t('The action was interrupted before its result was recorded. Check the target before retrying.'),
                    retryable: false,
                    completedAt: Date.now(),
                },
            });
        } finally {
            this.setResponding(false);
        }
    }

    private applyExecutionOutcome(
        messageId: string,
        request: ApprovalRequest,
        execution: ApprovalExecutionOutcome | ToolResultPayload,
    ) {
        const outcome = this.toApprovalOutcome(execution, request);
        this.updateApprovalState(messageId, { status: outcome.status, outcome });
        if (outcome.status === 'succeeded') {
            const raw = (execution?.kind === 'approval-execution' ? execution.result : execution) as ToolResultPayload;
            void this.openFileFromToolResult(request.action, raw, request.args);
        }
    }

    private toApprovalOutcome(
        execution: ApprovalExecutionOutcome | ToolResultPayload,
        request: ApprovalRequest,
    ): ApprovalOutcome {
        if (execution?.kind === 'approval-execution') {
            return {
                status: execution.status,
                detail: execution.detail,
                error: execution.error,
                target: execution.target ?? request.target,
                completedAt: execution.completedAt ?? Date.now(),
                retryable: execution.retryable,
            };
        }

        // 兼容测试桩/旧调用方返回的裸工具结果。
        const succeeded = execution?.success === true || execution?.status === 'success';
        return {
            status: succeeded ? 'succeeded' : 'failed',
            detail: succeeded ? execution?.message : undefined,
            error: succeeded ? undefined : (execution?.error || execution?.message || t('The action failed.')),
            target: request.target,
            completedAt: Date.now(),
            retryable: !succeeded,
        };
    }

    private findApprovalMessage(messageId: string): ChatMessage | undefined {
        return this.messages.find(message => message.id === messageId && !!message.approval);
    }

    private approvalBelongsToThisConversation(request: ApprovalRequest): boolean {
        // 旧快照可能没有 conversationId；有值时必须是当前会话，防止把 A 会话的请求在 B 会话执行。
        return !request.conversationId
            || !this.conversationId
            || request.conversationId === this.conversationId;
    }

    private updateApprovalState(messageId: string, approvalState: ApprovalState) {
        const index = this.messages.findIndex(message => message.id === messageId);
        if (index < 0) return;
        const next: ChatMessage = { ...this.messages[index], approvalState };
        this.messages[index] = next;
        this.onMessageUpdated?.(next);
    }

    /**
     * 恢复投影时处理 status=running 的审批：
     * - 登记表里仍在跑 → 等它结束并落终态；
     * - 登记表有结果 → 直接落终态；
     * - 都没有 → 查审计记录；查不到才标记为「未执行，可安全重试」。
     */
    private async reconcileRunningApprovals() {
        const running = this.messages.filter(
            message => message.approval && message.approvalState?.status === 'running',
        );
        if (running.length === 0) return;
        if (typeof this.api.reconcileApprovedAction !== 'function') {
            for (const message of running) {
                this.updateApprovalState(message.id, {
                    status: 'unknown',
                    outcome: {
                        status: 'unknown',
                        detail: t('The action was interrupted before its result was recorded. Check the target before retrying.'),
                        retryable: false,
                        completedAt: Date.now(),
                    },
                });
            }
            return;
        }

        for (const message of running) {
            const request = message.approval;
            if (!request) continue;
            try {
                const outcome = await this.api.reconcileApprovedAction(
                    request.id,
                    request.action,
                    request.args,
                    this.conversationId,
                    { requestedAt: message.timestamp },
                );
                this.applyExecutionOutcome(message.id, request, outcome);
            } catch (error: unknown) {
                this.updateApprovalState(message.id, {
                    status: 'unknown',
                    outcome: {
                        status: 'unknown',
                        error: thrownMessage(error) || String(error),
                        detail: t('Could not verify the result. Check the target manually.'),
                        retryable: false,
                        completedAt: Date.now(),
                    },
                });
            }
        }
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
        if (typeof this.api.steerActiveRun !== 'function') return false;

        // 必须听 steer 的回话,不能只看自己的 activeStreamController:
        // 后者在调 chatStream 之前就置位,而 harness 要到 queryStream 内部
        // 若干 await 之后才 register。这段窗口里补话会被丢弃,
        // 若仍渲染用户气泡,用户会以为发出去了。
        if (this.api.steerActiveRun(trimmed) !== true) return false;

        this.addMessage('user', trimmed);
        return true;
    }

    /** 是否正在运行一个可被补话的流。供 UI 决定补话入口的可用态。 */
    public isRunActive(): boolean {
        return !!this.activeStreamController && !this.activeStreamController.signal.aborted;
    }

    public async undoWorkspaceEdit(editId: string): Promise<WorkspaceEditResult> {
        if (typeof this.api.undoWorkspaceEdit !== 'function') {
            const message = 'Workspace edit undo is not available.';
            this.onWorkspaceEditUndoFailed?.(message);
            return { success: false, error: message };
        }

        try {
            const result = await this.api.undoWorkspaceEdit(editId);
            if (result?.success && result?.edit) {
                this.onWorkspaceEditUndone?.(result.edit);
            } else {
                this.onWorkspaceEditUndoFailed?.(result?.error || 'Unable to undo workspace edit.');
            }
            return result;
        } catch (error: unknown) {
            const message = thrownMessage(error) || 'Unable to undo workspace edit.';
            this.onWorkspaceEditUndoFailed?.(message);
            return { success: false, error: message };
        }
    }

    public async undoAllWorkspaceEdits(editIds?: string[]): Promise<WorkspaceEditResult[]> {
        if (editIds?.length) {
            const results: WorkspaceEditResult[] = [];
            for (const editId of editIds) {
                results.push(await this.undoWorkspaceEdit(editId));
            }
            return results;
        }

        if (typeof this.api.undoAllWorkspaceEdits !== 'function') {
            const message = 'Workspace edit undo is not available.';
            this.onWorkspaceEditUndoFailed?.(message);
            return [{ success: false, error: message }];
        }

        try {
            const results = await this.api.undoAllWorkspaceEdits();
            for (const result of results || []) {
                if (result?.success && result?.edit) {
                    this.onWorkspaceEditUndone?.(result.edit);
                } else if (result?.error) {
                    this.onWorkspaceEditUndoFailed?.(result.error);
                }
            }
            return results || [];
        } catch (error: unknown) {
            const message = thrownMessage(error) || 'Unable to undo workspace edits.';
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
        if (typeof this.api.recordDirectWrite === 'function') {
            await this.api.recordDirectWrite({
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

        // 若当前仍有活动流,先取消,避免「改进重答」与旧流并存产生孤儿流。
        if (this.isRunActive()) {
            this.cancelActiveStream();
        }

        const userInput = this.deriveFileBackSourceQuery(messageId);
        const trimmedReason = reason.trim();

        // 1. 存教训(失败不应阻断重答,仅记日志)。
        if (typeof this.api.retainLesson === 'function' && trimmedReason) {
            try {
                await this.api.retainLesson({
                    userInput,
                    rejectedOutput: targetMsg.content,
                    reason: trimmedReason,
                    source: 'shell',
                });
            } catch (error: unknown) {
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

    private isFileWriteRequest(message: string): boolean {
        return isFileWriteRequest(message);
    }

    private isFileWriteTool(name: string): boolean {
        return isFileWriteToolName(name);
    }

    private shiftToolArgs(toolArgs: Map<string, Record<string, unknown>[]>, name: string): Record<string, unknown> {
        const calls = toolArgs.get(name);
        if (!calls || calls.length === 0) return {};
        const args = calls.shift() || {};
        if (calls.length === 0) toolArgs.delete(name);
        return args;
    }

    private isSuccessfulToolResult(result: ToolResultPayload): boolean {
        return isSuccessfulWriteToolResult(result);
    }

    private handleWorkspaceEditResult(result: ToolResultPayload): void {
        if (!result?.workspaceEdit) return;
        this.onWorkspaceEdit?.(result.workspaceEdit);
    }

    private getResultPath(action: string, result: ToolResultPayload, args: Record<string, unknown>): string {
        return getFileWriteResultPath(action, result, args);
    }

    private getWriteToolError(result: ToolResultPayload): string {
        return getFileWriteError(result);
    }

    private getFileWriteFailureMessage(attemptedWrite: boolean, lastError?: string): string {
        return buildFileWriteFailureMessage(attemptedWrite, lastError);
    }

    private async openFileFromToolResult(action: string, result: ToolResultPayload, args: Record<string, unknown> = {}) {
        if (!this.isSuccessfulToolResult(result)) return;
        const path = this.getResultPath(action, result, args);
        if (!path) return;

        try {
            const file = this.app.vault?.getAbstractFileByPath?.(path);
            if (!file || !(file instanceof TFile)) return;
            await this.app.workspace?.getLeaf?.(false)?.openFile?.(file);
        } catch (error) {
            logger.warn(`Unable to open file after write: ${path}`, 'ChatController.openFileFromToolResult', error);
        }
    }

    /**
     * 消息列表的唯一创建入口(ADR 0002)。
     *
     * 任何地方另建一条 ChatMessage,都会得到另一个 id——宿主的投影渲染操作栏、
     * 本列表解析反馈,两边就再也对不上。所以 id 只在此处生成一次。
     */
    private addMessage(
        role: 'user' | 'ai' | 'system',
        content: string,
        approval?: ApprovalRequest,
        extra?: MessageAddedOptions & {
            sessionEntryId?: string;
            metadata?: ChatMessage['metadata'];
        },
    ): ChatMessage {
        const msg: ChatMessage = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            role,
            content,
            timestamp: Date.now(),
            approval,
            sessionEntryId: extra?.sessionEntryId,
            metadata: extra?.metadata,
        };
        this.messages.push(msg);
        if (this.onMessageAdded) {
            this.onMessageAdded(msg, { alreadyRendered: extra?.alreadyRendered === true });
        }
        return msg;
    }

    /**
     * 记录一条流式 ai 回复。正文已随 text_delta 上屏,故标 alreadyRendered——
     * 宿主只把它写进投影,不再画第二遍(ADR 0002)。
     * 终态(outcome)与失败原因随消息持久化,回放时才能还原失败/取消,而不是默认成功。
     * @returns 新消息 id,供失败卡片按消息定位重试现场。
     */
    private recordStreamedReply(
        text: string,
        options: {
            assistantEntryId?: string;
            interrupted?: boolean;
            outcome?: ChatTurnOutcome;
            failureReason?: string;
        } = {},
    ): string {
        const metadata: ChatMessage['metadata'] = {};
        if (options.outcome) metadata.outcome = options.outcome;
        if (options.failureReason) metadata.failureReason = options.failureReason;
        if (options.interrupted) metadata.interrupted = true;
        const msg = this.addMessage('ai', text, undefined, {
            sessionEntryId: options.assistantEntryId,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            alreadyRendered: true,
        });
        return msg.id;
    }

    private addApprovalMessage(request: ApprovalRequest) {
        const enriched: ApprovalRequest = {
            ...request,
            id: request.id || createApprovalRequestId(),
            conversationId: request.conversationId ?? this.conversationId,
        };
        this.addMessage('system', enriched.message, enriched);
    }

    private setResponding(status: boolean) {
        // this.isResponding = status;
        if (this.onStatusChanged) {
            this.onStatusChanged(status);
        }
    }

    private handleError(error: unknown) {
        logger.error('Chat error', error, 'ChatController');
        let msg = 'Unknown error occurred.';
        const message = thrownMessage(error);
        if (message) msg = message;
        this.addMessage('system', `Error: ${msg}`);
    }

    private isAbortError(error: unknown): boolean {
        // 与旧实现 `error?.name === 'AbortError'` 对齐：对象与函数抛出值都按 name 识别。
        return (typeof error === 'object' && error !== null || typeof error === 'function')
            && 'name' in error && error.name === 'AbortError';
    }

    private normalizeContextItems(context: ChatContextItem[] | string): ChatContextItem[] {
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
     * 后台执行 file-back，不阻塞 UI
     * 手动模式（👍 按钮）和自动模式共用
     */
    private async runFileBackInBackground(msgId: string) {
        const targetMsg = this.messages.find(m => m.id === msgId && m.role === 'ai');
        if (!targetMsg) return;

        const toolRegistry = (this.app as AppWithPluginHost).plugins?.plugins?.[PLUGIN_ID]?.toolRegistry;
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
            } catch (error: unknown) {
                logger.error('File-back failed', error, 'ChatController');
                this.addMessage('system', `Archive failed: ${thrownMessage(error) || 'Unknown error'}`);
                return;
            }
        }

        const fileBackPrompt = `用户对以下回答点赞，请将其归档到知识库。使用 file_back_knowledge 工具，提取标题和核心内容，并提取相关的 topics 主题标签。\n\n回答内容：\n${targetMsg.content}`;
        this.api.chat(fileBackPrompt, [], '').then(() => {
            this.addMessage('system', 'Archived to the knowledge wiki.');
        }).catch((error: unknown) => {
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
     * 自动 file-back 已移除：改为 AI 在 query_knowledge 流程中自主判断是否调用 file_back_knowledge
     * 手动模式保留：用户点赞（👍）时通过 /file-back 命令触发
     */

    /**
     * /wiki:compile [path] — 编译笔记到知识 wiki
     * 无参数：编译当前笔记 + 所有 pending
     * 文件路径：编译指定文件
     * 目录路径：扫描目录下所有 .md 注册并编译
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
            await this.renderMemoryView({ mode, limit: 10 }, note);
            return;
        }

        if (legacyCommand === '/profile') {
            await this.renderMemoryView({ mode: 'overview', limit: 10 }, note);
            return;
        }

        this.addMessage('system', 'Usage: `/memory [overview|observations|search <query>|forget <field|all>]`');
    }

    private async renderMemoryView(request: MemoryViewRequest, prefix: string = '') {
        if (typeof this.api.getMemoryView !== 'function') {
            this.addMessage('system', `${prefix}No memory data available.`);
            return;
        }

        const view = await this.api.getMemoryView(request);
        if (!view) {
            this.addMessage('system', `${prefix}No memory data available.`);
            return;
        }

        this.addMessage('system', `${prefix}${this.formatMemoryView(view, request)}`);
    }

    private formatMemoryView(view: MemoryView, request: MemoryViewRequest): string {
        const stats: Partial<MemoryStats> = view.stats || {};
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

    private appendMemoryRecords(lines: string[], title: string, records: MemoryRecord[], showMeta: boolean) {
        lines.push('', `### ${title}`);
        if (!records || records.length === 0) {
            lines.push('- No matching memories.');
            return;
        }

        for (const record of records) {
            const text = this.truncateMemoryText(record.text || '', 220);
            const meta = showMeta
                ? ` _(id: ${record.id}, type: ${record.type}, confidence: ${Number(record.confidence || 0).toFixed(2)}${this.formatProvenance(record)})_`
                : ` _(${this.formatProvenance(record).replace(/^, /, '')})_`;
            lines.push(`- ${text}${meta}`);
        }
    }

    /**
     * 溯源(provenance):把每条记忆的来源与时间透出,回答"这条为什么被记住/何时记的"。
     * 数据已在 record 上(source.kind / mentionedAt),此前从不展示。返回以 ", " 开头的片段(便于拼接)。
     */
    private formatProvenance(record: MemoryRecord): string {
        const parts: string[] = [];
        const kind = record?.source?.kind;
        if (kind) {
            // 来源类型 → 人类可读标签。
            const label: Record<string, string> = {
                chat: '对话', tool: '工具', manual: '归纳',
                'profile-migration': '迁移', 'summary-migration': '迁移',
            };
            parts.push(`来源: ${label[kind] || kind}`);
        }
        const ts = record?.mentionedAt ?? record?.createdAt;
        if (typeof ts === 'number' && ts > 0) {
            parts.push(`记于 ${this.formatRelativeTime(ts)}`);
        }
        if (record?.supersedes?.length) {
            parts.push('已更新过');
        }
        return parts.length > 0 ? `, ${parts.join(', ')}` : '';
    }

    /** 相对时间:今天/N天前/N月前,便于用户快速判断记忆新旧。 */
    private formatRelativeTime(ts: number): string {
        const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
        if (days <= 0) return '今天';
        if (days === 1) return '昨天';
        if (days < 30) return `${days} 天前`;
        if (days < 365) return `${Math.floor(days / 30)} 个月前`;
        return `${Math.floor(days / 365)} 年前`;
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

        // 遗留 UserProfile 已退役(#6):/forget 现在只作用于 Hindsight 记忆。
        // 旧实现还会 updateProfile 清空 profile 字段,但那是 write-only 死状态、对召回零影响,一并删除。
        if (typeof this.api.forgetMemory !== 'function') {
            this.addMessage('system', `${compatibilityNote}No user memory data available.`);
            return;
        }

        const validFields = ['all', 'name', 'profession', 'expertise', 'preferences', 'workflows', 'projects', 'goals'];
        if (!validFields.includes(f)) {
            this.addMessage('system', `${compatibilityNote}Unknown field: ${f}\nForgettable fields: name, profession, expertise, preferences, workflows, projects, goals, all`);
            return;
        }

        const result = await this.api.forgetMemory(f);
        const fallback = f === 'all' ? 'Cleared all remembered user data.' : `Forgot memory field: ${f}`;
        this.addMessage('system', `${compatibilityNote}${result?.message || fallback}`);
    }

    private async handleNewNote(argStr: string) {
        if (!argStr.trim()) {
            this.addMessage('system', t('Usage: `/new <title>` or `/new <title> <content>`'));
            return;
        }
        const firstNewline = argStr.indexOf('\n');
        const title = firstNewline > 0 ? argStr.substring(0, firstNewline).trim() : argStr.trim();
        const content = firstNewline > 0 ? argStr.substring(firstNewline + 1) : '';
        const path = `${title}.md`;

        try {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing) {
                this.addMessage('system', `${t('File already exists:')} ${path}`);
                return;
            }
            const file = await this.app.vault.create(path, content);
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            this.addMessage('system', `${t('Created and opened:')} [[${path}]]`);
        } catch (e: unknown) {
            this.addMessage('system', `${t('Failed to create:')} ${thrownMessage(e)}`);
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
            const result = await this.api.chat(
                instruction,
                [],
                selection,
                'slash-edit',
            );
            this.addMessage('ai', result);
        } catch (e: unknown) {
            this.addMessage('system', `${t('Edit failed:')} ${thrownMessage(e)}`);
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
        const skillCommands = typeof this.api.getSkillCommands === 'function'
            ? this.api.getSkillCommands()
            : [];

        let help = `## Shell Commands\n\n`;
        help += localCommands
            .map((entry) => `- \`${entry.command}\` — ${entry.description}`)
            .join('\n');

        if (skillCommands.length > 0) {
            help += `\n\n## Skill Commands\n\n`;
            help += skillCommands
                .map((entry) => `- \`${entry.command}\` — ${entry.description}`)
                .join('\n');
        }

        // 用户自定义命令(.obsidian/baizer-commands/*.md)。同步快照,启动预热后有值。
        const userCommands = typeof this.api.getUserCommandsSync === 'function'
            ? this.api.getUserCommandsSync()
            : [];
        if (userCommands.length > 0) {
            help += `\n\n## User Commands\n\n`;
            help += userCommands
                .map((entry) => `- \`${entry.command}\` - ${entry.description}`)
                .join('\n');
        }

        help += `\n\nType \`/\` to browse commands and \`@\` to mention files.`;
        this.addMessage('system', help);
    }

    private async handleWikiCompile(pathArg: string) {
        const path = pathArg.trim();
        const plugin = (this.app as AppWithPluginHost).plugins?.plugins?.[PLUGIN_ID];
        const runtime = plugin?.knowledgeRuntime;

        if (!runtime) {
            this.addMessage('system', 'Knowledge system is not initialized.');
            return;
        }

        this.setResponding(true);
        try {
            if (!path) {
            // 无参数：编译当前笔记 + 所有 pending
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.addMessage('system', `${t('Compiling:')} ${activeFile.path}...`);
                    const r = await runtime.compileByPath(activeFile.path);
                    this.addMessage('system', `${t('Done: registered')} ${r.registered}, ${t('succeeded')} ${r.success}, ${t('failed')} ${r.failed}`);
                }
                    // 再编译所有 pending，带进度回调避免 heartbeat 误报
                const maxBatch = runtime.settings.knowledgeMaxCompileBatch || 50;
                const result = await runtime.compiler.compileAllPending(maxBatch, (current: number, total: number, noteId: string) => {
                    this.addMessage('system', `[${current}/${total}] ${t('Compiling:')} ${noteId}`);
                });
                if (result.success > 0) {
                    await runtime.indexer.rebuildIndex();
                }
                this.addMessage('system', `${t('Batch compile done:')} ${result.success} ${t('succeeded')}, ${result.failed} ${t('failed')}`);
            } else {
                this.addMessage('system', `${t('Compiling:')} ${path}...`);
                const r = await runtime.compileByPath(path);
                this.addMessage('system', `${t('Done: registered')} ${r.registered}, ${t('succeeded')} ${r.success}, ${t('failed')} ${r.failed}`);
            }
        } catch (e: unknown) {
            this.addMessage('system', `${t('Compile failed:')} ${thrownMessage(e)}`);
        } finally {
            this.setResponding(false);
        }
    }
}


/**
 * 审批请求身份：时间戳 + 随机后缀，随消息投影持久化。
 * 不用数组下标/消息 id，因为请求在会话快照里要独立于 presentation 存在。
 */
function createApprovalRequestId(): string {
    return `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
