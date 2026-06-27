// src/knowledge/metadata-index.ts
// 基于 Obsidian metadataCache 的内存知识索引

import { App, TFile } from 'obsidian';
import { ArticleMeta, WIKI_ARTICLES_SUBFOLDER, normalizeTopicSlug } from './types';

/**
 * 从 metadataCache 的 frontmatter 中提取 topics 数组
 * 兼容新格式 ["label"] 和旧格式 [{slug, label}]
 */
function extractTopics(fm: Record<string, any>): string[] {
  const raw = fm.topics;
  if (!Array.isArray(raw)) return [];
  return raw.map((t: any) => {
    if (typeof t === 'string') return t;
    if (t && typeof t === 'object' && t.label) return t.label;
    return '';
  }).filter((s: string) => s.length > 0);
}

/**
 * 从 metadataCache 的 frontmatter 中提取字符串数组字段
 */
function extractStringArray(fm: Record<string, any>, key: string): string[] {
  const raw = fm[key];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return [raw]; }
  }
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Fall through to a single item.
  }
  return value ? [value] : [];
}

function extractCategorizedKnowledge(fm: Record<string, any>): { category: string; items: string[] }[] {
  const raw = fm.categorized_knowledge;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry: any) => entry && typeof entry.category === 'string')
    .map((entry: any) => ({
      category: entry.category,
      items: Array.isArray(entry.items)
        ? entry.items.map(String)
        : typeof entry.items === 'string'
          ? parseStringList(entry.items)
          : [],
    }))
    .filter((entry) => entry.category.length > 0);
}

function extractEntities(fm: Record<string, any>): { name: string; type: string; description: string }[] {
  const raw = fm.entities;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry: any) => entry && typeof entry.name === 'string' && typeof entry.type === 'string')
    .map((entry: any) => ({
      name: entry.name,
      type: entry.type,
      description: typeof entry.description === 'string' ? entry.description : '',
    }))
    .filter((entry) => entry.name.length > 0);
}

/**
 * 基于 metadataCache 的轻量内存索引
 * 启动时全量构建，之后通过事件增量更新
 */
export class MetadataIndex {
  private articles: Map<string, ArticleMeta> = new Map();
  private articlesFolder: string;

  constructor(private app: App, wikiFolder: string) {
    this.articlesFolder = `${wikiFolder}/${WIKI_ARTICLES_SUBFOLDER}`;
  }

