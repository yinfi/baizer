type IntervalId = ReturnType<typeof setInterval> | number;

interface ThinkingRendererOptions {
  now?: () => number;
  /** 可注入的定时器,便于测试控制;默认使用全局 setInterval/clearInterval。 */
  setInterval?: (handler: () => void, ms: number) => IntervalId;
  clearInterval?: (id: IntervalId) => void;
}

/**
 * 把连续的思考流按「空行(段落)」切成多个可独立折叠的节点,
 * 更接近 Claude/o1 的思维链体验:已完成的段落折叠成一行标题,
 * 当前正在生成的段落保持展开并实时显示文本与计时。
 */
export class ThinkingRenderer {
  private sessionActive = false;
  private sessionStartedAt = 0;
  /** 正在流式生成的「当前段落」节点;遇到空行被提交后置空,下一段重新创建。 */
  private activeSegment: HTMLElement | null = null;
  /** 当前段落尚未提交的原始文本(遇到下一个空行前的累积)。 */
  private pendingText = '';
  private nodeCount = 0;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => IntervalId;
  private readonly clearIntervalFn: (id: IntervalId) => void;
  /** 驱动「思考中」计时的定时器句柄;与 token 流解耦,模型静默期计时也会持续走动。 */
  private timerHandle: IntervalId | null = null;

  constructor(private timeline: HTMLElement, options: ThinkingRendererOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setInterval
      ?? ((handler, ms) => globalThis.setInterval(handler, ms));
    this.clearIntervalFn = options.clearInterval
      ?? ((id) => globalThis.clearInterval(id as any));
  }

  appendThinking(content: string) {
    if (!content) return;
    this.ensureSession();
    this.pendingText += content;
    this.flushCompletedParagraphs();
    this.renderActiveSegment();
    this.refreshTimerLabel();
  }

  finalizeCurrentThinking() {
    if (!this.sessionActive) return;
    this.stopTimer();

    // 把当前段落剩余文本提交为最后一个节点,并打上总计时长。
    this.commitActiveSegment(true);

    this.sessionActive = false;
    this.activeSegment = null;
    this.pendingText = '';
  }

  getNodeCount() {
    return this.nodeCount;
  }

  /**
   * 释放渲染器持有的定时器。
   * 当流被中途丢弃(切换/关闭标签页,未走 finalize)时必须调用,否则 interval 泄漏。
   */
  dispose() {
    this.stopTimer();
    this.sessionActive = false;
    this.activeSegment = null;
    this.pendingText = '';
  }

  /** 开启一次思考会话(整段连续思考共享同一计时起点)。 */
  private ensureSession() {
    if (this.sessionActive) return;
    this.sessionActive = true;
    this.sessionStartedAt = this.now();
    this.pendingText = '';
    this.activeSegment = null;
    this.startTimer();
  }

  /**
   * 以空行为界把已完整的段落提交为独立(默认折叠)节点,
   * 只把最后一段不完整的残留留在 pendingText 里继续流式。
   */
  private flushCompletedParagraphs() {
    // 段落分隔:一个或多个空行。保留最后一段(可能还没写完)。
    const parts = this.pendingText.split(/\n\s*\n/);
    if (parts.length <= 1) return;

    const completed = parts.slice(0, -1).map(part => part.trim()).filter(Boolean);
    this.pendingText = parts[parts.length - 1];

    for (const paragraph of completed) {
      this.commitParagraph(paragraph);
    }
    // 已提交的段落不再属于当前活动节点,下一段重新创建。
    this.activeSegment = null;
  }

  /** 把 pendingText 同步进「当前段落」节点;没有节点则按需创建。 */
  private renderActiveSegment() {
    const text = this.pendingText.trim();
    if (!text) return;

    if (!this.activeSegment) {
      this.activeSegment = this.createSegmentNode({ active: true });
    }
    this.setSegmentText(this.activeSegment, text);
  }

  /** 把一段已完整的段落作为「已完成、默认折叠」的节点直接落地。 */
  private commitParagraph(paragraph: string) {
    const node = this.createSegmentNode({ active: false });
    this.setSegmentText(node, paragraph);
  }

  /**
   * 收尾时把当前活动段落转为完成态。
   * @param withDuration 为最后一段附上整次思考的总时长,作为该会话的计时落点。
   */
  private commitActiveSegment(withDuration: boolean) {
    const text = this.pendingText.trim();
    if (!text) {
      this.activeSegment = null;
      return;
    }
    if (!this.activeSegment) {
      this.activeSegment = this.createSegmentNode({ active: true });
    }
    this.setSegmentText(this.activeSegment, text);
    this.removeClass(this.activeSegment, 'is-thinking');
    this.addClass(this.activeSegment, 'is-complete');

    if (withDuration) {
      const timer = this.activeSegment.querySelector('.baizer-thinking-timer') as HTMLElement;
      if (timer) timer.textContent = this.formatDuration(this.now() - this.sessionStartedAt);
    }
    this.activeSegment = null;
    this.pendingText = '';
  }

