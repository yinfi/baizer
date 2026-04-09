// src/knowledge/query.ts

import { App, TFile } from 'obsidian';
import { DEFAULT_WIKI_FOLDER, WIKI_INDEX_FILENAME } from './types';

export interface QueryKnowledgeResult {
  query: string;
  indexContent: string;
  maxResults: number;
  instruction: string;
}

/**
 * 构建 query_knowledge 工具的返回结果
 */
export function buildQueryResult(
  query: string,
  indexContent: string,
  maxResults?: number
): QueryKnowledgeResult {
  const max = maxResults ?? 3;

  if (!indexContent || indexContent.trim().length === 0) {
    return {
      query,
      indexContent: '',
      maxResults: max,
      instruction: '知识库为空，暂无可检索的内容。可以建议用户先编译一些笔记。'
    };
  }

  return {
    query,
    indexContent,
    maxResults: max,
    instruction: `以上是知识库索引。请根据用户的问题"${query}"，从索引中找出最相关的文章（最多 ${max} 篇），然后使用 read_note 工具读取这些 summary 的全文来回答用户问题。回答时请引用具体来源。`
  };
}

/**
 * query_knowledge 工具执行器
 */
export class QueryKnowledgeExecutor {
  constructor(
    private app: App,
    private wikiFolder: string = DEFAULT_WIKI_FOLDER
  ) {}

  async execute(args: { query: string; max_results?: number }): Promise<QueryKnowledgeResult> {
    const indexPath = `${this.wikiFolder}/${WIKI_INDEX_FILENAME}`;
    const file = this.app.vault.getAbstractFileByPath(indexPath);

    let indexContent = '';
    if (file && file instanceof TFile) {
      indexContent = await this.app.vault.read(file);
    }

    return buildQueryResult(args.query, indexContent, args.max_results);
  }
}
