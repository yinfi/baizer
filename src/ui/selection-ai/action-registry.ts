export type ActionKind = 'rewrite' | 'readonly';

export interface SelectionActionContext {
  activeNote?: boolean;  // 活动笔记当前小节
  knowledge?: boolean;   // 知识库深检索节选
  memory?: boolean;      // Hindsight 记忆召回
}

export interface SelectionAction {
  id: string;
  icon: string;      // Obsidian setIcon 名
  label: string;     // hover tooltip / 菜单文案
  kind: ActionKind;
  promptTemplate: string; // 含 {{selection}} 占位;translate 额外含 {{target}}
  context: SelectionActionContext; // 声明该动作所需上下文源
}

export const SELECTION_ACTIONS: SelectionAction[] = [
  {
    id: 'improve', icon: 'wand', label: 'Polish', kind: 'rewrite',
    promptTemplate: '请润色下面这段文字,使其更流畅自然,保持原意与语言不变。只输出润色后的文字,不要解释:\n\n{{selection}}',
    context: { activeNote: true, memory: true },
  },
  {
    id: 'fix', icon: 'check', label: 'Proofread', kind: 'rewrite',
    promptTemplate: '请校对下面这段文字的拼写、语法与标点错误,保持原意与语言不变。只输出修正后的文字,不要解释:\n\n{{selection}}',
    context: {},
  },
  {
    id: 'translate', icon: 'languages', label: 'Translate', kind: 'rewrite',
    promptTemplate: '请把下面这段文字翻译成{{target}}。只输出译文,不要解释:\n\n{{selection}}',
    context: { knowledge: true },
  },
  {
    id: 'expand', icon: 'expand', label: 'Expand', kind: 'rewrite',
    promptTemplate: '请在保持原意与语言不变的前提下扩写下面这段文字,补充细节使其更充实。只输出扩写后的文字,不要解释:\n\n{{selection}}',
    context: { activeNote: true, knowledge: true, memory: true },
  },
  {
    id: 'summarize', icon: 'text', label: 'Summarize', kind: 'rewrite',
    promptTemplate: '请用与原文相同的语言,把下面这段文字概括成简洁的摘要。只输出摘要,不要解释:\n\n{{selection}}',
    context: {},
  },
  {
    id: 'explain', icon: 'search', label: 'Explain', kind: 'readonly',
    promptTemplate: '请解释并介绍下面这段文字涉及的概念/背景,可结合联网检索与我的知识库。用中文回答:\n\n{{selection}}',
    context: { activeNote: true, knowledge: true, memory: true },
  },
];

export function getAction(id: string): SelectionAction | undefined {
  return SELECTION_ACTIONS.find(a => a.id === id);
}

/** 检测翻译方向:含中日韩字符 → 译英;否则译中。 */
export function detectTranslateDirection(text: string): 'to-en' | 'to-zh' {
  return /[一-鿿぀-ゟ゠-ヿ가-힯]/.test(text) ? 'to-en' : 'to-zh';
}

/** 把选区文本(及翻译目标语言)填入动作模板。 */
export function buildActionPrompt(actionId: string, selection: string): string {
  const action = getAction(actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);
  let prompt = action.promptTemplate.replace('{{selection}}', () => selection);
  if (action.id === 'translate') {
    const target = detectTranslateDirection(selection) === 'to-en' ? 'English' : '中文';
    prompt = prompt.replace('{{target}}', () => target);
  }
  return prompt;
}
