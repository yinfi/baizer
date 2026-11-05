/**
 * render-scheduler.ts —— 局部重绘调度器
 *
 * 为什么需要它
 * ----------
 * 设置页的 `renderAccordion()` 被 30+ 个 handler 调用，其中一部分会在「渲染进行中」
 * 再次请求重绘：例如 `renderMemorySection()` 首次展开时触发 `refreshMemoryView()`，
 * 后者立刻把 `memoryLoading` 置位并再调一次 `renderAccordion()`；`<details>` 的
 * toggle 事件里也有同样的调用。同步重绘会 `host.empty()` 掉外层正在构建的 DOM，
 * 造成重复构建与游离节点；这类嵌套长任务在移动端 WebView 上会直接卡住主线程。
 *
 * 语义
 * ----
 * - `request()`：把重绘排到当前任务之后（默认微任务）。同一轮里多次调用只排一次；
 * - 渲染过程中再次 `request()`：不嵌套，等本轮渲染结束后补一次；
 * - `cancel()`：丢弃尚未执行的排队请求（面板关闭时用，避免 hide 之后又重绘）。
 *
 * 只做调度，不碰 DOM；调度函数可注入，便于单测。
 */

export type ScheduleCallback = (callback: () => void) => void;

export interface RenderScheduler {
  /** 请求一次重绘；同一轮事件循环内重复调用会被合并。 */
  request(): void;
  /** 丢弃尚未执行的排队请求。 */
  cancel(): void;
  /** 是否有已排队但尚未执行的重绘（供测试与 hide 逻辑判断）。 */
  isScheduled(): boolean;
}

const defaultSchedule: ScheduleCallback = callback => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  // 极老的 WebView 兜底：微任务不可用时退回宏任务，语义仍是「下一轮再画」。
  setTimeout(callback, 0);
};

/**
 * 创建一个「合并且不可重入」的重绘调度器。
 *
 * @param render   真正的重绘函数（同步执行）。
 * @param schedule 排队实现；默认 queueMicrotask，测试可注入同步/手动触发版本。
 */
export function createRenderScheduler(
  render: () => void,
  schedule: ScheduleCallback = defaultSchedule,
): RenderScheduler {
  let scheduled = false;
  let running = false;
  let queuedWhileRunning = false;
  // cancel() 会让已排队但还没执行的回调失效；用代际号而不是布尔量，
  // 避免「取消后同一轮又 request()」被旧回调误触发。
  let generation = 0;

  const run = (): void => {
    running = true;
    try {
      render();
    } finally {
      running = false;
      if (queuedWhileRunning) {
        queuedWhileRunning = false;
        run();
      }
    }
  };

  return {
    request(): void {
      if (running) {
        // 渲染中请求重绘：绝不嵌套，结束后补一轮即可。
        queuedWhileRunning = true;
        return;
      }
      if (scheduled) return;
      scheduled = true;
      const myGeneration = generation;
      schedule(() => {
        if (myGeneration !== generation) return;
        scheduled = false;
        run();
      });
    },

    cancel(): void {
      generation++;
      scheduled = false;
      queuedWhileRunning = false;
    },

    isScheduled(): boolean {
      return scheduled || queuedWhileRunning;
    },
  };
}
