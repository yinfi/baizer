/**
 * 外部输入(JSON.parse / 磁盘读取 / 工具与模型返回值)的运行时窄化助手。
 *
 * 目的:用 `unknown` + 显式窄化取代 `any` 上的直接属性访问(no-unsafe-member-access),
 * 而不是换成另一种绕过检查的断言。所有助手只做「类型判断」,不做默认值填充或转换,
 * 因此替换原有 `x.foo` 访问时,取值语义保持不变:取不到/类型不符时得到 undefined。
 */

/** 非 null 的对象(含数组)。需要排除数组时用 isPlainRecord。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** 非 null、非数组的对象。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 unknown 当作对象读取;不是对象时返回空对象(只读使用,勿写入)。 */
export function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : EMPTY_RECORD;
}
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({});

/** 读取对象上的某个属性;value 不是对象时返回 undefined。 */
export function prop(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

/** 仅当值本身是 string 时返回它,否则 undefined。 */
export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** 仅当值是 number 时返回它,否则 undefined。 */
export function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/** 仅当值是 boolean 时返回它,否则 undefined。 */
export function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** 数组时返回 unknown[],否则 undefined。 */
export function asArray(value: unknown): unknown[] | undefined {
    return Array.isArray(value) ? (value as unknown[]) : undefined;
}
