/**
 * scroll-request-scheduler.ts — 把「延迟执行的滚动」绑定到发起它的会话身份上。
 *
 * 旧 bug(issue #64):`scrollToEnd()` 用 `window.setTimeout(fn, 50)` 延迟到下一轮
 * DOM 更新后才读 scrollHeight,但这个延迟回调不知道自己是为哪个 tab 发起的。
 * 如果 50ms 内用户切换了 tab,回调触发时量到的是*新*活动 tab 的几何,却把*旧*
 * tab 的意图(当时一定是「跟随」,因为滚动请求本身就代表有新内容到达)应用到了
 * 新 tab 身上,表现为 A 的尾部活动意外滚动了 B。
 *
 * 本类只做一件事:记录「发起延迟滚动时的会话 id」与「当前激活的会话 id」,
 * 回调触发时两者不一致就整个跳过。它不关心滚动策略本身(近底/跟随/未读那些逻辑
 * 由 ScrollFollowController 负责),纯粹是「延迟任务 + 过期校验」的基础设施,
 * 因此与 ScrollFollowController 分成两个文件,各自可以独立测试。
 */

export interface ScrollRequestSchedulerOptions<SessionId> {
    /** 延迟多久后触发(毫秒)。默认 50,与旧实现一致,给 DOM 更新留出时间。 */
    delayMs?: number;
    /** 当前激活的会话 id。回调触发时会和发起时的 id 比较,不一致则视为过期。 */
    getActiveSessionId: () => SessionId | null;
    /** 到期且未过期时执行的真正滚动动作。 */
    run: (sessionId: SessionId) => void;
}

/**
 * 调度一次延迟滚动,绑定到 `sessionId`。
 *
 * 用法:每个会话自己的滚动请求入口都传自己的 sessionId;调度器在 fire 时重新
 * 问一遍 `getActiveSessionId()`,只有仍然相等才真正执行 `run`。视图切走/标签页
 * 关闭/视图卸载后,只要 `getActiveSessionId()` 不再回传这个 id(或该会话已被
 * dispose,见下方 `ScrollRequestSchedulerRegistry`),过期请求就是安全的空操作。
 */
export class ScrollRequestScheduler<SessionId> {
    private readonly delayMs: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(private readonly sessionId: SessionId, private readonly options: ScrollRequestSchedulerOptions<SessionId>) {
        this.delayMs = options.delayMs ?? 50;
    }

    /** 发起一次延迟滚动请求(幂等地复用同一个 timer——多次调用只需触发一次)。 */
    request(): void {
        if (this.disposed) return;
        if (this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.disposed) return;
            if (this.options.getActiveSessionId() !== this.sessionId) return;
            this.options.run(this.sessionId);
        }, this.delayMs);
    }

    /** 取消挂起的请求(不标记为 disposed,之后仍可再 request)。 */
    cancelPending(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** 会话关闭/视图卸载:取消挂起请求并让该实例永久失效。 */
    dispose(): void {
        this.cancelPending();
        this.disposed = true;
    }
}

/**
 * 按会话 id 持有一批 ScrollRequestScheduler,方便 ShellView 统一管理多 tab。
 */
export class ScrollRequestSchedulerRegistry<SessionId> {
    private readonly schedulers = new Map<SessionId, ScrollRequestScheduler<SessionId>>();

    constructor(private readonly factory: (sessionId: SessionId) => ScrollRequestScheduler<SessionId>) { }

    /** 发起某会话的延迟滚动请求,惰性创建该会话的 scheduler。 */
    request(sessionId: SessionId): void {
        this.getOrCreate(sessionId).request();
    }

    /** 取消某会话挂起的请求,但保留 scheduler(该会话仍可继续用)。 */
    cancelPending(sessionId: SessionId): void {
        this.schedulers.get(sessionId)?.cancelPending();
    }

    /** 该会话已关闭:失效其 scheduler 并从登记表移除。 */
    dispose(sessionId: SessionId): void {
        this.schedulers.get(sessionId)?.dispose();
        this.schedulers.delete(sessionId);
    }

    /** 视图整体卸载:失效所有会话的 scheduler。 */
    disposeAll(): void {
        for (const scheduler of this.schedulers.values()) {
            scheduler.dispose();
        }
        this.schedulers.clear();
    }

    private getOrCreate(sessionId: SessionId): ScrollRequestScheduler<SessionId> {
        let scheduler = this.schedulers.get(sessionId);
        if (!scheduler) {
            scheduler = this.factory(sessionId);
            this.schedulers.set(sessionId, scheduler);
        }
        return scheduler;
    }
}
