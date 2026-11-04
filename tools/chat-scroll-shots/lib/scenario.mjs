/**
 * Deterministic chat-scroll scenario driven directly through the real
 * `ShellView` code path (`handleStatusChange` / `handleStreamEvent`), per
 * `src/models/interfaces.ts:65`'s `StreamEvent` union.
 *
 * All of this executes inside the Obsidian renderer via `Runtime.evaluate`,
 * so every function here must be self-contained and string-serialisable
 * (no closures over outer scope, no imports).
 */

/** Builds enough StreamEvents to force real overflow in `.shell-output-area`. */
function buildLongParagraph(sentenceCount, seed) {
  // Deliberately avoids the issue's own affordance copy ("回到最新" / "有新输出") and any English
  // equivalent ("back to latest" / "new message") so the probe's text-heuristic affordance search
  // in lib/chat-probe.mjs cannot false-positive match ordinary streamed prose instead of a real
  // interactive control.
  const topics = [
    '滚动跟随策略需要同时考虑距底阈值与用户主动上翻的信号',
    '流式增量渲染不应在用户阅读历史内容时把视口强行拉回去',
    '折叠与展开的思考时间线节点不应触发非预期的滚动跳转',
    '多会话之间的跟随状态、未读计数与阅读锚点必须互相隔离',
    '窄侧栏布局下的提示入口同样需要保持清晰且容易点中',
  ];
  const parts = [];
  for (let i = 0; i < sentenceCount; i += 1) {
    parts.push(`${topics[(i + seed) % topics.length]}（第 ${i + 1} 句，seed ${seed}）。`);
  }
  return parts.join('');
}

/**
 * Returns the ordered list of {type, event, note} steps this scenario drives.
 * `type: 'event'` → call `view.handleStreamEvent(event)`.
 * `type: 'status'` → call `view.handleStatusChange(event)` (event is boolean).
 * `type: 'marker'` → no view call; a checkpoint the driver captures/measures at.
 */
export function buildScenarioSteps() {
  const steps = [];
  steps.push({ type: 'status', event: true, note: 'stream starts (loading indicator)' });

  // Phase 1: stream enough content to overflow the container and land at the bottom.
  // Several text_delta chunks (not one big one) because the real stream never arrives whole,
  // and the debounced block-level renderer (`renderStreamContent`) needs multiple ticks to
  // exercise stable/tail block promotion the same way a live model response would.
  for (let i = 0; i < 14; i += 1) {
    steps.push({
      type: 'event',
      event: { type: 'text_delta', content: `${buildLongParagraph(3, i)}\n\n` },
      note: `initial text_delta chunk ${i + 1}/14`,
    });
  }
  steps.push({ type: 'sync', note: 'streamed-to-bottom sync point (phase 1 end, not independently captured)' });

  // Phase 2: a tool-call / thinking timeline block, so collapse/expand has something to act on.
  steps.push({ type: 'event', event: { type: 'step_boundary' }, note: 'step boundary before tool call' });
  steps.push({
    type: 'event',
    event: { type: 'thinking', content: '检查当前视口是否已经接近底部，决定是否需要继续跟随滚动。' },
    note: 'thinking block (goes into the timeline, not the response body)',
  });
  steps.push({
    type: 'event',
    event: { type: 'tool_call', name: 'search_vault', args: { query: 'scroll follow threshold' }, id: 'call-1' },
    note: 'tool_call (renders into the timeline)',
  });
  steps.push({
    type: 'event',
    event: { type: 'tool_result', name: 'search_vault', result: { matches: 3 }, id: 'call-1' },
    note: 'tool_result',
  });
  steps.push({ type: 'event', event: { type: 'step_boundary' }, note: 'step boundary after tool call' });

  // Phase 3: more streamed text to push well past one screen of overflow.
  for (let i = 0; i < 16; i += 1) {
    steps.push({
      type: 'event',
      event: { type: 'text_delta', content: `${buildLongParagraph(3, i + 100)}\n\n` },
      note: `post-tool text_delta chunk ${i + 1}/16`,
    });
  }
  steps.push({ type: 'sync', note: 'fully streamed-to-bottom sync point (ready to scroll up, not independently captured)' });

  // Scenario proper per the issue: scroll up at least one screen, THEN more output arrives.
  steps.push({ type: 'scroll-up', amountScreens: 1.3, note: 'user scrolls up >= 1 screen while streaming' });
  steps.push({ type: 'marker', note: 'capture-1 scrolled-up reading anchor preserved' });

  for (let i = 0; i < 10; i += 1) {
    steps.push({
      type: 'event',
      event: { type: 'text_delta', content: `${buildLongParagraph(3, i + 200)}\n\n` },
      note: `after-scroll-up text_delta chunk ${i + 1}/10`,
    });
  }
  steps.push({ type: 'marker', note: 'capture-2 paused with new output arrived (back-to-latest entry expected)' });

  // `text: ''` is deliberate: ShellView.finalizeStream() prefers a non-empty `done.text` over the
  // UI's own accumulated text (it exists so the runtime can replace the final text, e.g. on a
  // generation-quality rewrite). A real stream's `done.text` is the FULL final answer; passing a
  // short placeholder here would truncate the rendered content and collapse scrollHeight, which
  // would misrepresent the scenario. Empty string falls back to `streamAccumulatedText`, i.e. the
  // same content already rendered from the text_delta chunks above, which is what we want.
  steps.push({
    type: 'event',
    event: { type: 'done', text: '' },
    note: 'stream done',
  });
  steps.push({ type: 'status', event: false, note: 'stream ends' });
  steps.push({ type: 'marker', note: 'capture-3 post-done still-scrolled-up (stream end must not force scroll)' });

  steps.push({ type: 'click-affordance', note: 'click the back-to-latest affordance' });
  steps.push({ type: 'marker', note: 'capture-4 post-click resumed follow at bottom' });

  return steps;
}

