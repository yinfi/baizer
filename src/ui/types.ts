import { ApprovalRequest } from './approval-card';
import type { App } from 'obsidian';
import type { KnowledgeRuntime } from '../knowledge/runtime';
import type { ChatTurnOutcome } from '../models/interfaces';
import type { ApprovalState } from '../services/approval-execution';
import type { WorkspaceEditSummary } from '../services/workspace-edit-service';
import type { ChangePreview } from './diff/change-preview';

export type ShellMessageRole = 'user' | 'ai' | 'system';

export interface ChatMessage {
    id: string;
    role: ShellMessageRole;
    content: string;
    timestamp: number;
    /**
     * 该消息在 pi 会话树中对应的 entry id(阶段B:entryId 锚定)。
     * user 与 ai 消息各自锚定本轮落盘的 user/assistant entry。
     * 是阶段C 分叉/重试(从某消息对应的 entry 用 navigateTree 派生新分支)的定位依据。
     * 无持久会话/历史消息/未锚定时缺省。
     */
    sessionEntryId?: string;
    /**
     * 分支导航信息(阶段C):仅投影历史分支时,给「有兄弟分支的 user 消息」附上,
     * 供 UI 渲染 `< index/count >` 并切换。leafIds[k] 是切到第 k 个兄弟时要 moveTo 的目标 leaf entry。
     * count<=1 或非分叉点时缺省。
     */
    branch?: { index: number; count: number; leafIds: string[] };
    /**
     * 分叉源问题文本(阶段C):ai 消息上携带其对应的 user 提问原文,
     * 供底部「分叉」输入预填。由 shell-view 在渲染 ai 操作栏前就近填充。
     */
    forkSourceText?: string;
    feedback?: 'up' | 'down' | null;
    approval?: ApprovalRequest;
    /**
     * 审批生命周期快照。请求(presentation)与结果分开持久化：
     * 切换 tab / 销毁视图后重新挂载时，卡片仍能从消息投影恢复成
     * pending / running / succeeded / failed / rejected / unknown。
     */
    approvalState?: ApprovalState;
    metadata?: {
        providerId?: string;
        modelId?: string;
        durationMs?: number;
        /**
         * 本轮终态。completed / failed / cancelled 与 StreamEvent 同源，
         * 随消息一起持久化，切换会话/重开视图/刷新后仍能还原终态，不把失败画成成功。
         * 缺省（历史消息）按 completed 处理。
         */
        outcome?: ChatTurnOutcome;
        /** 失败原因（outcome === 'failed' 时存在），随消息持久化，回放时仍需可见。 */
        failureReason?: string;
        interrupted?: boolean;
        workspaceEdit?: WorkspaceEditSummary;
    };
}

export interface ToolRunState {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'error' | 'approval_required';
    input: Record<string, unknown>;
    result?: unknown;
    error?: string;
    startedAt: number;
    finishedAt?: number;
}

export interface ConversationSnapshot {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    providerId: string;
    modelId: string;
    messages: ChatMessage[];
    currentNote?: string;
    pinnedAt?: number;
}

/**
 * `file_back_knowledge` 的返回契约。
 * `ToolRegistry.execute` 声明为 `Promise<any>`,这里收窄为归档流程实际消费的字段。
 */
export interface FileBackToolResult {
    success?: boolean;
    path?: string;
    error?: string;
}

/** file-back 调用点用到的最小工具注册表契约。 */
export interface FileBackToolRegistry {
    execute(name: string, args: unknown): Promise<FileBackToolResult>;
}

/**
 * Baizer 宿主插件实例中 UI 层需要读取的成员。
 * 与 main.ts 的 `BaizerPlugin` 字段对应(知识运行时可能尚未初始化,故可为 null)。
 */
export interface BaizerPluginHost {
    knowledgeRuntime?: KnowledgeRuntime | null;
    toolRegistry?: FileBackToolRegistry;
}

/** Obsidian 未公开 `App.plugins` 注册表的类型,这里只声明本项目读取的路径。 */
interface AppWithPluginRegistry {
    plugins?: {
        plugins?: Record<string, BaizerPluginHost | undefined>;
    };
}

/**
 * 从 Obsidian 内部插件注册表取回 Baizer 插件实例。
 * 这是 UI 层读取 `app.plugins.plugins[PLUGIN_ID]` 的唯一入口,避免散落的 `as any`。
 * 注册表缺失(非官方运行时/测试桩)时返回 undefined,调用方按「未初始化」处理。
 */
export function getBaizerPluginHost(app: App, pluginId: string): BaizerPluginHost | undefined {
    return (app as App & AppWithPluginRegistry).plugins?.plugins?.[pluginId];
}

/**
 * UI 层读取工具结果的契约。
 *
 * 运行时来源(`StreamEvent['tool_result'].result`、`ToolRegistry.execute`)仍是 `any`
 * ——工具结果形态由各工具自己定义。这里集中声明宿主实际读取的字段,调用方在边界处
 * 一次性收窄,后续成员访问即受类型保护,不必逐个 `as any`。
 * 除 `workspaceEdit` 外的字段都可能缺省,读取方需自行回退。
 */
export interface ToolResultView {
    success?: boolean;
    status?: string;
    error?: string;
    message?: string;
    path?: string;
    target?: string;
    /** 写入类工具落盘后回传的 workspace 编辑摘要(供撤销/打开落盘文件)。 */
    workspaceEdit?: WorkspaceEditSummary;
    /** 审批请求载荷的判别位。 */
    approval_required?: boolean;
    /** 审批请求身份(登记表键)。 */
    requestId?: string;
    /** 审批动作名与作用对象。 */
    action?: string;
    /** 审批动作参数。 */
    args?: Record<string, unknown>;
    /** 审批预览。 */
    preview?: ChangePreview;
}

/**
 * `approval_required` 为真时的工具结果:此时 `action` / `target` 由工具保证存在,
 * 可直接写入 `ApprovalRequest`(与旧实现 `result.action` 的取值语义一致)。
 */
export type ApprovalRequiredToolResult = ToolResultView & {
    approval_required: true;
    action: string;
    target: string;
};

/**
 * 判别一次工具结果是否为审批请求。
 * 与原 `if (!result?.approval_required) return null` 的运行时语义完全一致(真值判断)。
 */
export function isApprovalRequiredResult(
    result: ToolResultView | null | undefined,
): result is ApprovalRequiredToolResult {
    return !!result?.approval_required;
}

/**
 * 兼容测试桩/旧调用方返回的「裸工具结果」:没有 `kind` 判别字段,
 * 靠 `success` / `status` 判断成败。与 `ApprovalExecutionOutcome` 组成联合后,
 * `kind === 'approval-execution'` 即可把两者分开。
 */
export type LegacyApprovalToolResult = ToolResultView & { kind?: undefined };
