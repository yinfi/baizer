// src/skills/builtin/knowledge/executor.ts

import { Tool, ToolArguments, ToolContext } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { BuiltinExecutor } from '../../skill-registry';
import { QueryKnowledgeExecutor } from '../../../knowledge/query';
import { FileBackExecutor } from '../../../knowledge/file-back';
import { asArray, asNumber, asString, prop } from '../../../utils/narrow';

/** 从工具入参里读取字符串数组；缺失返回 undefined，非字符串项按无效输入丢弃。 */
function asStringArray(value: unknown): string[] | undefined {
  const items = asArray(value);
  return items ? items.filter((item): item is string => typeof item === 'string') : undefined;
}

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
      const query = asString(prop(args, 'query'));
      if (!query) return { error: 'Missing query parameter' };
      const maxResults = asNumber(prop(args, 'max_results'));
      const result = await queryExecutor.execute(
        maxResults === undefined ? { query } : { query, max_results: maxResults },
      );
      // 展开成匿名对象字面量：QueryKnowledgeResult 是外部声明的窄接口，
      // 这里按工具结果的统一视图（Record<string, unknown>）收口，字段值原样保留。
      return { ...result };
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
      const title = asString(prop(args, 'title'));
      const content = asString(prop(args, 'content'));
      if (title === undefined || content === undefined) {
        return { error: 'Missing title or content parameter' };
      }
      return await fileBackExecutor.execute({
        title,
        content,
        source_queries: asStringArray(prop(args, 'source_queries')) ?? [],
        related_sources: asStringArray(prop(args, 'related_sources')) ?? [],
        topics: asStringArray(prop(args, 'topics')),
        source_url: asString(prop(args, 'source_url')),
      });
    },
  };

  return [queryKnowledge, fileBackKnowledge];
}

export function createExecutor(registry: ToolRegistry): BuiltinExecutor {
  return {
    async execute(args: ToolArguments, ctx: ToolContext) {
      // simple mode: 直接执行 query_knowledge
      const query = asString(prop(args, 'query')) || asString(prop(args, 'name')) || '';
      if (!query) return { error: 'Missing query parameter' };
      return registry.execute('query_knowledge', { query, max_results: asNumber(prop(args, 'max_results')) || 3 });
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
