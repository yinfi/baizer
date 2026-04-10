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
export async function requestUrl(_options: any): Promise<any> { return { text: '' }; }
