/**
 * 轻量 i18n：以英文原文作为 key 的键值表 + t(key)。
 *
 * 设计取舍（第一性原理）：
 * - 面向用户的英文文案数量大（settings ~200 条），若为每条发明 key 名，改造成本与出错率都高。
 * - 直接以「英文原文」为 key：调用点从 setName('Overview') 改成 setName(t('Overview')) 即可，
 *   零 key 命名负担，也让漏翻译时天然回退到英文原文（key 本身就是英文）。
 * - 仅在中文环境启用翻译；其它 locale 一律返回原文。
 * - 绝不用于面向 LLM 的 prompt 文案——那些必须保持英文，不经过 t()。
 */

import { ZH_MESSAGES } from './zh-messages';

/** 是否处于中文环境。navigator 在移动端/桌面端均可用；缺失时按非中文处理。 */
function detectIsChinese(): boolean {
    try {
        const lang = (globalThis.navigator?.language || '').toLowerCase();
        return lang.startsWith('zh');
    } catch {
        return false;
    }
}

let isChinese = detectIsChinese();

/** 测试或手动覆盖 locale 时使用。 */
export function setLocaleForTesting(chinese: boolean): void {
    isChinese = chinese;
}

/**
 * 翻译。key 即英文原文；命中中文表且为中文环境则返回中文，否则原样返回 key。
 */
export function t(key: string): string {
    if (!isChinese) return key;
    return ZH_MESSAGES[key] ?? key;
}
