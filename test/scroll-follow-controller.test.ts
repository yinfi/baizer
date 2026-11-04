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

function geometry(scrollTop: number, scrollHeight: number, clientHeight = 400) {
  return { scrollTop, scrollHeight, clientHeight };
}

async function runTests() {
  console.log('=== ScrollFollowController Tests ===');
  const { ScrollFollowController, NEAR_BOTTOM_THRESHOLD_PX } = await import('../src/ui/scroll/scroll-follow-controller');

  await test('new controller defaults to following and no unread', () => {
    const follow = new ScrollFollowController();
    expect(follow.isFollowing()).toBe(true);
    expect(follow.hasUnread()).toBe(false);
  });

  await test('threshold boundary: distance exactly at threshold is NOT near-bottom (strict <)', () => {
    const follow = new ScrollFollowController();
    // scrollHeight(1000) - scrollTop(520) - clientHeight(400) = 80 == threshold, not < threshold.
    follow.onScroll(geometry(520, 1000, 400));
    expect(follow.isFollowing()).toBe(false);
    expect(follow.isLatchedNearBottom()).toBe(false);
  });

  await test('threshold boundary: distance one pixel inside threshold is near-bottom', () => {
    const follow = new ScrollFollowController();
    // distance = 1000 - 521 - 400 = 79 < 80.
    follow.onScroll(geometry(521, 1000, 400));
    expect(follow.isFollowing()).toBe(true);
    expect(follow.isLatchedNearBottom()).toBe(true);
  });

  await test('custom threshold is respected', () => {
    const follow = new ScrollFollowController({ thresholdPx: 10 });
    // distance = 1000 - 585 - 400 = 15, not < 10 with the custom threshold.
    follow.onScroll(geometry(585, 1000, 400));
    expect(follow.isFollowing()).toBe(false);
  });

  await test('user scrolling up pauses following immediately', () => {
    const follow = new ScrollFollowController();
    expect(follow.isFollowing()).toBe(true);
    // Far from bottom.
    follow.onScroll(geometry(0, 2000, 400));
    expect(follow.isFollowing()).toBe(false);
  });

  await test('scrolling back near bottom resumes following and clears unread', () => {
    const follow = new ScrollFollowController();
    follow.onScroll(geometry(0, 2000, 400)); // pause
    follow.onContentWillGrow(); // marks unread while paused
    expect(follow.hasUnread()).toBe(true);

    follow.onScroll(geometry(1650, 2000, 400)); // distance = 2000-1650-400=-50 < 80: near bottom
    expect(follow.isFollowing()).toBe(true);
    expect(follow.hasUnread()).toBe(false);
  });

  // 验收标准1:近底判断不能在内容增长之后用新的 scrollHeight 反推。
  await test('onContentWillGrow reads the latched pre-growth state, not a recomputed one', () => {
    const follow = new ScrollFollowController();
    // User was near the bottom of a short transcript.
    follow.onScroll(geometry(120, 200, 400)); // distance = 200-120-400 <0 -> near bottom, following=true
    expect(follow.isFollowing()).toBe(true);

    // Content grows a lot (long streamed answer) without any new scroll event in between.
    // onContentWillGrow must still say "yes, follow" because the user WAS at the bottom
    // before growth — it must not require a fresh measurement against the new scrollHeight.
    const shouldFollow = follow.onContentWillGrow();
    expect(shouldFollow).toBe(true);
  });

  await test('pausing keeps onContentWillGrow returning false across repeated growth (tokens)', () => {
    const follow = new ScrollFollowController();
    follow.onScroll(geometry(0, 5000, 400)); // scrolled far up, paused
    expect(follow.onContentWillGrow()).toBe(false); // token 1
    expect(follow.onContentWillGrow()).toBe(false); // token 2 (markdown finalize)
    expect(follow.onContentWillGrow()).toBe(false); // token 3 (image load)
    expect(follow.hasUnread()).toBe(true);
    expect(follow.isFollowing()).toBe(false);
  });

  await test('jumpToLatest resumes following and clears unread', () => {
    const follow = new ScrollFollowController();
    follow.onScroll(geometry(0, 5000, 400));
    follow.onContentWillGrow();
    expect(follow.hasUnread()).toBe(true);

    follow.jumpToLatest();
    expect(follow.isFollowing()).toBe(true);
    expect(follow.hasUnread()).toBe(false);
    expect(follow.isLatchedNearBottom()).toBe(true);
  });

  await test('recordScrollPosition updates the reading anchor without touching follow/unread state', () => {
    const follow = new ScrollFollowController();
    follow.onScroll(geometry(0, 5000, 400)); // paused, anchor = 0
    follow.onContentWillGrow(); // unread
    expect(follow.isFollowing()).toBe(false);
    expect(follow.hasUnread()).toBe(true);

    follow.recordScrollPosition(1234);
    expect(follow.getLastKnownScrollTop()).toBe(1234);
    // Recording geometry must not be mistaken for user intent.
    expect(follow.isFollowing()).toBe(false);
    expect(follow.hasUnread()).toBe(true);
  });

  // 硬约束:scroll-behavior:smooth 期间的中间帧 scroll 事件必须被忽略,不能误判成用户上翻。
  await test('onScroll is ignored while a programmatic scroll is in flight', () => {
    const follow = new ScrollFollowController();
    follow.beginProgrammaticScroll();
    // Smooth-scroll intermediate frame: far from bottom while mid-animation.
    follow.onScroll(geometry(100, 5000, 400));
    // Must NOT have paused following — this was a programmatic scroll in flight, not a user action.
    expect(follow.isFollowing()).toBe(true);
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);

    follow.endProgrammaticScroll();
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
    // A real scroll event after the programmatic scroll ends is honoured normally.
    follow.onScroll(geometry(100, 5000, 400));
    expect(follow.isFollowing()).toBe(false);
  });

  await test('nested begin/end programmatic scroll calls require matching end calls', () => {
    const follow = new ScrollFollowController();
    follow.beginProgrammaticScroll();
    follow.beginProgrammaticScroll();
    follow.endProgrammaticScroll();
    expect(follow.isProgrammaticScrollInFlight()).toBe(true); // still one outstanding
    follow.onScroll(geometry(100, 5000, 400));
    expect(follow.isFollowing()).toBe(true); // still ignored

    follow.endProgrammaticScroll();
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
  });

  await test('reaching the declared programmatic target ends the ignore window early', () => {
    const follow = new ScrollFollowController();
    follow.beginProgrammaticScroll(4600); // start anchor is 0 (fresh controller)
    follow.onScroll(geometry(2000, 5000, 400)); // mid-animation frame, still ignored
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);
    expect(follow.isFollowing()).toBe(true);

    follow.onScroll(geometry(4600, 5000, 400)); // lands exactly on target
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
    expect(follow.getLastKnownScrollTop()).toBe(4600); // this event was processed, not dropped
  });

  await test('a scroll that moves away from the programmatic target is treated as user intent', () => {
    const follow = new ScrollFollowController();
    follow.onScroll(geometry(2600, 5000, 400)); // paused: distance 2000 is not near bottom
    follow.onContentWillGrow(); // unread, per the acceptance criteria
    expect(follow.isFollowing()).toBe(false);

    // A programmatic "jump to bottom" is requested from this paused state
    // (e.g. clicking "back to latest"): start anchor is 2600, target is 4600.
    follow.beginProgrammaticScroll(4600);

    // Smooth-scroll frames moving monotonically toward the target are ignored
    // (the click already resumed following synchronously before this call).
    follow.jumpToLatest();
    follow.onScroll(geometry(3200, 5000, 400));
    expect(follow.isProgrammaticScrollInFlight()).toBe(true);
    expect(follow.isFollowing()).toBe(true);

    // The user grabs the scrollbar and drags it the other way mid-animation
    // (no wheel/touch/key event fires for a scrollbar drag, so this is the
    // only signal available). It is now farther from the target than the
    // start position was -> treated as a real user action, not animation noise.
    follow.onScroll(geometry(500, 5000, 400));
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
    expect(follow.isFollowing()).toBe(false); // paused immediately
    expect(follow.getLastKnownScrollTop()).toBe(500);
  });

  await test('noteUserScrollIntent ends the ignore window immediately regardless of geometry', () => {
    const follow = new ScrollFollowController();
    follow.beginProgrammaticScroll(4600);
    follow.onScroll(geometry(2000, 5000, 400)); // ignored, still mid-animation

    follow.noteUserScrollIntent(); // wheel/touchstart/keydown observed
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);

    // The very next scroll event is now honoured as real user input.
    follow.onScroll(geometry(1800, 5000, 400));
    expect(follow.isFollowing()).toBe(false);
  });

  await test('endProgrammaticScroll never goes negative past zero', () => {
    const follow = new ScrollFollowController();
    follow.endProgrammaticScroll();
    follow.endProgrammaticScroll();
    expect(follow.isProgrammaticScrollInFlight()).toBe(false);
    // A genuine scroll event right after is honoured (not stuck "in flight" forever).
    follow.onScroll(geometry(0, 5000, 400));
    expect(follow.isFollowing()).toBe(false);
  });

  // 每会话独立实例 = 隔离:一个实例的状态变化不影响另一个实例。
  await test('two independent controller instances do not share state (per-session isolation)', () => {
    const sessionA = new ScrollFollowController();
    const sessionB = new ScrollFollowController();

    sessionA.onScroll(geometry(0, 5000, 400)); // A scrolls way up
    sessionA.onContentWillGrow(); // A gets new content while paused -> unread

    expect(sessionA.isFollowing()).toBe(false);
    expect(sessionA.hasUnread()).toBe(true);
    // B must be completely unaffected.
    expect(sessionB.isFollowing()).toBe(true);
    expect(sessionB.hasUnread()).toBe(false);
  });

  await test('NEAR_BOTTOM_THRESHOLD_PX is the documented single constant (80px)', () => {
    expect(NEAR_BOTTOM_THRESHOLD_PX).toBe(80);
  });

  await test('a brand-new session (initialFollowing default) starts following from the bottom', () => {
    const follow = new ScrollFollowController({ initialFollowing: true });
    expect(follow.isFollowing()).toBe(true);
    expect(follow.isLatchedNearBottom()).toBe(true);
  });
}

