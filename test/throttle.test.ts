/**
 * throttle.test.ts — Throttle 工具单元测试
 *
 * 使用假时钟（手动推进 Date.now）覆盖各种节流场景，
 * 不依赖真实 setTimeout，执行速度快且稳定。
 */

import { throttle, ThrottleMap, debounce } from '../src/utils/throttle';

// ── 假时钟工具 ────────────────────────────────────────────────────────────────

let fakeNow = 0;
const realDateNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface FakeTimer {
    id: number;
    deadline: number;
    callback: () => void;
    cancelled: boolean;
}

let timers: FakeTimer[] = [];
let nextTimerId = 1;

function installFakeClock(): void {
    fakeNow = 0;
    timers = [];
    nextTimerId = 1;

    (Date as any).now = () => fakeNow;

    (globalThis as any).setTimeout = (cb: () => void, ms: number): number => {
        const id = nextTimerId++;
        timers.push({ id, deadline: fakeNow + ms, callback: cb, cancelled: false });
        return id;
    };

    (globalThis as any).clearTimeout = (id: number): void => {
        const t = timers.find(t => t.id === id);
        if (t) t.cancelled = true;
    };
}

function restoreRealClock(): void {
    (Date as any).now = realDateNow;
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
}

/**
 * 推进假时钟 `ms` 毫秒，触发所有到期的定时器（按时间顺序，支持嵌套）。
 */
function tick(ms: number): void {
    const target = fakeNow + ms;
    while (true) {
        const due = timers
            .filter(t => !t.cancelled && t.deadline <= target)
            .sort((a, b) => a.deadline - b.deadline);
        if (due.length === 0) break;
        const t = due[0];
        t.cancelled = true;          // 标记为已触发，防止重复执行
        fakeNow = t.deadline;
        t.callback();
    }
    fakeNow = target;
}

// ── 测试框架 ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    installFakeClock();
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (err: any) {
        console.error(`  FAIL ${name}`);
        console.error(`       ${err?.message ?? err}`);
        failed++;
    } finally {
        restoreRealClock();
    }
}

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
    if (actual !== expected) {
        throw new Error(
            msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

console.log('=== Throttle Tests ===');

// ── throttle — leading edge ──────────────────────────────────────────────────

test('leading call executes immediately', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    assertEqual(calls.length, 1, 'should have fired once');
    assertEqual(calls[0], 1);
});

test('second call within window is suppressed (no trailing)', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100, trailing: false });

    fn(1);
    tick(50);
    fn(2);
    tick(100);
    assertEqual(calls.length, 1, 'only leading call expected');
    assertEqual(calls[0], 1);
});

test('trailing call fires after window expires', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);   // leading
    tick(50);
    fn(2);   // within window → pending trailing
    tick(60); // total 110ms → trailing fires
    assertEqual(calls.length, 2, 'leading + trailing expected');
    assertEqual(calls[1], 2, 'trailing should carry last arg');
});

test('only last trailing arg is delivered', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);   // leading
    tick(20);
    fn(2);   // pending
    tick(20);
    fn(3);   // overwrites pending
    tick(70); // window end → trailing fires with 3
    assertEqual(calls.length, 2);
    assertEqual(calls[1], 3, 'last arg should win');
});

test('after window, next call triggers a new leading', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    tick(150);  // window fully expired
    fn(2);
    assertEqual(calls.length, 2, 'second leading expected');
    assertEqual(calls[1], 2);
});

// ── throttle — leading=false ─────────────────────────────────────────────────

test('leading=false defers first call to end of window', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100, leading: false });

    fn(1);
    assertEqual(calls.length, 0, 'should not fire immediately');
    tick(100);
    assertEqual(calls.length, 1, 'should fire after window');
    assertEqual(calls[0], 1);
});

// ── throttle.flush() ─────────────────────────────────────────────────────────

test('flush() triggers pending trailing immediately', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);   // leading
    tick(30);
    fn(2);   // pending
    fn.flush();
    assertEqual(calls.length, 2, 'flush should deliver trailing');
    assertEqual(calls[1], 2);
});

test('flush() resets state so next call is a fresh leading', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    tick(30);
    fn(2);
    fn.flush();
    fn(3);
    assertEqual(calls.length, 3, 'post-flush call should fire immediately');
    assertEqual(calls[2], 3);
});

// ── throttle.cancel() ────────────────────────────────────────────────────────

test('cancel() drops pending trailing', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);   // leading
    tick(30);
    fn(2);   // pending
    fn.cancel();
    tick(100);
    assertEqual(calls.length, 1, 'trailing should be cancelled');
});

