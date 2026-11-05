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
    executionMode: 'parallel',
    risk: 'read',
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
    executionMode: 'sequential',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '回填文章的标题' },
        content: { type: 'string', description: '要归档的内容（Markdown）' },
        topics: { type: 'array', items: { type: 'string', description: '单个用于归类文章的主题标签' }, description: '主题标签' },
        source_queries: { type: 'array', items: { type: 'string', description: '产生该知识回答的一条原始用户问题' }, description: '触发问题列表' },
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

/** 外部工具入参（模型生成）的窄化：只认对象，字段按类型校验。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createExecutor(registry: ToolRegistry): BuiltinExecutor {
  return {
    async execute(args: unknown, ctx: ToolContext) {
      // simple mode: 直接执行 query_knowledge
      const rawQuery = isRecord(args) ? args.query ?? args.name : undefined;
      const query = typeof rawQuery === 'string' ? rawQuery : '';
      if (!query) return { error: 'Missing query parameter' };
      const rawMaxResults = isRecord(args) ? args.max_results : undefined;
      // 与旧实现 `args?.max_results || 3` 对齐：0/NaN/非数字一律回退 3。
      const maxResults = typeof rawMaxResults === 'number' && rawMaxResults ? rawMaxResults : 3;
      return registry.execute('query_knowledge', { query, max_results: maxResults });
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
