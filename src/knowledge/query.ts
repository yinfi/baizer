// src/knowledge/query.ts
// 紧凑索引 + AI 语义筛选的知识查询执行器

import { MetadataIndex } from './metadata-index';

export interface QueryKnowledgeResult {
  query: string;
  indexContent: string;
  maxResults: number;
  instruction: string;
}

/**
 * query_knowledge 工具执行器
 *
 * 策略：将紧凑的全量索引（标题/主题/核心观点/路径）交给 AI，
 * 由 AI 自行判断语义相关性并选择要深入阅读的文章。
 * 文章量超过阈值时，先用关键词粗筛缩小范围。
 */
export class QueryKnowledgeExecutor {
  constructor(private metadataIndex: MetadataIndex) {}

  async execute(args: { query: string; max_results?: number }): Promise<QueryKnowledgeResult> {
    const max = args.max_results ?? 5;
    const { index, totalCount, filtered } = this.metadataIndex.buildSmartIndex(args.query);

    if (totalCount === 0) {
      return {
        query: args.query,
        indexContent: '',
        maxResults: max,
        instruction: '知识库为空，暂无可检索的内容。可以建议用户先编译一些笔记。'
      };
    }

    const scope = filtered
      ? `以上是从 ${totalCount} 篇文章中初筛出的候选列表。`
      : `以上是知识库全部 ${totalCount} 篇文章的索引。`;

    return {
      query: args.query,
      indexContent: index,
      maxResults: max,
      instruction: [
        scope,
        `请根据用户问题"${args.query}"，从中选出最相关的文章（最多 ${max} 篇），`,
        '使用 read_note 工具读取其 summary 全文，然后基于内容回答用户。',
        '如果引用了知识库文章，必须在回答末尾用 "---" 分隔后列出引用来源，格式：📚 引用来源：- [[路径|标题]]。',
        '如果索引中没有相关文章，正常回答即可，不要添加引用部分。',
        '\n\n自动归档判断：如果你的回答综合了 2 篇及以上知识来源、产出了新的洞察或总结，',
        '请主动调用 file_back_knowledge 工具将回答归档到知识库，并提取合适的 topics 主题标签。',
        '如果只是简单转述单篇文章内容，则不需要归档。'
      ].join('')
    };
  }
}
