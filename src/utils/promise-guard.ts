import { logger } from './logger';
import { thrownMessage } from './thrown-message';

/**
 * 把任意 rejection 原因变成 Error，供 `Promise.reject()` / `reject()` 使用
 * （@typescript-eslint/prefer-promise-reject-errors）。
 *
 * Error 实例原样返回：obsidian 的 requestUrl 抛出的错误可能带 status 等字段，
 * 下游按字段判断，不能被重新包装掉。非 Error 的抛出值才包一层，原值放进 `cause`。
 */
export function toError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    const message = thrownMessage(reason) || (typeof reason === 'string' && reason) || 'Unknown error';
    return new Error(message, { cause: reason });
}

/**
 * 有意不等待一个 Promise，但保证它 reject 时有人看见：记日志，并可选地回调（例如弹 Notice）。
 * 取代裸的 `void promise` / 不带 catch 的 `promise.then(...)`——那两种写法下失败会变成
 * unhandled rejection，用户和日志都看不到。
 *
 * 接受 `undefined`/同步返回值，便于直接包 `debouncer.run()` 这类返回 `V | void` 的调用。
 */
export function detach(
    task: PromiseLike<unknown> | void,
    context: string,
    onError?: (error: unknown) => void,
): void {
    if (!task) return;
    Promise.resolve(task).catch((error: unknown) => {
        logger.error('Unhandled async failure', error, context);
        if (!onError) return;
        try {
            onError(error);
        } catch (callbackError) {
            logger.error('Async failure handler threw', callbackError, context);
        }
    });
}

/**
 * 把返回 Promise 的函数适配成「返回 void」的回调，用于事件监听器、Modal 回调、
 * setInterval 等声明为同步 void 的位置（@typescript-eslint/no-misused-promises）。
 * 函数体同步部分照常立即执行（例如 preventDefault 必须在第一个 await 之前跑完），
 * reject 统一走 detach 记录。
 */
export function voidHandler<A extends unknown[]>(
    fn: (...args: A) => PromiseLike<unknown> | void,
    context: string,
    onError?: (error: unknown) => void,
): (...args: A) => void {
    return (...args: A): void => {
        let result: PromiseLike<unknown> | void;
        try {
            result = fn(...args);
        } catch (error) {
            result = Promise.reject(toError(error));
        }
        detach(result, context, onError);
    };
}
