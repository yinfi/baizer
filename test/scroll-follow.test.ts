import { readFileSync } from 'fs';
import {
    NEAR_BOTTOM_THRESHOLD_PX,
    ScrollFollowController,
    isNearBottom,
} from '../src/ui/scroll/scroll-follow-controller';

/**
 * 聊天滚动跟随回归测试（issue #64）。
 *
 * 覆盖验收标准里可程序化的部分：
 * - 仅近底（<80px）且跟随中才随新输出贴底；
 * - 上翻立即暂停，暂停后只有新输出才点亮「有新输出」；
 * - 点击「回到最新」恢复跟随；
 * - 折叠/定型等纯布局变化不回滚、不点亮未读；
 * - 会话之间位置/跟随/未读隔离，旧会话的延迟回调不能滚动新会话；
 * - 新会话定位到最新，已有会话恢复阅读位置；
 * - 视图关闭后延迟回调全部失效。
 */

function expect(actual: any) {
    return {
        toBe: (expected: any) => {
            if (actual !== expected) {
                throw new Error(`Expected ${expected} but got ${actual}`);
            }
        },
        toEqual: (expected: any) => {
            const actualStr = JSON.stringify(actual);
            const expectedStr = JSON.stringify(expected);
            if (actualStr !== expectedStr) {
                throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
            }
        },
        toBeGreaterThan: (expected: number) => {
            if (!(actual > expected)) {
                throw new Error(`Expected ${actual} to be greater than ${expected}`);
            }
        },
    };
}

async function test(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
    } catch (e: any) {
        console.error(`  FAIL ${name}: ${e.message}`);
        process.exit(1);
    }
}

class FakeScrollContainer {
    scrollTop = 0;
    scrollHeight = 0;
    clientHeight = 300;
    scrollCalls = 0;
    /** 内容变短导致 scrollTop 被 clamp 时，浏览器会异步补一个 scroll 事件。 */
    private pendingScrollEvents = 0;

    /** 模拟内容高度变化：变矮时 clamp scrollTop 并排入一次 scroll 事件（真实布局行为）。 */
    setScrollHeight(px: number): void {
        this.scrollHeight = px;
        const max = this.maxScrollTop();
        if (this.scrollTop > max) {
            this.scrollTop = max;
            this.pendingScrollEvents += 1;
        }
    }

    grow(px: number): void {
        this.setScrollHeight(this.scrollHeight + px);
    }

    /** 取出并清空待投递的 scroll 事件数（由宿主在下一拍派发给 controller）。 */
    takeScrollEvents(): number {
        const count = this.pendingScrollEvents;
        this.pendingScrollEvents = 0;
        return count;
    }

    maxScrollTop(): number {
        return Math.max(0, this.scrollHeight - this.clientHeight);
    }

    scrollTo(options?: ScrollToOptions): void {
        this.scrollCalls += 1;
        this.scrollTop = Math.min(Math.max(0, options?.top ?? 0), this.maxScrollTop());
    }
}

function createScheduler() {
    let seq = 0;
    const pending = new Map<number, () => void>();
    return {
        schedule: (callback: () => void) => {
            seq += 1;
            pending.set(seq, callback);
            return seq;
        },
        cancel: (handle: unknown) => {
            pending.delete(handle as number);
        },
        flush() {
            let guard = 0;
            while (pending.size > 0 && guard < 20) {
                guard += 1;
                const tasks = [...pending.values()];
                pending.clear();
                for (const task of tasks) task();
            }
        },
        /** 只跑当前这一拍，不执行回调里新排的定时器（用于恢复重试的分步断言）。 */
        flushOnce() {
            const tasks = [...pending.values()];
            pending.clear();
            for (const task of tasks) task();
        },
        size() {
            return pending.size;
        },
    };
}

