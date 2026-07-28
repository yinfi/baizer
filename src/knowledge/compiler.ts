// src/knowledge/compiler.ts

import { App, TFile } from 'obsidian';
import { CompilerExtraction, TopicRef, normalizeTopicSlug, OntologySchema } from './types';
import {
  ensureSourceId,
  setKnowledgeStatus,
  getFilesByKnowledgeStatus,
  getPendingReason,
  KnowledgePendingReason,
} from './frontmatter';
import { computeSchemaHash, extractFrontmatter } from './ontology';

/**
 * 去除 markdown frontmatter（--- 之间的部分），返回正文
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return content;
  return content.substring(endIdx + 3).trimStart();
}

/**
 * 计算文件正文的 content hash（排除 frontmatter）
 * 复用 ontology.ts 的 computeSchemaHash（djb2 算法）
 */
export function computeContentHash(content: string): string {
  const body = stripFrontmatter(content);
  return computeSchemaHash(body);
}

export interface CurrentCompiledSummary {
  path: string;
  sourceId: string;
  compiledAt?: string;
  contentHash: string;
  schemaHash?: string;
}

export interface CompileAllPendingOptions {
  pendingReasons?: KnowledgePendingReason[];
  /** 文件级并发上限(同时编译的文件数)。默认 3。避免打爆 provider 速率限制。 */
  fileConcurrency?: number;
}

function asString(value: any): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarySourceIdFromPath(summaryPath: string): string {
  return summaryPath.split('/').pop()?.replace(/\.md$/, '') || summaryPath;
}

async function readGeneratedSummary(
  app: App,
  summaryPath: string
): Promise<CurrentCompiledSummary | null> {
  const file = app.vault.getAbstractFileByPath(summaryPath);
  if (!file || !(file instanceof TFile)) return null;

  try {
    const content = await app.vault.read(file);
    const parsed = extractFrontmatter(content) || {};
    const cached = app.metadataCache.getFileCache(file)?.frontmatter || {};
    const generated = cached.knowledge_generated === true
      || cached.knowledge_generated === 'true'
      || parsed.knowledge_generated === true
      || parsed.knowledge_generated === 'true'
      || content.includes('knowledge_generated: true');
    if (!generated) return null;

    const contentHash = asString(cached.content_hash) || asString(parsed.content_hash);
    if (!contentHash) return null;

    const sourceId = asString(cached.knowledge_source_id)
      || asString(parsed.knowledge_source_id)
      || summarySourceIdFromPath(summaryPath);

    return {
      path: summaryPath,
      sourceId,
      compiledAt: asString(cached.compiled_at) || asString(parsed.compiled_at),
      contentHash,
      schemaHash: asString(cached.schema_hash) || asString(parsed.schema_hash),
    };
  } catch {
    return null;
  }
}

export async function findCurrentCompiledSummary(
  app: App,
  file: TFile,
  wikiFolder: string,
  schemaHash?: string
): Promise<CurrentCompiledSummary | null> {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter || {};
  const candidates: string[] = [];
  const summaryPath = asString(frontmatter.knowledge_summary);
  const sourceId = asString(frontmatter.knowledge_source_id);

  if (summaryPath) candidates.push(summaryPath);
  if (sourceId) candidates.push(`${wikiFolder}/Articles/${sourceId}.md`);

  if (candidates.length === 0) return null;

  let contentHash: string;
  try {
    contentHash = computeContentHash(await app.vault.read(file));
  } catch {
    return null;
  }

  for (const candidate of Array.from(new Set(candidates))) {
    const summary = await readGeneratedSummary(app, candidate);
    if (!summary) continue;
    if (summary.contentHash !== contentHash) continue;
    if (schemaHash && summary.schemaHash !== schemaHash) continue;
    return summary;
  }

  return null;
}

/**
 * 按 markdown heading 边界对长文档分块
 * - content <= 30000 字符：不分块，返回 [content]
 * - 否则按 ## / ### 标题切割，每块 <= maxChunkSize
 * - 单个 section 超长时在段落边界（\n\n）二次分割
 * - 相邻块有 overlap 字符重叠
 * - 每块带 frontmatter + 前 200 字符作为上下文前缀
 */
