// src/knowledge/topic-utils.ts

import { TopicRef } from './types';

export interface TopicPageEntry {
  title: string;
  summaryPath: string;
}

/**
 * 生成 topic 页的 Markdown 内容
 */
export function buildTopicPageContent(
  slug: string,
  label: string,
  entries: TopicPageEntry[]
): string {
  const now = new Date().toISOString();
  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "topic_page"\ntopic_slug: "${slug}"\ncompiled_at: "${now}"\n---\n# ${label}\n\n`;

  if (entries.length === 0) {
    md += '暂无相关文章。\n';
  } else {
    md += '## 相关文章\n\n';
    for (const entry of entries) {
      md += `- [[${entry.summaryPath}|${entry.title}]]\n`;
    }
  }
  return md;
}

/**
 * 从 topic 页内容中解析出已有的条目链接
 */
export function parseTopicPageEntries(content: string): TopicPageEntry[] {
  const entries: TopicPageEntry[] = [];
  const regex = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ summaryPath: match[1], title: match[2] });
  }
  return entries;
}

/**
 * 从多组 topics 中收集所有唯一的 slug，返回 slug -> label 映射
 */
export function collectAllTopics(topicSets: TopicRef[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const topics of topicSets) {
    for (const t of topics) {
      if (!map.has(t.slug)) {
        map.set(t.slug, t.label);
      }
    }
  }
  return map;
}
