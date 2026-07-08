import { t } from '../../i18n/zh';

interface HistoryMenuItem {
  id: string;
  title: string;
  updatedAt: number;
  providerId?: string;
  modelId?: string;
  currentNote?: string;
  isActive?: boolean;
  pinnedAt?: number;
}

interface HistoryMenuHandlers {
  onOpen: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onTogglePin?: (id: string) => void | Promise<void>;
  onClose?: () => void;
}

export class HistoryMenu {
  private items: HistoryMenuItem[] = [];
  private filterQuery = '';
  /** 持久的列表容器与计数标签;搜索输入只重渲染列表区,绝不重建搜索框(避免打断 IME / 光标跳位)。 */
  private listContainerEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly handlers: HistoryMenuHandlers,
  ) { }

  update(items: HistoryMenuItem[]) {
    this.items = items.map(item => ({ ...item }));
    this.filterQuery = '';
    this.render();
  }

  hide() {
    this.containerEl.style.display = 'none';
    this.containerEl.empty();
    this.listContainerEl = null;
    this.countEl = null;
    this.filterQuery = '';
  }

  /** 重建整个菜单骨架(toolbar + 列表容器)。仅在 update()/hide() 等数据集变更时调用一次。 */
  private render() {
    this.containerEl.empty();
    this.containerEl.style.display = 'block';
    this.listContainerEl = null;
    this.countEl = null;

    if (this.items.length === 0) {
      this.containerEl.createDiv({
        cls: 'baizer-history-empty',
        text: t('No saved conversations yet.'),
      });
      return;
    }

    const toolbar = this.containerEl.createDiv({ cls: 'baizer-history-toolbar' });
    const searchInput = toolbar.createEl('input', {
      cls: 'baizer-history-search',
      value: this.filterQuery,
      attr: {
        type: 'search',
        placeholder: t('Search conversations or notes'),
        'aria-label': t('Search conversations'),
      },
    }) as HTMLInputElement;
    searchInput.addEventListener('input', (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      this.filterQuery = target?.value || '';
      // 只重渲染结果列表,搜索框本身保持不变 —— 不打断输入法、不丢光标。
      this.renderList();
    });
    searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.handlers.onClose?.();
    });

    this.countEl = toolbar.createSpan({ cls: 'baizer-history-count' });
    this.listContainerEl = this.containerEl.createDiv({ cls: 'baizer-history-list' });

    this.renderList();
    searchInput.focus();
  }

  /** 只刷新结果列表与计数,不触碰搜索框。每次按键走这里。 */
  private renderList() {
    const list = this.listContainerEl;
    if (!list) return;
    list.empty();

    const filteredItems = this.getFilteredItems();
    if (this.countEl) {
      this.countEl.textContent = `${filteredItems.length} / ${this.items.length}`;
    }

    if (filteredItems.length === 0) {
      list.createDiv({
        cls: 'baizer-history-empty',
        text: t('No matching conversations.'),
      });
      return;
    }

    this.buildGroups(filteredItems).forEach((group) => {
      const section = list.createDiv({ cls: 'baizer-history-group' });
      section.createDiv({ cls: 'baizer-history-group-title', text: group.title });
      group.items.forEach((item) => this.renderItem(section, item));
    });
  }

  private getFilteredItems(): HistoryMenuItem[] {
    const query = this.filterQuery.trim().toLowerCase();
    if (!query) {
      return this.items.map(item => ({ ...item }));
    }

    return this.items.filter((item) => {
      const haystack = [
        item.title,
        item.providerId,
        item.modelId,
        item.currentNote,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  }

  private formatTimestamp(value: number): string {
    if (!Number.isFinite(value)) return '';
    return new Date(value).toLocaleString('zh-CN');
  }

  private buildGroups(items: HistoryMenuItem[]) {
    const now = Date.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const todayStart = startOfToday.getTime();
    const recentThreshold = todayStart - (7 * 24 * 60 * 60 * 1000);

    const pinned = items.filter(item => Number.isFinite(item.pinnedAt));
    const today = items.filter(item => !item.pinnedAt && item.updatedAt >= todayStart);
    const recent = items.filter(item => !item.pinnedAt && item.updatedAt < todayStart && item.updatedAt >= recentThreshold);
    const older = items.filter(item => !item.pinnedAt && item.updatedAt < recentThreshold);

    return [
      { title: t('Pinned'), items: this.sortItems(pinned, true) },
      { title: t('Today'), items: this.sortItems(today) },
      { title: t('Recent'), items: this.sortItems(recent) },
      { title: t('Older'), items: this.sortItems(older) },
    ].filter(group => group.items.length > 0);
  }

  private sortItems(items: HistoryMenuItem[], usePinnedAt = false): HistoryMenuItem[] {
    return [...items].sort((a, b) => {
      const left = usePinnedAt ? (a.pinnedAt || a.updatedAt) : a.updatedAt;
      const right = usePinnedAt ? (b.pinnedAt || b.updatedAt) : b.updatedAt;
      return right - left;
    });
  }

  private renderItem(containerEl: HTMLElement, item: HistoryMenuItem) {
    const row = containerEl.createDiv({
      cls: `baizer-history-item${item.isActive ? ' is-active' : ''}`,
      attr: { role: 'button', tabindex: '0' },
    });
    if (item.currentNote) {
      row.setAttribute('title', item.currentNote);
    }
    const body = row.createDiv({ cls: 'baizer-history-body' });
    body.createSpan({ cls: 'baizer-history-title', text: item.title });
    const meta = body.createDiv({ cls: 'baizer-history-meta' });
    meta.createSpan({ cls: 'baizer-history-provider', text: item.providerId || t('Unknown provider') });
    if (item.modelId) {
      meta.createSpan({ cls: 'baizer-history-model', text: item.modelId });
    }
    if (item.currentNote) {
      meta.createSpan({ cls: 'baizer-history-note', text: item.currentNote });
    }
    meta.createSpan({ cls: 'baizer-history-updated', text: this.formatTimestamp(item.updatedAt) });

    const actions = row.createDiv({ cls: 'baizer-history-actions' });
    const pinLabel = item.pinnedAt ? t('Unpin') : t('Pin');
    const pinButton = actions.createEl('button', {
      cls: 'baizer-history-pin clickable-icon',
      text: pinLabel,
      attr: { 'aria-label': `${pinLabel} ${item.title}` },
    });
    const deleteButton = actions.createEl('button', {
      cls: 'baizer-history-delete clickable-icon',
      text: t('Delete'),
      attr: { 'aria-label': `${t('Delete')} ${item.title}` },
    });

    row.addEventListener('click', () => {
      void this.handlers.onOpen(item.id);
    });
    row.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void this.handlers.onOpen(item.id);
    });
    pinButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.handlers.onTogglePin?.(item.id);
    });
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.handlers.onDelete(item.id);
    });
  }
}
