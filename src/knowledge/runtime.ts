// src/knowledge/runtime.ts

import { App, TFile, Notice, debounce } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import { ModelService } from '../services/model-service';
import { KnowledgeCompiler } from './compiler';
import { WikiIndexer } from './indexer';
import { KnowledgeLinter } from './linter';
import { KnowledgeWatcher } from './watcher';
import { QueryKnowledgeExecutor } from './query';
import { FileBackExecutor } from './file-back';
import { MetadataIndex } from './metadata-index';
import { KnowledgeStatusService } from './status-service';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_INDEX_BASE_FILENAME,
  ONTOLOGY_SCHEMA_FILENAME,
  OntologySchema,
} from './types';
import {
  getKnowledgeStatus,
  getSourceId,
  setKnowledgeStatus,
  ensureSourceId,
  getFilesByKnowledgeStatus,
  getUnregisteredFiles,
} from './frontmatter';
import { parseOntologySchema, extractFrontmatter, computeSchemaHash, buildDiscoveryPrompt, parseDiscoveryResponse, buildOntologyFile } from './ontology';

/**
 * Knowledge Wiki 生命周期管理器
 */
export class KnowledgeRuntime {
  public compiler: KnowledgeCompiler;
  public indexer: WikiIndexer;
  private linter: KnowledgeLinter;
  private watcher: KnowledgeWatcher;
  private queryExecutor: QueryKnowledgeExecutor;
  private fileBackExecutor: FileBackExecutor;
  private metadataIndex: MetadataIndex;
  private modelService: ModelService;
  private statusService: KnowledgeStatusService;

  /** 暴露给 SkillRegistry 注册 knowledge 工具 */
  getQueryExecutor(): QueryKnowledgeExecutor { return this.queryExecutor; }
  getFileBackExecutor(): FileBackExecutor { return this.fileBackExecutor; }
  getStatusService(): KnowledgeStatusService { return this.statusService; }
  private autoCompiling = false;

  constructor(
    private app: App,
    public settings: PluginSettings,
    modelService: ModelService,
  ) {
    const wikiFolder = settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    this.modelService = modelService;

    this.compiler = new KnowledgeCompiler(
      app,
      (prompt: string) => modelService.generate(prompt, '你是一个知识编译器，请严格按照要求提取结构化信息。'),
      wikiFolder
    );

    this.metadataIndex = new MetadataIndex(app, wikiFolder);
    this.indexer = new WikiIndexer(app, this.metadataIndex, wikiFolder);
    this.linter = new KnowledgeLinter(app, wikiFolder);
    this.statusService = new KnowledgeStatusService(app, {
      watchedFolders: settings.knowledgeSourceFolders || [],
      wikiFolder,
    });

    this.watcher = new KnowledgeWatcher(
      app,
      settings.knowledgeSourceFolders || [],
      wikiFolder
    );

    // 自动编译：watcher 检测到新文件/修改后，debounce 5秒合并批量编译
    const debouncedAutoCompile = debounce(async () => {
      if (!this.settings.knowledgeAutoCompile) return;
      if (this.autoCompiling) return;
      this.autoCompiling = true;
      try {
        const maxBatch = this.settings.knowledgeMaxCompileBatch || 50;
        const ontology = await this.loadOntologySchema();
        console.log(`[KnowledgeRuntime] Auto-compiling pending notes...${ontology ? ' (with ontology schema)' : ''}`);
        const result = await this.compiler.compileAllPending(maxBatch, undefined, ontology?.schema, ontology?.hash);
        if (result.success > 0) {
          await this.indexer.rebuildIndex();
          new Notice(`Auto-compiled: ${result.success} notes`);
        }
        if (result.failed > 0) {
          console.warn(`[KnowledgeRuntime] Auto-compile: ${result.failed} failed`);
        }
      } catch (e) {
        console.error(`[KnowledgeRuntime] Auto-compile error:`, e);
      } finally {
        this.autoCompiling = false;
      }
    }, 5000, true);

    this.watcher.setOnCompileNeeded(debouncedAutoCompile);

    this.queryExecutor = new QueryKnowledgeExecutor(this.metadataIndex);
    this.fileBackExecutor = new FileBackExecutor(app, this.indexer, wikiFolder);
  }