export function chunkDocument(
  content: string,
  maxChunkSize: number = 25000,
  overlap: number = 500
): string[] {
  // 短文章不分块
  if (content.length <= 30000) return [content];

  // 提取 frontmatter + 前 200 字符作为全局上下文前缀
  const body = stripFrontmatter(content);
  let contextPrefix = '';
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      contextPrefix = content.substring(0, endIdx + 3) + '\n';
    }
  }
  contextPrefix += body.substring(0, 200) + '\n...\n\n';

  // 按 heading 边界切割（## 或 ###）
  const sections: string[] = [];
  const headingRegex = /^#{2,3}\s+/m;
  let remaining = body;

  while (remaining.length > 0) {
    // 在 maxChunkSize 范围内找最后一个 heading 边界
    if (remaining.length <= maxChunkSize) {
      sections.push(remaining);
      break;
    }

    const searchArea = remaining.substring(0, maxChunkSize);
    let splitIdx = -1;

    // 从后往前找 heading 边界
    const lines = searchArea.split('\n');
    let charCount = 0;
    for (let i = lines.length - 1; i > 0; i--) {
      charCount += lines[i].length + 1;
      if (headingRegex.test(lines[i])) {
        splitIdx = searchArea.length - charCount;
        break;
      }
    }

    // 没找到 heading，在段落边界（\n\n）分割
    if (splitIdx <= 0) {
      const lastPara = searchArea.lastIndexOf('\n\n');
      splitIdx = lastPara > 0 ? lastPara : maxChunkSize;
    }

    sections.push(remaining.substring(0, splitIdx));
    // overlap：回退 overlap 字符，保证上下文连续
    // 死循环防护：splitIdx 恒 >=1，但当 splitIdx <= overlap 时
    // max(0, splitIdx-overlap) 会钳到 0 使 remaining 原地不动。
    // 此时放弃 overlap、按 splitIdx 全量推进，保证每轮严格变短。
    const overlapStart = splitIdx > overlap ? splitIdx - overlap : splitIdx;
    remaining = remaining.substring(overlapStart);
  }

  // 每块加上下文前缀
  const prefixLen = contextPrefix.length;
  const effectiveMax = maxChunkSize - prefixLen;

  return sections.map((section, i) => {
    // 如果加了前缀后超长，截断 section（不应该常发生）
    const trimmed = section.length > effectiveMax
      ? section.substring(0, effectiveMax)
      : section;
    return contextPrefix + trimmed;
  });
}

/**
 * 合并多个 chunk 的提取结果（Reduce 阶段）
 * 纯函数，不需要 AI 调用
 */
export function mergeExtractions(extractions: CompilerExtraction[]): CompilerExtraction {
  // 空数组 guard
  if (extractions.length === 0) {
    return {
      title: '', author: '', source_url: '', created_at: '',
      topics: [], concepts: [], key_claims: [], review_flags: ['all_chunks_empty'],
    };
  }

  // 单个直接返回
  if (extractions.length === 1) return extractions[0];

  // title/author/source_url/created_at: 取第一个非空
  const first = (field: keyof CompilerExtraction) =>
    (extractions.find(e => {
      const v = e[field];
      return typeof v === 'string' && v.length > 0;
    })?.[field] as string) || '';

  // topics: 按 slug 去重
  const topicMap = new Map<string, TopicRef>();
  for (const e of extractions) {
    for (const t of e.topics) {
      if (!topicMap.has(t.slug)) topicMap.set(t.slug, t);
    }
  }

  // concepts: exact match 去重
  const conceptSet = new Set<string>();
  for (const e of extractions) {
    for (const c of e.concepts) conceptSet.add(c);
  }

  // key_claims: exact match 去重，保持顺序
  const claimSet = new Set<string>();
  const claims: string[] = [];
  for (const e of extractions) {
    for (const c of e.key_claims) {
      if (!claimSet.has(c)) { claimSet.add(c); claims.push(c); }
    }
  }

  // entities: 按 name+type 去重，description 取最长
  const entityMap = new Map<string, { name: string; type: string; description: string }>();
  for (const e of extractions) {
    for (const ent of (e.entities || [])) {
      const key = `${ent.name}::${ent.type}`;
      const existing = entityMap.get(key);
      if (!existing || ent.description.length > existing.description.length) {
        entityMap.set(key, ent);
      }
    }
  }

  // categorized_knowledge: 按 category 合并 items，去重
  const catMap = new Map<string, Set<string>>();
  for (const e of extractions) {
    for (const ck of (e.categorized_knowledge || [])) {
      if (!catMap.has(ck.category)) catMap.set(ck.category, new Set());
      for (const item of ck.items) catMap.get(ck.category)!.add(item);
    }
  }
  const categorized_knowledge = Array.from(catMap.entries()).map(([category, items]) => ({
    category,
    items: Array.from(items),
  }));

  // review_flags: 全部保留 + compiled_from_N_chunks
  const flagSet = new Set<string>();
  for (const e of extractions) {
    for (const f of e.review_flags) flagSet.add(f);
  }
  flagSet.add(`compiled_from_${extractions.length}_chunks`);

  return {
    title: first('title'),
    author: first('author'),
    source_url: first('source_url'),
    created_at: first('created_at'),
    topics: Array.from(topicMap.values()),
    concepts: Array.from(conceptSet),
    key_claims: claims,
    review_flags: Array.from(flagSet),
    categorized_knowledge: categorized_knowledge.length > 0 ? categorized_knowledge : undefined,
    entities: entityMap.size > 0 ? Array.from(entityMap.values()) : undefined,
  };
}

