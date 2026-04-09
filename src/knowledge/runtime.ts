// src/knowledge/runtime.ts

import { App, TFile, Notice, debounce } from 'obsidian';
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
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_INDEX_FILENAME
} from './types';

/**
 * Knowledge Wiki 生命周期管理器
 * main.ts 只做一件事：实例化 KnowledgeRuntime 并委托生命周期
 */
export class KnowledgeRuntime {
  private registry: KnowledgeRegistryManager;
  private compiler: KnowledgeCompiler;
  private indexer: WikiIndexer;
  private linter: KnowledgeLinter;
  private watcher: KnowledgeWatcher;
  private queryExecutor: QueryKnowledgeExecutor;
  private fileBackExecutor: FileBackExecutor;

  constructor(
    private app: App,
    private settings: PluginSettings,
    private modelService: ModelService,
    private toolManager: ToolManager
  ) {
    const wikiFolder = settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;

    this.registry = new KnowledgeRegistryManager(app.vault.adapter as any);

    this.compiler = new KnowledgeCompiler(
      app,
      this.registry,
      (prompt: string) => modelService.generate(prompt, '你是一个知识编译器，请严格按照要求提取结构化信息。'),
      wikiFolder
    );

    this.indexer = new WikiIndexer(app, this.registry, wikiFolder);
    this.linter = new KnowledgeLinter(app, this.registry, wikiFolder);

    this.watcher = new KnowledgeWatcher(
      app,
      this.registry,
      settings.knowledgeSourceFolders || [],
      wikiFolder
    );

    this.queryExecutor = new QueryKnowledgeExecutor(app, wikiFolder);
    this.fileBackExecutor = new FileBackExecutor(app, this.indexer, wikiFolder);

    toolManager.setKnowledgeExecutors(this.queryExecutor, this.fileBackExecutor);
  }

  async initialize(): Promise<void> {
    await this.registry.load();
    this.registry.resetProcessingOnStartup();
    await this.registry.save();
    console.log('[KnowledgeRuntime] Initialized');
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
        const indexPath = `${wikiFolder}/${WIKI_INDEX_FILENAME}`;
        const file = this.app.vault.getAbstractFileByPath(indexPath);
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
  }

  async getGuardianKnowledgeContext(editorContext: string): Promise<string> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const indexPath = `${wikiFolder}/${WIKI_INDEX_FILENAME}`;
    const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
    if (!indexFile || !(indexFile instanceof TFile)) return '';

    const indexContent = await this.app.vault.read(indexFile);

    const keywords = editorContext
      .split(/[\s,，。！？、；：""''（）\[\]{}]+/)
      .filter(w => w.length >= 2)
      .slice(0, 10);

    if (keywords.length === 0) return '';

    const matchedArticles: string[] = [];
    const lines = indexContent.split('\n');
    for (const line of lines) {
      const linkMatch = line.match(/\[\[([^\]|]+)\|([^\]]+)\]\]/);
      if (!linkMatch) continue;
      const [, path, title] = linkMatch;
      const titleLower = title.toLowerCase();
      if (keywords.some(kw => titleLower.includes(kw.toLowerCase()))) {
        matchedArticles.push(path);
      }
    }

    if (matchedArticles.length === 0) return '';

    let context = '[知识库参考]\n';
    for (const articlePath of matchedArticles.slice(0, 3)) {
      const file = this.app.vault.getAbstractFileByPath(articlePath);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const titleMatch = fm.match(/title:\s*"([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : articlePath;

        const claims: string[] = [];
        const claimRegex = /^\s+-\s+"([^"]+)"/gm;
        let claimMatch;
        if (fm.includes('key_claims:')) {
          const afterClaims = fm.substring(fm.indexOf('key_claims:'));
          while ((claimMatch = claimRegex.exec(afterClaims)) !== null) {
            claims.push(claimMatch[1]);
            if (claims.length >= 3) break;
          }
        }

        const conceptsMatch = fm.match(/concepts:\s*(\[.*\])/);
        let concepts: string[] = [];
        if (conceptsMatch) {
          try { concepts = JSON.parse(conceptsMatch[1]); } catch {}
        }

        context += `来自《${title}》：\n`;
        if (claims.length > 0) {
          context += `- 核心观点：${claims.join('；')}\n`;
        }
        if (concepts.length > 0) {
          context += `- 关键概念：${concepts.join('、')}\n`;
        }
        context += '\n';
      } catch { continue; }
    }

    context += '请在补全建议中自然融入上述个人知识，而不是给出通用回答。\n';
    return context;
  }

  updateSettings(settings: PluginSettings): void {
    this.watcher.updateWatchedFolders(settings.knowledgeSourceFolders || []);
  }

  /**
   * 按路径编译：支持文件或目录
   * 文件 → 注册并编译该文件
   * 目录 → 扫描目录下所有 .md，注册未注册的，然后编译所有 pending
   * @returns { registered: number, success: number, failed: number }
   */
  async compileByPath(path: string): Promise<{ registered: number; success: number; failed: number }> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!abstractFile) throw new Error(`路径不存在: ${path}`);

    let registered = 0;

    if (abstractFile instanceof TFile) {
      // 单文件
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