  async initialize(): Promise<void> {
    // 等待 metadataCache 就绪后再构建索引和执行启动逻辑
    if ((this.app.metadataCache as any).initialized) {
      this.metadataIndex.rebuild();
      await this.onMetadataReady();
    } else {
      const ref = this.app.metadataCache.on('resolved', async () => {
        this.metadataIndex.rebuild();
        this.app.metadataCache.offref(ref);
        console.log(`[KnowledgeRuntime] MetadataCache resolved, ${this.metadataIndex.size} articles indexed`);
        await this.onMetadataReady();
      });
    }

    // 迁移旧索引
    await this.indexer.migrateLegacyIndex();
    this.indexer.checkBasesPlugin();
    await this.indexer.ensureBaseFile();

    console.log(`[KnowledgeRuntime] Initialized`);
  }

  /** metadataCache 就绪后：扫描未注册文件 + 重置 processing + 触发自动编译 */
  private async onMetadataReady(): Promise<void> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const sourceFolders = this.settings.knowledgeSourceFolders || [];

    // 重置上次中断的 processing 状态
    const stuckFiles = getFilesByKnowledgeStatus(this.app, 'processing');
    for (const f of stuckFiles) {
      await setKnowledgeStatus(this.app, f, 'pending');
    }
    if (stuckFiles.length > 0) {
      console.log(`[KnowledgeRuntime] Reset ${stuckFiles.length} stuck processing files`);
    }

    // 2. 检测过期文件（schema 或内容变更）
    const staleCount = await this.detectStaleFiles(wikiFolder);
    if (staleCount > 0) {
      console.log(`[KnowledgeRuntime] Detected ${staleCount} stale files for recompilation`);
    }

    // 2.5 自动发现 ontology（_ontology.md 不存在且文章数足够时）
    await this.discoverOntology();

    // 3. 扫描监听目录，注册未标记的文件
    const unregistered = getUnregisteredFiles(this.app, sourceFolders, wikiFolder);
    for (const file of unregistered) {
      await ensureSourceId(this.app, file);
      await setKnowledgeStatus(this.app, file, 'pending');
    }
    if (unregistered.length > 0) {
      console.log(`[KnowledgeRuntime] Startup scan: registered ${unregistered.length} new files`);
    }

    // 计算总 pending 数：刚注册的 + 之前 stuck 的 + 已有的 pending
    // 注意：刚写入 frontmatter 的文件 metadataCache 可能还没更新，
    // 所以用已知数量而非再次查询 metadataCache
    const existingPending = getFilesByKnowledgeStatus(this.app, 'pending').length;
    const totalPending = Math.max(existingPending, unregistered.length + stuckFiles.length);