function createHarness() {
    const container = new FakeScrollContainer();
    const scheduler = createScheduler();
    const unreadEvents: Array<[string, boolean]> = [];
    const generation = { value: 0 };
    const controller = new ScrollFollowController({
        getContainer: () => container,
        onUnreadChange: (sessionId, unread) => unreadEvents.push([sessionId, unread]),
        getRenderGeneration: () => generation.value,
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
        restoreDelayMs: 0,
    });
    return {
        container,
        scheduler,
        controller,
        unreadEvents,
        activate(sessionId: string, mode: 'new' | 'restore' = 'new') {
            controller.activateSession(sessionId, mode);
            scheduler.flush();
        },
        flush: () => scheduler.flush(),
        /** 模拟异步渲染代次前进（切换 tab、开启新回合）。 */
        bumpGeneration() {
            generation.value += 1;
        },
        /** 派发布局 clamp 产生的 scroll 事件（真实浏览器会在下一拍投递）。 */
        flushScrollEvents() {
            const count = container.takeScrollEvents();
            for (let i = 0; i < count; i++) controller.handleScroll();
        },
        /** 模拟一次新输出到达：内容增长 + 增长前后按真实调用顺序通知策略。 */
        output(px: number, markUnread = true) {
            const token = controller.captureGrowth();
            container.grow(px);
            controller.afterGrowth(token, { markUnread });
            scheduler.flush();
        },
    };
}

function cssRuleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    return match?.[1] ?? '';
}

