import { App, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';
import { StreamController } from '../controllers/stream-controller';
import { ThinkingRenderer } from '../renderers/thinking-renderer';
import { StreamEvent } from '../../models/interfaces';

export interface PanelRect { left: number; top: number; width: number; height: number; }

export const DEFAULT_PANEL_RECT: PanelRect = { left: 0, top: 0, width: 420, height: 360 };
const MIN_W = 280, MIN_H = 200;
const STORAGE_KEY = 'baizer.selection.floating-panel.rect';

/** 把矩形约束进视口:先夹尺寸(min..viewport),再夹位置(0..viewport-size)。 */
export function clampRect(rect: PanelRect, viewport: { width: number; height: number }): PanelRect {
  const width = Math.max(MIN_W, Math.min(rect.width, viewport.width));
  const height = Math.max(MIN_H, Math.min(rect.height, viewport.height));
  const left = Math.max(0, Math.min(rect.left, viewport.width - width));
  const top = Math.max(0, Math.min(rect.top, viewport.height - height));
  return { left, top, width, height };
}

/** 从 localStorage 读上次矩形;无/损坏返回 null。 */
export function loadPanelRect(storage: Pick<Storage, 'getItem'> = localStorage): PanelRect | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === 'number' && typeof p?.top === 'number' && typeof p?.width === 'number' && typeof p?.height === 'number') return p;
    return null;
  } catch { return null; }
}

/** 写入 localStorage(失败静默)。 */
export function savePanelRect(rect: PanelRect, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(rect)); } catch { /* ignore */ }
}

export interface FloatingPanelOptions {
  app: App;
  intent: string;                     // 顶部干净意图(如「解释:作为空间根目录」),非真实 prompt
  title?: string;                     // 标题栏文案；缺省时用 intent
  anchor: { x: number; y: number };   // 选区屏幕坐标,用于首次定位
  onClose: () => void;
  onSubmit: (text: string) => void;   // 追问(text 是用户新输入,由调用方决定如何发)
  onReplace: (resultText: string) => void;  // 用当前结果正文替换选区
}

/**
 * 可拖拽 + 可缩放的独立浮窗,承载"解释"这类只读对话。
 * 标题栏拖动、右下角缩放,尺寸/位置持久化到 localStorage。
 */
export class FloatingPanel {
  private root: HTMLElement;
  private body: HTMLElement;          // 滚动区:thinking 时间线 + 正文
  private timeline: HTMLElement;      // thinking 折叠时间线容器
  private answerEl: HTMLElement;      // 流式正文容器
  private statusEl: HTMLElement;      // "思考中…" 状态行
  private component = new Component();
  private stream: StreamController;
  private thinkingRenderer: ThinkingRenderer | null = null;
  private answerText = '';            // 累积的正文(供替换/复制)
  private onDragMove?: (e: MouseEvent) => void;
  private onDragUp?: () => void;
  private onResizeMove?: (e: MouseEvent) => void;
  private onResizeUp?: () => void;

  constructor(private opts: FloatingPanelOptions) {
    this.root = document.body.createDiv({ cls: 'baizer-floating-panel' });
    this.applyRect(this.resolveInitialRect());
    this.buildHeader();

    this.body = this.root.createDiv({ cls: 'baizer-fp-messages' });
    // 顶部意图行(干净文案,非真实 prompt)
    this.body.createDiv({ cls: 'baizer-fp-intent', text: this.opts.intent });
    this.timeline = this.body.createDiv({ cls: 'baizer-fp-timeline' });
    this.statusEl = this.body.createDiv({ cls: 'baizer-fp-status', text: '思考中…' });
    this.answerEl = this.body.createDiv({ cls: 'baizer-fp-answer' });

    this.buildFooter();
    this.buildResizeHandle();

    // 复用 shell 的流式分发:thinking→时间线折叠,text_delta→正文累积重渲。
    this.stream = new StreamController({
      onThinking: (c) => { this.ensureThinking(); this.thinkingRenderer?.appendThinking(c); this.scrollToEnd(); },
      onToolCall: () => { /* 选区场景一般无工具调用;忽略以保持面板简洁 */ },
      onToolResult: () => { /* 同上 */ },
      onTextDelta: (c) => { this.thinkingRenderer?.finalizeCurrentThinking(); this.answerText += c; this.renderAnswer(); this.scrollToEnd(); },
      onDone: () => { this.thinkingRenderer?.finalizeCurrentThinking(); this.statusEl.addClass('baizer-hidden'); this.scrollToEnd(); },
      onError: (m) => { this.statusEl.addClass('baizer-hidden'); this.answerText += `\n\n> ⚠ ${m}`; this.renderAnswer(); },
    });
  }

  private ensureThinking() {
    if (!this.thinkingRenderer) this.thinkingRenderer = new ThinkingRenderer(this.timeline);
  }

