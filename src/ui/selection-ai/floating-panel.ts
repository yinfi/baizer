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
