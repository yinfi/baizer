/**
 * 聊天滚动跟随策略（issue #64）。
 *
 * 责任边界：本模块只决定「什么时候滚、滚到哪里」以及每个会话的跟随/未读/位置状态，
 * 不碰 DOM 渲染。宿主（ShellView）在内容增长前后调用 captureGrowth / afterGrowth，
 * 在滚动事件时调用 handleScroll，在切换会话时调用 prepareForSessionSwitch /
 * activateSession。
 *
 * 两条不可退让的规则：
 * 1. 是否跟随看「内容增长前」的快照（近底 + 跟随），绝不能在内容变高后重新用新高度
 *    判断「用户原来是否在底部」——那会把读者上翻后仍算作跟随，直接拉回底部。
 * 2. 延迟滚动必须绑定发起时的会话身份与渲染代次。tab 切换或新一轮渲染后，旧回调只能丢弃，
 *    不能滚动新会话的视口。
 *
 * 恢复阶段（activateSession 到恢复定时器执行之间）收到的 scroll 一律当成布局产物：
 * 只忽略，不改跟随/未读/阅读位置；只有真实输入（handleUserScrollIntent*）才取消恢复。
 */

/** 距底小于该值视为「接近底部」，允许恢复自动跟随。 */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

/** 内容增长后的跟随滚动延迟：让同帧 DOM 变更落地后再读 scrollHeight。 */
const FOLLOW_SCROLL_DELAY_MS = 0;

/** 切换/重建会话后恢复阅读位置的延迟：等异步 Markdown 渲染把高度补上。 */
const RESTORE_POSITION_DELAY_MS = 50;

/** 恢复落位被 clamp 时最多顺延重试的次数（高度可能还在异步长出来）。 */
const RESTORE_RETRY_LIMIT = 2;

export interface ScrollMetrics {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

export interface ScrollContainer extends ScrollMetrics {
    /** 与 HTMLElement.scrollTo 兼容；测试替身只需实现实际用到的签名。 */
    scrollTo?: (options?: ScrollToOptions) => void;
}

export type RestorePhase = 'idle' | 'restoring';

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
    /**
     * 激活后的位置恢复阶段。'restoring' 期间出现的 scroll 只可能是布局、切 tab 或
     * scrollTop clamp 的产物，不是用户意图：既不能取消恢复，也不能改写跟随/未读。
     */
    restorePhase: RestorePhase;
    /** 待恢复的目标；被真实输入取消后仍保留，普通点击未移动视口时可重放。 */
    restoreTarget: number | 'bottom' | null;
    /** 真实输入取消恢复时的 scrollTop；pointerup/touchend 未移动视口时据此重放。 */
    restoreIntentTop: number | null;
}

/** 内容增长前捕获的状态快照。增长后回调必须带上它，过期即丢弃。 */
export interface GrowthToken {
    sessionId: string;
    /** 增长前是否已在近底区：决定这次增长后要不要贴底。 */
    nearBottom: boolean;
    /** 增长前是否处于自动跟随。 */
    following: boolean;
    /** 宿主渲染代次：异步渲染完成时若代次已变，token 已过期。 */
    renderGeneration: number;
}

export type SessionActivationMode = 'new' | 'restore';

export interface ScrollFollowControllerOptions {
    getContainer: () => ScrollContainer | null;
    /** 未读状态变化通知；宿主只在 id 仍是活动会话时更新入口 UI。 */
    onUnreadChange?: (sessionId: string, unread: boolean) => void;
    /** 宿主的流式渲染代次；异步回调据此判断自己是否已过期。 */
    getRenderGeneration?: () => number;
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
        restorePhase: 'idle',
        restoreTarget: null,
        restoreIntentTop: null,
    };
}

export class ScrollFollowController {
    private readonly sessions = new Map<string, ScrollSessionState>();
    private readonly timers = new Map<string, unknown>();
    private activeSessionId: string | null = null;
    private disposed = false;