async function runTests() {
    console.log('=== Chat Scroll Follow Tests ===');

    await test('near-bottom threshold is 80px', () => {
        expect(NEAR_BOTTOM_THRESHOLD_PX).toBe(80);
        const metrics = (distance: number) => ({
            scrollTop: 400 - 300 - distance,
            scrollHeight: 400,
            clientHeight: 300,
        });
        expect(isNearBottom({ scrollTop: 20, scrollHeight: 400, clientHeight: 300 })).toBe(true); // 80
        expect(isNearBottom({ scrollTop: 19, scrollHeight: 400, clientHeight: 300 })).toBe(false); // 81
        expect(isNearBottom(metrics(-50))).toBe(true); // 超底（clamp 前）也视为近底
    });

    await test('follows new output only while near the bottom', () => {
        const h = createHarness();
        h.container.scrollHeight = 600;
        h.activate('a', 'new');
        expect(h.container.scrollTop).toBe(300);

        h.output(200);
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
        expect(h.controller.isFollowing()).toBe(true);
        expect(h.controller.hasUnread()).toBe(false);
    });

    await test('scrolling up pauses follow and keeps the reading anchor while output grows', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        expect(h.container.scrollTop).toBe(900);

        // 用户上翻一屏。
        h.container.scrollTop = 300;
        h.controller.handleScroll();
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(false);

        h.output(200);
        h.output(200);
        expect(h.container.scrollTop).toBe(300);
        expect(h.controller.hasUnread()).toBe(true);
        // activateSession 会发布一次当前状态（false），之后才是新输出点亮。
        expect(h.unreadEvents).toEqual([['a', false], ['a', true]]);
    });

    await test('scrolling up without new output does not show the unread entry', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');

        h.container.scrollTop = 200;
        h.controller.handleScroll();
        h.flush();

        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(false);
        expect(h.unreadEvents).toEqual([['a', false]]);
    });

    await test('wheel-up pauses immediately, before the scroll event catches up', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');

        h.controller.handleUserScrollIntentUp();
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(false);

        h.output(120);
        // 暂停后即使有新输出也不贴底；只点亮返回入口。
        expect(h.container.scrollTop).toBe(900);
        expect(h.controller.hasUnread()).toBe(true);
    });

    await test('"back to latest" scrolls to the end, clears unread and resumes follow', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 250;
        h.controller.handleScroll();
        h.output(300);
        expect(h.controller.hasUnread()).toBe(true);

        h.controller.scrollToLatest();
        h.flush();
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
        expect(h.controller.isFollowing()).toBe(true);
        expect(h.controller.hasUnread()).toBe(false);
        expect(h.unreadEvents).toEqual([['a', false], ['a', true], ['a', false]]);

        // 再次上翻仍能再次暂停。
        h.container.scrollTop = 400;
        h.controller.handleScroll();
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('layout-only changes while paused neither scroll nor mark unread', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 200;
        h.controller.handleScroll();
        const callsBefore = h.container.scrollCalls;

        // 过程块折叠/展开、图片延迟加载、Markdown 定型：只改变高度，不是新输出。
        h.output(80, false);
        h.output(160, false);
        h.output(-40, false);

        expect(h.container.scrollTop).toBe(200);
        expect(h.container.scrollCalls).toBe(callsBefore);
        expect(h.controller.hasUnread()).toBe(false);
    });

    await test('each session keeps its own follow/unread/position state', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 150;
        h.controller.handleScroll();
        h.output(100);
        expect(h.controller.hasUnread()).toBe(true);

        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
        expect(h.controller.isFollowing()).toBe(true);
        expect(h.controller.hasUnread()).toBe(false);

        h.controller.prepareForSessionSwitch();
        h.activate('a', 'restore');
        expect(h.container.scrollTop).toBe(150);
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(true);
    });

    await test('a stale delayed callback from session A never scrolls session B', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        // 先让 B 处于暂停状态，并记住它的阅读位置 100。
        h.activate('b', 'new');
        h.container.scrollTop = 100;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        // 回到 A 并制造一笔待执行的贴底回调。
        h.activate('a', 'new');
        h.container.grow(200);
        h.controller.afterGrowth(h.controller.captureGrowth(), { markUnread: true });
        h.controller.prepareForSessionSwitch();
        // 切回 B；A 的旧回调此刻到期。
        h.controller.activateSession('b', 'restore');
        const callsBefore = h.container.scrollCalls;
        h.flush();

        expect(h.container.scrollTop).toBe(100);
        // 只有 B 的位置恢复真正执行；A 的过期回调被会话身份校验丢弃。
        expect(h.container.scrollCalls - callsBefore).toBe(1);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('a pending position restore cannot override an immediate user scroll-up', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        // 切回 A：位置恢复还在 50ms 队列里，用户已经用滚轮上翻。
        h.controller.activateSession('a', 'restore');
        h.container.scrollTop = 300;
        h.controller.handleUserScrollIntentUp();
        h.controller.handleScroll();
        h.flush();

        expect(h.container.scrollTop).toBe(300);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('a bare scroll event during restore is ignored and the saved anchor is restored', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        // 切回 A 时布局会先产生过渡 scroll（旧内容高度、clamp 等），它不是用户意图：
        // 恢复必须照常执行，跟随/未读也不得被这次 scroll 改写。
        h.controller.activateSession('a', 'restore');
        h.container.scrollTop = 1300;
        h.controller.handleScroll();
        h.flush();

        expect(h.container.scrollTop).toBe(500);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('real input during restore cancels it', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        h.controller.activateSession('a', 'restore');
        // 用户按下滚动条 / 触摸 / 键盘滚动键：真实输入，恢复让位。
        h.container.scrollTop = 700;
        h.controller.handleUserScrollIntent();
        const callsBefore = h.container.scrollCalls;
        h.flush();

        expect(h.container.scrollTop).toBe(700);
        expect(h.container.scrollCalls).toBe(callsBefore);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('a plain click during restore does not lose the saved anchor', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        h.controller.activateSession('a', 'restore');
        // 点击/选文本：pointerdown 取消了恢复，但 pointerup 时视口没有移动。
        h.container.scrollTop = 1300;
        h.controller.handleUserScrollIntent();
        h.controller.handleUserScrollIntentEnd();
        h.flush();

        expect(h.container.scrollTop).toBe(500);
    });

    await test('a pointer drag that moved the viewport is not replayed on pointerup', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        h.controller.activateSession('a', 'restore');
        h.container.scrollTop = 900;
        h.controller.handleUserScrollIntent();
        h.container.scrollTop = 400;
        h.controller.handleScroll();
        h.controller.handleUserScrollIntentEnd();
        h.flush();

        expect(h.container.scrollTop).toBe(400);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('restore retries when the content has not grown enough to reach the anchor', () => {
        const h = createHarness();
        h.container.setScrollHeight(1200);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        // 切回 A 时内容还没长回来：max=0，500 被 clamp 到 0。
        h.container.setScrollHeight(200);
        h.controller.activateSession('a', 'restore');
        h.scheduler.flushOnce();
        expect(h.container.scrollTop).toBe(0);

        // 异步 Markdown 把内容补上后，重试把读者放回 500。
        h.container.setScrollHeight(1000);
        h.flush();

        expect(h.container.scrollTop).toBe(500);
    });

    await test('a restore timer that fires after switching away leaves the phase idle', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();

        h.controller.activateSession('a', 'restore');
        h.activate('b', 'new');
        h.flush();

        expect(h.controller.getSessionState('a')?.restorePhase).toBe('idle');
    });

    await test('a clamp scroll during restore is layout noise, not a user scroll', () => {
        const h = createHarness();
        // A 是矮会话：暂停在 150，还有未读；B 是高会话，停在底部。
        h.container.setScrollHeight(500);
        h.activate('a', 'new');
        h.container.scrollTop = 150;
        h.controller.handleUserScrollIntentUp();
        h.controller.handleScroll();
        h.output(10);
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(true);

        h.controller.prepareForSessionSwitch();
        h.container.setScrollHeight(3000);
        h.activate('b', 'new');
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
        h.controller.prepareForSessionSwitch();

        // 切回 A：内容重建后高度只有 500，浏览器把 scrollTop 从 2700 clamp 到 200，
        // 并在恢复定时器执行前投递一次 scroll。它不能取消恢复、也不能重开跟随/清未读。
        h.container.setScrollHeight(500);
        h.controller.activateSession('a', 'restore');
        h.flushScrollEvents();
        h.flush();

        expect(h.container.scrollTop).toBe(150);
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(true);
    });

    await test('switching away before a pending restore keeps the saved anchor', () => {
        const h = createHarness();
        h.container.setScrollHeight(1600);
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();

        // 回到 A 后恢复还没执行就再次切走：过渡位置不能覆盖已保存的 500。
        h.controller.activateSession('a', 'restore');
        h.container.scrollTop = 1300;
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');
        h.flush();
        h.controller.activateSession('a', 'restore');
        h.flush();

        expect(h.container.scrollTop).toBe(500);
    });

    await test('a stale render generation cannot schedule a follow scroll', () => {
        const h = createHarness();
        h.container.setScrollHeight(1200);
        h.activate('a', 'new');
        // 增长前仍在跟随、近底，但渲染期间切了 tab / 开了新回合：代次已前进，token 过期。
        const token = h.controller.captureGrowth();
        h.bumpGeneration();
        const callsBefore = h.container.scrollCalls;
        h.container.grow(200);
        h.controller.afterGrowth(token, { markUnread: true });
        h.flush();

        expect(h.container.scrollCalls).toBe(callsBefore);
        expect(h.controller.hasUnread()).toBe(false);
    });

    await test('growth token snapshots near-bottom and following before the content grows', () => {
        const h = createHarness();
        h.container.setScrollHeight(1200);
        h.activate('a', 'new');
        const followingToken = h.controller.captureGrowth();
        expect(followingToken?.nearBottom).toBe(true);
        expect(followingToken?.following).toBe(true);

        h.container.scrollTop = 200;
        h.controller.handleScroll();
        const pausedToken = h.controller.captureGrowth();
        expect(pausedToken?.nearBottom).toBe(false);
        expect(pausedToken?.following).toBe(false);
    });

    await test('a layout growth that leaves the reader above the threshold does not snap to bottom', () => {
        const h = createHarness();
        h.container.setScrollHeight(1200);
        h.activate('a', 'new');
        // 图片延迟加载 / 代码块展开把内容撑高 300px，但没有用户 scroll 事件：
        // following 仍是 true，读者实际上已在距底 300px 处。
        h.container.grow(300);
        expect(h.controller.isFollowing()).toBe(true);
        const callsBefore = h.container.scrollCalls;

        h.output(80);

        // 新输出不能用增长后的新高度回判「原来在底部」：保持阅读锚点，只点亮返回入口。
        expect(h.container.scrollTop).toBe(900);
        expect(h.container.scrollCalls).toBe(callsBefore);
        expect(h.controller.isFollowing()).toBe(false);
        expect(h.controller.hasUnread()).toBe(true);
    });

    await test('several growths in one tick schedule a single follow scroll', () => {
        const h = createHarness();
        h.container.setScrollHeight(1200);
        h.activate('a', 'new');
        const callsBefore = h.container.scrollCalls;

        for (let i = 0; i < 4; i++) {
            const token = h.controller.captureGrowth();
            h.container.grow(10);
            h.controller.afterGrowth(token, { markUnread: true });
        }
        expect(h.container.scrollCalls).toBe(callsBefore);

        h.flush();
        expect(h.container.scrollCalls).toBe(callsBefore + 1);
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
    });

    await test('a growth token captured in another session is ignored', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 200;
        h.controller.handleScroll();
        const staleToken = h.controller.captureGrowth();

        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');
        const callsBefore = h.container.scrollCalls;
        h.container.grow(300);
        h.controller.afterGrowth(staleToken, { markUnread: true });
        h.flush();

        expect(h.controller.hasUnread()).toBe(false);
        expect(h.container.scrollCalls).toBe(callsBefore);
    });

    await test('a new conversation starts at the latest output; a restored one keeps its position', () => {
        const h = createHarness();
        h.container.scrollHeight = 1600;
        h.activate('a', 'new');
        h.container.scrollTop = 500;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();

        // 新会话：即使容器里还是旧内容，也定位到最新并开始跟随。
        h.activate('c', 'new');
        expect(h.container.scrollTop).toBe(h.container.maxScrollTop());
        expect(h.controller.isFollowing()).toBe(true);

        h.controller.prepareForSessionSwitch();
        h.activate('a', 'restore');
        expect(h.container.scrollTop).toBe(500);
        expect(h.controller.isFollowing()).toBe(false);
    });

    await test('near-bottom manual scroll back resumes follow and clears unread', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 200;
        h.controller.handleScroll();
        h.output(100);
        expect(h.controller.hasUnread()).toBe(true);

        h.container.scrollTop = h.container.maxScrollTop() - 40;
        h.controller.handleScroll();
        expect(h.controller.isFollowing()).toBe(true);
        expect(h.controller.hasUnread()).toBe(false);
    });

    await test('background output marks unread only for a paused session', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.scrollTop = 200;
        h.controller.handleScroll();
        h.controller.prepareForSessionSwitch();
        h.activate('b', 'new');

        h.controller.noteOutputInSession('a');
        h.controller.noteOutputInSession('b');

        expect(h.controller.getSessionState('a')?.unread).toBe(true);
        expect(h.controller.getSessionState('b')?.unread).toBe(false);
    });

    await test('dispose cancels pending callbacks so a closed view cannot scroll', () => {
        const h = createHarness();
        h.container.scrollHeight = 1200;
        h.activate('a', 'new');
        h.container.grow(100);
        h.controller.afterGrowth(h.controller.captureGrowth(), { markUnread: true });
        const topBefore = h.container.scrollTop;
        const callsBefore = h.container.scrollCalls;

        h.controller.dispose();
        h.flush();

        expect(h.container.scrollTop).toBe(topBefore);
        expect(h.container.scrollCalls).toBe(callsBefore);
    });

    await test('unread entry fits a 300px sidebar without horizontal overflow', () => {
        const css = readFileSync('styles.css', 'utf8');
        const bar = cssRuleBody(css, '.shell-unread-bar');
        const button = cssRuleBody(css, '.shell-unread-button');
        const normalizedBar = bar.replace(/\s+/g, ' ');
        const normalizedButton = button.replace(/\s+/g, ' ');

        expect(normalizedBar.includes('min-width: 0')).toBe(true);
        expect(normalizedButton.includes('max-width: 100%')).toBe(true);
        expect(normalizedButton.includes('overflow: hidden')).toBe(true);
        expect(normalizedButton.includes('text-overflow: ellipsis')).toBe(true);
        expect(normalizedButton.includes('white-space: nowrap')).toBe(true);
    });
}

runTests().catch((e) => {
    console.error(e);
    process.exit(1);
});