/**
 * Page-side driver: locates the ShellView instance and plays back the given
 * event-only steps (status/event), returning per-step scroll telemetry.
 * Scroll/click/marker steps are handled by the Node-side orchestrator since
 * they need real waits and the CDP-level probe between steps.
 */
export function buildDriveEventExpression(step, viewTypeConst) {
  const payload = JSON.stringify(step);
  return `(() => {
    const step = ${payload};
    const leaves = app.workspace.getLeavesOfType(${JSON.stringify(viewTypeConst)});
    if (!leaves.length) return { ok: false, error: 'no ' + ${JSON.stringify(viewTypeConst)} + ' leaf found' };
    const view = leaves[0].view;
    const outputArea = document.querySelector('.shell-output-area');
    const before = outputArea ? { scrollTop: outputArea.scrollTop, scrollHeight: outputArea.scrollHeight } : null;
    try {
      if (step.type === 'status') {
        view.handleStatusChange(step.event);
      } else if (step.type === 'event') {
        // handleStreamEvent is TS-private but present on the prototype at runtime
        // (the bundle is not minified/mangled for member names).
        view.handleStreamEvent(step.event);
      }
    } catch (e) {
      return { ok: false, error: String(e && e.stack || e) };
    }
    return { ok: true, before, note: step.note };
  })()`;
}

export function buildOpenChatViewExpression(viewTypeConst) {
  return `(async () => {
    const { workspace } = app;
    let leaves = workspace.getLeavesOfType(${JSON.stringify(viewTypeConst)});
    let leaf = leaves[0] ?? null;
    if (!leaf) {
      const newLeaf = workspace.getRightLeaf(false);
      if (!newLeaf) return { ok: false, error: 'workspace.getRightLeaf(false) returned null' };
      await newLeaf.setViewState({ type: ${JSON.stringify(viewTypeConst)}, active: true });
      leaf = newLeaf;
    }
    await workspace.revealLeaf(leaf);
    return { ok: true };
  })()`;
}
