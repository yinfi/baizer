/**
 * scroll-follow-controller.ts — 聊天滚动的「跟随策略」(issue #64)。
 *
 * 背景:旧实现里 `ShellView.scrollToEnd()` 无条件把 `scrollTop` 设成 `scrollHeight`,
 * 不管用户是不是正在往上翻阅读历史。本模块把「是否该在新内容到达时跟去底部」从
 * DOM 操作里剥出来,变成一个纯策略对象——不摸 DOM,只吃geometry 快照和滚动事件,
 * 吐出「现在该不该滚」「有没有未读」这两个布尔判断,方便独立单测。
 *
 * 每个会话(tab)拥有自己独立的一个实例——调用方(ShellView)负责按 tabId 维护
 * `Map<TabId, ScrollFollowController>`,这就是 issue 要求的「跟随/未读/阅读位置
 * 按会话隔离」。本类本身不知道 tabId 是什么,隔离是「一个会话一个实例」这件事
 * 自然带来的,不需要类内部再记一份会话标识。
 *
 * 近底判断的锚点问题(验收标准1):不能等内容长高之后再用新的 scrollHeight 去判断
 * 「用户之前是不是在底部」——那时量出来的距离已经被新内容污染。正确做法是把
 * 「是否近底」这件事锚定在*内容增长之前最后一次观测到的几何快照*上:每次真实的
 * 用户滚动事件(`onScroll`)都会用当时的几何更新 `isNearBottom` 这个锚存值;
 * `onContentWillGrow()` 读的是这个存量判断,而不是重新测量。
 *
 * smooth 滚动的干扰(硬约束):`.shell-output-area` 有 `scroll-behavior: smooth`,
 * 代码把 scrollTop 设到底部后,浏览器会在后续若干帧里连续触发 scroll 事件,
 * 中间几何都不是终态。若把这些中间事件当成「用户往上翻」会误暂停刚刚才因为
 * 用户点击「回到最新」或正常跟随而发起的滚动。应对方式:调用方在发起程序化滚动
 * 前调用 `beginProgrammaticScroll()`,期间的 `onScroll()` 调用会被完整忽略
 * (不更新锚存、不触发暂停判断);调用方负责在滚动稳定后调用
 * `endProgrammaticScroll()`(平滑滚动没有现成的"滚动完成"事件,因此按固定时长
 * 的 timer 兜底收尾——更准确的做法是监听 scrollend,但该事件在部分 Obsidian
 * 运行时的 WebView 内核上不可用,固定延时更稳)。
 */

/** 距底小于该阈值(像素)时视为「近底」,新内容到达时继续跟随。 */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

/**
 * 判定「程序化滚动已经到达目标」的像素容差。到达即提前结束忽略窗口,
 * 使紧随其后的真实用户滚动能被立刻识别,不必等满整个兜底时长。
 */
export const PROGRAMMATIC_SCROLL_ARRIVAL_EPSILON_PX = 1;

/** 一次几何测量快照。 */
export interface ScrollGeometry {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

export interface ScrollFollowControllerOptions {
    /** 初始是否跟随到底部;新会话传 true,因为一个新会话理应从底部开始。 */
    initialFollowing?: boolean;
    /** 判定「近底」的距离阈值(像素),默认 NEAR_BOTTOM_THRESHOLD_PX。 */
    thresholdPx?: number;
}

/**
 * 单个会话的滚动跟随策略。不持有/操作任何 DOM 节点,调用方把测到的几何与滚动
 * 事件喂给它,它吐出「现在该不该把视口贴到底部」「要不要显示未读提示」。
 */
export class ScrollFollowController {
    private readonly thresholdPx: number;
    private following: boolean;
    /** 内容增长前最后一次观测到的「是否近底」——近底判断的锚点,不随增长重算。 */
    private latchedNearBottom: boolean;
    private unread = false;
    /** >0 时处于程序化滚动期间,期间的 onScroll 一律忽略(平滑滚动中间帧的噪声)。 */
    private programmaticScrollDepth = 0;
    /** 本次程序化滚动期望落到哪个 scrollTop;用于「到达即提前解除忽略」判断。 */
    private programmaticScrollTarget: number | null = null;
    /** 本次程序化滚动的起跳位置;用于判断后续观测是「朝目标前进」还是「背离目标」。 */
    private programmaticScrollStart: number | null = null;
    /**
     * 最后一次真实用户滚动时记下的 scrollTop——该会话的「阅读锚点」。
     * outputContainer 是所有 tab 共享的同一个滚动容器(切 tab 只切 display,不重建
     * 滚动盒),浏览器不会替我们按子树记一份滚动位置,所以必须自己存、切回来时自己还原。
     */
    private lastKnownScrollTop: number;

