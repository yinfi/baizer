/**
 * 聊天滚动跟随策略（issue #64）。
 *
 * 责任边界：本模块只决定「什么时候滚、滚到哪里」以及每个会话的跟随/未读/位置状态，
 * 不碰 DOM 渲染。宿主（ShellView）在内容增长前后调用 captureGrowth / afterGrowth，
 * 在滚动事件时调用 handleScroll，在切换会话时调用 prepareForSessionSwitch /
 * activateSession。
 *
 * 两条不可退让的规则：
 * 1. 是否跟随看「内容增长前」的跟随状态，绝不能在内容变高后重新用新高度判断
 *    「用户原来是否在底部」——那会把读者上翻后仍算作跟随，直接拉回底部。
 * 2. 延迟滚动必须绑定发起时的会话身份。tab 切换后，旧会话遗留的回调只能丢弃，
 *    不能滚动新会话的视口。
 */

/** 距底小于该值视为「接近底部」，允许恢复自动跟随。 */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

/** 内容增长后的跟随滚动延迟：让同帧 DOM 变更落地后再读 scrollHeight。 */
const FOLLOW_SCROLL_DELAY_MS = 0;

/** 切换/重建会话后恢复阅读位置的延迟：等异步 Markdown 渲染把高度补上。 */
const RESTORE_POSITION_DELAY_MS = 50;

export interface ScrollMetrics {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

export interface ScrollContainer extends ScrollMetrics {
    /** 与 HTMLElement.scrollTo 兼容；测试替身只需实现实际用到的签名。 */
    scrollTo?: (options?: ScrollToOptions) => void;
}

export interface ScrollSessionState {
    /** 自动跟随新输出。用户主动上翻立即置 false，点「回到最新」或滚回近底恢复。 */
    following: boolean;
    /** 暂停跟随后确有新输出到达。只有它为 true 时才显示返回入口。 */
    unread: boolean;
    /** 上次记录的阅读位置（scrollTop）。切换会话/重建 DOM 后据此恢复。 */
    scrollTop: number;
    initialized: boolean;
    /** 本次激活后用户已主动上翻：待执行的「恢复位置」不能再把读者拉回去。 */
    restoreBlocked: boolean;
    /** 激活后的位置恢复仍在队列里；期间任何外部滚动都视为用户意图。 */
    restorePending: boolean;
}

/** 内容增长前捕获的会话身份。增长后回调必须带上它，过期即丢弃。 */
export interface GrowthToken {
    sessionId: string;
}

export type SessionActivationMode = 'new' | 'restore';

export interface ScrollFollowControllerOptions {
    getContainer: () => ScrollContainer | null;
    /** 未读状态变化通知；宿主只在 id 仍是活动会话时更新入口 UI。 */
    onUnreadChange?: (sessionId: string, unread: boolean) => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    /** 恢复位置的延迟，默认 50ms；测试可设 0。 */
    restoreDelayMs?: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
    return metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
}

export function isNearBottom(
    metrics: ScrollMetrics,
    thresholdPx: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
    return distanceFromBottom(metrics) <= thresholdPx;
}

export function createScrollSessionState(): ScrollSessionState {
    return {
        following: true,
        unread: false,
        scrollTop: 0,
        initialized: false,
        restoreBlocked: false,
        restorePending: false,
    };
}

export class ScrollFollowController {
    private readonly sessions = new Map<string, ScrollSessionState>();
    private readonly timers = new Map<string, unknown>();
    private activeSessionId: string | null = null;
    private disposed = false;

    private readonly getContainer: () => ScrollContainer | null;
    private readonly onUnreadChange?: (sessionId: string, unread: boolean) => void;
    private readonly schedule: (callback: () => void, delayMs: number) => unknown;
    private readonly cancel: (handle: unknown) => void;
    private readonly restoreDelayMs: number;

    constructor(options: ScrollFollowControllerOptions) {
        this.getContainer = options.getContainer;
        this.onUnreadChange = options.onUnreadChange;
        this.schedule = options.schedule
            ?? ((callback, delayMs) => (typeof window !== 'undefined'
                ? window.setTimeout(callback, delayMs)
                : setTimeout(callback, delayMs)));
        this.cancel = options.cancel
            ?? ((handle) => {
                if (typeof window !== 'undefined') window.clearTimeout(handle as number);
                else clearTimeout(handle as unknown as NodeJS.Timeout);
            });
        this.restoreDelayMs = options.restoreDelayMs ?? RESTORE_POSITION_DELAY_MS;
    }

    getActiveSessionId(): string | null {
        return this.activeSessionId;
    }

    getSessionState(sessionId: string): ScrollSessionState | null {
        return this.sessions.get(sessionId) ?? null;
    }

