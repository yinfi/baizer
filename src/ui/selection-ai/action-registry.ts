export type ActionKind = 'rewrite' | 'readonly';

export interface SelectionAction {
  id: string;
  icon: string;      // Obsidian setIcon 名
  label: string;     // hover tooltip / 菜单文案
  kind: ActionKind;
  promptTemplate: string; // 含 {{selection}} 占位;translate 额外含 {{target}}
}

export const SELECTION_ACTIONS: SelectionAction[] = [
  {
    id: 'improve', icon: 'wand', label: '润色', kind: 'rewrite',
    promptTemplate: '请润色下面这段文字,使其更流畅自然,保持原意与语言不变。只输出润色后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'fix', icon: 'check', label: '校对', kind: 'rewrite',
    promptTemplate: '请校对下面这段文字的拼写、语法与标点错误,保持原意与语言不变。只输出修正后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'translate', icon: 'languages', label: '翻译', kind: 'rewrite',
    promptTemplate: '请把下面这段文字翻译成{{target}}。只输出译文,不要解释:\n\n{{selection}}',
  },
  {
    id: 'expand', icon: 'expand', label: '扩写', kind: 'rewrite',
    promptTemplate: '请在保持原意与语言不变的前提下扩写下面这段文字,补充细节使其更充实。只输出扩写后的文字,不要解释:\n\n{{selection}}',
  },
  {
    id: 'summarize', icon: 'text', label: '摘要', kind: 'rewrite',
    promptTemplate: '请用与原文相同的语言,把下面这段文字概括成简洁的摘要。只输出摘要,不要解释:\n\n{{selection}}',
  },
  {
    id: 'explain', icon: 'search', label: '解释', kind: 'readonly',
    promptTemplate: '请解释并介绍下面这段文字涉及的概念/背景,可结合联网检索与我的知识库。用中文回答:\n\n{{selection}}',
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
  if (!action) throw new Error(`未知动作: ${actionId}`);
  let prompt = action.promptTemplate.replace('{{selection}}', selection);
  if (action.id === 'translate') {
    const target = detectTranslateDirection(selection) === 'to-en' ? 'English' : '中文';
    prompt = prompt.replace('{{target}}', target);
  }
  return prompt;
}
