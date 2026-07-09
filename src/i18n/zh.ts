/**
 * 轻量 i18n：以英文原文作为 key 的键值表 + t(key)。
 *
 * 设计取舍（第一性原理）：
 * - 面向用户的英文文案数量大（settings ~200 条），若为每条发明 key 名，改造成本与出错率都高。
 * - 直接以「英文原文」为 key：调用点从 setName('Overview') 改成 setName(t('Overview')) 即可，
 *   零 key 命名负担，也让漏翻译时天然回退到英文原文（key 本身就是英文）。
 * - 语言由用户设定的 Locale 驱动：'auto' 回落到系统探测，'en'/'zh' 显式指定。
 * - 绝不用于面向 LLM 的 prompt 文案——那些必须保持英文，不经过 t()。
 */

import { ZH_MESSAGES } from './zh-messages';

/** 用户可选语言：auto=跟随系统，en=英文，zh=中文。 */
export type Locale = 'auto' | 'en' | 'zh';

/** 系统是否为中文环境。navigator 在移动端/桌面端均可用；缺失时按非中文处理。 */
function detectIsChinese(): boolean {
    try {
        const lang = (globalThis.navigator?.language || '').toLowerCase();
        return lang.startsWith('zh');
    } catch {
        return false;
    }
}

/** 用户设定的语言，默认跟随系统。 */
let currentLocale: Locale = 'auto';

/** 把用户设定解析为实际生效的具体语言（en / zh）。auto 时按系统探测。 */
function resolveLocale(): 'en' | 'zh' {
    if (currentLocale === 'auto') return detectIsChinese() ? 'zh' : 'en';
    return currentLocale;
}

/** 设置当前语言。设置面板切换、loadSettings 初始化均调用此函数。 */
export function setLocale(locale: Locale): void {
    currentLocale = locale;
}

/** 读取用户设定的语言（可能是 'auto'）。 */
export function getLocale(): Locale {
    return currentLocale;
}

/**
 * 测试或手动覆盖 locale 时使用；保留旧签名，内部转发到 setLocale。
 */
export function setLocaleForTesting(chinese: boolean): void {
    setLocale(chinese ? 'zh' : 'en');
}

/**
 * 翻译。key 即英文原文；解析为 zh 且命中中文表则返回中文，否则原样返回 key。
 */
export function t(key: string): string {
    if (resolveLocale() !== 'zh') return key;
    return ZH_MESSAGES[key] ?? key;
}
