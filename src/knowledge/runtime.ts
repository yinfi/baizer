// src/knowledge/runtime.ts

import { App, TFile, Notice } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import { ModelService } from '../services/model-service';
import { ToolManager } from '../mcp/tools';
import { KnowledgeRegistryManager } from './registry';
import { KnowledgeCompiler } from './compiler';
import { WikiIndexer } from './indexer';
import { KnowledgeLinter } from './linter';
import { KnowledgeWatcher } from './watcher';
import { QueryKnowledgeExecutor } from './query';
import { FileBackExecutor } from './file-back';
import { MetadataIndex } from './metadata-index';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_INDEX_BASE_FILENAME,
} from './types';

/**
 * Knowledge Wiki 生命周期管理器
 */
export class KnowledgeRuntime {
  private registry: KnowledgeRegistryManager;
  public compiler: KnowledgeCompiler;
  public indexer: WikiIndexer;
  private linter: KnowledgeLinter;
  private watcher: KnowledgeWatcher;
  private queryExecutor: QueryKnowledgeExecutor;
  private fileBackExecutor: FileBackExecutor;
  private metadataIndex: MetadataIndex;

  constructor(
    private app: App,
    public settings: PluginSettings,
    modelService: ModelService,
    toolManager: ToolManager
  ) {
    const wikiFolder = settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;

    this.registry = new KnowledgeRegistryManager(app.vault.adapter as any);

    this.compiler = new KnowledgeCompiler(
      app,
      this.registry,
      (prompt: string) => modelService.generate(prompt, '你是一个知识编译器，请严格按照要求提取结构化信息。'),
      wikiFolder
    );

    this.metadataIndex = new MetadataIndex(app, wikiFolder);
    this.indexer = new WikiIndexer(app, this.registry, this.metadataIndex, wikiFolder);
    this.linter = new KnowledgeLinter(app, this.registry, wikiFolder);

    this.watcher = new KnowledgeWatcher(
      app,
      this.registry,
      settings.knowledgeSourceFolders || [],
      wikiFolder
    );

    this.queryExecutor = new QueryKnowledgeExecutor(this.metadataIndex);
    this.fileBackExecutor = new FileBackExecutor(app, this.indexer, wikiFolder);

    toolManager.setKnowledgeExecutors(this.queryExecutor, this.fileBackExecutor);
  }

  async initialize(): Promise<void> {
    await this.registry.load();
    this.registry.resetProcessingOnStartup();
    await this.registry.save();

    // 等待 metadataCache 就绪后再构建索引
    // Obsidian 的 metadataCache 是异步填充的，插件 onload 时可能还没准备好
    if ((this.app.metadataCache as any).initialized) {
      this.metadataIndex.rebuild();
    } else {
      // resolved 事件在 vault 所有文件的 cache 都就绪后触发一次
      const ref = this.app.metadataCache.on('resolved', () => {
        this.metadataIndex.rebuild();
        this.app.metadataCache.offref(ref);
        console.log(`[KnowledgeRuntime] MetadataCache resolved, ${this.metadataIndex.size} articles indexed`);
      });
    }

    // 迁移旧索引
    await this.indexer.migrateLegacyIndex();

    // 检测 Bases 插件
    this.indexer.checkBasesPlugin();

    // 确保 .base 文件存在（不触发内存索引重建，等 metadataCache 就绪后再建）
    await this.indexer.ensureBaseFile();

    console.log(`[KnowledgeRuntime] Initialized, ${this.metadataIndex.size} articles indexed`);
  }