    constructor(options: ScrollFollowControllerOptions = {}) {
        this.thresholdPx = options.thresholdPx ?? NEAR_BOTTOM_THRESHOLD_PX;
        this.following = options.initialFollowing ?? true;
        this.latchedNearBottom = this.following;
        this.lastKnownScrollTop = 0;
    }

    /** 当前是否处于「跟随」状态(近底且未被用户上翻暂停)。 */
    isFollowing(): boolean {
        return this.following;
    }

    /** 是否存在用户尚未看到的新输出(暂停跟随期间产生的内容)。 */
    hasUnread(): boolean {
        return this.unread;
    }

    /**
     * 程序化滚动即将发起(例如即将把 scrollTop 设为 scrollHeight)。
     * 调用后到 endProgrammaticScroll() 之前的所有 onScroll() 都被忽略,
     * 避免 scroll-behavior:smooth 产生的中间帧被误判成用户上翻。
     *
     * @param targetScrollTop 本次期望落到的 scrollTop。给了之后,一旦观测到滚动
     *   已到达该位置就立刻解除忽略(见 onScroll),把「吞掉用户输入」的窗口从
     *   固定的兜底时长压缩到动画真正结束的那一刻。
     */
    beginProgrammaticScroll(targetScrollTop?: number): void {
        this.programmaticScrollDepth += 1;
        if (typeof targetScrollTop === 'number') {
            this.programmaticScrollTarget = targetScrollTop;
            // 记住起跳位置:用它判断后续观测到的 scrollTop 是在「朝目标前进」
            // (平滑动画的正常中间帧)还是「背离目标」(用户插手的强信号)。
            this.programmaticScrollStart = this.lastKnownScrollTop;
        }
    }

    /** 程序化滚动结束(平滑滚动的中间帧已经走完,后续 scroll 事件可信为用户操作)。 */
    endProgrammaticScroll(): void {
        this.programmaticScrollDepth = Math.max(0, this.programmaticScrollDepth - 1);
        if (this.programmaticScrollDepth === 0) {
            this.programmaticScrollTarget = null;
            this.programmaticScrollStart = null;
        }
    }

    /**
     * 观测到确定的用户意图事件(wheel / touchstart / pointerdown / 方向键等)时调用:
     * 立刻结束任何进行中的程序化滚动忽略窗口。
     *
     * 为什么需要它:程序化滚动期间我们把 scroll 事件一律当噪声忽略,但用户完全
     * 可能在平滑动画还没走完时就上翻——那种情况下浏览器会打断动画并派发 scroll,
     * 若只靠固定兜底时长,用户的这次上翻会被吞掉几百毫秒。wheel/touch/key/pointer
     * 这些事件**只可能由用户产生**、程序化滚动绝不会触发,因此可以安全地当作
     * 「现在开始,scroll 事件可信」的硬信号,让「用户上翻立即暂停」成立。
     */
    noteUserScrollIntent(): void {
        this.programmaticScrollDepth = 0;
        this.programmaticScrollTarget = null;
        this.programmaticScrollStart = null;
    }

    /** 是否正处于程序化滚动期间(供调用方判断是否要忽略某次测量)。 */
    isProgrammaticScrollInFlight(): boolean {
        return this.programmaticScrollDepth > 0;
    }

