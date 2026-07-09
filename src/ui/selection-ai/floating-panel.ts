import { App, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';

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
  title: string;
  anchor: { x: number; y: number };   // 选区屏幕坐标,用于首次定位
  onClose: () => void;
  onSubmit: (text: string) => void;   // 追问
  onReplace: () => void;              // 用最后一条 AI 回答替换选区
}

/**
 * 可拖拽 + 可缩放的独立浮窗,承载"解释"这类只读对话。
 * 标题栏拖动、右下角缩放,尺寸/位置持久化到 localStorage。
 */
export class FloatingPanel {
  private root: HTMLElement;
  private messageList: HTMLElement;
  private component = new Component();
  private onDragMove?: (e: MouseEvent) => void;
  private onDragUp?: () => void;
  private onResizeMove?: (e: MouseEvent) => void;
  private onResizeUp?: () => void;

  constructor(private opts: FloatingPanelOptions) {
    this.root = document.body.createDiv({ cls: 'baizer-floating-panel' });
    this.applyRect(this.resolveInitialRect());
    this.buildHeader();
    this.messageList = this.root.createDiv({ cls: 'baizer-fp-messages' });
    this.buildFooter();
    this.buildResizeHandle();
  }

  private resolveInitialRect(): PanelRect {
    const vw = window.innerWidth, vh = window.innerHeight;
    const saved = loadPanelRect();
    if (saved) return clampRect(saved, { width: vw, height: vh });
    const r = { ...DEFAULT_PANEL_RECT, left: this.opts.anchor.x, top: this.opts.anchor.y + 8 };
    return clampRect(r, { width: vw, height: vh });
  }

  private applyRect(r: PanelRect) {
    Object.assign(this.root.style, {
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
    header.createSpan({ text: this.opts.title, cls: 'baizer-fp-title' });
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
    replace.onclick = () => this.opts.onReplace();
    const copy = footer.createEl('button', { text: '复制', attr: { type: 'button' } });
    copy.onclick = () => {
      const last = this.messageList.querySelector('.baizer-fp-msg.ai:last-child');
      void navigator.clipboard.writeText(last?.textContent || '');
      new Notice('已复制');
    };
  }

  /** 渲染一批消息(role: 'user' | 'ai')。调用方每次流式更新后重渲。 */
  renderMessages(messages: Array<{ role: string; content: string }>) {
    this.messageList.empty();
    for (const m of messages) {
      const el = this.messageList.createDiv({ cls: `baizer-fp-msg ${m.role}` });
      if (m.role === 'ai') void MarkdownRenderer.render(this.opts.app, m.content, el, '', this.component);
      else el.setText(m.content);
    }
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  destroy() {
    if (this.onDragMove) window.removeEventListener('mousemove', this.onDragMove);
    if (this.onDragUp) window.removeEventListener('mouseup', this.onDragUp);
    if (this.onResizeMove) window.removeEventListener('mousemove', this.onResizeMove);
    if (this.onResizeUp) window.removeEventListener('mouseup', this.onResizeUp);
    this.component.unload();
    this.root.remove();
    this.opts.onClose();
  }
}
