// src/knowledge/indexer.ts
// 生成 Obsidian Bases 索引文件，替代手动 markdown 索引

import { App, TFile, Notice } from 'obsidian';
import { MetadataIndex } from './metadata-index';
import { logger } from '../utils/logger';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_INDEX_BASE_FILENAME,
  WIKI_INDEX_FILENAME,
  WIKI_TOPICS_SUBFOLDER,
} from './types';

/**
 * 生成 .base 文件内容（Obsidian Bases YAML 格式）
 */
export function buildBaseFileContent(articlesFolder: string): string {
  return `# Knowledge Wiki 索引 - 由插件自动生成
# 请勿手动编辑此文件

filters:
  and:
    - file.folder == "${articlesFolder}"

properties:
  title:
    displayName: 标题
  topics:
    displayName: 主题
  concepts:
    displayName: 概念
  compiled_at:
    displayName: 编译时间
  source_url:
    displayName: 来源
  author:
    displayName: 作者

views:
  - type: table
    name: "所有文章"
    order: [title, topics, compiled_at, source_url]
  - type: table
    name: "按主题"
    groupBy:
      property: note.topics
      direction: ASC
    order: [title, concepts, compiled_at]
`;
}

/**
 * 索引器：维护 .base 索引文件 + 内存索引
 */
export class WikiIndexer {
  constructor(
    private app: App,
    private metadataIndex: MetadataIndex,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  /** 重建索引：刷新内存索引 + 生成 .base 文件 */
  async rebuildIndex(): Promise<void> {
    this.metadataIndex.rebuild();
    await this.ensureBaseFile();
  }

  /** 只确保 .base 文件存在（不刷新内存索引） */
  async ensureBaseFile(): Promise<void> {
    await this.ensureFolder(this.wikiFolder);
    await this.generateBaseFile();
  }

  /** 检测 Bases 核心插件是否启用，未启用则提示 */
  checkBasesPlugin(): void {
    const internalPlugins = (this.app as any).internalPlugins;
    const basesPlugin = internalPlugins?.plugins?.['bases'];
    if (!basesPlugin || !basesPlugin.enabled) {
      new Notice(
        'Knowledge Wiki 需要启用 Bases 核心插件才能正常显示索引视图。\n请在 设置 → 核心插件 中启用 Bases。',
        8000
      );
    }
  }

  /** 迁移：清理旧的 index.md 和 Topics/ 文件夹 */
  async migrateLegacyIndex(): Promise<void> {
    // 删除旧 index.md
    const oldIndexPath = `${this.wikiFolder}/${WIKI_INDEX_FILENAME}`;
    const oldIndex = this.app.vault.getAbstractFileByPath(oldIndexPath);
    if (oldIndex && oldIndex instanceof TFile) {
      const content = await this.app.vault.read(oldIndex);
      if (content.includes('knowledge_generated: true')) {
        await this.app.vault.trash(oldIndex, true);
        logger.info('Migrated: removed legacy index.md', 'WikiIndexer');
      }
    }

    // 删除旧 Topics/ 下的 generated 文件
    const topicsDir = `${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}`;
    const topicFiles = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(topicsDir + '/') && f.extension === 'md'
    );
    for (const file of topicFiles) {
      const content = await this.app.vault.read(file);
      if (content.includes('knowledge_generated: true')) {
        await this.app.vault.trash(file, true);
      }
    }
    if (topicFiles.length > 0) {
      logger.info(`Migrated: cleaned ${topicFiles.length} legacy topic pages`, 'WikiIndexer');
    }
  }

  private async generateBaseFile(): Promise<void> {
    const basePath = `${this.wikiFolder}/${WIKI_INDEX_BASE_FILENAME}`;
    const articlesFolder = `${this.wikiFolder}/Articles`;
    const content = buildBaseFileContent(articlesFolder);

    const existing = this.app.vault.getAbstractFileByPath(basePath);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }

    const adapter = this.app.vault.adapter;
    if (await adapter.exists(basePath)) {
      await adapter.write(basePath, content);
      return;
    }

    try {
      await this.app.vault.create(basePath, content);
    } catch (e: any) {
      if (String(e?.message ?? e).includes('File already exists')) {
        await adapter.write(basePath, content);
        return;
      }
      throw e;
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try { await this.app.vault.createFolder(path); } catch { /* already exists */ }
    }
  }
}
