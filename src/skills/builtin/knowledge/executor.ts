// src/skills/builtin/knowledge/executor.ts

import { Tool, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import { QueryKnowledgeExecutor } from '../../../knowledge/query';
import { FileBackExecutor } from '../../../knowledge/file-back';

/**
 * Knowledge 工具需要 executor 实例（运行时注入）
 */
export function createKnowledgeTools(
  queryExecutor: QueryKnowledgeExecutor | null,
  fileBackExecutor: FileBackExecutor | null,
): Tool[] {
  const queryKnowledge: Tool = {
    name: 'query_knowledge',
    description: '从个人知识库中检索相关知识。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题' },
        max_results: { type: 'integer', description: '最多返回几篇，默认 3' },
      },
      required: ['query'],
    },
    async execute(args) {
      if (!queryExecutor) return { error: 'Knowledge system not initialized' };
      return await queryExecutor.execute(args);
    },
  };

  const fileBackKnowledge: Tool = {
    name: 'file_back_knowledge',
    description: '将高质量知识回答存回知识库 Wiki。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '回填文章的标题' },
        content: { type: 'string', description: '要归档的内容（Markdown）' },
        topics: { type: 'array', items: { type: 'string' }, description: '主题标签' },
        source_queries: { type: 'array', items: { type: 'string' }, description: '触发问题列表' },
      },
      required: ['title', 'content', 'source_queries'],
    },
    async execute(args) {
      if (!fileBackExecutor) return { error: 'Knowledge system not initialized' };
      return await fileBackExecutor.execute(args);
    },
  };

  return [queryKnowledge, fileBackKnowledge];
}

export function createExecutor(registry: ToolRegistry): BuiltinExecutor {
  return {
    async execute(args: any, ctx: ToolContext) {
      // simple mode: 直接执行 query_knowledge
      const query = args?.query || args?.name || '';
      if (!query) return { error: 'Missing query parameter' };
      return registry.execute('query_knowledge', { query, max_results: args?.max_results || 3 });
    },
  };
}

export function registerTools(
  registry: ToolRegistry,
  queryExecutor: QueryKnowledgeExecutor | null,
  fileBackExecutor: FileBackExecutor | null,
): void {
  for (const tool of createKnowledgeTools(queryExecutor, fileBackExecutor)) {
    registry.register(tool);
  }
}