test('cancel() resets state so next call is a fresh leading', () => {
    const calls: number[] = [];
    const fn = throttle((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    tick(30);
    fn.cancel();
    fn(2);
    assertEqual(calls.length, 2, 'after cancel next call should fire immediately');
    assertEqual(calls[1], 2);
});

// ── ThrottleMap ───────────────────────────────────────────────────────────────

test('ThrottleMap throttles each key independently', () => {
    const calls: Array<[string, number]> = [];
    const map = new ThrottleMap((key: string, n: number) => calls.push([key, n]), { wait: 100 });

    map.call('a', 1);  // a: leading
    map.call('b', 10); // b: independent leading
    tick(50);
    map.call('a', 2);  // a: pending trailing
    map.call('b', 20); // b: pending trailing
    tick(60);
    assertEqual(calls.length, 4);
    assert(calls.some(c => c[0] === 'a' && c[1] === 1), 'a leading');
    assert(calls.some(c => c[0] === 'b' && c[1] === 10), 'b leading');
    assert(calls.some(c => c[0] === 'a' && c[1] === 2), 'a trailing');
    assert(calls.some(c => c[0] === 'b' && c[1] === 20), 'b trailing');
});

test('ThrottleMap.cancel removes the key entry', () => {
    const calls: string[] = [];
    const map = new ThrottleMap((key: string) => calls.push(key), { wait: 100 });

    map.call('x');
    tick(30);
    map.call('x'); // pending
    map.cancel('x');
    tick(100);
    assertEqual(calls.length, 1, 'cancelled key should not trail');
});

test('ThrottleMap.cancelAll cancels all keys', () => {
    const calls: string[] = [];
    const map = new ThrottleMap((key: string) => calls.push(key), { wait: 100 });

    map.call('p');
    map.call('q');
    tick(30);
    map.call('p'); // pending
    map.call('q'); // pending
    map.cancelAll();
    tick(100);
    assertEqual(calls.length, 2, 'only leading calls, no trailing after cancelAll');
});

test('ThrottleMap.flush delivers pending call for one key', () => {
    const calls: Array<[string, number]> = [];
    const map = new ThrottleMap((key: string, n: number) => calls.push([key, n]), { wait: 100 });

    map.call('k', 1); // leading
    tick(40);
    map.call('k', 2); // pending
    map.flush('k');
    assertEqual(calls.length, 2);
    assertEqual(calls[1][1], 2, 'flush should deliver pending arg');
});

// ── debounce — trailing（默认）────────────────────────────────────────────────

test('debounce trailing: does not fire immediately', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    assertEqual(calls.length, 0, 'should not fire immediately in trailing mode');
});

test('debounce trailing: fires after wait expires', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    tick(100);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 1);
});

test('debounce trailing: resets timer on repeated calls', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    tick(50);
    fn(2);   // 重置计时
    tick(50); // 共 100ms，但从第二次调用算还差 50ms
    assertEqual(calls.length, 0, 'should not have fired yet');
    tick(50); // 现在到期
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 2, 'last arg should win');
});

test('debounce trailing: multiple rapid calls only invoke once', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(1); tick(10);
    fn(2); tick(10);
    fn(3); tick(10);
    fn(4);
    tick(100);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 4);
});

// ── debounce — leading ────────────────────────────────────────────────────────

test('debounce leading: fires immediately on first call', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100, leading: true });

    fn(1);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 1);
});

test('debounce leading: subsequent calls within window are ignored', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100, leading: true });

    fn(1);
    tick(40); fn(2);
    tick(40); fn(3);
    assertEqual(calls.length, 1, 'only first call should fire');
});

test('debounce leading: fires again after window expires', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100, leading: true });

    fn(1);
    tick(110);
    fn(2);
    assertEqual(calls.length, 2);
    assertEqual(calls[1], 2);
});

test('debounce leading: window does NOT reset on calls within window', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100, leading: true });

    fn(1);           // fires immediately, window opens (0–100ms)
    tick(80); fn(2); // still in window, ignored, timer NOT reset
    tick(80); fn(3); // total 160ms — window already ended at 100ms, so this fires immediately
    assertEqual(calls.length, 2, 'should fire at t=0 and again at t=160 (new window)');
    assertEqual(calls[0], 1);
    assertEqual(calls[1], 3);
});

// ── debounce.flush() ─────────────────────────────────────────────────────────

test('debounce flush() delivers pending trailing call immediately', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(42);
    fn.flush();
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 42);
});

test('debounce flush() with no pending call is a no-op', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn.flush();
    assertEqual(calls.length, 0);
});

test('debounce leading: flush() resets cooldown without executing fn', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100, leading: true });

    fn(1);                     // fires immediately (leading)
    tick(50);
    fn.flush();                // should reset cooldown, NOT call fn again
    assertEqual(calls.length, 1, 'flush should not execute fn in leading mode');
    fn(2);                     // cooldown cleared, should fire immediately
    assertEqual(calls.length, 2, 'next call after flush should fire immediately');
    assertEqual(calls[1], 2);
});

// ── debounce.cancel() ────────────────────────────────────────────────────────

test('debounce cancel() drops pending trailing call', () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), { wait: 100 });

    fn(1);
    fn.cancel();
    tick(100);
    assertEqual(calls.length, 0, 'cancelled call should not fire');
});

// ── 结果汇总 ──────────────────────────────────────────────────────────────────

if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
} else {
    console.log(`\nAll ${passed} throttle tests passed.`);
}
