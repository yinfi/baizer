/**
 * throttle.ts — 节流 / 防抖工具
 *
 * 提供三种原语：
 *   - throttle()   基于时间窗口的函数节流（leading + trailing 可配置）
 *   - debounce()   防抖：在最后一次调用后等待 wait ms 再执行（trailing）；
 *                  或在第一次调用时立即执行、窗口内忽略重复（leading）
 *   - ThrottleMap  按 key 独立节流，适合多实例场景（如每个文件独立节流）
 */

export interface ThrottleOptions {
    /** 时间窗口（毫秒），默认 300 */
    wait?: number;
    /**
     * 是否在窗口开始时立即执行一次（leading edge），默认 true
     * 关闭后第一次调用也会延迟到 wait 结束后才触发
     */
    leading?: boolean;
    /**
     * 是否在窗口结束时执行最后一次调用（trailing edge），默认 true
     * 关闭后窗口内多次调用只保留第一次，不补发最后一次
     */
    trailing?: boolean;
}

export interface ThrottledFn<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): void;
    /** 立即执行已挂起的 trailing 调用并重置节流状态 */
    flush(): void;
    /** 取消挂起的 trailing 调用并重置节流状态 */
    cancel(): void;
}

/**
 * 创建一个节流函数。
 *
 * 在 `wait` 毫秒内，最多执行 `fn` 一次（leading）；
 * 若 trailing=true，窗口结束后会补发最后一次被压制的调用。
 *
 * @example
 * const save = throttle((content: string) => vault.write(content), { wait: 500 });
 * save('a'); // 立即执行
 * save('b'); // 500ms 后执行（trailing）
 */
export function throttle<T extends (...args: any[]) => any>(
    fn: T,
    options: ThrottleOptions = {}
): ThrottledFn<T> {
    const wait = options.wait ?? 300;
    const leading = options.leading ?? true;
    const trailing = options.trailing ?? true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastCallTime: number | null = null;
    let pendingArgs: Parameters<T> | null = null;

    function invoke(args: Parameters<T>): void {
        lastCallTime = Date.now();
        fn(...args);
    }

    function scheduleTrailing(args: Parameters<T>, remaining: number): void {
        timer = setTimeout(() => {
            timer = null;
            if (trailing && pendingArgs !== null) {
                invoke(pendingArgs);
                pendingArgs = null;
            } else {
                lastCallTime = null;
            }
        }, remaining);
    }

    const throttled = function (...args: Parameters<T>): void {
        const now = Date.now();
        const elapsed = lastCallTime === null ? Infinity : now - lastCallTime;
        const remaining = wait - elapsed;

        if (remaining <= 0 || remaining > wait) {
            // 窗口已过期
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (leading) {
                invoke(args);
            } else {
                // leading=false：记录时间但不立即执行，等 trailing
                lastCallTime = now;
                pendingArgs = args;
                scheduleTrailing(args, wait);
            }
        } else {
            // 窗口内，记录最新参数留给 trailing
            pendingArgs = args;
            if (!timer && trailing) {
                scheduleTrailing(args, remaining);
            }
        }
    } as ThrottledFn<T>;

    throttled.flush = function (): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (pendingArgs !== null) {
            invoke(pendingArgs);
            pendingArgs = null;
        }
        lastCallTime = null;
    };

    throttled.cancel = function (): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        pendingArgs = null;
        lastCallTime = null;
    };

    return throttled;
}

// ─────────────────────────────────────────────────────────────────────────────
// debounce
// ─────────────────────────────────────────────────────────────────────────────

export interface DebounceOptions {
    /** 等待窗口（毫秒），默认 300 */
    wait?: number;
    /**
     * leading=true：在窗口开始时立即执行，窗口内的后续调用被忽略。
     * leading=false（默认）：在最后一次调用后等待 wait ms 再执行（trailing）。
     */
    leading?: boolean;
}

export interface DebouncedFn<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): void;
    /** 立即执行挂起的 trailing 调用并重置状态 */
    flush(): void;
    /** 取消挂起的 trailing 调用并重置状态 */
    cancel(): void;
}