    /**
     * 真实滚动事件到达时调用(通常绑定在 scroll-area 的 'scroll' 事件上)。
     * 这是唯一会更新「近底锚点」和「是否跟随」的入口——由此保证验收标准1
     * (近底判断不能在内容长高后用新高度反推)天然成立:判断永远基于
     * 「用户滚动那一刻」的几何,而不是之后任何时间点的几何。
     */
    onScroll(geometry: ScrollGeometry): void {
        if (this.programmaticScrollDepth > 0) {
            const target = this.programmaticScrollTarget;
            const arrived = target !== null
                && Math.abs(geometry.scrollTop - target) <= PROGRAMMATIC_SCROLL_ARRIVAL_EPSILON_PX;
            // 背离目标 = 有人在动画途中把滚动位置往反方向拽了。平滑滚动是单调趋近
            // 目标的,绝不会自己走远,所以这只能是用户插手(例如拖滚动条——那种操作
            // 不会派发 wheel,光靠 noteUserScrollIntent 的快速通道盖不住)。
            const movedAway = target !== null
                && this.programmaticScrollStart !== null
                && Math.abs(geometry.scrollTop - target) > Math.abs(this.programmaticScrollStart - target) + PROGRAMMATIC_SCROLL_ARRIVAL_EPSILON_PX;

            if (!arrived && !movedAway) return;
            // 动画已结束,或用户已经插手:立刻解除忽略,让这次滚动按真实意图处理。
            this.endProgrammaticScroll();
        }

        this.lastKnownScrollTop = geometry.scrollTop;
        const distanceFromBottom = this.distanceFromBottom(geometry);
        const nearBottom = distanceFromBottom < this.thresholdPx;
        this.latchedNearBottom = nearBottom;

        if (nearBottom) {
            // 用户自己滚回了底部附近:恢复跟随,未读清零。
            this.following = true;
            this.unread = false;
        } else if (this.following) {
            // 之前在跟随,现在用户滚走了(不管方向):暂停跟随,保持当前阅读锚点。
            this.following = false;
        }
    }

    /**
     * 内容即将增长前调用(新 token、折叠/展开高度变化、图片加载完成撑高等任何
     * 会改变 scrollHeight 的事件之前)。只读 `latchedNearBottom` 这个锚存值,
     * 不重新测量几何——这正是验收标准1要求的「不能用增长后的新高度判断原意」。
     *
     * 返回 true 表示调用方应该在内容渲染完之后把视口滚到底部(跟随);
     * 返回 false 表示应该保持当前滚动位置不动,并记一笔未读。
     */
    onContentWillGrow(): boolean {
        if (this.following) return true;

        // 暂停中收到新内容:标记未读,供「回到最新」入口显示判断用。
        this.unread = true;
        return false;
    }

    /**
     * 用户点击「回到最新」时调用:恢复跟随、清未读,并把近底锚点复位为 true。
     * 调用方随后应执行真正的滚动(并包在 begin/endProgrammaticScroll 之间)。
     */
    jumpToLatest(): void {
        this.following = true;
        this.unread = false;
        this.latchedNearBottom = true;
    }

    /**
     * 程序化滚动落定后,把该会话的阅读锚点记成实际落点。
     * 之所以需要这个入口:程序化滚动期间的 onScroll 被整段忽略(见
     * beginProgrammaticScroll),锚点不会自己更新;不在这里补记,切到别的 tab
     * 再切回来时就会拿着一个过期的 scrollTop 把视口拽回半屏之前的位置。
     * 注意本方法*不*改变跟随/未读状态——它只是记录几何,不表达任何意图,
     * 因此不会把用户在动画期间的上翻动作"洗掉"成跟随。
     */
    recordScrollPosition(scrollTop: number): void {
        this.lastKnownScrollTop = scrollTop;
    }

    /** 近底判断的当前锚存值(主要供测试与调试观察,不建议业务代码依赖)。 */
    isLatchedNearBottom(): boolean {
        return this.latchedNearBottom;
    }

    /**
     * 该会话最后一次已知的阅读位置(scrollTop)。切回该 tab 时,调用方应把
     * outputContainer.scrollTop 设回这个值——outputContainer 是所有 tab 共享的
     * 同一个滚动盒,不会自己记住「切走前每个子树滚到哪」。
     */
    getLastKnownScrollTop(): number {
        return this.lastKnownScrollTop;
    }

    private distanceFromBottom(geometry: ScrollGeometry): number {
        return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
    }
}
