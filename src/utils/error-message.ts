/**
 * 从任意抛出值里取出可展示的错误信息。
 *
 * 插件在剪贴板、事件回调、第三方 promise 这些边界上接到的值不一定是 `Error`：
 * 可能是字符串、带 `message` 字段的普通对象、数字，甚至 `null` / `undefined`。
 * 之前用 `e?.message || 'unknown error'` 表达这种「尽力而为」的语义，只有把
 * 参数标成 `any` 才能通过类型检查；这里改成 `unknown` + 显式窄化，运行时语义
 * 保持不变：
 *
 * - 有 truthy 的 `message` 就显示它（非字符串按模板字符串的字符串化规则转换）；
 * - 其余情况（无 message、空字符串、非对象抛出值）回退到 fallback。
 *
 * 不要求 `instanceof Error`：非 Error 但带 message 的对象此前能显示，
 * 不应因为这次类型清理而丢掉这条信息。
 */
export function getErrorMessage(error: unknown, fallback = 'unknown error'): string {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        const message = (error as { message?: unknown }).message;
        if (message) return String(message);
    }
    return fallback;
}