/**
 * 创建一个防抖函数。
 *
 * trailing 模式（默认）：最后一次调用结束后等待 `wait` ms 才执行。
 * leading 模式：第一次调用立即执行，窗口内的后续调用全部忽略（不会延后窗口结束时间）。
 * 窗口结束后重置，下次调用再次立即执行。
 *
 * @example
 * // trailing（最常见）：用户停止输入 500ms 后保存
 * const save = debounce((content: string) => vault.write(content), { wait: 500 });
 *
 * @example
 * // leading：立即响应，窗口内忽略重复（类似 Obsidian debounce 第三参数 false）
 * const log = debounce(handleEvent, { wait: 1000, leading: true });
 */
export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    options: DebounceOptions = {}
): DebouncedFn<T> {
    const wait = options.wait ?? 300;
    const leading = options.leading ?? false;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingArgs: Parameters<T> | null = null;
    let leadingFired = false;

    const debounced = function (...args: Parameters<T>): void {
        if (leading) {
            // leading 模式：窗口未激活时立即执行，之后进入冷却
            // 冷却期内的调用全部忽略，不重置计时器（标准 leading debounce 行为）
            if (!leadingFired) {
                leadingFired = true;
                fn(...args);
                // 计时器只设一次，窗口结束后重置状态
                timer = setTimeout(() => {
                    timer = null;
                    leadingFired = false;
                }, wait);
            }
            // 窗口内：静默丢弃，不记录 pendingArgs（leading 无 trailing 语义）
        } else {
            // trailing 模式：每次调用都重置等待计时器，记录最新参数
            pendingArgs = args;
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                const args = pendingArgs!;
                pendingArgs = null;
                fn(...args);
            }, wait);
        }
    } as DebouncedFn<T>;

    debounced.flush = function (): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (leading) {
            // leading 模式：flush 仅提前结束冷却窗口，不执行函数
            leadingFired = false;
        } else {
            // trailing 模式：立即执行挂起的调用
            leadingFired = false;
            if (pendingArgs !== null) {
                const args = pendingArgs;
                pendingArgs = null;
                fn(...args);
            }
        }
    };

    debounced.cancel = function (): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        pendingArgs = null;
        leadingFired = false;
    };

    return debounced;
}

// ─────────────────────────────────────────────────────────────────────────────
// ThrottleMap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 key 独立维护节流状态的 Map。
 * 适合需要对多个独立资源（如不同文件路径）分别节流的场景。
 *
 * @example
 * const saveMap = new ThrottleMap((path: string, content: string) => vault.write(path, content), { wait: 500 });
 * saveMap.call('notes/a.md', 'hello');
 * saveMap.call('notes/b.md', 'world'); // b 独立于 a 的节流窗口
 */
export class ThrottleMap<TKey, TArgs extends any[]> {
    private readonly fn: (...args: [TKey, ...TArgs]) => void;
    private readonly options: ThrottleOptions;
    private readonly map = new Map<TKey, ThrottledFn<(...args: [TKey, ...TArgs]) => void>>();

    constructor(fn: (...args: [TKey, ...TArgs]) => void, options: ThrottleOptions = {}) {
        this.fn = fn;
        this.options = options;
    }

    /** 对指定 key 调用节流函数 */
    call(key: TKey, ...args: TArgs): void {
        let throttled = this.map.get(key);
        if (!throttled) {
            throttled = throttle(this.fn, this.options);
            this.map.set(key, throttled);
        }
        throttled(key, ...args);
    }

    /** 立即触发指定 key 的 trailing 调用并重置 */
    flush(key: TKey): void {
        this.map.get(key)?.flush();
    }

    /** 取消指定 key 的 trailing 调用并重置 */
    cancel(key: TKey): void {
        this.map.get(key)?.cancel();
        this.map.delete(key);
    }

    /** 取消所有 key 的挂起调用并清空 map */
    cancelAll(): void {
        for (const throttled of this.map.values()) {
            throttled.cancel();
        }
        this.map.clear();
    }
}
