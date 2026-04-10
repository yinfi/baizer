// src/knowledge/compiler.ts

import { App, TFile } from 'obsidian';
import { CompilerExtraction, TopicRef, normalizeTopicSlug } from './types';
import { KnowledgeRegistryManager } from './registry';

/**
 * 构建编译器 prompt：让 AI 从原始笔记中提取结构化字段
 */
export function buildCompilerPrompt(noteContent: string, notePath: string): string {
  return `你是一个知识编译器。请从以下笔记中提取结构化信息。

笔记路径: ${notePath}

笔记内容:
---
${noteContent.substring(0, 30000)}
---

请提取以下字段，以 JSON 格式返回（不要添加任何其他文字）：

\`\`\`json
{
  "title": "文章标题",
  "author": "作者（如果能识别）",
  "source_url": "来源 URL（如果 frontmatter 中有 source 字段）",
  "created_at": "创建时间（ISO 8601，如果能识别）",
  "topics": [
    {"slug": "标准化的-slug", "label": "显示标签"}
  ],
  "concepts": ["关键概念1", "关键概念2"],
  "key_claims": ["核心观点1", "核心观点2"],
  "review_flags": ["低置信度提取说明（如有）"]
}
\`\`\`

规则：
- topics 的 slug 必须是小写、连字符分隔的英文或中文
- 如果无法确定某个字段，留空字符串或空数组
- review_flags 用于标记你不确定的提取结果
- 不要编造信息，只提取笔记中实际存在的内容`;
}

/**
 * 解析 AI 返回的编译结果
 */
export function parseCompilerResponse(response: string): CompilerExtraction | null {
  try {
    const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();

    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.title !== 'string') return null;

    const topics: TopicRef[] = (parsed.topics || []).map((t: any) => ({
      slug: normalizeTopicSlug(t.slug || t.label || ''),
      label: t.label || t.slug || ''
    })).filter((t: TopicRef) => t.slug.length > 0);

    return {
      title: parsed.title || '',
      author: parsed.author || '',
      source_url: parsed.source_url || '',
      created_at: parsed.created_at || '',
      topics,
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      key_claims: Array.isArray(parsed.key_claims) ? parsed.key_claims : [],
      review_flags: Array.isArray(parsed.review_flags) ? parsed.review_flags : []
    };
  } catch {
    return null;
  }
}

/**
 * 生成 summary 页的 Markdown 内容
 */
export function buildSummaryMarkdown(
  sourceId: string,
  extraction: CompilerExtraction,
  sourcePath: string | null
): string {
  const now = new Date().toISOString();

  let fm = '---\n';
  fm += 'knowledge_generated: true\n';
  fm += `knowledge_source_id: "${sourceId}"\n`;
  fm += `title: "${extraction.title.replace(/"/g, '\\"')}"\n`;
  if (extraction.source_url) fm += `source_url: "${extraction.source_url}"\n`;
  if (extraction.author) fm += `author: "${extraction.author.replace(/"/g, '\\"')}"\n`;
  if (extraction.created_at) fm += `created_at: "${extraction.created_at}"\n`;
  fm += `compiled_at: "${now}"\n`;

  if (extraction.topics.length > 0) {
    fm += 'topics:\n';
    for (const t of extraction.topics) {
      fm += `  - "${t.label.replace(/"/g, '\\"')}"\n`;
    }
  }

  if (extraction.concepts.length > 0) {
    fm += `concepts: ${JSON.stringify(extraction.concepts)}\n`;
  }

  if (extraction.key_claims.length > 0) {
    fm += 'key_claims:\n';
    for (const claim of extraction.key_claims) {
      fm += `  - "${claim.replace(/"/g, '\\"')}"\n`;
    }
  }

  if (extraction.review_flags.length > 0) {
    fm += `review_flags: ${JSON.stringify(extraction.review_flags)}\n`;
  } else {
    fm += 'review_flags: []\n';
  }

  fm += '---\n';

  let body = `# ${extraction.title}\n\n`;

  body += '## 摘要\n\n';
  if (extraction.key_claims.length > 0) {
    body += extraction.key_claims.slice(0, 2).map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无核心观点提取）\n';
  }

  body += '\n## 核心观点\n\n';
  if (extraction.key_claims.length > 0) {
    body += extraction.key_claims.map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无）\n';
  }

  body += '\n## 关键概念\n\n';
  if (extraction.concepts.length > 0) {
    body += extraction.concepts.map(c => `- ${c}`).join('\n') + '\n';
  } else {
    body += '（无）\n';
  }

  body += '\n## 原始来源\n\n';
  if (sourcePath) {
    body += `[[${sourcePath}]]\n`;
  } else {
    body += '原始来源已删除。\n';
  }

  return fm + body;
}

