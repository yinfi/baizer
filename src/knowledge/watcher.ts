// src/knowledge/watcher.ts
// 文件夹监听器：检测监听目录中的文件变更，通过 frontmatter 管理状态

import { App, TFile, debounce } from 'obsidian';
import { DEFAULT_WIKI_FOLDER } from './types';
import {
  getKnowledgeStatus,
  readSummaryFrontmatter,
  setKnowledgeStatus,
  ensureSourceId,
} from './frontmatter';
import { computeContentHash } from './compiler';

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

export async function hasSourceContentChanged(app: App, file: TFile): Promise<boolean> {
  const cache = app.metadataCache.getFileCache(file);
  const summaryPath = typeof cache?.frontmatter?.knowledge_summary === 'string'
    ? cache.frontmatter.knowledge_summary
    : null;
  if (!summaryPath) return true;

  const summaryFrontmatter = await readSummaryFrontmatter(app, summaryPath);
  if (!summaryFrontmatter?.content_hash) return true;

  try {
    const content = await app.vault.read(file);
    return computeContentHash(content) !== summaryFrontmatter.content_hash;
  } catch {
    return true;
  }
}

/**
 * 文件夹监听器：监听指定文件夹，自动标记新建/修改的笔记
 * 通过 onCompileNeeded 回调通知上层触发编译
 */
export class KnowledgeWatcher {
  private debouncedHandlers: Map<string, () => void> = new Map();
  private _onCompileNeeded: (() => void) | null = null;
  /** 正在写 frontmatter 的文件路径，用于过滤自触发的 modify 事件 */
  private writingPaths: Set<string> = new Set();

  constructor(
    private app: App,
    private watchedFolders: string[],
    private wikiFolder: string = DEFAULT_WIKI_FOLDER,
    private debounceMs: number = 60000
  ) {}

  /** 设置自动编译回调 */
  setOnCompileNeeded(cb: () => void): void {
    this._onCompileNeeded = cb;
  }

  /** 外部主动触发编译（如启动时检测到 pending 项） */
  triggerCompile(): void {
    this._onCompileNeeded?.();
  }

  /** 新文件创建：标记 pending + 生成 source_id */
  async onFileCreate(file: TFile): Promise<void> {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;
    if (this.writingPaths.has(file.path)) return;
    const status = getKnowledgeStatus(this.app, file);
    if (status) return; // 已有状态，跳过

    this.writingPaths.add(file.path);
    try {
      await ensureSourceId(this.app, file);
      await setKnowledgeStatus(this.app, file, 'pending');
      console.log(`[KnowledgeWatcher] Registered new file: ${file.path}`);
      this._onCompileNeeded?.();
    } finally {
      // 延迟清除，等 vault modify 事件传播完毕
      setTimeout(() => this.writingPaths.delete(file.path), 500);
    }
  }

  /** 文件修改：已完成的标记回 pending（debounce） */
  onFileModify(file: TFile): void {
    if (!shouldEnqueueFile(file.path, this.watchedFolders, this.wikiFolder)) return;
    if (this.writingPaths.has(file.path)) return;
    const key = file.path;
    if (this.debouncedHandlers.has(key)) return;

    const handler = debounce(async () => {
      const status = getKnowledgeStatus(this.app, file);
      if (status === 'done' && await hasSourceContentChanged(this.app, file)) {
        this.writingPaths.add(file.path);
        try {
          await setKnowledgeStatus(this.app, file, 'pending');
          console.log(`[KnowledgeWatcher] Marked pending (was done): ${file.path}`);
          this._onCompileNeeded?.();
        } finally {
          setTimeout(() => this.writingPaths.delete(file.path), 500);
        }
      }
      this.debouncedHandlers.delete(key);
    }, this.debounceMs, true);

    this.debouncedHandlers.set(key, handler);
    handler();
  }

  updateWatchedFolders(folders: string[]): void {
    this.watchedFolders = folders;
  }

  cleanup(): void {
    this.debouncedHandlers.clear();
  }
}