async function runSchedulerTests() {
  console.log('=== ScrollRequestScheduler Tests (stale-delay invalidation) ===');
  const { ScrollRequestScheduler, ScrollRequestSchedulerRegistry } = await import('../src/ui/scroll/scroll-request-scheduler');

  await test('fires run() when the active session still matches the one that requested it', async () => {
    let activeId = 'tab-a';
    let runCount = 0;
    const scheduler = new ScrollRequestScheduler('tab-a', {
      delayMs: 5,
      getActiveSessionId: () => activeId,
      run: () => { runCount += 1; },
    });

    scheduler.request();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCount).toBe(1);
  });

  // 核心 bug 场景:50ms 延迟期间用户切换了 tab,过期回调必须整体跳过,不能误触另一个会话。
  await test('skips run() entirely when the active session changed before the delay fired (stale callback)', async () => {
    let activeId = 'tab-a';
    let runCount = 0;
    const scheduler = new ScrollRequestScheduler('tab-a', {
      delayMs: 5,
      getActiveSessionId: () => activeId,
      run: () => { runCount += 1; },
    });

    scheduler.request();
    activeId = 'tab-b'; // user switched tabs within the delay window
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCount).toBe(0);
  });

  await test('cancelPending() prevents a pending request from firing', async () => {
    let runCount = 0;
    const scheduler = new ScrollRequestScheduler('tab-a', {
      delayMs: 5,
      getActiveSessionId: () => 'tab-a',
      run: () => { runCount += 1; },
    });

    scheduler.request();
    scheduler.cancelPending();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCount).toBe(0);
  });

  await test('dispose() permanently invalidates the scheduler, even for future request() calls', async () => {
    let runCount = 0;
    const scheduler = new ScrollRequestScheduler('tab-a', {
      delayMs: 5,
      getActiveSessionId: () => 'tab-a',
      run: () => { runCount += 1; },
    });

    scheduler.dispose();
    scheduler.request(); // must be a no-op post-dispose
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCount).toBe(0);
  });

  await test('multiple request() calls before the delay fires only run once (coalesced)', async () => {
    let runCount = 0;
    const scheduler = new ScrollRequestScheduler('tab-a', {
      delayMs: 10,
      getActiveSessionId: () => 'tab-a',
      run: () => { runCount += 1; },
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runCount).toBe(1);
  });

  await test('registry isolates per-session schedulers: disposing one tab does not affect another', async () => {
    let activeId = 'tab-a';
    const runs: string[] = [];
    const registry = new ScrollRequestSchedulerRegistry<string>((sessionId) =>
      new ScrollRequestScheduler(sessionId, {
        delayMs: 5,
        getActiveSessionId: () => activeId,
        run: (id) => { runs.push(id); },
      }),
    );

    registry.request('tab-a');
    registry.dispose('tab-a');
    registry.request('tab-b');
    activeId = 'tab-b';
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runs).toEqual(['tab-b']);
  });

  await test('registry disposeAll() invalidates every session scheduler (view close)', async () => {
    const runs: string[] = [];
    const registry = new ScrollRequestSchedulerRegistry<string>((sessionId) =>
      new ScrollRequestScheduler(sessionId, {
        delayMs: 5,
        getActiveSessionId: () => sessionId,
        run: (id) => { runs.push(id); },
      }),
    );

    registry.request('tab-a');
    registry.request('tab-b');
    registry.disposeAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runs).toEqual([]);
  });
}

runTests()
  .then(() => runSchedulerTests())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
