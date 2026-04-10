// src/knowledge/watcher.ts

import { App, TFile, debounce } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import { DEFAULT_WIKI_FOLDER } from './types';

/**
 * 检查文件路径是否在监听文件夹列表中
 */
export function isInWatchedFolder(filePath: string, watchedFolders: string[]): boolean {
  return watchedFolders.some(folder => {
    const normalized = folder.endsWith('/') ? folder : folder + '/';
    return filePath.startsWith(normalized);
  });
}

/**
 * 判断文件是否应该入队编译
 */
export function shouldEnqueueFile(
  filePath: string,
  watchedFolders: string[],
  wikiFolder: string = DEFAULT_WIKI_FOLDER
): boolean {
  if (!filePath.endsWith('.md')) return false;
  if (filePath.startsWith(wikiFolder + '/')) return false;
  return isInWatchedFolder(filePath, watchedFolders);
}

/**
 * 文件夹监听器：监听指定文件夹，将新建/修改的笔记自动入队
 */
export class KnowledgeWatcher {
  private debouncedHandlers: Map<string, () => void> = new Map();

  constructor(
    app: App,
    private registry: KnowledgeRegistryManager,
    private watchedFolders: string[],
    private wikiFolder: string = DEFAULT_WIKI_FOLDER,
    private debounceMs: number = 60000
  ) {}

  async onFileCreate(file: TFile): Promise<void> {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;
    const existing = this.registry.findByPath(file.path);
    if (existing) return;
    this.registry.register(file.path);
    await this.registry.save();
    console.log(`[KnowledgeWatcher] Registered new file: ${file.path}`);
  }

  onFileModify(file: TFile): void {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;
    const key = file.path;
    if (this.debouncedHandlers.has(key)) return;

    const handler = debounce(async () => {
      const record = this.registry.findByPath(file.path);
      if (record && record.status === 'done') {
        this.registry.transition(record.id, 'stale');
        await this.registry.save();
        console.log(`[KnowledgeWatcher] Marked stale: ${file.path}`);
      }
      this.debouncedHandlers.delete(key);
    }, this.debounceMs, true);

    this.debouncedHandlers.set(key, handler);
    handler();
  }

  async onFileDelete(filePath: string): Promise<void> {
    const record = this.registry.findByPath(filePath);
    if (!record) return;
    if (record.status !== 'missing_source') {
      try {
        this.registry.transition(record.id, 'missing_source');
        await this.registry.save();
        console.log(`[KnowledgeWatcher] Marked missing_source: ${filePath}`);
      } catch {}
    }
  }

  async onFileRename(oldPath: string, newPath: string): Promise<void> {
    const record = this.registry.findByPath(oldPath);
    if (!record) {
      if (shouldEnqueueFile(newPath, this.watchedFolders, this.wikiFolder)) {
        this.registry.register(newPath);
        await this.registry.save();
      }
      return;
    }
    this.registry.updatePath(record.id, newPath);
    await this.registry.save();
    console.log(`[KnowledgeWatcher] Updated path: ${oldPath} -> ${newPath}`);
  }

  updateWatchedFolders(folders: string[]): void {
    this.watchedFolders = folders;
  }

  cleanup(): void {
    this.debouncedHandlers.clear();
  }
}