  registerCommands(plugin: any): void {
    plugin.addCommand({
      id: 'knowledge-compile-this',
      name: 'Knowledge: Compile this note',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice('Please open a note first.');
          return;
        }

        new Notice(`Compiling: ${file.path}...`);

        let record = this.registry.findByPath(file.path);
        if (!record) {
          record = this.registry.register(file.path);
          await this.registry.save();
        } else if (record.status === 'done') {
          this.registry.transition(record.id, 'stale');
          this.registry.transition(record.id, 'pending');
          await this.registry.save();
        } else if (record.status === 'stale') {
          this.registry.transition(record.id, 'pending');
          await this.registry.save();
        }

        const result = await this.compiler.compileNote(record.id);
        if (result) {
          await this.indexer.rebuildIndex();
          new Notice(`Compiled: ${result}`);
        } else {
          const updated = this.registry.getRecord(record.id);
          new Notice(`Compilation failed: ${updated?.error || 'Unknown error'}`);
        }
      }
    });

    plugin.addCommand({
      id: 'knowledge-compile-all',
      name: 'Knowledge: Compile all pending',
      callback: async () => {
        new Notice('Compiling all pending notes...');
        const maxBatch = this.settings.knowledgeMaxCompileBatch || 50;
        const result = await this.compiler.compileAllPending(maxBatch);
        if (result.success > 0) {
          await this.indexer.rebuildIndex();
        }
        new Notice(`Compiled: ${result.success} success, ${result.failed} failed`);
      }
    });

    plugin.addCommand({
      id: 'knowledge-open-index',
      name: 'Knowledge: Open knowledge index',
      callback: async () => {
        const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
        const basePath = `${wikiFolder}/${WIKI_INDEX_BASE_FILENAME}`;
        const file = this.app.vault.getAbstractFileByPath(basePath);
        if (file && file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        } else {
          new Notice('Knowledge index not found. Compile some notes first.');
        }
      }
    });

    plugin.addCommand({
      id: 'knowledge-lint',
      name: 'Knowledge: Run knowledge lint',
      callback: async () => {
        new Notice('Running knowledge lint...');
        const reportPath = await this.linter.generateReport();
        new Notice(`Health report generated: ${reportPath}`);
        const file = this.app.vault.getAbstractFileByPath(reportPath);
        if (file && file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        }
      }
    });
  }

  registerEvents(plugin: any): void {
    // 文件变更事件
    plugin.registerEvent(
      this.app.vault.on('create', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.settings.knowledgeAutoCompile) {
            this.watcher.onFileCreate(file);
          }
        }
      })
    );

    plugin.registerEvent(
      this.app.vault.on('modify', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.settings.knowledgeAutoCompile) {
            this.watcher.onFileModify(file);
          }
        }
      })
    );

    plugin.registerEvent(
      this.app.vault.on('delete', (file: any) => {
        if (file instanceof TFile) {
          this.watcher.onFileDelete(file.path);
          this.metadataIndex.onFileDeleted(file.path);
        }
      })
    );

    plugin.registerEvent(
      this.app.vault.on('rename', (file: any, oldPath: string) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.watcher.onFileRename(oldPath, file.path);
        }
      })
    );

    // metadataCache 变更事件：增量更新内存索引
    plugin.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        this.metadataIndex.onFileChanged(file);
      })
    );
  }

  /** Guardian 知识上下文：从内存索引搜索，通过 metadataCache 读取详情 */
  async getGuardianKnowledgeContext(editorContext: string): Promise<string> {
    const keywords = editorContext
      .split(/[\s,，。！？、；：""''（）\[\]{}]+/)
      .filter(w => w.length >= 2)
      .slice(0, 10)
      .join(' ');

    if (!keywords) return '';

    const articles = this.metadataIndex.search(keywords, 3);
    if (articles.length === 0) return '';

    let context = '[知识库参考]\n';
    for (const article of articles) {
      context += `来自《${article.title}》：\n`;
      if (article.keyClaims.length > 0) {
        context += `- 核心观点：${article.keyClaims.slice(0, 3).join('；')}\n`;
      }
      if (article.concepts.length > 0) {
        context += `- 关键概念：${article.concepts.join('、')}\n`;
      }
      context += '\n';
    }
    context += '请在补全建议中自然融入上述个人知识，而不是给出通用回答。\n';
    return context;
  }

  updateSettings(settings: PluginSettings): void {
    this.watcher.updateWatchedFolders(settings.knowledgeSourceFolders || []);
  }

  async compileByPath(path: string): Promise<{ registered: number; success: number; failed: number }> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!abstractFile) throw new Error(`路径不存在: ${path}`);

    let registered = 0;

    if (abstractFile instanceof TFile) {
      let record = this.registry.findByPath(path);
      if (!record) {
        record = this.registry.register(path);
        registered = 1;
      } else if (record.status === 'done') {
        this.registry.transition(record.id, 'stale');
        this.registry.transition(record.id, 'pending');
      } else if (record.status === 'stale') {
        this.registry.transition(record.id, 'pending');
      }
      await this.registry.save();

      const result = await this.compiler.compileNote(record.id);
      if (result) {
        await this.indexer.rebuildIndex();
        return { registered, success: 1, failed: 0 };
      }
      return { registered, success: 0, failed: 1 };
    }

    // 目录：扫描所有 .md
    const files = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(path + '/') && f.extension === 'md' &&
      !f.path.startsWith(wikiFolder + '/')
    );

    for (const file of files) {
      if (!this.registry.findByPath(file.path)) {
        this.registry.register(file.path);
        registered++;
      }
    }
    await this.registry.save();

    const maxBatch = this.settings.knowledgeMaxCompileBatch || 50;
    const result = await this.compiler.compileAllPending(maxBatch);
    if (result.success > 0) {
      await this.indexer.rebuildIndex();
    }
    return { registered, ...result };
  }

  cleanup(): void {
    this.watcher.cleanup();
  }
}
