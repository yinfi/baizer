import { App, TFile } from 'obsidian';
import {
  getKnowledgeStatus,
  readSummaryFrontmatter,
} from './frontmatter';
import { computeContentHash } from './compiler';
import {
  DEFAULT_WIKI_FOLDER,
} from './types';
import { StaleCheckMarker } from './stale-marker';
import { logger } from '../utils/logger';

export type KnowledgePanelState =
  | 'unregistered'
  | 'pending'
  | 'processing'
  | 'done'
  | 'failed'
  | 'stale';

export interface KnowledgeNoteStatus {
  path: string;
  state: KnowledgePanelState;
  summaryPath: string | null;
  compiledAt: string | null;
  error: string | null;
}

export interface KnowledgeGlobalCounts {
  pending: number;
  failed: number;
  stale: number;
}

export interface KnowledgeStatusServiceConfig {
  watchedFolders: string[];
  wikiFolder: string;
}

/** getGlobalCounts 结果的缓存有效期（毫秒）：设置页反复渲染时避免全库重扫。#81 */
export const GLOBAL_COUNTS_TTL_MS = 30_000;

/** 全库遍历的分批大小：限制同时进行的 getNoteStatus 数量，降低首轮遍历的阻塞时长。 */
const GLOBAL_COUNTS_BATCH_SIZE = 8;

/** 判断两份服务配置是否指向同一扫描范围（用于决定计数缓存是否失效）。 */
function isSameScope(
  a: KnowledgeStatusServiceConfig,
  b: KnowledgeStatusServiceConfig,
): boolean {
  if (a.wikiFolder !== b.wikiFolder) return false;
  if (a.watchedFolders.length !== b.watchedFolders.length) return false;
  return a.watchedFolders.every((folder, index) => folder === b.watchedFolders[index]);
}

export class KnowledgeStatusService {
  private config: KnowledgeStatusServiceConfig;
  /** getGlobalCounts 的计数缓存；cachedAt 为缓存结果产出时刻。 */
  private globalCountsCache: { counts: KnowledgeGlobalCounts; cachedAt: number } | null = null;
  /** 在途的全库遍历：并发的非强制调用共享它，避免重复遍历。 */
  private globalCountsInFlight: Promise<KnowledgeGlobalCounts> | null = null;
  /** 每次启动新遍历时自增，旧遍历回来时据此判断结果是否已被更新的遍历取代。 */
  private globalCountsGeneration = 0;
  /**
   * 单实例标记：getStaleFiles() 有多个入口（启动扫描、markOntologyStaleFilesPending），
   * 若各自 new 一个就会各自 load→save，后写覆盖前写。
   */
  private staleMarker: StaleCheckMarker | null = null;
  /** 在途的 getStaleFiles：并发调用复用同一次遍历，避免两次全库扫描互相覆盖标记。 */
  private staleFilesInFlight: Promise<TFile[]> | null = null;

  constructor(
    private app: App,
    config: Partial<KnowledgeStatusServiceConfig> = {},
  ) {
    this.config = {
      watchedFolders: config.watchedFolders || [],
      wikiFolder: config.wikiFolder || DEFAULT_WIKI_FOLDER,
    };
  }

  /** 标记文件只跟 app 有关，与扫描范围无关，所以跨 updateConfig 复用同一个实例。 */
  updateConfig(config: Partial<KnowledgeStatusServiceConfig>): void {
    const next: KnowledgeStatusServiceConfig = {
      watchedFolders: config.watchedFolders || this.config.watchedFolders,
      wikiFolder: config.wikiFolder || this.config.wikiFolder,
    };
    // KnowledgeRuntime 每次保存设置都会调用 updateConfig；只有扫描范围真正变化时
    // 才需要让计数缓存失效，否则一次无关注销会把全库标记扫描白白重做一遍。
    if (!isSameScope(this.config, next)) {
      this.invalidateGlobalCounts();
    }
    this.config = next;
  }

