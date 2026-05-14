import { App, TFile } from 'obsidian';
import {
  getKnowledgeStatus,
  getSummaryFrontmatter,
} from './frontmatter';
import { computeContentHash } from './compiler';
import { computeSchemaHash } from './ontology';
import {
  DEFAULT_WIKI_FOLDER,
  ONTOLOGY_SCHEMA_FILENAME,
} from './types';

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

export class KnowledgeStatusService {
  private config: KnowledgeStatusServiceConfig;

  constructor(
    private app: App,
    config: Partial<KnowledgeStatusServiceConfig> = {},
  ) {
    this.config = {
      watchedFolders: config.watchedFolders || [],
      wikiFolder: config.wikiFolder || DEFAULT_WIKI_FOLDER,
    };
  }

  updateConfig(config: Partial<KnowledgeStatusServiceConfig>): void {
    this.config = {
      watchedFolders: config.watchedFolders || this.config.watchedFolders,
      wikiFolder: config.wikiFolder || this.config.wikiFolder,
    };
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
      const currentSchemaHash = await this.getCurrentSchemaHash();
      const stale = await this.isStaleFile(file, summaryPath, currentSchemaHash);
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
      ? getSummaryFrontmatter(this.app, summaryPath)
      : null;

    return {
      path: file.path,
      state,
      summaryPath,
      compiledAt: compiledAt || summaryFrontmatter?.compiled_at || null,
      error,
    };
  }

  async getGlobalCounts(): Promise<KnowledgeGlobalCounts> {
    const counts: KnowledgeGlobalCounts = {
      pending: 0,
      failed: 0,
      stale: 0,
    };

    for (const file of this.getTrackedFiles()) {
      const status = await this.getNoteStatus(file);
      if (!status) continue;

      if (status.state === 'pending') counts.pending++;
      if (status.state === 'failed') counts.failed++;
      if (status.state === 'stale') counts.stale++;
    }

    return counts;
  }

  async getStaleFiles(): Promise<TFile[]> {
    const currentSchemaHash = await this.getCurrentSchemaHash();
    const staleFiles: TFile[] = [];

    for (const file of this.getTrackedFiles()) {
      const baseStatus = getKnowledgeStatus(this.app, file);
      if (baseStatus !== 'done') continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const summaryPath = typeof cache?.frontmatter?.knowledge_summary === 'string'
        ? cache.frontmatter.knowledge_summary
        : null;

      if (await this.isStaleFile(file, summaryPath, currentSchemaHash)) {
        staleFiles.push(file);
      }
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

  private async getCurrentSchemaHash(): Promise<string | undefined> {
    const schemaPath = `${this.config.wikiFolder}/${ONTOLOGY_SCHEMA_FILENAME}`;
    const file = this.app.vault.getAbstractFileByPath(schemaPath);
    if (!(file instanceof TFile)) return undefined;

    try {
      const content = await this.app.vault.read(file);
      return computeSchemaHash(content);
    } catch {
      return undefined;
    }
  }

  private async isStaleFile(
    file: TFile,
    summaryPath: string | null,
    currentSchemaHash?: string,
  ): Promise<boolean> {
    if (!summaryPath) return false;

    const summaryFrontmatter = getSummaryFrontmatter(this.app, summaryPath);
    if (!summaryFrontmatter) return false;

    if (
      currentSchemaHash &&
      summaryFrontmatter.schema_hash &&
      summaryFrontmatter.schema_hash !== currentSchemaHash
    ) {
      return true;
    }

    if (!summaryFrontmatter.content_hash) {
      return false;
    }

    try {
      const content = await this.app.vault.read(file);
      return computeContentHash(content) !== summaryFrontmatter.content_hash;
    } catch {
      return false;
    }
  }
}