  /** 创建一个思考段落节点(header 含折叠箭头/标题/计时,body 承载完整文本)。 */
  private createSegmentNode(opts: { active: boolean }): HTMLElement {
    const cls = opts.active
      ? 'baizer-thinking-block think-node is-thinking'
      : 'baizer-thinking-block think-node is-complete is-collapsed';
    const block = (this.timeline as any).createDiv({ cls }) as HTMLElement;

    const header = (block as any).createDiv({ cls: 'baizer-thinking-header' }) as HTMLElement;
    (header as any).createSpan({ cls: 'baizer-thinking-caret', text: '>' });
    (header as any).createSpan({ cls: 'baizer-thinking-label', text: 'Thinking' });
    if (opts.active) {
      (header as any).createSpan({ cls: 'baizer-thinking-timer', text: '0s' });
    }
    this.setAttribute(header, 'role', 'button');
    this.setAttribute(header, 'tabindex', '0');
    this.setAttribute(header, 'aria-expanded', String(opts.active));

    (block as any).createDiv({ cls: 'baizer-thinking-content' });
    header.addEventListener('click', () => this.toggleCollapsed(block));
    header.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.toggleCollapsed(block);
    });

    this.nodeCount++;
    return block;
  }

  /** 写入段落正文,并用首行作为 header 摘要标题。 */
  private setSegmentText(block: HTMLElement, text: string) {
    const detail = block.querySelector('.baizer-thinking-content') as HTMLElement;
    const label = block.querySelector('.baizer-thinking-label') as HTMLElement;
    if (detail) detail.textContent = text;
    if (label) label.textContent = this.deriveTitle(text);
  }

  /** 取首个非空行、剥掉 Markdown 装饰后截断,作为段落折叠时的一行摘要。 */
  private deriveTitle(text: string) {
    const firstLine = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) || text.trim();
    const normalized = firstLine
      .replace(/^[#>\-*\s]+/, '')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return this.preview(normalized || firstLine);
  }

  /** 启动每秒一次的计时刷新;若已有定时器先清掉,避免重复块叠加多个 interval。 */
  private startTimer() {
    this.stopTimer();
    this.timerHandle = this.setIntervalFn(() => this.refreshTimerLabel(), 1000);
  }

  private stopTimer() {
    if (this.timerHandle !== null) {
      this.clearIntervalFn(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** 刷新当前活动段落的计时显示;读取实时 now(),与 token 流无关。 */
  private refreshTimerLabel() {
    if (!this.activeSegment) return;
    const timer = this.activeSegment.querySelector('.baizer-thinking-timer') as HTMLElement;
    if (timer) timer.textContent = this.formatDuration(this.now() - this.sessionStartedAt);
  }

  private toggleCollapsed(block: HTMLElement) {
    const header = block.querySelector('.baizer-thinking-header') as HTMLElement;
    const nextCollapsed = !this.hasClass(block, 'is-collapsed');
    this.toggleClass(block, 'is-collapsed', nextCollapsed);
    if (header) {
      this.setAttribute(header, 'aria-expanded', String(!nextCollapsed));
    }
  }

  private preview(value: string) {
    return value.length > 48 ? `${value.substring(0, 48)}...` : value;
  }

  private formatDuration(durationMs: number) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
    return `${seconds}s`;
  }

  private setAttribute(el: HTMLElement, name: string, value: string) {
    if (typeof (el as any).setAttribute === 'function') {
      (el as any).setAttribute(name, value);
    }
  }

  private hasClass(el: HTMLElement, name: string) {
    if (typeof (el as any).hasClass === 'function') {
      return (el as any).hasClass(name);
    }
    return el.classList.contains(name);
  }

  private addClass(el: HTMLElement, name: string) {
    if (typeof (el as any).addClass === 'function') {
      (el as any).addClass(name);
    } else {
      el.classList.add(name);
    }
  }

  private removeClass(el: HTMLElement, name: string) {
    if (typeof (el as any).removeClass === 'function') {
      (el as any).removeClass(name);
    } else {
      el.classList.remove(name);
    }
  }

  private toggleClass(el: HTMLElement, name: string, enabled: boolean) {
    if (typeof (el as any).toggleClass === 'function') {
      (el as any).toggleClass(name, enabled);
      return;
    }

    if (enabled) this.addClass(el, name);
    else this.removeClass(el, name);
  }
}
