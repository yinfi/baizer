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
    this.filterQuery = '';
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.style.display = 'block';

    if (this.items.length === 0) {
      this.containerEl.createDiv({
        cls: 'ocli-history-empty',
        text: 'No saved conversations yet.',
      });
      return;
    }

    const toolbar = this.containerEl.createDiv({ cls: 'ocli-history-toolbar' });
    const searchInput = toolbar.createEl('input', {
      cls: 'ocli-history-search',
      value: this.filterQuery,
      attr: {
        type: 'search',
        placeholder: 'Search conversations or notes',
        'aria-label': 'Search conversations',
      },
    }) as HTMLInputElement;
    searchInput.addEventListener('input', (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      this.filterQuery = target?.value || '';
      this.render();
    });
    searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.handlers.onClose?.();
    });

    const filteredItems = this.getFilteredItems();
    toolbar.createSpan({
      cls: 'ocli-history-count',
      text: `${filteredItems.length} / ${this.items.length}`,
    });
    searchInput.focus();

    if (filteredItems.length === 0) {
      this.containerEl.createDiv({
        cls: 'ocli-history-empty',
        text: 'No matching conversations.',
      });
      return;
    }

    this.buildGroups(filteredItems).forEach((group) => {
      const section = this.containerEl.createDiv({ cls: 'ocli-history-group' });
      section.createDiv({ cls: 'ocli-history-group-title', text: group.title });
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
    return new Date(value).toLocaleString();
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
      { title: 'Pinned', items: this.sortItems(pinned, true) },
      { title: 'Today', items: this.sortItems(today) },
      { title: 'Recent', items: this.sortItems(recent) },
      { title: 'Older', items: this.sortItems(older) },
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
      cls: `ocli-history-item${item.isActive ? ' is-active' : ''}`,
      attr: { role: 'button', tabindex: '0' },
    });
    if (item.currentNote) {
      row.setAttribute('title', item.currentNote);
    }
    const body = row.createDiv({ cls: 'ocli-history-body' });
    body.createSpan({ cls: 'ocli-history-title', text: item.title });
    const meta = body.createDiv({ cls: 'ocli-history-meta' });
    meta.createSpan({ cls: 'ocli-history-provider', text: item.providerId || 'Unknown provider' });
    if (item.modelId) {
      meta.createSpan({ cls: 'ocli-history-model', text: item.modelId });
    }
    if (item.currentNote) {
      meta.createSpan({ cls: 'ocli-history-note', text: item.currentNote });
    }
    meta.createSpan({ cls: 'ocli-history-updated', text: this.formatTimestamp(item.updatedAt) });

    const actions = row.createDiv({ cls: 'ocli-history-actions' });
    const pinButton = actions.createEl('button', {
      cls: 'ocli-history-pin clickable-icon',
      text: item.pinnedAt ? 'Unpin' : 'Pin',
      attr: { 'aria-label': `${item.pinnedAt ? 'Unpin' : 'Pin'} ${item.title}` },
    });
    const deleteButton = actions.createEl('button', {
      cls: 'ocli-history-delete clickable-icon',
      text: 'Delete',
      attr: { 'aria-label': `Delete ${item.title}` },
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