  async getNoteStatus(noteOrPath: TFile | string | null | undefined): Promise<KnowledgeNoteStatus | null> {
    const file = this.resolveNote(noteOrPath);
    if (!file || this.isWikiFile(file.path)) {
      return null;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};
    const baseStatus = getKnowledgeStatus(this.app, file);
    const summaryPath = typeof frontmatter.knowledge_summary === 'string'
      ? frontmatter.knowledge_summary
      : null;
    const compiledAt = typeof frontmatter.knowledge_compiled_at === 'string'
      ? frontmatter.knowledge_compiled_at
      : null;
    const error = typeof frontmatter.knowledge_error === 'string'
      ? frontmatter.knowledge_error
      : null;

    let state: KnowledgePanelState;
    if (baseStatus === 'failed') {
      state = 'failed';
    } else if (baseStatus === 'processing') {
      state = 'processing';
    } else {
      const stale = await this.isStaleFile(file, summaryPath);
      if (stale) {
        state = 'stale';
      } else if (baseStatus === 'pending') {
        state = 'pending';
      } else if (baseStatus === 'done') {
        state = 'done';
      } else {
        state = 'unregistered';
      }
    }

    const summaryFrontmatter = summaryPath
      ? await readSummaryFrontmatter(this.app, summaryPath)
      : null;

    return {
      path: file.path,
      state,
      summaryPath,
      compiledAt: compiledAt || summaryFrontmatter?.compiled_at || null,
      error,
    };
  }

  /**
   * 统计监听目录内 pending/failed/stale 笔记数量。
   *
   * 设置页的知识库分区每次渲染都会调用本方法，若每次都串行遍历全库会明显卡顿
   * （#81，移动端尤甚）。因此结果按 GLOBAL_COUNTS_TTL_MS 缓存：TTL 内直接复用缓存，
   * 并发的非强制调用共享同一个在途遍历；forceFresh:true 可绕过缓存立即重算。
   */
  async getGlobalCounts(
    options: { forceFresh?: boolean } = {},
  ): Promise<KnowledgeGlobalCounts> {
    const forceFresh = options.forceFresh === true;
    const cached = this.globalCountsCache;

    if (!forceFresh && cached && Date.now() - cached.cachedAt < GLOBAL_COUNTS_TTL_MS) {
      return cached.counts;
    }
    if (!forceFresh && this.globalCountsInFlight) {
      return this.globalCountsInFlight;
    }

    const generation = ++this.globalCountsGeneration;
    const traversal = this.collectGlobalCounts();
    this.globalCountsInFlight = traversal;

    const settle = (counts: KnowledgeGlobalCounts): KnowledgeGlobalCounts => {
      // 只有最新一次遍历的结果能写缓存，避免被较早启动、较晚返回的旧遍历覆盖。
      if (generation === this.globalCountsGeneration) {
        this.globalCountsCache = { counts, cachedAt: Date.now() };
      }
      if (this.globalCountsInFlight === traversal) {
        this.globalCountsInFlight = null;
      }
      return counts;
    };
    const fail = (error: unknown): never => {
      if (this.globalCountsInFlight === traversal) {
        this.globalCountsInFlight = null;
      }
      throw error;
    };

    return traversal.then(settle, fail);
  }

  /** 清空计数缓存并丢弃在途遍历引用，使下一次调用重新遍历全库。 */
  invalidateGlobalCounts(): void {
    this.globalCountsCache = null;
    this.globalCountsGeneration++;
    this.globalCountsInFlight = null;
  }

  /** 分批并发遍历监听目录，产出一次计数结果（不计缓存语义）。 */
  private async collectGlobalCounts(): Promise<KnowledgeGlobalCounts> {
    const counts: KnowledgeGlobalCounts = {
      pending: 0,
      failed: 0,
      stale: 0,
    };

    // 既无 knowledge_status 也无 knowledge_summary 的笔记只可能是 'unregistered'，
    // 从不参与计数；先过滤掉它们可省去大量 getNoteStatus 调用。
    const files = this.getTrackedFiles().filter((file) => this.mayContributeCounts(file));

    // 分批 Promise.all：把原本 N 次串行 await 压缩为 N/8 轮，降低首轮遍历墙钟时间。
    for (let start = 0; start < files.length; start += GLOBAL_COUNTS_BATCH_SIZE) {
      const batch = files.slice(start, start + GLOBAL_COUNTS_BATCH_SIZE);
      const statuses = await Promise.all(batch.map((file) => this.getNoteStatus(file)));

      for (const status of statuses) {
        if (!status) continue;

        if (status.state === 'pending') counts.pending++;
        if (status.state === 'failed') counts.failed++;
        if (status.state === 'stale') counts.stale++;
      }
    }

    return counts;
  }