  private renderAnswer() {
    this.answerEl.empty();
    void MarkdownRenderer.render(this.opts.app, this.answerText, this.answerEl, '', this.component);
  }

  private scrollToEnd() {
    this.body.scrollTop = this.body.scrollHeight;
  }

  /** 接收 ChatController 转发的流事件。 */
  handleStreamEvent(event: StreamEvent) {
    this.stream.handleEvent(event);
  }

  /** 新一轮开始:清空上轮正文与 thinking、恢复状态行(追问时用)。 */
  beginTurn() {
    this.thinkingRenderer?.dispose();
    this.thinkingRenderer = null;
    this.timeline.empty();
    this.answerText = '';
    this.answerEl.empty();
    this.statusEl.removeClass('baizer-hidden');
    this.scrollToEnd();
  }

  private resolveInitialRect(): PanelRect {
    const vw = window.innerWidth, vh = window.innerHeight;
    const saved = loadPanelRect();
    if (saved) return clampRect(saved, { width: vw, height: vh });
    const r = { ...DEFAULT_PANEL_RECT, left: this.opts.anchor.x, top: this.opts.anchor.y + 8 };
    return clampRect(r, { width: vw, height: vh });
  }

  private applyRect(r: PanelRect) {
    this.root.setCssStyles({
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  private currentRect(): PanelRect {
    const b = this.root.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }
  private buildHeader() {
    const header = this.root.createDiv({ cls: 'baizer-fp-header' });
    header.createSpan({ text: this.opts.title ?? this.opts.intent, cls: 'baizer-fp-title' });
    const close = header.createEl('button', { cls: 'baizer-fp-close', attr: { type: 'button', 'aria-label': 'Close' } });
    setIcon(close, 'x');
    close.onclick = () => this.destroy();

    // 拖动:按下标题栏,mousemove 改 left/top,松开存盘
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.onmousedown = (e) => {
      if ((e.target as HTMLElement).closest('.baizer-fp-close')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = this.currentRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    };
    this.onDragMove = (e: MouseEvent) => {
      if (!dragging) return;
      const cur = this.currentRect();
      const r = clampRect(
        { left: ox + (e.clientX - sx), top: oy + (e.clientY - sy), width: cur.width, height: cur.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      this.applyRect(r);
    };
    this.onDragUp = () => { if (dragging) { dragging = false; savePanelRect(this.currentRect()); } };
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);
  }

  private buildResizeHandle() {
    const handle = this.root.createDiv({ cls: 'baizer-fp-resize' });
    let resizing = false, sx = 0, sy = 0, ow = 0, oh = 0;
    handle.onmousedown = (e) => {
      resizing = true; sx = e.clientX; sy = e.clientY;
      const r = this.currentRect(); ow = r.width; oh = r.height;
      e.preventDefault(); e.stopPropagation();
    };
    this.onResizeMove = (e: MouseEvent) => {
      if (!resizing) return;
      const cur = this.currentRect();
      const r = clampRect(
        { left: cur.left, top: cur.top, width: ow + (e.clientX - sx), height: oh + (e.clientY - sy) },
        { width: window.innerWidth, height: window.innerHeight },
      );
      this.applyRect(r);
    };
    this.onResizeUp = () => { if (resizing) { resizing = false; savePanelRect(this.currentRect()); } };
    window.addEventListener('mousemove', this.onResizeMove);
    window.addEventListener('mouseup', this.onResizeUp);
  }
  private buildFooter() {
    const footer = this.root.createDiv({ cls: 'baizer-fp-footer' });
    const input = footer.createEl('textarea', { cls: 'baizer-fp-input', attr: { rows: '1', placeholder: '继续追问...' } });
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = input.value.trim();
        if (text) { input.value = ''; this.opts.onSubmit(text); }
      }
    };
    const replace = footer.createEl('button', { text: '替换', attr: { type: 'button' } });
    replace.onclick = () => {
      if (!this.answerText.trim()) { new Notice('还没有可应用的结果。'); return; }
      this.opts.onReplace(this.answerText.trim());
    };
    const copy = footer.createEl('button', { text: '复制', attr: { type: 'button' } });
    copy.onclick = () => {
      if (!this.answerText.trim()) { new Notice('还没有可复制的结果。'); return; }
      void navigator.clipboard.writeText(this.answerText.trim());
      new Notice('已复制');
    };
  }

  destroy() {
    if (this.onDragMove) window.removeEventListener('mousemove', this.onDragMove);
    if (this.onDragUp) window.removeEventListener('mouseup', this.onDragUp);
    if (this.onResizeMove) window.removeEventListener('mousemove', this.onResizeMove);
    if (this.onResizeUp) window.removeEventListener('mouseup', this.onResizeUp);
    this.thinkingRenderer?.dispose();
    this.component.unload();
    this.root.remove();
    this.opts.onClose();
  }
}