/**
 * 构建编译器 prompt：让 AI 从原始笔记中提取结构化字段
 */
export function buildCompilerPrompt(noteContent: string, notePath: string, ontologySchema?: OntologySchema): string {
  let prompt = `你是一个知识编译器。请从以下笔记中提取结构化信息。

笔记路径: ${notePath}

笔记内容:
---
${noteContent}
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

  // Ontology schema 注入
  if (ontologySchema) {
    prompt += '\n\n## 本体模型提取要求\n\n请额外按以下知识类别对提取内容进行分类：\n\n';
    for (const c of ontologySchema.categories) {
      prompt += `- "${c.name}"：${c.description}\n`;
    }

    if (ontologySchema.entity_types.length > 0) {
      prompt += '\n请额外识别以下类型的实体：\n\n';
      for (const e of ontologySchema.entity_types) {
        prompt += `- "${e.name}"：${e.description}\n`;
      }
    }

    prompt += `
在 JSON 输出中新增以下字段：

"categorized_knowledge": [
  {"category": "类别名", "items": ["该类别下的条目1", "条目2"]}
],
"entities": [
  {"name": "实体名", "type": "实体类型", "description": "一句话描述"}
]

规则：
- 每个 item 只归入最匹配的一个 category，不要重复归类
- 如果文章内容不涉及某个 category，该 category 的 items 为空数组
- 实体名使用文章中最常见的称呼形式`;
  }

  return prompt;
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

    const reviewFlags: string[] = Array.isArray(parsed.review_flags) ? parsed.review_flags : [];

    // Ontology 字段解析（fail-visible：解析失败不影响基础字段）
    let categorized_knowledge: CompilerExtraction['categorized_knowledge'];
    let entities: CompilerExtraction['entities'];

    try {
      if (Array.isArray(parsed.categorized_knowledge)) {
        categorized_knowledge = parsed.categorized_knowledge
          .filter((ck: any) => typeof ck?.category === 'string' && Array.isArray(ck?.items))
          .map((ck: any) => ({
            category: ck.category,
            items: ck.items.filter((i: any) => typeof i === 'string'),
          }));
      }
      if (Array.isArray(parsed.entities)) {
        entities = parsed.entities
          .filter((e: any) => typeof e?.name === 'string' && typeof e?.type === 'string')
          .map((e: any) => ({
            name: e.name,
            type: e.type,
            description: typeof e.description === 'string' ? e.description : '',
          }));
      }
    } catch {
      // Ontology 字段解析失败，标记到 review_flags
      reviewFlags.push('ontology_extraction_failed');
      console.warn('[parseCompilerResponse] Ontology fields parse failed, base fields preserved');
    }

    return {
      title: parsed.title || '',
      author: parsed.author || '',
      source_url: parsed.source_url || '',
      created_at: parsed.created_at || '',
      topics,
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      key_claims: Array.isArray(parsed.key_claims) ? parsed.key_claims : [],
      review_flags: reviewFlags,
      categorized_knowledge,
      entities,
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
  sourcePath: string | null,
  schemaHash?: string,
  contentHash?: string
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
  if (schemaHash) fm += `schema_hash: "${schemaHash}"\n`;
  if (contentHash) fm += `content_hash: "${contentHash}"\n`;

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

  // Ontology 扩展字段写入 frontmatter
  if (extraction.categorized_knowledge && extraction.categorized_knowledge.length > 0) {
    fm += 'categorized_knowledge:\n';
    for (const ck of extraction.categorized_knowledge) {
      fm += `  - category: "${ck.category.replace(/"/g, '\\"')}"\n`;
      fm += `    items: ${JSON.stringify(ck.items)}\n`;
    }
  }

  if (extraction.entities && extraction.entities.length > 0) {
    fm += 'entities:\n';
    for (const e of extraction.entities) {
      fm += `  - name: "${e.name.replace(/"/g, '\\"')}"\n`;
      fm += `    type: "${e.type.replace(/"/g, '\\"')}"\n`;
      fm += `    description: "${e.description.replace(/"/g, '\\"')}"\n`;
    }
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

  // Ontology 扩展字段写入 body
  if (extraction.categorized_knowledge && extraction.categorized_knowledge.length > 0) {
    body += '\n## 知识分类\n\n';
    for (const ck of extraction.categorized_knowledge) {
      if (ck.items.length > 0) {
        body += `### ${ck.category}\n\n`;
        body += ck.items.map(i => `- ${i}`).join('\n') + '\n\n';
      }
    }
  }

  if (extraction.entities && extraction.entities.length > 0) {
    body += '\n## 实体\n\n';
    for (const e of extraction.entities) {
      body += `- **${e.name}**（${e.type}）：${e.description}\n`;
    }
    body += '\n';
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
 * 编译器主类：协调 frontmatter 状态、AI 调用、文件写入
 */
export class KnowledgeCompiler {
  constructor(
    private app: App,
    private generateFn: (prompt: string) => Promise<string>,
    private wikiFolder: string
  ) {}

  /**
   * 编译单篇笔记
   * 短文章（<= 30000 字符）走单次 AI 调用
   * 长文章走 Map-Reduce：分块并行提取 + 纯函数合并
   * @param schema 可选的 ontology schema，传入时注入到 prompt
   * @param schemaHash 可选的 schema 内容 hash，写入 summary frontmatter
   * @param concurrency Map 阶段并行度（默认 3）
   */
  async compileNote(
    file: TFile,
    schema?: OntologySchema,
    schemaHash?: string,
    concurrency: number = 3
  ): Promise<string | null> {
    const sourceId = await ensureSourceId(this.app, file);
    await setKnowledgeStatus(this.app, file, 'processing');

    try {
      const content = await this.app.vault.read(file);
      const contentHash = computeContentHash(content);
      let extraction: CompilerExtraction | null;

      if (content.length <= 30000) {
        // 短文章：单次 AI 调用
        const prompt = buildCompilerPrompt(content, file.path, schema);
        const response = await this.generateFn(prompt);
        extraction = parseCompilerResponse(response);
      } else {
        // 长文章：Map-Reduce
        const chunks = chunkDocument(content);
        const allResults: PromiseSettledResult<CompilerExtraction | null>[] = [];

        // 批次并行
        for (let i = 0; i < chunks.length; i += concurrency) {
          const batch = chunks.slice(i, i + concurrency);
          const batchResults = await Promise.allSettled(
            batch.map(async (chunk, batchIdx) => {
              const chunkIdx = i + batchIdx;
              const chunkPrompt = buildCompilerPrompt(chunk, file.path, schema);
              const prefix = `[注意：这是文档的第 ${chunkIdx + 1}/${chunks.length} 块，请只提取本块中的信息]\n\n`;
              const response = await this.generateFn(prefix + chunkPrompt);
              return parseCompilerResponse(response);
            })
          );
          allResults.push(...batchResults);
        }

        // 收集成功的提取结果
        const extractions: CompilerExtraction[] = [];
        const failedChunks: number[] = [];
        allResults.forEach((r, idx) => {
          if (r.status === 'fulfilled' && r.value) {
            extractions.push(r.value);
          } else {
            failedChunks.push(idx);
          }
        });

        if (extractions.length === 0) {
          await setKnowledgeStatus(this.app, file, 'failed', {
            error: `All ${chunks.length} chunks failed extraction`
          });
          return null;
        }

        // 合并 + 标记失败的 chunk
        extraction = mergeExtractions(extractions);
        for (const idx of failedChunks) {
          extraction.review_flags.push(`chunk_${idx}_extraction_failed`);
        }
      }

      if (!extraction) {
        await setKnowledgeStatus(this.app, file, 'failed', {
          error: 'Failed to parse AI response'
        });
        return null;
      }

      const summaryPath = `${this.wikiFolder}/Articles/${sourceId}.md`;
      const summaryContent = buildSummaryMarkdown(
        sourceId, extraction, file.path, schemaHash, contentHash
      );

      const articlesDir = `${this.wikiFolder}/Articles`;
      if (!this.app.vault.getAbstractFileByPath(articlesDir)) {
        await this.app.vault.createFolder(articlesDir);
      }

      const existingFile = this.app.vault.getAbstractFileByPath(summaryPath);
      if (existingFile && existingFile instanceof TFile) {
        const existingContent = await this.app.vault.read(existingFile);
        if (!existingContent.includes('knowledge_generated: true')) {
          await setKnowledgeStatus(this.app, file, 'failed', {
            error: 'Target file exists and is not a generated file'
          });
          return null;
        }
        await this.app.vault.modify(existingFile, summaryContent);
      } else {
        await this.app.vault.create(summaryPath, summaryContent);
      }

      await setKnowledgeStatus(this.app, file, 'done', {
        source_id: sourceId,
        compiled_at: new Date().toISOString(),
        summary: summaryPath,
      });
      return summaryPath;
    } catch (e: any) {
      try {
        await setKnowledgeStatus(this.app, file, 'failed', { error: e.message });
      } catch { /* frontmatter 写入也失败了，忽略 */ }
      return null;
    }
  }

  /**
   * 批量编译所有 pending 项(文件级并发)。
   *
   * 从「逐文件串行 await」改为「带全局上限的文件级并发」:大 vault 首次编译显著提速。
   * 复用单篇内已验证的 Promise.allSettled 批处理模式(见 compileNote 长文 Map-Reduce)。
   *
   * 并发上限的两层含义(避免打爆 provider 速率限制):
   * - fileConcurrency:同时编译的文件数(默认 3,保守)。
   * - concurrency:单篇长文内 chunk 的并行度(默认 3)。
   * 二者相乘是最坏情况的在途 LLM 调用数(3×3=9),故默认都取保守值,均可配。
   *
   * 计数在每个文件「落定时」累加(不按数组下标),保证并发下 success/failed 正确;
   * onProgress 用共享计数器在完成时回调,呈现「已完成/总数」。
   *
   * @param schema 可选的 ontology schema，整个 batch 使用同一份
   * @param schemaHash 可选的 schema 内容 hash
   * @param concurrency 单篇长文内 chunk 的并行度(默认 3)
   * @param options.fileConcurrency 文件级并发上限(默认 3)
   */
  async compileAllPending(
    maxBatch: number = 50,
    onProgress?: (current: number, total: number, path: string) => void,
    schema?: OntologySchema,
    schemaHash?: string,
    concurrency?: number,
    options?: CompileAllPendingOptions
  ): Promise<{ success: number; failed: number }> {
    // stuck-file reset 已移到 runtime.ts onMetadataReady() 统一管理

    const allowedReasons = options?.pendingReasons
      ? new Set<KnowledgePendingReason>(options.pendingReasons)
      : null;
    const pendingFiles = getFilesByKnowledgeStatus(this.app, 'pending')
      .filter((file) => !allowedReasons || allowedReasons.has(getPendingReason(this.app, file) as KnowledgePendingReason))
      .slice(0, maxBatch);

    const total = pendingFiles.length;
    const fileConcurrency = Math.max(1, options?.fileConcurrency ?? 3);
    let success = 0;
    let failed = 0;
    let completed = 0;

    // 编译单个 pending 文件:命中已有摘要则跳过(计成功),否则走 compileNote。
    // 计数与 onProgress 在此「落定时」处理,天然线程安全(单线程事件循环 + await 点原子)。
    const compileOne = async (file: TFile): Promise<void> => {
      try {
        const currentSummary = await findCurrentCompiledSummary(this.app, file, this.wikiFolder, schemaHash);
        if (currentSummary) {
          // 已有当前摘要:仅标记 done 并跳过,不计入 success/failed(与旧串行行为一致)。
          await setKnowledgeStatus(this.app, file, 'done', {
            source_id: currentSummary.sourceId,
            compiled_at: currentSummary.compiledAt || new Date().toISOString(),
            summary: currentSummary.path,
          });
          return;
        }
        const result = await this.compileNote(file, schema, schemaHash, concurrency);
        if (result) { success++; } else { failed++; }
      } catch {
        // compileNote 内部已处理并落 failed 状态;此处兜底计数,不让单文件异常中断整批。
        failed++;
      } finally {
        completed++;
        onProgress?.(completed, total, file.path);
      }
    };

    // 文件级批处理:每批至多 fileConcurrency 个文件并发,批间等待(Promise.allSettled)。
    for (let i = 0; i < pendingFiles.length; i += fileConcurrency) {
      const batch = pendingFiles.slice(i, i + fileConcurrency);
      await Promise.allSettled(batch.map((file) => compileOne(file)));
    }

    return { success, failed };
  }
}
