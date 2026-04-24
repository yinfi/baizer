export type SuggestionType = 'command' | 'file';

export interface SuggestionItem {
  label: string;
  desc?: string;
  value?: string;
}

export interface SuggestionTrigger {
  type: SuggestionType;
  query: string;
}

export function detectSuggestionTrigger(value: string, cursor: number): SuggestionTrigger | null {
  const textBeforeCursor = value.substring(0, cursor);
  const lastWord = textBeforeCursor.split(/\s+/).pop() || '';

  if (lastWord.startsWith('/')) {
    return { type: 'command', query: lastWord.substring(1) };
  }

  if (lastWord.startsWith('@')) {
    return { type: 'file', query: lastWord.substring(1) };
  }

  return null;
}

export class InputController {
  private isSuggesting = false;
  private suggestionType: SuggestionType | null = null;
  private selectedIndex = 0;
  private suggestions: SuggestionItem[] = [];

  setSuggestions(type: SuggestionType, suggestions: SuggestionItem[]) {
    this.isSuggesting = suggestions.length > 0;
    this.suggestionType = type;
    this.selectedIndex = 0;
    this.suggestions = suggestions;
  }

  hide() {
    this.isSuggesting = false;
    this.suggestionType = null;
    this.selectedIndex = 0;
    this.suggestions = [];
  }

  navigate(dir: number): number {
    if (this.suggestions.length === 0) return this.selectedIndex;
    this.selectedIndex += dir;
    if (this.selectedIndex < 0) this.selectedIndex = this.suggestions.length - 1;
    if (this.selectedIndex >= this.suggestions.length) this.selectedIndex = 0;
    return this.selectedIndex;
  }

  selectSuggestion(value: string, cursor: number): { text: string; cursor: number } | null {
    const item = this.suggestions[this.selectedIndex];
    if (!item || !this.suggestionType) return null;

    const textBeforeCursor = value.substring(0, cursor);
    const lastWord = textBeforeCursor.split(/\s+/).pop() || '';
    const replacement = this.suggestionType === 'command' ? item.label : (item.value || item.label);

    const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - lastWord.length) + replacement + ' ';
    const newText = newTextBefore + value.substring(cursor);

    this.hide();
    return {
      text: newText,
      cursor: newTextBefore.length,
    };
  }

  getSuggestions() {
    return this.suggestions;
  }

  getSelectedIndex() {
    return this.selectedIndex;
  }

  getSuggestionType() {
    return this.suggestionType;
  }

  getIsSuggesting() {
    return this.isSuggesting;
  }
}
