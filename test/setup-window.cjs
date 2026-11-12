/**
 * 测试预加载:让 Node 下的测试拥有 `window`。
 *
 * 源码按 Obsidian 弹出窗口的要求使用 `window.setTimeout` 等,而测试跑在没有 DOM 的 Node 里。
 * 这里把 `window` 定义成回落到 globalThis 的代理:
 *   - 读取任何成员都实时取自 globalThis,所以测试里对 `globalThis.setTimeout` / `fetch` 的替换照常生效;
 *   - 测试自己 `global.window = {...}` 赋值时,保留它的成员并对缺失成员回落到 globalThis。
 */
function withFallback(target) {
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      const value = globalThis[key];
      return typeof value === 'function' && !/^[A-Z]/.test(String(key)) ? value.bind(globalThis) : value;
    },
    set(obj, key, value) {
      // 写入(如测试里的 window.fetch = ...)落到 globalThis,与读取保持一致。
      if (key in obj) obj[key] = value;
      else globalThis[key] = value;
      return true;
    },
    has(obj, key) {
      return key in obj || key in globalThis;
    },
  });
}

let current = withFallback({});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  enumerable: true,
  get() { return current; },
  set(value) { current = withFallback(value ?? {}); },
});