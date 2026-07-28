import { setIcon } from 'obsidian';
import { SuggestionItem, SuggestionType } from '../controllers/input-controller';

interface CommandDropdownUpdate {
  type: SuggestionType;
  items: SuggestionItem[];
  selectedIndex: number;
}

interface CommandDropdownHandlers {
  onSelect: (item: SuggestionItem, index: number) => void;
  onNavigate: (dir: number) => void;
  onCancel: () => void;
}

let dropdownIdCounter = 0;

export class CommandDropdown {
  private items: SuggestionItem[] = [];
  private selectedIndex = 0;
  private type: SuggestionType = 'command';
  /** listbox 唯一 id,用于宿主 textarea 的 aria-controls / 每个 option 的 id 前缀。 */
  private readonly listboxId = `baizer-suggest-listbox-${++dropdownIdCounter}`;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly handlers: CommandDropdownHandlers,
  ) { }

  update({ type, items, selectedIndex }: CommandDropdownUpdate) {
    this.type = type;
    this.items = [...items];
    this.selectedIndex = selectedIndex;
    this.containerEl.empty();

    if (this.items.length === 0) {
      this.hide();
      return;
    }

    this.containerEl.removeClass('baizer-hidden');
    this.setAttribute(this.containerEl, 'role', 'listbox');
    this.setAttribute(this.containerEl, 'id', this.listboxId);

    let selectedEl: HTMLElement | null = null;
    this.items.forEach((item, index) => {
      const isSelected = index === this.selectedIndex;
      const el = this.containerEl.createDiv({
        cls: `suggestion-item${isSelected ? ' is-selected' : ''}`,
        attr: { role: 'option', id: this.getOptionId(index), 'aria-selected': String(isSelected) },
      });
      if (isSelected) selectedEl = el;
      const icon = el.createSpan({ cls: 'suggestion-icon' });
      setIcon(icon, this.getIconName(item));
      const copy = el.createDiv({ cls: 'suggestion-copy' });
      copy.createSpan({ cls: 'suggestion-title', text: this.getTitle(item) });
      copy.createSpan({ cls: 'suggestion-value', text: this.getInsertValue(item) });
      if (item.desc && item.desc !== this.getTitle(item)) {
        copy.createSpan({ cls: 'suggestion-desc', text: item.desc });
      }
      el.createSpan({ cls: 'suggestion-source', text: item.source || this.getDefaultSource() });
      el.addEventListener('click', () => this.handlers.onSelect(item, index));
    });

    // 键盘上下移动选中项时,把选中项滚进可视区,避免高亮跑到视口外看不见。
    if (selectedEl && typeof (selectedEl as HTMLElement).scrollIntoView === 'function') {
      (selectedEl as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  /** listbox 容器 id(供宿主 aria-controls 指向)。 */
  getListboxId(): string {
    return this.listboxId;
  }

  /** 当前选中 option 的 id(供宿主 aria-activedescendant 指向);无候选时返回 null。 */
  getActiveOptionId(): string | null {
    if (this.items.length === 0) return null;
    return this.getOptionId(this.selectedIndex);
  }

  private getOptionId(index: number): string {
    return `${this.listboxId}-option-${index}`;
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.items.length === 0) return false;

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.handlers.onNavigate(-1);
      return true;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.handlers.onNavigate(1);
      return true;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.items[this.selectedIndex];
      if (item) this.handlers.onSelect(item, this.selectedIndex);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.handlers.onCancel();
      return true;
    }

    return false;
  }

  hide() {
    this.containerEl.addClass('baizer-hidden');
    this.containerEl.empty();
    this.items = [];
  }

  private getIconName(item: SuggestionItem) {
    if (item.source === 'scope') {
      if (item.scope === 'backlinks') return 'network';
      if (item.scope === 'recent') return 'clock';
      if (item.scope === 'tag') return 'tag';
      return 'file-text';
    }
    if (this.type === 'file') return 'file-text';
    if (this.type === 'skill') return 'sparkles';
    if (item.label.includes('compile')) return 'refresh-cw';
    if (item.label.includes('clear')) return 'eraser';
    if (item.label.includes('help')) return 'circle-help';
    if (item.label.includes('open')) return 'folder-open';
    if (item.label.includes('edit')) return 'pencil';
    return 'terminal';
  }

  private getTitle(item: SuggestionItem) {
    if (item.source === 'scope') {
      if (item.scope === 'backlinks') return 'Backlinks';
      if (item.scope === 'recent') return 'Recent notes';
      if (item.scope === 'tag') return item.tag ? `Tag: ${item.tag}` : 'Tag';
      return 'Current note';
    }
    if (this.type === 'command' && item.desc) return item.desc;
    return item.label.replace(/^[@/$]/, '');
  }

  private getInsertValue(item: SuggestionItem) {
    if (item.kind === 'scope') return item.value || item.label;
    if (this.type === 'command') return item.label;
    return item.value || item.label;
  }

  private getDefaultSource() {
    if (this.type === 'file') return 'file';
    if (this.type === 'skill') return 'skill';
    return 'local';
  }

  private setAttribute(el: HTMLElement, name: string, value: string) {
    if (typeof (el as any).setAttribute === 'function') {
      (el as any).setAttribute(name, value);
    }
  }
}
