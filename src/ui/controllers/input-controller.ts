import { ContextItem } from '../../services/context-manager';

export type SuggestionType = 'command' | 'file' | 'skill';

export interface SuggestionItem {
  label: string;
  desc?: string;
  value?: string;
  source?: 'local' | 'skill' | 'file' | 'scope';
  kind?: 'scope';
  scope?: ContextItem['scope'];
  tag?: string;
}

export interface SuggestionTrigger {
  type: SuggestionType;
  query: string;
}

export interface SuggestionSelection {
  text: string;
  cursor: number;
  contextItem?: ContextItem;
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

  if (lastWord.startsWith('$')) {
    return { type: 'skill', query: lastWord.substring(1) };
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

  selectSuggestion(value: string, cursor: number): SuggestionSelection | null {
    const item = this.suggestions[this.selectedIndex];
    if (!item || !this.suggestionType) return null;

    const textBeforeCursor = value.substring(0, cursor);
    const lastWord = textBeforeCursor.split(/\s+/).pop() || '';
    const replaceStart = textBeforeCursor.substring(0, textBeforeCursor.length - lastWord.length);
    let newTextBefore = '';
    let newText = '';

    if (item.kind === 'scope') {
      const prefix = replaceStart.endsWith(' ') ? replaceStart.slice(0, -1) : replaceStart;
      const suffix = value.substring(cursor).startsWith(' ')
        ? value.substring(cursor + 1)
        : value.substring(cursor);
      const separator = prefix && suffix ? ' ' : '';
      newTextBefore = `${prefix}${separator}`;
      newText = `${newTextBefore}${suffix}`;
    } else {
      const replacement = this.suggestionType === 'command' ? item.label : (item.value || item.label);
      newTextBefore = replaceStart + replacement + ' ';
      newText = newTextBefore + value.substring(cursor);
    }

    const contextItem = item.kind === 'scope' && item.scope
      ? {
          id: item.scope === 'tag' && item.tag ? `scope:tag:${item.tag}` : `scope:${item.scope}`,
          type: 'scope' as const,
          data: item.label,
          summary: item.desc,
          scope: item.scope,
          tag: item.tag,
        }
      : undefined;

    this.hide();
    return {
      text: newText,
      cursor: newTextBefore.length,
      contextItem,
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