  /** 快速预判：该文件是否可能贡献 pending/failed/stale 计数。 */
  private mayContributeCounts(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return Boolean(frontmatter?.knowledge_status || frontmatter?.knowledge_summary);
  }

  async getStaleFiles(): Promise<TFile[]> {
    // 单飞：启动扫描与 markOntologyStaleFilesPending() 可能同时到达；并发跑两遍既浪费，
    // 也会让两个 marker 各自 load→save 互相覆盖。后来者复用同一次结果。
    if (this.staleFilesInFlight) return this.staleFilesInFlight;
    const run = this.collectStaleFiles();
    this.staleFilesInFlight = run;
    try {
      return await run;
    } finally {
      this.staleFilesInFlight = null;
    }
  }

  private async collectStaleFiles(): Promise<TFile[]> {
    const staleFiles: TFile[] = [];
    const marker = this.staleMarker ?? (this.staleMarker = new StaleCheckMarker(this.app));
    await marker.load();
    const confirmed = new Set<string>();
    const markerSizeBefore = marker.size;
    let skippedByMarker = 0;

    for (const file of this.getTrackedFiles()) {
      const baseStatus = getKnowledgeStatus(this.app, file);
      if (baseStatus !== 'done') continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const summaryPath = typeof cache?.frontmatter?.knowledge_summary === 'string'
        ? cache.frontmatter.knowledge_summary
        : null;
      if (!summaryPath) continue;

      const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);
      const summary = summaryFile instanceof TFile ? summaryFile : null;

      if (marker.isUnchanged(file, summary, summaryPath)) {
        skippedByMarker++;
        confirmed.add(file.path);
        continue;
      }

      const result = await this.evaluateStaleness(file, summaryPath);
      if (result === 'stale') {
        staleFiles.push(file);
        continue;
      }
      if (result === 'fresh') {
        marker.recordFresh(file, summary, summaryPath);
        confirmed.add(file.path);
      }
    }

    marker.retainOnly(confirmed);
    await marker.save();
    if (markerSizeBefore > 0 || skippedByMarker > 0) {
      logger.debug(
        `getStaleFiles: marker skipped ${skippedByMarker} unchanged file(s), ${staleFiles.length} stale found`,
        'KnowledgeStatusService',
      );
    }

    return staleFiles;
  }

  private getTrackedFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) =>
      !this.isWikiFile(file.path) && this.isInWatchedFolders(file.path)
    );
  }

  private resolveNote(noteOrPath: TFile | string | null | undefined): TFile | null {
    if (!noteOrPath) return null;
    if (noteOrPath instanceof TFile) return noteOrPath;
    const file = this.app.vault.getAbstractFileByPath(noteOrPath);
    return file instanceof TFile ? file : null;
  }

  private isWikiFile(path: string): boolean {
    return path.startsWith(`${this.config.wikiFolder}/`);
  }

  private isInWatchedFolders(path: string): boolean {
    if (this.config.watchedFolders.length === 0) return false;
    return this.config.watchedFolders.some((folder) => {
      const normalized = folder.endsWith('/') ? folder : `${folder}/`;
      return path.startsWith(normalized);
    });
  }

  private async isStaleFile(
    file: TFile,
    summaryPath: string | null,
  ): Promise<boolean> {
    if (!summaryPath) return false;
    return (await this.evaluateStaleness(file, summaryPath)) === 'stale';
  }

  private async evaluateStaleness(
    file: TFile,
    summaryPath: string,
  ): Promise<'stale' | 'fresh' | 'unknown'> {
    const summaryFrontmatter = await readSummaryFrontmatter(this.app, summaryPath);
    if (!summaryFrontmatter?.content_hash) return 'unknown';

    try {
      const content = await this.app.vault.read(file);
      return computeContentHash(content) === summaryFrontmatter.content_hash ? 'fresh' : 'stale';
    } catch {
      return 'unknown';
    }
  }
}
