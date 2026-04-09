// src/knowledge/indexer.ts

import { App, TFile } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import {
  DEFAULT_WIKI_FOLDER,
  WIKI_ARTICLES_SUBFOLDER,
  WIKI_TOPICS_SUBFOLDER,
  WIKI_INDEX_FILENAME,
  TopicRef
} from './types';
import { buildTopicPageContent, TopicPageEntry, collectAllTopics } from './topic-utils';

export interface IndexArticleEntry {
  sourceId: string;
  title: string;
  summaryPath: string;
  compiledAt: string;
}

export interface IndexTopicEntry {
  slug: string;
  label: string;
  topicPagePath: string;
}

/**
 * 生成全局索引页 Markdown 内容
 */
export function buildGlobalIndexContent(
  articles: IndexArticleEntry[],
  topics: IndexTopicEntry[]
): string {
  const now = new Date().toISOString();

  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "global_index"\ncompiled_at: "${now}"\n---\n# Knowledge Wiki\n\n`;

  md += '## Articles\n\n';
  if (articles.length === 0) {
    md += '暂无已编译的文章。\n\n';
  } else {
    const sorted = [...articles].sort((a, b) =>
      new Date(b.compiledAt).getTime() - new Date(a.compiledAt).getTime()
    );
    for (const a of sorted) {
      md += `- [[${a.summaryPath}|${a.title}]] (${a.compiledAt.split('T')[0]})\n`;
    }
    md += '\n';
  }

  md += '## Topics\n\n';
  if (topics.length === 0) {
    md += '暂无主题分类。\n\n';
  } else {
    const sorted = [...topics].sort((a, b) => a.slug.localeCompare(b.slug));
    for (const t of sorted) {
      md += `- [[${t.topicPagePath}|${t.label}]]\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * 索引器主类：编译完成后维护全局索引和 topic 索引页
 */
export class WikiIndexer {
  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  async rebuildIndex(): Promise<void> {
    const completedRecords = this.registry.getCompletedRecords();

    const articles: IndexArticleEntry[] = [];
    const allTopicSets: TopicRef[][] = [];
    const summaryMeta: Map<string, { title: string; topics: TopicRef[] }> = new Map();

    for (const record of completedRecords) {
      if (!record.summary_path) continue;
      const file = this.app.vault.getAbstractFileByPath(record.summary_path);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fm = this.parseFrontmatter(content);
        if (!fm) continue;

        const title = fm.title || record.path.split('/').pop()?.replace('.md', '') || 'Untitled';
        const compiledAt = fm.compiled_at || record.updated_at;
        const topics: TopicRef[] = fm.topics || [];

        articles.push({ sourceId: record.id, title, summaryPath: record.summary_path, compiledAt });
        allTopicSets.push(topics);
        summaryMeta.set(record.summary_path, { title, topics });
      } catch { continue; }
    }

    const topicMap = collectAllTopics(allTopicSets);

    await this.ensureFolder(`${this.wikiFolder}`);
    await this.ensureFolder(`${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}`);

    const topicEntries: IndexTopicEntry[] = [];
    const activeTopicSlugs = new Set<string>();

    for (const [slug, label] of topicMap) {
      const entries: TopicPageEntry[] = [];
      for (const [summaryPath, meta] of summaryMeta) {
        if (meta.topics.some(t => t.slug === slug)) {
          entries.push({ title: meta.title, summaryPath });
        }
      }
      if (entries.length === 0) continue;

      activeTopicSlugs.add(slug);
      const topicPagePath = `${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}/${slug}.md`;
      const topicContent = buildTopicPageContent(slug, label, entries);
      await this.writeGeneratedFile(topicPagePath, topicContent);
      topicEntries.push({ slug, label, topicPagePath });
    }

    await this.removeOrphanTopicPages(activeTopicSlugs);

    const indexContent = buildGlobalIndexContent(articles, topicEntries);
    const indexPath = `${this.wikiFolder}/${WIKI_INDEX_FILENAME}`;
    await this.writeGeneratedFile(indexPath, indexContent);
  }

  private parseFrontmatter(content: string): Record<string, any> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const fm: Record<string, any> = {};
    const lines = match[1].split('\n');
    let currentKey = '';
    let currentArray: any[] | null = null;

    for (const line of lines) {
      const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
      if (kvMatch) {
        if (currentArray && currentKey) {
          fm[currentKey] = currentArray;
          currentArray = null;
        }
        currentKey = kvMatch[1];
        const value = kvMatch[2].trim();
        if (value === '') {
          currentArray = [];
        } else {
          fm[currentKey] = value.replace(/^["']|["']$/g, '');
          currentKey = '';
        }
      } else if (currentArray !== null && line.trim().startsWith('- ')) {
        const item = line.trim().substring(2).trim();
        if (item.startsWith('{') || item.startsWith('slug:')) {
          const slugMatch = item.match(/slug:\s*"([^"]+)"/);
          const labelMatch = item.match(/label:\s*"([^"]+)"/);
          if (slugMatch) {
            const obj: any = { slug: slugMatch[1] };
            if (labelMatch) obj.label = labelMatch[1];
            currentArray.push(obj);
          }
        } else {
          currentArray.push(item.replace(/^["']|["']$/g, ''));
        }
      } else if (currentArray !== null) {
        const labelMatch = line.match(/\s+label:\s*"([^"]+)"/);
        if (labelMatch && currentArray.length > 0) {
          const last = currentArray[currentArray.length - 1];
          if (typeof last === 'object') last.label = labelMatch[1];
        }
      }
    }

    if (currentArray && currentKey) {
      fm[currentKey] = currentArray;
    }

    for (const [key, value] of Object.entries(fm)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        try { fm[key] = JSON.parse(value); } catch { /* keep as string */ }
      }
    }

    return fm;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try { await this.app.vault.createFolder(path); } catch { /* already exists */ }
    }
  }

  private async writeGeneratedFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && existing instanceof TFile) {
      const existingContent = await this.app.vault.read(existing);
      if (existingContent.includes('knowledge_generated: true')) {
        await this.app.vault.modify(existing, content);
        return;
      }
      console.warn(`[WikiIndexer] Skipping ${path}: not a generated file`);
      return;
    }
    await this.app.vault.create(path, content);
  }

  private async removeOrphanTopicPages(activeSlugs: Set<string>): Promise<void> {
    const topicsDir = `${this.wikiFolder}/${WIKI_TOPICS_SUBFOLDER}`;
    const folder = this.app.vault.getAbstractFileByPath(topicsDir);
    if (!folder) return;

    const files = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(topicsDir + '/') && f.extension === 'md'
    );

    for (const file of files) {
      const slug = file.basename;
      if (!activeSlugs.has(slug)) {
        const content = await this.app.vault.read(file);
        if (content.includes('knowledge_generated: true')) {
          await this.app.vault.trash(file, true);
        }
      }
    }
  }
}
