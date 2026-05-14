// test/__mocks__/obsidian.ts
// Stub for obsidian module - allows tests to import modules that reference obsidian types

export class App {}
export class TFile {
  path: string = '';
  basename: string = '';
  extension: string = 'md';
}
export class TFolder {}
export class TAbstractFile {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class Modal {}
export class ItemView {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class Vault {}
export function debounce<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: Parameters<T>) => fn(...args)) as T;
}
export const MarkdownRenderer = {
  render: async (_app: any, markdown: string, el: any) => {
    if (el && typeof el.setText === 'function') {
      el.setText(markdown);
    } else if (el) {
      el.textContent = markdown;
    }
  },
};
export async function requestUrl(_options: any): Promise<any> { return { text: '' }; }
