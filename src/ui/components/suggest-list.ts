import { CommandDropdown } from './command-dropdown';
import {
  InputController,
  detectSuggestionTrigger,
  SuggestionItem,
  SuggestionType,
  SuggestionSelection,
} from '../controllers/input-controller';

export interface SuggestListOptions {
  container: HTMLElement;
  /** 按 trigger 类型与 query 返回候选(调用方决定支持哪些类型)。 */
  provideItems: (type: SuggestionType, query: string) => SuggestionItem[];
  /** 选中一项后:text 是回填后的完整输入,cursor 是新光标位,contextItem 可选。 */
  onApply: (selection: SuggestionSelection) => void;
}

/**
 * 与宿主无关的补全挂载器:trigger 检测 → 取 items → 渲染下拉 → 键盘导航 → 回填。
 * 复用 CommandDropdown(渲染) + InputController(选中逻辑)。
 * 调用方在输入事件里调 handleInput,在 keydown 里先调 handleKeyDown。
 */
export class SuggestList {
  private readonly controller = new InputController();
  private readonly dropdown: CommandDropdown;
  private currentValue = '';
  private currentCursor = 0;

  constructor(private readonly options: SuggestListOptions) {
    this.dropdown = new CommandDropdown(options.container, {
      onNavigate: (dir) => this.navigate(dir),
      onSelect: (_item, index) => this.selectAt(index),
      onCancel: () => this.hide(),
    });
  }

  handleInput(value: string, cursor: number) {
    this.currentValue = value;
    this.currentCursor = cursor;
    const trigger = detectSuggestionTrigger(value, cursor);
    if (!trigger) { this.hide(); return; }
    const items = this.options.provideItems(trigger.type, trigger.query);
    this.controller.setSuggestions(trigger.type, items);
    if (this.controller.getSuggestions().length === 0) { this.hide(); return; }
    this.render();
  }

  /** 返回 true 表示本次按键已被补全消费,宿主应 return。 */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.controller.getIsSuggesting()) return false;
    return this.dropdown.handleKeyDown(event);
  }

  isOpen(): boolean {
    return this.controller.getIsSuggesting();
  }

  hide() {
    this.controller.hide();
    this.dropdown.hide();
  }

  private navigate(dir: number) {
    this.controller.navigate(dir);
    this.render();
  }

  private selectAt(index: number) {
    // 先把选中项对齐到 index,再复用 controller 的回填逻辑
    while (this.controller.getSelectedIndex() < index) this.controller.navigate(1);
    while (this.controller.getSelectedIndex() > index) this.controller.navigate(-1);
    const selection = this.controller.selectSuggestion(this.currentValue, this.currentCursor);
    this.hide();
    if (selection) this.options.onApply(selection);
  }

  private render() {
    const type = this.controller.getSuggestionType();
    if (!type) return;
    this.dropdown.update({
      type,
      items: this.controller.getSuggestions(),
      selectedIndex: this.controller.getSelectedIndex(),
    });
  }
}