/**
 * 编译器主类：协调 registry、AI 调用、文件写入
 */
export class KnowledgeCompiler {
  constructor(
    private app: App,
    private registry: KnowledgeRegistryManager,
    private generateFn: (prompt: string) => Promise<string>,
    private wikiFolder: string
  ) {}

  /**
   * 编译单篇笔记
   * @returns summary 文件路径，或 null（失败时）
   */
  async compileNote(sourceId: string): Promise<string | null> {
    const record = this.registry.getRecord(sourceId);
    if (!record) throw new Error(`Record not found: ${sourceId}`);

    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!file || !(file instanceof TFile)) {
      this.registry.transition(sourceId, 'missing_source');
      await this.registry.save();
      return null;
    }

    this.registry.transition(sourceId, 'processing');
    await this.registry.save();

    try {
      const content = await this.app.vault.read(file);
      const prompt = buildCompilerPrompt(content, record.path);
      const response = await this.generateFn(prompt);
      const extraction = parseCompilerResponse(response);

      if (!extraction) {
        this.registry.transition(sourceId, 'failed', 'Failed to parse AI response');
        await this.registry.save();
        return null;
      }

      const summaryPath = `${this.wikiFolder}/Articles/${sourceId}.md`;
      const summaryContent = buildSummaryMarkdown(sourceId, extraction, record.path);

      const articlesDir = `${this.wikiFolder}/Articles`;
      if (!this.app.vault.getAbstractFileByPath(articlesDir)) {
        await this.app.vault.createFolder(articlesDir);
      }

      const existingFile = this.app.vault.getAbstractFileByPath(summaryPath);
      if (existingFile && existingFile instanceof TFile) {
        const existingContent = await this.app.vault.read(existingFile);
        if (!existingContent.includes('knowledge_generated: true')) {
          this.registry.transition(sourceId, 'failed', 'Target file exists and is not a generated file');
          await this.registry.save();
          return null;
        }
        await this.app.vault.modify(existingFile, summaryContent);
      } else {
        await this.app.vault.create(summaryPath, summaryContent);
      }

      this.registry.setSummaryPath(sourceId, summaryPath);
      this.registry.transition(sourceId, 'done');
      await this.registry.save();
      return summaryPath;
    } catch (e: any) {
      try {
        this.registry.transition(sourceId, 'failed', e.message);
      } catch { /* 状态可能已经不允许转换 */ }
      await this.registry.save();
      return null;
    }
  }

  /**
   * 批量编译所有 pending 和 stale 项
   */
  async compileAllPending(maxBatch: number = 50, onProgress?: (current: number, total: number, noteId: string) => void): Promise<{ success: number; failed: number }> {
    const staleRecords = this.registry.getByStatus('stale');
    for (const r of staleRecords) {
      this.registry.transition(r.id, 'pending');
    }
    await this.registry.save();

    const pendingRecords = this.registry.getByStatus('pending').slice(0, maxBatch);
    let success = 0;
    let failed = 0;

    for (let i = 0; i < pendingRecords.length; i++) {
      const record = pendingRecords[i];
      onProgress?.(i + 1, pendingRecords.length, record.id);
      const result = await this.compileNote(record.id);
      if (result) { success++; } else { failed++; }
    }

    return { success, failed };
  }
}
