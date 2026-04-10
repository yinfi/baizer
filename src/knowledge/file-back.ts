// src/knowledge/file-back.ts

import { App } from 'obsidian';
import { DEFAULT_WIKI_FOLDER, WIKI_ARTICLES_SUBFOLDER } from './types';
import { WikiIndexer } from './indexer';

/**
 * 生成 file-back ID
 */
export function generateFileBackId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 12; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `fb_${suffix}`;
}

/**
 * 生成回填页的 Markdown 内容
 */
export function buildFileBackMarkdown(
  fileBackId: string,
  title: string,
  content: string,
  sourceQueries: string[],
  relatedSources: string[],
  topics: string[] = [],
  sourceUrl?: string
): string {
  const now = new Date().toISOString();

  let fm = '---\n';
  fm += 'knowledge_generated: true\n';
  fm += 'knowledge_artifact_type: "file_back"\n';
  fm += `title: "${title.replace(/"/g, '\\"')}"\n`;
  fm += `compiled_at: "${now}"\n`;

  if (topics.length > 0) {
    fm += 'topics:\n';
    for (const t of topics) {
      fm += `  - "${t.replace(/"/g, '\\"')}"\n`;
    }
  } else {
    fm += 'topics: []\n';
  }

  if (sourceUrl) {
    fm += `source_url: "${sourceUrl.replace(/"/g, '\\"')}"\n`;
  }

  fm += 'source_queries:\n';
  for (const q of sourceQueries) {
    fm += `  - "${q.replace(/"/g, '\\"')}"\n`;
  }

  if (relatedSources.length > 0) {
    fm += 'related_sources:\n';
    for (const s of relatedSources) {
      fm += `  - "${s}"\n`;
    }
  } else {
    fm += 'related_sources: []\n';
  }

  fm += '---\n';

  return `${fm}# ${title}\n\n${content}\n`;
}

/**
 * file_back_knowledge 工具执行器
 */
export class FileBackExecutor {
  constructor(
    private app: App,
    private indexer: WikiIndexer,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  async execute(args: {
    title: string;
    content: string;
    source_queries: string[];
    related_sources: string[];
    topics?: string[];
    source_url?: string;
  }): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const fileBackId = generateFileBackId();
      const filePath = `${this.wikiFolder}/${WIKI_ARTICLES_SUBFOLDER}/${fileBackId}.md`;

      const markdown = buildFileBackMarkdown(
        fileBackId,
        args.title,
        args.content,
        args.source_queries || [],
        args.related_sources || [],
        args.topics || [],
        args.source_url
      );

      const articlesDir = `${this.wikiFolder}/${WIKI_ARTICLES_SUBFOLDER}`;
      if (!this.app.vault.getAbstractFileByPath(articlesDir)) {
        try { await this.app.vault.createFolder(articlesDir); } catch {}
      }

      await this.app.vault.create(filePath, markdown);
      await this.indexer.rebuildIndex();

      return { success: true, path: filePath };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}