    private readonly getContainer: () => ScrollContainer | null;
    private readonly onUnreadChange?: (sessionId: string, unread: boolean) => void;
    private readonly getRenderGeneration?: () => number;
    private readonly schedule: (callback: () => void, delayMs: number) => unknown;
    private readonly cancel: (handle: unknown) => void;
    private readonly restoreDelayMs: number;

    constructor(options: ScrollFollowControllerOptions) {
        this.getContainer = options.getContainer;
        this.onUnreadChange = options.onUnreadChange;
        this.getRenderGeneration = options.getRenderGeneration;
        this.schedule = options.schedule
            ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
        this.cancel = options.cancel
            ?? ((handle) => window.clearTimeout(handle as number));
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
     * 内容增长前调用。token 快照「增长前」的会话身份、是否近底、是否跟随与渲染代次：
     * 增长本身会改变距底距离，增长后再用新高度回判会把上翻的读者误拉回底部。
     */
    captureGrowth(): GrowthToken | null {
        if (this.disposed || !this.activeSessionId) return null;
        const state = this.sessions.get(this.activeSessionId);
        const metrics = this.readMetrics();
        return {
            sessionId: this.activeSessionId,
            nearBottom: metrics ? isNearBottom(metrics) : false,
            following: state?.following ?? true,
            renderGeneration: this.renderGeneration(),
        };
    }

    /**
     * 内容增长后调用。
     * - 增长前近底且跟随、此刻仍跟随：安排滚到底。
     * - 否则不回滚；markUnread 的新输出点亮返回入口。
     * 过期会话/过期渲染代次（切换 tab 或新一轮渲染后的旧回调）直接丢弃。
     */
    afterGrowth(token: GrowthToken | null, options: { markUnread?: boolean } = {}): void {
        if (!token || this.disposed) return;
        if (token.sessionId !== this.activeSessionId) return;
        if (token.renderGeneration !== this.renderGeneration()) return;
        const state = this.sessions.get(token.sessionId);
        if (!state) return;

        if (token.following && token.nearBottom && state.following) {
            this.scheduleFollowScroll(token.sessionId);
            return;
        }
        if (!options.markUnread) return;
        // 增长前已离开近底区却仍挂着 following：布局变化（图片延迟加载、块折展）
        // 把读者带离了底部，这里如实暂停跟随，让下一次输出也不会再贴底。
        if (state.following && !token.nearBottom) state.following = false;
        if (!state.following) this.setUnread(token.sessionId, true);
    }

    /**
     * 真实输入（可滚动区域的 wheel / touchstart / keydown / pointerdown）到达。
     * 若位置恢复尚未执行，取消它；恢复阶段本身的布局 scroll 不走这里。
     */
    handleUserScrollIntent(): void {
        if (this.disposed) return;
        const state = this.activeState();
        if (!state || state.restorePhase !== 'restoring') return;
        state.restoreBlocked = true;
        state.restorePhase = 'idle';
        const metrics = this.readMetrics();
        state.restoreIntentTop = metrics ? metrics.scrollTop : null;
        this.cancelTimer(this.activeSessionId as string);
    }

    /**
     * 真实输入结束（pointerup / touchend）。若这次交互没有移动视口（普通点击、选文本、
     * 点链接），把被取消的恢复重新排队，避免读者停在被 clamp 的默认位置。
     */
    handleUserScrollIntentEnd(): void {
        if (this.disposed) return;
        const sessionId = this.activeSessionId;
        if (!sessionId) return;
        const state = this.sessions.get(sessionId);
        if (!state || state.restoreIntentTop == null || state.restoreTarget == null) return;
        const startTop = state.restoreIntentTop;
        state.restoreIntentTop = null;
        const metrics = this.readMetrics();
        if (!metrics) return;
        if (Math.abs(metrics.scrollTop - startTop) > 0.5) return;
        state.restoreBlocked = false;
        state.restorePhase = 'restoring';
        this.scheduleRestore(sessionId, state.restoreTarget);
    }

    /** 用户明确向上滚动（滚轮上推）时立即暂停，不等 scroll 事件追上。 */
    handleUserScrollIntentUp(): void {
        if (this.disposed) return;
        const state = this.activeState();
        if (!state) return;
        state.following = false;
        state.restoreBlocked = true;
        state.restorePhase = 'idle';
        state.restoreIntentTop = null;
        this.cancelTimer(this.activeSessionId as string);
    }

    /**
     * 滚动事件处理。
     * - 恢复阶段（激活后到位置落定前）：布局、切 tab、内容变短 clamp 都会产生 scroll，
     *   不能当成用户意图——只忽略，恢复与跟随/未读保持不变。
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

        // 恢复尚未执行：期间的 scroll 只可能是布局产物，不更新保存位置、不改跟随/未读。
        if (state.restorePhase === 'restoring') return;

        // 任何向下的 scrollTop 减少都是读者的上翻意图；程序化贴底只会让 scrollTop 变大。
        const movedUp = metrics.scrollTop < state.scrollTop - 0.5;
        state.scrollTop = metrics.scrollTop;

        if (movedUp) {
            state.following = false;
            // 切回会话后位置恢复不应覆盖用户刚做出的上翻。
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
        state.restorePhase = 'idle';
        state.restoreTarget = null;
        state.restoreIntentTop = null;
        this.cancelTimer(this.activeSessionId);
        this.applyScrollTop(this.maxScrollTop());
        this.setUnread(this.activeSessionId, false);
        // 内容可能还在异步渲染，下一拍再贴一次底（跟随中，允许）。
        this.scheduleFollowScroll(this.activeSessionId);
    }

    /**
     * 切换会话前调用：把当前可见位置记到活动会话上。
     * 跟随中的会话记为底部（切回时继续贴底）；暂停中的会话记为精确 scrollTop（恢复阅读锚点）。
     * 若该会话的位置恢复还没执行，保留待恢复的锚点，不被过渡布局位置覆盖。
     */
    prepareForSessionSwitch(): void {
        if (this.disposed || !this.activeSessionId) return;
        const state = this.sessions.get(this.activeSessionId);
        const metrics = this.readMetrics();
        if (!state || !metrics) return;
        state.initialized = true;
        if (state.restorePhase === 'restoring') return;
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
        state.restorePhase = 'restoring';

        const target = mode === 'new' || !hadPosition
            ? 'bottom' as const
            : state.following ? 'bottom' as const : state.scrollTop;
        state.restoreTarget = target;
        state.restoreIntentTop = null;

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

    private scheduleRestore(sessionId: string, target: number | 'bottom', attempt = 0): void {
        this.cancelTimer(sessionId);
        this.timers.set(sessionId, this.schedule(() => {
            this.timers.delete(sessionId);
            const state = this.sessions.get(sessionId);
            // 先结束恢复阶段再判活动/阻断，避免该会话残留 'restoring'。
            if (state) state.restorePhase = 'idle';
            if (this.disposed || this.activeSessionId !== sessionId || !state) return;
            if (state.restoreBlocked) return;
            this.applyScrollTop(target === 'bottom' ? this.maxScrollTop() : target);
            if (target === 'bottom') {
                state.restoreTarget = null;
                state.restoreIntentTop = null;
                return;
            }
            const metrics = this.readMetrics();
            // 目标位置比当前 max 更靠下：内容高度还没长够，落位被 clamp。顺延一拍重试。
            if (metrics && metrics.scrollTop < target - 2 && attempt < RESTORE_RETRY_LIMIT) {
                state.restorePhase = 'restoring';
                this.scheduleRestore(sessionId, target, attempt + 1);
                return;
            }
            state.restoreTarget = null;
            state.restoreIntentTop = null;
        }, this.restoreDelayMs));
    }

    private renderGeneration(): number {
        return this.getRenderGeneration?.() ?? 0;
    }

    /**
     * 同一 tick 内多次内容增长只安排一次贴底：timers 以会话为键，
     * 已有待执行回调时直接复用，避免逐块渲染把视口反复拉到底。
     */
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
