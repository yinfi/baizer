import { ContextItem } from './context-manager';

export interface ContextBudgetOptions {
  maxItems: number;
  maxChars: number;
  perItemChars: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  maxItems: 8,
  maxChars: 6000,
  perItemChars: 1200,
};

const TYPE_PRIORITY: Record<ContextItem['type'], number> = {
  file: 4,
  text: 3,
  url: 2,
  youtube: 2,
  image: 1,
};

export function budgetTextBlock(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 3) return '.'.repeat(maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

export function budgetContextItems(
  items: ContextItem[],
  options: Partial<ContextBudgetOptions> = {},
): ContextItem[] {
  const budget = { ...DEFAULT_CONTEXT_BUDGET, ...options };
  let usedChars = 0;

  const normalized = items.map((item, index) => ({
    item: {
      ...item,
      content: item.content ? budgetTextBlock(item.content, budget.perItemChars) : item.content,
      summary: item.summary ? budgetTextBlock(item.summary, Math.min(160, budget.perItemChars)) : item.summary,
    },
    priority: TYPE_PRIORITY[item.type] ?? 0,
    index,
  }));

  normalized.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.index - b.index;
  });

  const selected: ContextItem[] = [];
  for (const entry of normalized) {
    if (selected.length >= budget.maxItems) break;

    const estimatedChars = (entry.item.content || entry.item.data || '').length;
    if (selected.length > 0 && usedChars + estimatedChars > budget.maxChars) continue;

    selected.push(entry.item);
    usedChars += estimatedChars;
  }

  return selected;
}
