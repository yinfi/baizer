import { logger } from './logger';

/**
 * 异步失败的统一落点。
 *
 * 背景（issue #92）：obsidian 事件回调、同步 UI 接口（`addEventListener`、`setInterval`、
 * `Modal.onSubmit`、`Debouncer.run()`）都期待 `void` 返回，直接传 `async` 函数或直接丢弃
 * 一个 Promise，会让 rejection 变成「未处理的 promise rejection」——用户只看到「没反应」，
 * 控制台之外没有任何人知道失败了。
 *
 * 这里既不用空 `.catch(() => {})` 吞掉错误，也不只是补一个 `void`：失败一律进 `logger`
 *（开发者控制台 / 日志导出可见），需要用户可见的调用方通过 `onError` 追加提示。
 *
 * @param context 日志里的失败描述（说明「哪一段异步工作失败了」）
 * @param task 产生 Promise 的同步工厂；同步抛错也会被接住（事件回调第一行就抛的情况）
 * @param onError 需要用户可见时的回调（例如设置面板的 Notice）
 */
export function voidAsync(
    context: string,
    task: () => unknown,
    onError?: (error: unknown) => void,
): void {
    void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
            logger.error(context, error, 'Async');
            if (!onError) return;
            try {
                onError(error);
            } catch (reportError: unknown) {
                // 失败提示自身再抛错，同样不能变成未处理 rejection。
                logger.error('Async failure reporter failed', reportError, 'Async');
            }
        });
}
