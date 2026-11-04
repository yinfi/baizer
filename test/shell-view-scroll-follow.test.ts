/**
 * ShellView 滚动跟随接线测试(issue #64)。
 *
 * 本仓库的 ShellView 测试惯例(见 command-suggestions.test.ts / message-projection.test.ts):
 * 直接 new ShellView(...) 后通过 (view as any) 注入/读取私有字段,不走完整 onOpen()
 * 生命周期(那需要一整套 Obsidian DOM 宿主)。这里沿用同一手法:注入一个带滚动几何的
 * 假 outputContainer 与假的 tabManager,然后直接驱动真实的滚动接线方法。
 *
 * 覆盖的验收标准:
 *  - 1:仅在内容增长前已近底时才跟随(且判断读的是锚存值,不是增长后的新高度)
 *  - 2:用户上翻立即暂停;token / Markdown 定型 / 折叠展开 / 图片延迟加载都不把视口拉回
 *  - 3:只有确有新输出才出现入口;点击后滚到底并恢复跟随
 *  - 4:跟随/未读/阅读位置按会话隔离;切 tab 时过期的 50ms 回调不滚动另一个会话
 */

(global as any).window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带滚动几何的假元素。除了 createDiv/createEl/addEventListener/toggleClass/remove
 * 这些 DOM 宿主方法外,额外提供 scrollTop / scrollHeight / clientHeight 三个
 * 真实滚动盒才有的可写属性,让被测代码读到的几何完全由测试摆布。
 */
class FakeScrollElement {
  children: FakeScrollElement[] = [];
  className = '';
  textContent = '';
  parentElement: FakeScrollElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  createDiv(attr?: any) {
    return this.createEl('div', attr);
  }

  createSpan(attr?: any) {
    return this.createEl('span', attr);
  }

  createEl(_tag: string, attr?: any) {
    const child = new FakeScrollElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    child.parentElement = this;
    for (const name of Object.keys(attr?.attr || {})) {
      child.attributes[name] = String(attr.attr[name]);
    }
    this.children.push(child);
    return child;
  }

  empty() {
    this.children = [];
    this.textContent = '';
  }

