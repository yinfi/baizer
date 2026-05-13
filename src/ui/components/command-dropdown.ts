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
      el.createSpan({ cls: 'suggestion-icon', text: this.getIcon() });
      el.createSpan({ cls: 'suggestion-text', text: item.label });
      if (item.desc) {
        el.createSpan({ cls: 'suggestion-desc', text: item.desc });
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

  private getIcon() {
    if (this.type === 'file') return '@';
    if (this.type === 'skill') return '$';
    return '/';
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