  /** 全量重建索引 */
  rebuild(): void {
    this.articles.clear();
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(this.articlesFolder + '/')
    );
    for (const file of files) {
      this.indexFile(file);
    }
  }

  /** 增量更新单个文件 */
  onFileChanged(file: TFile): void {
    if (!file.path.startsWith(this.articlesFolder + '/')) return;
    this.indexFile(file);
  }

  /** 文件删除时移除索引 */
  onFileDeleted(path: string): void {
    for (const [key, meta] of this.articles) {
      if (meta.summaryPath === path) {
        this.articles.delete(key);
        break;
      }
    }
  }

  /** 从 metadataCache 读取单个文件的 frontmatter 并索引 */
  private indexFile(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    // knowledge_generated 可能是布尔 true 或字符串 "true"
    if (!fm || (fm.knowledge_generated !== true && fm.knowledge_generated !== 'true')) return;

    const sourceId = fm.knowledge_source_id || file.basename;
    const meta: ArticleMeta = {
      sourceId,
      title: fm.title || file.basename,
      summaryPath: file.path,
      topics: extractTopics(fm),
      concepts: extractStringArray(fm, 'concepts'),
      keyClaims: extractStringArray(fm, 'key_claims'),
      compiledAt: fm.compiled_at || '',
      sourceUrl: fm.source_url || undefined,
      author: fm.author || undefined,
      categorizedKnowledge: extractCategorizedKnowledge(fm),
      entities: extractEntities(fm),
      schemaHash: fm.schema_hash || undefined,
    };
    this.articles.set(sourceId, meta);
  }

  /** 获取全部文章 */
  getAllArticles(): ArticleMeta[] {
    return Array.from(this.articles.values());
  }

  /** 按 topic 过滤（按归一化 slug 匹配，消除大小写/标点/空格差异） */
  getByTopic(topic: string): ArticleMeta[] {
    const targetSlug = normalizeTopicSlug(topic);
    if (!targetSlug) return [];
    return this.getAllArticles().filter(a =>
      a.topics.some(t => {
        const slug = normalizeTopicSlug(t);
        return slug === targetSlug || slug.includes(targetSlug);
      })
    );
  }

  /** 关键词搜索：匹配 title + topics + concepts */
  search(query: string, maxResults: number = 5): ArticleMeta[] {
    const keywords = query
      .toLowerCase()
      .split(/[\s,;，；]+/)
      .filter(k => k.length >= 2);

    if (keywords.length === 0) {
      return this.getAllArticles()
        .sort((a, b) => b.compiledAt.localeCompare(a.compiledAt))
        .slice(0, maxResults);
    }

    const scored = this.getAllArticles().map(article => {
      let score = 0;
      const titleLower = article.title.toLowerCase();
      const topicsLower = article.topics.map(t => t.toLowerCase());
      const conceptsLower = article.concepts.map(c => c.toLowerCase());
      const claimsLower = article.keyClaims.map(c => c.toLowerCase());
      const categorizedLower = (article.categorizedKnowledge || []).flatMap(entry => [
        entry.category.toLowerCase(),
        ...entry.items.map(item => item.toLowerCase()),
      ]);
      const entitiesLower = (article.entities || []).flatMap(entry => [
        entry.name.toLowerCase(),
        entry.type.toLowerCase(),
        entry.description.toLowerCase(),
      ]);

      for (const kw of keywords) {
        if (titleLower.includes(kw)) score += 5;
        if (topicsLower.some(t => t.includes(kw))) score += 4;
        if (conceptsLower.some(c => c.includes(kw))) score += 3;
        if (claimsLower.some(c => c.includes(kw))) score += 2;
        if (categorizedLower.some(c => c.includes(kw))) score += 3;
        if (entitiesLower.some(e => e.includes(kw))) score += 4;
      }
      return { article, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.article);
  }

  /**
   * 生成紧凑全量索引：每篇文章一行，供 AI 做语义筛选
   * 格式：[编号] 标题 | 主题 | 核心观点(前2条) | 路径
   */
  buildCompactIndex(): string {
    const articles = this.getAllArticles()
      .sort((a, b) => b.compiledAt.localeCompare(a.compiledAt));

    if (articles.length === 0) return '';

    let index = `知识库共 ${articles.length} 篇文章：\n\n`;
    index += this.formatArticleLines(articles);
    return index;
  }

  /**
   * 关键词粗筛 + 紧凑索引：文章量大时先缩小范围
   * @param query 用户查询
   * @param threshold 超过此数量时启用粗筛
   */
  buildSmartIndex(query: string, threshold: number = 100): { index: string; totalCount: number; filtered: boolean } {
    const total = this.articles.size;

    if (total <= threshold) {
      // 文章量小，直接返回全量紧凑索引
      return { index: this.buildCompactIndex(), totalCount: total, filtered: false };
    }

    // 文章量大，先关键词粗筛
    const candidates = this.search(query, 30);
    if (candidates.length > 0) {
      let index = `知识库共 ${total} 篇文章，以下是与查询最可能相关的 ${candidates.length} 篇：\n\n`;
      index += this.formatArticleLines(candidates);
      return { index, totalCount: total, filtered: true };
    }

    // 粗筛无结果：返回主题概览 + 最近文章，避免全量索引撑爆 token
    const topicSummary = this.getTopicSummary();
    const recent = this.getAllArticles()
      .sort((a, b) => b.compiledAt.localeCompare(a.compiledAt))
      .slice(0, 20);

    let index = `知识库共 ${total} 篇文章，关键词未直接命中。\n\n`;
    if (topicSummary.length > 0) {
      index += '## 知识库主题概览\n';
      for (const t of topicSummary.slice(0, 30)) {
        index += `- ${t.topic} (${t.count} 篇)\n`;
      }
      index += '\n';
    }
    index += '## 最近编译的文章\n\n';
    index += this.formatArticleLines(recent);
    return { index, totalCount: total, filtered: true };
  }

  /** 将文章列表格式化为紧凑行 */
  private formatArticleLines(articles: ArticleMeta[]): string {
    let result = '';
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const parts: string[] = [`[${i + 1}] ${a.title}`];
      if (a.topics.length > 0) parts.push(`主题: ${a.topics.join('/')}`);
      if (a.keyClaims.length > 0) {
        parts.push(`观点: ${a.keyClaims.slice(0, 2).join('；')}`);
      }
      parts.push(`路径: [[${a.summaryPath}]]`);
      const ontologyParts: string[] = [];
      if (a.categorizedKnowledge && a.categorizedKnowledge.length > 0) {
        ontologyParts.push(...a.categorizedKnowledge.slice(0, 2).map(entry =>
          `${entry.category}: ${entry.items.slice(0, 2).join('/')}`
        ));
      }
      if (a.entities && a.entities.length > 0) {
        ontologyParts.push(`Entities: ${a.entities.slice(0, 3).map(entry => entry.name).join('/')}`);
      }
      if (ontologyParts.length > 0) parts.push(`Ontology: ${ontologyParts.join('; ')}`);
      result += parts.join(' | ') + '\n';
    }
    return result;
  }

  /**
   * 获取所有唯一 topic 及其文章数
   * 按归一化 slug 聚合，使 "Second Brain"/"second-brain" 等变体合并为一项；
   * 显示 label 取该 slug 下首次出现的原始写法。
   */
  getTopicSummary(): { topic: string; count: number }[] {
    const counts = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const article of this.articles.values()) {
      // 同一篇文章内 slug 去重，避免变体在单篇内重复计数
      const seen = new Set<string>();
      for (const topic of article.topics) {
        const slug = normalizeTopicSlug(topic);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        counts.set(slug, (counts.get(slug) || 0) + 1);
        if (!labels.has(slug)) labels.set(slug, topic);
      }
    }
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ topic: labels.get(slug) || slug, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 文章总数 */
  get size(): number {
    return this.articles.size;
  }
}