  appendChild(child: FakeScrollElement) {
    // 真实 DOM 的 appendChild 对已经是本节点子节点的元素是"移到末尾"而不是
    // 重复插入——moveToEnd() 依赖这个语义(用它把「回到最新」按钮挪到消息
    // 子树之后),这里必须先从旧父节点里摘掉,否则假 DOM 会产生重复子节点,
    // 测不出真实场景下的 DOM 顺序 bug。
    if (child.parentElement) {
      const oldSiblings = child.parentElement.children;
      const index = oldSiblings.indexOf(child);
      if (index !== -1) oldSiblings.splice(index, 1);
    }
    child.parentElement = this;
    this.children.push(child);
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  removeEventListener(type: string, handler: Function) {
    const list = this.listeners[type];
    if (!list) return;
    this.listeners[type] = list.filter((item) => item !== handler);
  }

  /** 触发一个监听器(例如 'scroll' / 'click')。 */
  emit(type: string, event: any = {}) {
    for (const handler of this.listeners[type] || []) {
      handler(event);
    }
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  addClass(name: string) {
    if (!this.hasClass(name)) this.className = `${this.className} ${name}`.trim();
  }

  removeClass(name: string) {
    this.className = this.className.split(' ').filter((token) => token && token !== name).join(' ');
  }

  toggleClass(name: string, enabled: boolean) {
    if (enabled) this.addClass(name);
    else this.removeClass(name);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }

  querySelector(selector: string): FakeScrollElement | null {
    if (!selector.startsWith('.')) return null;
    return this.findFirstByClass(selector.slice(1));
  }

  querySelectorAll(selector: string): FakeScrollElement[] {
    if (!selector.startsWith('.')) return [];
    return this.findAllByClass(selector.slice(1));
  }

  private findFirstByClass(className: string): FakeScrollElement | null {
    for (const child of this.children) {
      if (child.hasClass(className)) return child;
      const nested = child.findFirstByClass(className);
      if (nested) return nested;
    }
    return null;
  }

  private findAllByClass(className: string): FakeScrollElement[] {
    const matches: FakeScrollElement[] = [];
    for (const child of this.children) {
      if (child.hasClass(className)) matches.push(child);
      matches.push(...child.findAllByClass(className));
    }
    return matches;
  }
}

/** 造一个最小可用的 ShellView:注入滚动容器 + 关闭历史菜单副作用。 */
async function createHarness() {
  const { ShellView } = await import('../src/ui/shell-view');
  const { BackToLatestAffordance } = await import('../src/ui/scroll/back-to-latest-affordance');

  const view: any = new ShellView({} as any, {
    getSkillCommands: () => [],
  } as any);

  const output = new FakeScrollElement();
  output.className = 'shell-output-area';
  view.outputContainer = output;
  view.hideHistoryMenu = () => undefined;
  view.persistActiveTab = async () => undefined;

  // 复刻 onOpen 里对滚动容器的接线:监听 scroll + 用户意图事件 + 挂「回到最新」按钮。
  output.addEventListener('scroll', view.handleOutputScrollBound);
  output.addEventListener('wheel', view.handleUserScrollIntentBound);
  output.addEventListener('touchstart', view.handleUserScrollIntentBound);
  output.addEventListener('keydown', view.handleUserScrollIntentBound);
  view.backToLatestAffordance = new BackToLatestAffordance(output, {
    onJumpToLatest: () => view.handleBackToLatestClick(),
  });

  // 视图总是至少有一个 tab;tabManager 由构造函数建好。
  const tabA = view.tabManager.createTab();
  view.tabManager.switchTab(tabA.id);

  /**
   * 每个 tab 自己的内容高度。真实场景里 outputContainer 是共享的滚动盒,但
   * 只有活动 tab 的子树可见(scrollHeight 由活动子树决定),所以切 tab 时
   * 几何必须跟着换成目标 tab 的高度——不建模这一点就无法诚实测试「切回来
   * 恢复阅读位置」。
   */
  const tabHeights: Record<string, number> = {};

  const activeTabId = () => view.tabManager.getActiveTab()?.id as string;

  /** 模拟浏览器把当前活动 tab 的内容撑高到某个高度。 */
  const growContent = (scrollHeight: number) => {
    tabHeights[activeTabId()] = scrollHeight;
    output.scrollHeight = scrollHeight;
  };

  /**
   * 模拟切到某个 tab:tabManager 切换 + 几何换成该 tab 的高度 + 视图恢复该 tab
   * 的阅读位置(对应生产代码 switchTab 里的 restoreScrollForActiveTab 调用)。
   */
  const activateTab = (tabId: string) => {
    view.tabManager.switchTab(tabId);
    output.scrollHeight = tabHeights[tabId] ?? 0;
    view.restoreScrollForActiveTab();
  };

  /** 模拟用户真实滚动到某个位置(会触发 scroll 事件,更新锚点/跟随状态)。 */
  const userScrollTo = (scrollTop: number) => {
    output.scrollTop = scrollTop;
    output.emit('scroll');
  };

  /**
   * 模拟用户的一次滚轮动作:先派发 wheel(确定的用户意图信号),再派发 scroll。
   * 真实浏览器里用户上翻就是这个顺序,且 wheel 会打断进行中的平滑滚动。
   */
  const userWheelTo = (scrollTop: number) => {
    output.emit('wheel', { deltaY: -100 });
    output.scrollTop = scrollTop;
    output.emit('scroll');
  };

  /** 视口高度固定 400px,便于按「距底距离」推演。 */
  output.clientHeight = 400;

  return { view, output, tabA, growContent, userScrollTo, userWheelTo, activateTab, tabHeights, BackToLatestAffordance };
}

function affordanceButton(output: FakeScrollElement) {
  return output.querySelector('.shell-back-to-latest');
}

async function runTests() {
  console.log('=== ShellView Scroll Follow Wiring Tests (issue #64) ===');

  // ── 验收标准1:内容增长前已近底 → 跟随到底 ──
  await test('follows to the bottom when the view was near the bottom before content grew', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(2000);
    userScrollTo(1600); // distance = 2000-1600-400 = 0 -> near bottom
    expect((view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id).isFollowing()).toBe(true);

    // 内容再增长(新 token 上屏),然后触发滚动请求。
    growContent(2600);
    view.scrollToEnd();
    await delay(80); // 越过 50ms 延迟

    expect(output.scrollTop).toBe(2600);
  });

  // ── 验收标准1(核心):近底判断锚定在增长前,而不是用增长后的新高度反推 ──
  await test('a user reading near the bottom keeps following even though growth makes the distance large', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(600);
    userScrollTo(200); // distance = 600-200-400 = 0 -> near bottom, following
    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);

    // 内容暴涨(一屏长回答):若实现是「在滚动时刻用新高度重新判断」,此刻距底已经
    // 是 3000-200-400=2400px,会被误判成「用户不在底部」而不跟随。正确实现读锚存值。
    growContent(3000);
    view.scrollToEnd();
    await delay(80);

    expect(output.scrollTop).toBe(3000);
  });

  // ── 验收标准2:用户上翻立即暂停,后续 token/定型/折叠展开/图片加载都不拉回 ──
  await test('a user scrolling up pauses follow and later output does not pull the viewport back down', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(3000);
    userScrollTo(2600); // 一开始就近底:distance = 3000-2600-400 = 0 -> 跟随
    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);

    userScrollTo(1200); // 用户上翻:distance = 3000-1200-400 = 1400 -> 立即暂停
    expect(follow.isFollowing()).toBe(false);
    expect(output.scrollTop).toBe(1200);

    // 1) 流式 token:内容增长 + scrollToEnd
    growContent(3400);
    view.scrollToEnd();
    await delay(80);
    expect(output.scrollTop).toBe(1200); // 视口没被拉走

    // 2) Markdown 最终定型(renderStreamContent → scrollToEnd;finalizeStream 的异步回调同理)
    growContent(3800);
    view.scrollToEnd();
    await delay(80);
    expect(output.scrollTop).toBe(1200);

    // 3) 过程块折叠/展开:重建活动 tab 消息(高度变化)也不能拉走
    growContent(4200);
    view.rerenderActiveTabPreservingScroll();
    await delay(80);
    expect(output.scrollTop).toBe(1200);

    // 4) 图片延迟加载撑高(只改高度,不改 scrollTop)
    growContent(5000);
    view.rerenderActiveTabPreservingScroll();
    await delay(80);
    expect(output.scrollTop).toBe(1200);

    // 阅读锚点保持,且已标记未读。
    expect(follow.hasUnread()).toBe(true);
    expect(output.scrollTop).toBe(1200);
  });

  // ── 验收标准3:只有确有新输出才出现入口 ──
  await test('the affordance stays hidden while paused with no new output, and appears once output arrives', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(3000);
    userScrollTo(1200); // 上翻暂停
    await delay(10);

    // 仅上翻、没有新内容 -> 不出现入口。
    const badge = affordanceButton(output)!;
    expect(badge.hasClass('baizer-hidden')).toBe(true);

    // 上翻后收到新内容 -> 出现入口。
    growContent(3600);
    view.scrollToEnd();
    await delay(80);
    expect(badge.hasClass('baizer-hidden')).toBe(false);
    expect(output.scrollTop).toBe(1200); // 仍未跳走
  });

  // ── 验收标准3:点击「回到最新」滚到底并恢复跟随;再次上翻能再次暂停 ──
  await test('clicking back-to-latest scrolls to the bottom, resumes following, and a later scroll-up pauses again', async () => {
    const { view, output, growContent, userScrollTo, userWheelTo } = await createHarness();

    growContent(3000);
    userScrollTo(1200);
    growContent(3600);
    view.scrollToEnd();
    await delay(80);

    const badge = affordanceButton(output)!;
    expect(badge.hasClass('baizer-hidden')).toBe(false);

    badge.querySelector('.shell-back-to-latest-button')!.emit('click', { preventDefault: () => { } });

    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);
    expect(follow.hasUnread()).toBe(false);
    expect(output.scrollTop).toBe(3600);
    expect(badge.hasClass('baizer-hidden')).toBe(true);

    // 再次上翻 -> 再次暂停。用滚轮模拟真实用户动作:wheel 会立刻解除
    // 程序化滚动的忽略窗口,所以即便点击「回到最新」的 smooth 动画兜底时长
    // 还没走完,这次上翻也不会被吞掉(「用户上翻立即暂停」)。
    userWheelTo(1500);
    expect(follow.isFollowing()).toBe(false);
  });

  // ── 硬约束补充:滚轮/触摸这类确定的用户意图必须立刻结束忽略窗口 ──
  await test('a wheel event ends the programmatic-scroll ignore window immediately', async () => {
    const { view, output, growContent, userScrollTo, userWheelTo } = await createHarness();

    growContent(3000);
    userScrollTo(2600); // 跟随
    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);

    growContent(4000);
    view.scrollToEnd();
    await delay(80); // 程序化滚到底(300ms 兜底窗口此刻仍在进行中)

    expect(output.scrollTop).toBe(4000);
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);

    // 用户在动画收尾前就上翻:wheel 先到,随后 scroll 事件必须被当作真实操作。
    userWheelTo(1200);
    expect(follow.isFollowing()).toBe(false);
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
  });

  // ── 硬约束:scroll-behavior:smooth 的中间帧不能被误判成用户上翻 ──
  await test('smooth-scroll intermediate frames are not mistaken for a user scroll-up', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(3000);
    userScrollTo(2600); // 近底跟随
    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);

    // 发起一次程序化滚动:代码把 scrollTop 设到底部,忽略窗口随即开启(兜底 300ms)。
    growContent(4000);
    view.scrollToEnd();
    await delay(80);
    expect(output.scrollTop).toBe(4000);
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);

    // 模拟 smooth 动画的中间帧:从起跳位置(2600)单调趋近目标(4000),
    // 中途每一帧距底仍然「看起来很远」。若被当成用户上翻,跟随会被错误暂停。
    output.scrollTop = 2900;
    output.emit('scroll');
    output.scrollTop = 3400;
    output.emit('scroll');
    output.scrollTop = 3800;
    output.emit('scroll');
    expect(follow.isFollowing()).toBe(true); // 中间帧没有把它误判成用户上翻

    // 兜底时长走完后,真实用户上翻能被识别。
    await delay(320);
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
    userScrollTo(1200);
    expect(follow.isFollowing()).toBe(false);
  });

  // 程序化滚动一旦落到目标位置,忽略窗口立即解除(不必等满兜底时长)。
  await test('reaching the programmatic scroll target releases the ignore window early', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(3000);
    userScrollTo(2600);
    const follow = (view as any).scrollFollowControllers.get(view.tabManager.getActiveTab().id);
    expect(follow.isFollowing()).toBe(true);

    growContent(4000);
    view.scrollToEnd();
    await delay(80); // 兜底计时器尚未到期
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);

    // 平滑动画的最后一帧:落在目标位置。
    output.emit('scroll');
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);

    // 因此紧接着的用户上翻立刻生效,不会被剩余的兜底时长吞掉。
    userScrollTo(1200);
    expect(follow.isFollowing()).toBe(false);
  });

  // ── 验收标准4:过期回调不能滚动另一个会话(核心 bug 场景) ──
  await test('a stale delayed scroll request from tab A does not scroll tab B after a tab switch', async () => {
    const { view, output, growContent, userScrollTo, activateTab, tabHeights } = await createHarness();

    const tabA = view.tabManager.getActiveTab();
    const tabB = view.tabManager.createTab(); // 新建即激活 B
    activateTab(tabA.id); // 回到 A

    growContent(2000);
    userScrollTo(1600); // A 近底跟随

    // A 上屏新内容并请求滚动,但 50ms 内用户切到了 B。
    growContent(2600);
    view.scrollToEnd(); // 绑定 tab A
    tabHeights[tabB.id] = 1200;
    activateTab(tabB.id); // 切到 B(B 的内容高度 1200)
    output.scrollTop = 400; // B 自己停在 400

    await delay(80); // A 的延迟回调此刻到期

    // A 的过期请求必须被整体跳过,B 的滚动位置不受影响。
    expect(output.scrollTop).toBe(400);
  });

  await test('per-session follow/unread/position state stays isolated across tab switches', async () => {
    const { view, output, growContent, userScrollTo, activateTab, tabHeights } = await createHarness();

    const tabA = view.tabManager.getActiveTab();
    const tabB = view.tabManager.createTab();
    activateTab(tabA.id);

    // A:近底跟随,然后上翻暂停,并收到新内容 -> A 有未读。
    growContent(3000);
    userScrollTo(2600);
    view.scrollToEnd();
    await delay(80);
    userScrollTo(1000); // A 上翻暂停
    growContent(3600);
    view.scrollToEnd();
    await delay(80);

    const followA = (view as any).scrollFollowControllers.get(tabA.id);
    expect(followA.isFollowing()).toBe(false);
    expect(followA.hasUnread()).toBe(true);
    expect(followA.getLastKnownScrollTop()).toBe(1000);

    // 切到 B:B 是全新会话 -> 从底部、跟随、无未读。
    tabHeights[tabB.id] = 800;
    activateTab(tabB.id);
    const followB = (view as any).scrollFollowControllers.get(tabB.id);
    expect(followB.isFollowing()).toBe(true);
    expect(followB.hasUnread()).toBe(false);

    // B 上翻暂停(B 自己的状态)。
    userScrollTo(100);
    expect(followB.isFollowing()).toBe(false);

    // 切回 A:A 的状态原样恢复,不受 B 影响。
    activateTab(tabA.id);
    expect(followA.isFollowing()).toBe(false);
    expect(followA.hasUnread()).toBe(true);
    expect(output.scrollTop).toBe(1000); // A 的阅读位置被还原(其内容高 3600,不会被裁剪)
    expect(followB.isFollowing()).toBe(false); // B 保持自己的状态

    // 且切回 A 时「回到最新」入口应当可见(A 有未读且暂停)。
    expect(affordanceButton(output)!.hasClass('baizer-hidden')).toBe(false);
  });

  // ── 验收标准4:视图关闭后延迟任务不再影响任何会话 ──
  await test('disposing all schedulers on view close prevents post-close scroll effects', async () => {
    const { view, output, growContent, userScrollTo } = await createHarness();

    growContent(2000);
    userScrollTo(1600);
    growContent(3000);
    view.scrollToEnd(); // 挂起一个 50ms 延迟请求

    // 模拟 onClose 的清理动作(直接调用被清理的部分,避免依赖完整 onClose 生命周期)。
    view.scrollRequestSchedulers.disposeAll();
    view.scrollFollowControllers.clear();
    output.scrollTop = 700;

    await delay(80);
    expect(output.scrollTop).toBe(700); // 关闭后的过期回调没有动它
  });

  // ── 验收标准4:新建会话 vs 恢复会话的初始定位都从底部、跟随开始 ──
  await test('a session first seen in this view starts at the bottom and following', async () => {
    const { view } = await createHarness();
    const follow = (view as any).getOrCreateScrollFollow('never-seen-before');
    expect(follow.isFollowing()).toBe(true);
    expect(follow.hasUnread()).toBe(false);
    expect(follow.getLastKnownScrollTop()).toBe(0);
  });

  // ── 验收标准3/5(静态断言):入口必须贴在*可见视口*底部,不能用 absolute 被滚出屏幕 ──
  await test('affordance stays pinned to the visible viewport (sticky, not absolute) and avoids horizontal overflow', async () => {
    const { readFileSync } = await import('fs');
    const css = readFileSync('styles.css', 'utf8');

    const affordanceRule = css.match(/\.shell-back-to-latest \{[\s\S]*?\}/);
    if (!affordanceRule) throw new Error('missing .shell-back-to-latest rule');
    const rule = affordanceRule[0];
    // .shell-output-area 本身就是 overflow-y: auto 的滚动容器:absolute + bottom
    // 会把按钮定位到*整段可滚动内容*的底部,用户往上翻(正是这个按钮该出现的场景)
    // 时它会跟着上方内容被滚出屏幕——这是一个已经在真实页面上复现过的具体 bug。
    // sticky 以同一个滚动容器为参照,始终贴在当前可见区域底部。
    if (!/position:\s*sticky/.test(rule)) {
      throw new Error('affordance must use position: sticky (absolute scrolls away with content inside its own overflow:auto ancestor)');
    }
    if (/position:\s*absolute/.test(rule)) {
      throw new Error('affordance must not use position: absolute inside its own scrolling ancestor');
    }
    if (!/max-width:\s*calc\(100% - /.test(rule)) {
      throw new Error('affordance must cap its width to the container so a 300px sidebar cannot overflow');
    }
    if (!/left:\s*50%/.test(rule) || !/transform:\s*translateX\(-50%\)/.test(rule)) {
      throw new Error('affordance must be horizontally centred');
    }
    // 按钮自身不得撑破父容器。
    const buttonRule = css.match(/\.shell-back-to-latest-button \{[\s\S]*?\}/);
    if (!buttonRule) throw new Error('missing .shell-back-to-latest-button rule');
    if (!/max-width:\s*100%/.test(buttonRule[0])) {
      throw new Error('affordance button must not exceed its parent width');
    }
    if (!/overflow:\s*hidden/.test(buttonRule[0])) {
      throw new Error('affordance button must clip long labels instead of overflowing');
    }
  });

  // ── 验收标准3/5(DOM 顺序回归):sticky 要求「回到最新」排在消息子树之后 ──
  await test('the affordance element is moved after the tab message subtree in DOM order', async () => {
    const { view, output } = await createHarness();

    // onOpen 的真实顺序:outputContainer 先有 scroll 监听 + 挂「回到最新」按钮,
    // 此刻还没有任何 tab 的消息子树——按钮天然是第一个(也是唯一一个)子节点。
    const affordanceIndexBeforeAnyTab = output.children.indexOf((view.backToLatestAffordance as any).el);
    expect(affordanceIndexBeforeAnyTab).toBe(0);

    // 消息子树是惰性创建的(第一条消息渲染时才 createDiv),发生在按钮构造*之后*,
    // 默认会被插到按钮后面。position: sticky 只有排在"正常流里更早的高内容兄弟
    // 节点"之后才贴得住可见视口底部——如果按钮还留在最前面,sticky 会退化成
    // 和 absolute 一样,用户往上翻时跟着内容一起滚出屏幕(issue #64 的真实回归)。
    view.getActiveMessageContainer();

    const tabMessagesIndex = output.children.findIndex((child: any) => child.hasClass('shell-tab-messages'));
    const affordanceIndexAfter = output.children.indexOf((view.backToLatestAffordance as any).el);
    if (tabMessagesIndex === -1) throw new Error('expected a .shell-tab-messages subtree to have been created');
    if (!(affordanceIndexAfter > tabMessagesIndex)) {
      throw new Error(
        `affordance must come after the message subtree in DOM order for position:sticky to stick ` +
        `(tabMessagesIndex=${tabMessagesIndex}, affordanceIndex=${affordanceIndexAfter})`
      );
    }

    // 还要对第二个 tab 成立:每次冒出新的子树兄弟节点都要把按钮重新挪到最后。
    const tabB = view.tabManager.createTab();
    view.tabManager.switchTab(tabB.id);
    view.getActiveMessageContainer();
    const affordanceIndexFinal = output.children.indexOf((view.backToLatestAffordance as any).el);
    expect(affordanceIndexFinal).toBe(output.children.length - 1);
  });

  await test('the affordance label is translated through t() (no hardcoded Chinese in shell-view)', async () => {
    const { readFileSync } = await import('fs');
    const shellView = readFileSync('src/ui/shell-view.ts', 'utf8');
    // 只检查*字符串字面量*里出现的标签文案,不检查中文注释——本仓库大量
    // 中文注释是正常的,硬约束管的是「界面文案」不能跳过 t() 直接硬编码。
    const stringLiteralWithLabel = /['"`][^'"`\n]*回到最新[^'"`\n]*['"`]/;
    if (stringLiteralWithLabel.test(shellView)) {
      throw new Error('shell-view.ts must not hardcode the affordance label in a string literal');
    }
    const affordance = readFileSync('src/ui/scroll/back-to-latest-affordance.ts', 'utf8');
    if (!/t\('New messages/.test(affordance)) {
      throw new Error('affordance label must go through t()');
    }
    const messages = readFileSync('src/i18n/zh-messages.ts', 'utf8');
    if (!messages.includes('New messages')) {
      throw new Error('zh-messages.ts must carry the affordance translation');
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