    if (this.settings.knowledgeAutoCompile && totalPending > 0) {
      console.log(`[KnowledgeRuntime] ${totalPending} pending notes, scheduling auto-compile...`);
      setTimeout(() => this.watcher.triggerCompile(), 10000);
    }
  }

  /**
   * 检测过期文件：schema 变更或内容变更时标记为 pending
   * 快速路径：先比较 ontology hash，没变则只检查 mtime 近期变化的文件
   */
  private async detectStaleFiles(wikiFolder: string): Promise<number> {
    const staleFiles = await this.statusService.getStaleFiles();
    for (const file of staleFiles) {
      await setKnowledgeStatus(this.app, file, 'pending');
    }
    return staleFiles.length;

    const doneFiles = getFilesByKnowledgeStatus(this.app, 'done');
    if (doneFiles.length === 0) return 0;

    // 加载当前 ontology schema hash
    const schemaFile = this.app.vault.getAbstractFileByPath(
      `${wikiFolder}/${ONTOLOGY_SCHEMA_FILENAME}`
    );
    let currentSchemaHash: string | undefined;
    if (schemaFile && schemaFile instanceof TFile) {
      const schemaContent = await this.app.vault.read(schemaFile);
      currentSchemaHash = computeSchemaHash(schemaContent);
    }

    let staleCount = 0;

    for (const file of doneFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const summaryPath = cache?.frontmatter?.knowledge_summary;
      if (!summaryPath) continue;

      const summaryFm = getSummaryFrontmatter(this.app, summaryPath);
      if (!summaryFm) continue;

      let isStale = false;

      // 检查 schema_hash 变更
      if (currentSchemaHash && summaryFm.schema_hash !== currentSchemaHash) {
        isStale = true;
      }

      // 检查 content_hash 变更（只在 summary 有 content_hash 时比较）
      if (!isStale && summaryFm.content_hash) {
        try {
          const content = await this.app.vault.read(file);
          const currentHash = computeContentHash(content);
          if (currentHash !== summaryFm.content_hash) {
            isStale = true;
          }
        } catch { /* 文件读取失败，跳过 */ }
      }

      if (isStale) {
        await setKnowledgeStatus(this.app, file, 'pending');
        staleCount++;
      }
    }

    return staleCount;
  }

  registerCommands(plugin: any): void {
    plugin.addCommand({
      id: 'knowledge-compile-this',
      name: 'Knowledge: Compile this note',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('Please open a note first.'); return; }

        new Notice(`Compiling: ${file.path}...`);
        const status = getKnowledgeStatus(this.app, file);
        if (status === 'done' || status === 'failed') {
          await setKnowledgeStatus(this.app, file, 'pending');
        } else if (!status) {
          await ensureSourceId(this.app, file);
          await setKnowledgeStatus(this.app, file, 'pending');
        }

        const ontology = await this.loadOntologySchema();
        const result = await this.compiler.compileNote(file, ontology?.schema, ontology?.hash);
        if (result) {
          await this.indexer.rebuildIndex();
          new Notice(`Compiled: ${result}`);
        } else {
          new Notice(`Compilation failed`);
        }
      }
    });

    plugin.addCommand({
      id: 'knowledge-compile-all',
      name: 'Knowledge: Compile all pending',
      callback: async () => {
        new Notice('Compiling all pending notes...');
        const maxBatch = this.settings.knowledgeMaxCompileBatch || 50;
        const ontology = await this.loadOntologySchema();
        const result = await this.compiler.compileAllPending(maxBatch, undefined, ontology?.schema, ontology?.hash);
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
          await this.app.workspace.getLeaf(false).openFile(file);
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
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      }
    });
  }

  registerEvents(plugin: any): void {
    // 文件创建：始终注册到 frontmatter
    plugin.registerEvent(
      this.app.vault.on('create', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.watcher.onFileCreate(file);
        }
      })
    );

    // 文件修改：已完成的标记回 pending
    plugin.registerEvent(
      this.app.vault.on('modify', (file: any) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.watcher.onFileModify(file);
        }
      })
    );

    // 删除和重命名不再需要特殊处理（frontmatter 跟着文件走）

    // metadataCache 变更事件：增量更新内存索引
    plugin.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        this.metadataIndex.onFileChanged(file);
      })
    );

    // 文件删除：更新内存索引
    plugin.registerEvent(
      this.app.vault.on('delete', (file: any) => {
        if (file instanceof TFile) {
          this.metadataIndex.onFileDeleted(file.path);
        }
      })
    );
  }

  /** Guardian 知识上下文 */
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
    this.settings = settings;
    this.watcher.updateWatchedFolders(settings.knowledgeSourceFolders || []);
    this.statusService.updateConfig({
      watchedFolders: settings.knowledgeSourceFolders || [],
      wikiFolder: settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER,
    });
  }

  /**
   * 加载 ontology schema（每次 batch 开始时调用一次）
   * 按 Amendment 1：不缓存，不监听，每次读取
   * @returns { schema, hash } 或 null（schema 不存在时）
   */
  async loadOntologySchema(): Promise<{ schema: OntologySchema; hash: string } | null> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const schemaPath = `${wikiFolder}/${ONTOLOGY_SCHEMA_FILENAME}`;
    const file = this.app.vault.getAbstractFileByPath(schemaPath);
    if (!file || !(file instanceof TFile)) return null;

    try {
      const rawContent = await this.app.vault.read(file);
      // 自行解析 frontmatter，不依赖 metadataCache（新文件 cache 可能未就绪）
      const frontmatter = extractFrontmatter(rawContent);
      const schema = parseOntologySchema(frontmatter);
      if (!schema) {
        console.warn('[KnowledgeRuntime] Ontology file exists but schema parse failed');
        return null;
      }

      const hash = computeSchemaHash(rawContent);
      return { schema, hash };
    } catch (e) {
      console.error('[KnowledgeRuntime] Failed to load ontology schema:', e);
      return null;
    }
  }

  /**
   * 自动发现 ontology schema
   * 从已编译的 Articles 聚合 topics/concepts/claims，让 AI 生成 schema
   * @param minArticles 最少需要多少篇已编译文章才触发（默认 10）
   * @returns schema 文件路径，或 null（文章不足/AI 失败时）
   */
  async discoverOntology(minArticles: number = 10): Promise<string | null> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const schemaPath = `${wikiFolder}/${ONTOLOGY_SCHEMA_FILENAME}`;

    // 已存在则跳过
    if (this.app.vault.getAbstractFileByPath(schemaPath)) {
      console.log('[KnowledgeRuntime] Ontology schema already exists, skipping discovery');
      return schemaPath;
    }

    // 扫描 Articles 目录，聚合统计
    const articlesDir = `${wikiFolder}/Articles`;
    const articlesFolder = this.app.vault.getAbstractFileByPath(articlesDir);
    if (!articlesFolder) return null;

    const articles: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(articlesDir + '/')) articles.push(f);
    }

    if (articles.length < minArticles) {
      console.log(`[KnowledgeRuntime] Only ${articles.length} articles, need ${minArticles} for ontology discovery`);
      return null;
    }

    // 聚合 topics, concepts, claims
    const topicCounts = new Map<string, number>();
    const conceptCounts = new Map<string, number>();
    const recentClaims: string[] = [];

    for (const file of articles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      // topics
      if (Array.isArray(fm.topics)) {
        for (const t of fm.topics) {
          const label = typeof t === 'string' ? t : t?.label;
          if (label) topicCounts.set(label, (topicCounts.get(label) || 0) + 1);
        }
      }
      // concepts
      if (Array.isArray(fm.concepts)) {
        for (const c of fm.concepts) {
          if (typeof c === 'string') conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
        }
      }
      // key_claims（取最近的）
      if (Array.isArray(fm.key_claims)) {
        for (const claim of fm.key_claims.slice(0, 3)) {
          if (typeof claim === 'string') recentClaims.push(claim);
        }
      }
    }

    // 过滤高频项
    const topTopics = Array.from(topicCounts.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([topic, count]) => ({ topic, count }));

    const topConcepts = Array.from(conceptCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([concept, count]) => ({ concept, count }));

    if (topTopics.length === 0 && topConcepts.length === 0) {
      console.log('[KnowledgeRuntime] No high-frequency topics/concepts found, skipping discovery');
      return null;
    }

    try {
      const prompt = buildDiscoveryPrompt({
        totalCount: articles.length,
        topTopics,
        topConcepts,
        recentClaims: recentClaims.slice(-20),
      });

      const response = await this.modelService.generate(prompt);
      const schema = parseDiscoveryResponse(response);
      if (!schema) {
        console.error('[KnowledgeRuntime] Failed to parse ontology discovery response');
        return null;
      }

      const content = buildOntologyFile(schema);
      await this.app.vault.create(schemaPath, content);
      console.log(`[KnowledgeRuntime] Ontology schema created at ${schemaPath}`);
      return schemaPath;
    } catch (e: any) {
      console.error('[KnowledgeRuntime] Ontology discovery failed:', e.message);
      return null;
    }
  }

  async compileByPath(path: string): Promise<{ registered: number; success: number; failed: number }> {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!abstractFile) throw new Error(`路径不存在: ${path}`);

    const ontology = await this.loadOntologySchema();
    let registered = 0;

    if (abstractFile instanceof TFile) {
      const status = getKnowledgeStatus(this.app, abstractFile);
      if (!status) {
        await ensureSourceId(this.app, abstractFile);
        await setKnowledgeStatus(this.app, abstractFile, 'pending');
        registered = 1;
      } else if (status === 'done' || status === 'failed') {
        await setKnowledgeStatus(this.app, abstractFile, 'pending');
      }

      const result = await this.compiler.compileNote(abstractFile, ontology?.schema, ontology?.hash);
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
      const status = getKnowledgeStatus(this.app, file);
      if (!status) {
        await ensureSourceId(this.app, file);
        await setKnowledgeStatus(this.app, file, 'pending');
        registered++;
      }
    }

    const maxBatch = this.settings.knowledgeMaxCompileBatch || 50;
    const result = await this.compiler.compileAllPending(maxBatch, undefined, ontology?.schema, ontology?.hash);
    if (result.success > 0) {
      await this.indexer.rebuildIndex();
    }
    return { registered, ...result };
  }

  cleanup(): void {
    this.watcher.cleanup();
  }
}