    isFollowing(): boolean {
        return this.activeState()?.following ?? true;
    }

    hasUnread(): boolean {
        return this.activeState()?.unread ?? false;
    }

    /**
     * 内容增长前调用。返回的 token 只携带会话身份：增长后的滚动由当时的跟随状态决定，
     * 不重新测量距底距离。
     */
    captureGrowth(): GrowthToken | null {
        if (this.disposed || !this.activeSessionId) return null;
        return { sessionId: this.activeSessionId };
    }

    /**
     * 内容增长后调用。
     * - 跟随中：安排滚到底。
     * - 已暂停：不回滚；只有 markUnread 的新输出才点亮返回入口。
     * 过期会话（切换 tab 后旧回调）直接丢弃。
     */
    afterGrowth(token: GrowthToken | null, options: { markUnread?: boolean } = {}): void {
        if (!token || this.disposed) return;
        if (token.sessionId !== this.activeSessionId) return;
        const state = this.sessions.get(token.sessionId);
        if (!state) return;

        if (state.following) {
            this.scheduleFollowScroll(token.sessionId);
            return;
        }
        if (options.markUnread) this.setUnread(token.sessionId, true);
    }

    /**
     * 活动会话若仍在跟随，安排一次滚到底。用于消息渲染完成等「内容可能已增长」的时机；
     * 暂停时什么都不做，绝不把读者拉回底部。
     */
    followActiveIfEnabled(): void {
        if (this.disposed || !this.activeSessionId) return;
        const state = this.sessions.get(this.activeSessionId);
        if (!state?.following) return;
        this.scheduleFollowScroll(this.activeSessionId);
    }

    /** 用户明确向上滚动（滚轮上推）时立即暂停，不等 scroll 事件追上。 */
    handleUserScrollIntentUp(): void {
        if (this.disposed) return;
        const state = this.activeState();
        if (!state) return;
        state.following = false;
        state.restoreBlocked = true;
    }

    /**
     * 滚动事件处理。
     * - 向上移动（scrollTop 变小）说明读者主动上翻：立即暂停跟随。
     * - 回到近底区（<= 80px）：恢复跟随并清除未读。
     * 程序化滚到底只会让 scrollTop 变大，不会被误判为上翻。
     */
    handleScroll(): void {
        if (this.disposed) return;
        const sessionId = this.activeSessionId;
        if (!sessionId) return;
        const state = this.sessions.get(sessionId);
        const metrics = this.readMetrics();
        if (!state || !metrics) return;

        // 位置恢复尚未执行时收到 scroll 事件：只可能是用户在动视口（恢复本身在回调里
        // 才发生），此时放弃恢复，避免把刚做出的滚动动作拉回去。
        if (state.restorePending) state.restoreBlocked = true;

        // 任何向下的 scrollTop 减少都是读者的上翻意图；程序化贴底只会让 scrollTop 变大。
        const movedUp = metrics.scrollTop < state.scrollTop - 0.5;
        state.scrollTop = metrics.scrollTop;

        if (movedUp) {
            state.following = false;
            // 切回会话后 50ms 内的位置恢复不应覆盖用户刚做出的上翻。
            state.restoreBlocked = true;
            return;
        }

        if (isNearBottom(metrics)) {
            state.following = true;
            this.setUnread(sessionId, false);
        }
    }

    /** 点击「有新输出 · 回到最新」：立即回到底部并恢复跟随。 */
    scrollToLatest(): void {
        if (this.disposed || !this.activeSessionId) return;
        const state = this.sessions.get(this.activeSessionId);
        if (!state) return;

        state.following = true;
        state.restorePending = false;
        this.cancelTimer(this.activeSessionId);
        this.applyScrollTop(this.maxScrollTop());
        this.setUnread(this.activeSessionId, false);
        // 内容可能还在异步渲染，下一拍再贴一次底（跟随中，允许）。
        this.scheduleFollowScroll(this.activeSessionId);
    }

    /**
     * 切换会话前调用：把当前可见位置记到活动会话上。
     * 跟随中的会话记为底部（切回时继续贴底）；暂停中的会话记为精确 scrollTop（恢复阅读锚点）。
     */
    prepareForSessionSwitch(): void {
        if (this.disposed || !this.activeSessionId) return;
        const state = this.sessions.get(this.activeSessionId);
        const metrics = this.readMetrics();
        if (!state || !metrics) return;
        state.initialized = true;
        state.scrollTop = state.following ? this.maxScrollTop(metrics) : metrics.scrollTop;
    }

