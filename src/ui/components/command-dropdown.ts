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

export class CommandDropdown {
  private items: SuggestionItem[] = [];
  private selectedIndex = 0;
  private type: SuggestionType = 'command';

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

    this.containerEl.style.display = 'block';
    this.setAttribute(this.containerEl, 'role', 'listbox');

    this.items.forEach((item, index) => {
      const el = this.containerEl.createDiv({
        cls: `suggestion-item${index === this.selectedIndex ? ' is-selected' : ''}`,
        attr: { role: 'option', 'aria-selected': String(index === this.selectedIndex) },
      });
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
    this.containerEl.style.display = 'none';
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
