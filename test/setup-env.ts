/**
 * Node 测试环境的浏览器全局垫片。
 *
 * 插件代码按 Obsidian 平台要求使用 `window.setTimeout` / `createDiv` 等 API
 * （弹出窗口兼容，见 issue #91），而单元测试跑在裸 Node 下，没有 `window`
 * 与 Obsidian 注入的全局 DOM 助手。本文件在测试进程启动时补齐这两类全局，
 * 让生产写法在单测中依然可执行。
 *
 * 由 test/run-tests.ts 通过 `--import` 注入。单独运行某个测试文件时：
 *   npx tsx --tsconfig tsconfig.test.json --import ./test/setup-env.ts test/xxx.test.ts
 */

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface FakeDomElement {
  tagName: string;
  className: string;
  textContent: string;
  id: string;
  title: string;
  style: Record<string, unknown>;
  dataset: Record<string, string>;
  children: FakeDomElement[];
  parentNode: FakeDomElement | null;
  [key: string]: unknown;
}

/** 给元素套上 Obsidian `DomElementInfo`（cls / text / attr）。 */
function applyElementInfo(element: FakeDomElement, options?: unknown): void {
  if (typeof options === 'string') {
    element.className = options;
    return;
  }
  if (!options || typeof options !== 'object') return;
  const info = options as { cls?: string | string[]; text?: string; attr?: Record<string, string> };
  if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
  if (info.text) element.textContent = info.text;
  for (const [name, value] of Object.entries(info.attr ?? {})) element[name] = value;
}

function createFakeElement(tagName: string): FakeDomElement {
  const element: FakeDomElement = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    id: '',
    title: '',
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    setAttribute(name: string, value: string) {
      element[name] = value;
    },
    removeAttribute(name: string) {
      delete element[name];
    },
    getAttribute(name: string) {
      return (element[name] as string | undefined) ?? null;
    },
    addClass(...classes: string[]) {
      const current = element.className.split(' ').filter(Boolean);
      for (const cls of classes) {
        if (!current.includes(cls)) current.push(cls);
      }
      element.className = current.join(' ');
    },
    removeClass(...classes: string[]) {
      element.className = element.className
        .split(' ')
        .filter(name => name && !classes.includes(name))
        .join(' ');
    },
    hasClass(cls: string) {
      return element.className.split(' ').includes(cls);
    },
    toggleClass(cls: string, enabled: boolean) {
      const addClass = element.addClass as (...names: string[]) => void;
      const removeClass = element.removeClass as (...names: string[]) => void;
      if (enabled) addClass(cls);
      else removeClass(cls);
    },
    setText(text: string) {
      element.textContent = text;
    },
    getText() {
      return element.textContent;
    },
    appendChild(child: FakeDomElement) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    append(...nodes: FakeDomElement[]) {
      for (const node of nodes) (element.appendChild as (child: FakeDomElement) => FakeDomElement)(node);
    },
    remove() {
      const parent = element.parentNode;
      if (!parent) return;
      parent.children = parent.children.filter(child => child !== element);
      element.parentNode = null;
    },
    empty() {
      element.children = [];
      element.textContent = '';
    },
    contains(node: FakeDomElement | null) {
      return node === element || element.children.includes(node as FakeDomElement);
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setCssStyles(styles: Record<string, unknown>) {
      element.style = { ...element.style, ...styles };
    },
    setCssProps(props: Record<string, unknown>) {
      element.style = { ...element.style, ...props };
    },
    createDiv(options?: unknown) {
      const child = createFakeElement('div');
      applyElementInfo(child, options);
      (element.appendChild as (created: FakeDomElement) => FakeDomElement)(child);
      return child;
    },
    createSpan(options?: unknown) {
      const child = createFakeElement('span');
      applyElementInfo(child, options);
      (element.appendChild as (created: FakeDomElement) => FakeDomElement)(child);
      return child;
    },
    createEl(tag: string, options?: unknown) {
      const child = createFakeElement(tag);
      applyElementInfo(child, options);
      (element.appendChild as (created: FakeDomElement) => FakeDomElement)(child);
      return child;
    },
    createSvg(tag: string, options?: unknown) {
      const child = createFakeElement(tag);
      applyElementInfo(child, options);
      (element.appendChild as (created: FakeDomElement) => FakeDomElement)(child);
      return child;
    },
  };
  return element;
}

function createGlobalElement(tagName: string, options?: unknown): FakeDomElement {
  const element = createFakeElement(tagName);
  applyElementInfo(element, options);
  return element;
}

const scope = globalThis as Record<string, unknown>;

if (typeof scope.window === 'undefined') {
  // 与浏览器一致：window === globalThis。补齐 Node 上没有的浏览器成员。
  scope.window = scope;
  const windowMembers: Record<string, unknown> = {
    setTimeout: (handler: (...args: unknown[]) => void, ms?: number) =>
      globalThis.setTimeout(handler, ms) as TimerHandle,
    clearTimeout: (handle: TimerHandle) => globalThis.clearTimeout(handle),
    setInterval: (handler: (...args: unknown[]) => void, ms?: number) =>
      globalThis.setInterval(handler, ms) as TimerHandle,
    clearInterval: (handle: TimerHandle) => globalThis.clearInterval(handle),
    requestAnimationFrame: (callback: (time: number) => void) =>
      globalThis.setTimeout(() => callback(Date.now()), 0) as TimerHandle,
    cancelAnimationFrame: (handle: TimerHandle) => globalThis.clearTimeout(handle),
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  };
  for (const [key, value] of Object.entries(windowMembers)) {
    if (!(key in scope)) scope[key] = value;
  }
}

// Obsidian 注入的全局 DOM 助手（无 window 的 `document.createElement` 替代品）。
scope.createEl = (tag: string, options?: unknown) => createGlobalElement(tag, options);
scope.createDiv = (options?: unknown) => createGlobalElement('div', options);
scope.createSpan = (options?: unknown) => createGlobalElement('span', options);
scope.createSvg = (tag: string, options?: unknown) => createGlobalElement(tag, options);
scope.createFragment = (callback?: (fragment: FakeDomElement) => void) => {
  const fragment = createFakeElement('fragment');
  callback?.(fragment);
  return fragment;
};