    /**
     * 会话切换/首次打开后调用。
     * @param mode 'new'=新会话定位到最新；'restore'=恢复已有会话的位置与跟随/未读状态。
     */
    activateSession(sessionId: string, mode: SessionActivationMode = 'restore'): void {
        if (this.disposed) return;
        this.activeSessionId = sessionId;
        const state = this.ensureSession(sessionId);
        // 「首次激活」与「切回已有会话」分开：新会话定位到最新；已知阅读位置按原样恢复，
        // 跟随中的会话直接贴底（期间到达的输出不能把读者留在半途）。
        const hadPosition = state.initialized;
        state.initialized = true;
        state.restoreBlocked = false;
        state.restorePending = true;

        const target = mode === 'new' || !hadPosition
            ? 'bottom' as const
            : state.following ? 'bottom' as const : state.scrollTop;

        if (mode === 'new') {
            state.following = true;
            state.unread = false;
        }

        this.cancelTimer(sessionId);
        this.scheduleRestore(sessionId, target);
        this.notifyUnread(sessionId, state.unread);
    }

    /** 后台会话收到新输出：仅在其仍处于暂停状态时标记未读；跟随中的会话切回时自然贴底。 */
    noteOutputInSession(sessionId: string): void {
        if (this.disposed) return;
        const state = this.sessions.get(sessionId);
        if (!state || state.following) return;
        this.setUnread(sessionId, true);
    }

    /** 关闭 tab 时清掉该会话的状态与待执行回调。 */
    removeSession(sessionId: string): void {
        this.cancelTimer(sessionId);
        this.sessions.delete(sessionId);
        if (this.activeSessionId === sessionId) this.activeSessionId = null;
    }

    /** 视图关闭：丢弃所有待执行回调，关闭后不能再滚动任何会话。 */
    dispose(): void {
        this.disposed = true;
        for (const handle of this.timers.values()) this.cancel(handle);
        this.timers.clear();
        this.sessions.clear();
        this.activeSessionId = null;
    }

    private activeState(): ScrollSessionState | null {
        return this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null;
    }

    private ensureSession(sessionId: string): ScrollSessionState {
        let state = this.sessions.get(sessionId);
        if (!state) {
            state = createScrollSessionState();
            this.sessions.set(sessionId, state);
        }
        return state;
    }

    private setUnread(sessionId: string, unread: boolean): void {
        const state = this.sessions.get(sessionId);
        if (!state || state.unread === unread) return;
        state.unread = unread;
        this.notifyUnread(sessionId, unread);
    }

    private notifyUnread(sessionId: string, unread: boolean): void {
        this.onUnreadChange?.(sessionId, unread);
    }

    private scheduleRestore(sessionId: string, target: number | 'bottom'): void {
        this.timers.set(sessionId, this.schedule(() => {
            this.timers.delete(sessionId);
            if (this.disposed || this.activeSessionId !== sessionId) return;
            const state = this.sessions.get(sessionId);
            if (!state) return;
            state.restorePending = false;
            if (state.restoreBlocked) return;
            this.applyScrollTop(target === 'bottom' ? this.maxScrollTop() : target);
        }, this.restoreDelayMs));
    }

    private scheduleFollowScroll(sessionId: string): void {
        if (this.timers.has(sessionId)) return;
        this.timers.set(sessionId, this.schedule(() => {
            this.timers.delete(sessionId);
            if (this.disposed || this.activeSessionId !== sessionId) return;
            const state = this.sessions.get(sessionId);
            if (!state?.following) return;
            this.applyScrollTop(this.maxScrollTop());
        }, FOLLOW_SCROLL_DELAY_MS));
    }

    private cancelTimer(sessionId: string): void {
        const handle = this.timers.get(sessionId);
        if (handle === undefined) return;
        this.cancel(handle);
        this.timers.delete(sessionId);
    }

    private readMetrics(): ScrollMetrics | null {
        const container = this.getContainer();
        if (!container) return null;
        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };
    }

    private maxScrollTop(metrics: ScrollMetrics | null = this.readMetrics()): number {
        if (!metrics) return 0;
        return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    }

    private applyScrollTop(top: number): void {
        const container = this.getContainer();
        if (!container) return;
        const max = Math.max(0, container.scrollHeight - container.clientHeight);
        const clamped = Math.min(Math.max(0, top), max);
        if (typeof container.scrollTo === 'function') {
            try {
                // 流式跟随必须立即落底（CSS 的 scroll-behavior: smooth 会拖慢 token 跟随）。
                container.scrollTo({ top: clamped, behavior: 'instant' as unknown as ScrollBehavior });
            } catch {
                // 老 webview 不认 instant/选项参数时退回直接赋值。
                container.scrollTop = clamped;
            }
        } else {
            container.scrollTop = clamped;
        }
        const state = this.activeState();
        if (state) state.scrollTop = clamped;
    }
}
