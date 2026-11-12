/**
 * 从任意抛出值里取出可读的错误文本。
 *
 * 为什么不是常见的 `error instanceof Error ? error.message : String(error)`：
 * 这里替换掉的原实现是 `e?.message`，它对「非 Error 但带 message 的对象」同样有效——
 * 而跨 realm 的异常（例如 Electron 渲染进程抛出来的）在本 realm 里
 * `instanceof Error` 恰好为 false。只认 Error 会把原本能显示的信息换成回退文案，
 * 也就是 issue #67 明确要求避免的「因只接受 Error 而丢弃原先可显示的信息」。
 *
 * 返回 '' 表示「拿不到可读信息」，回退文案由调用方决定（原实现是 `|| 'unknown error'`）。
 * 与 `e?.message || 回退文案` 逐值对齐：message 为真值时才文本化显示（数字/对象照旧显示），
 * 假值（''/0/false/null/undefined/NaN）与原始类型抛出值（字符串/数字等）一律回退。
 */
export function thrownMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message: unknown = error.message;
        // 原实现把 message 交给 `|| 'unknown error'` 与模板字符串，故只文本化真值。
        return message ? String(message) : '';
    }
    return '';
}
