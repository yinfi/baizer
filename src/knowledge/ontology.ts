// src/knowledge/ontology.ts
// Ontology schema 解析、验证、发现 — 纯函数模块

import { OntologySchema, OntologyCategory, OntologyEntityType } from './types';

// ===== 窄化工具 =====
// frontmatter / AI 返回值都是不可信输入。这里集中提供 unknown 安全读取原语，
// 避免在调用点使用 any 或 `as` 断言。

/** 判断未知值是否为普通对象（排除 null 与数组） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取字符串字段；非字符串返回 undefined */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 读取非空字符串字段；空串与非字符串返回 undefined（对齐旧 `value || undefined` 语义） */
export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 读取字符串数组字段；非数组返回 []，元素按 String() 归一化 */
export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) result.push(String(item));
  return result;
}

/** 提取异常消息：Error 取 message，类 Error 对象取字符串 message，其余 undefined */
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/**
 * 从原始 markdown 内容中提取 frontmatter 对象
 * 不依赖 Obsidian metadataCache，自行解析 YAML
 */
export function extractFrontmatter(rawContent: string): Record<string, unknown> | null {
  if (!rawContent.startsWith('---')) return null;
  const endIdx = rawContent.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = rawContent.substring(4, endIdx);
  try {
    return parseSimpleYaml(yamlBlock);
  } catch {
    return null;
  }
}

/**
 * 简易 YAML 解析器 — 只处理 ontology schema 用到的结构：
 * 标量值、对象数组（- name: / description:）
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    // 顶层 key: value
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    const inlineVal = kvMatch[2].trim();

    // 值是数组（下一行以 - 开头）
    if (!inlineVal && i + 1 < lines.length && lines[i + 1].match(/^\s+-/)) {
      const arr: unknown[] = [];
      i++;
      while (i < lines.length) {
        const arrLine = lines[i];
        // 数组项开始：  - key: val
        const itemMatch = arrLine.match(/^\s+-\s+(\w[\w_]*)\s*:\s*"?(.*?)"?\s*$/);
        if (itemMatch) {
          const obj: Record<string, string> = {};
          obj[itemMatch[1]] = itemMatch[2];
          i++;
          // 读取同一对象的后续属性（缩进更深，不以 - 开头）
          while (i < lines.length) {
            const propLine = lines[i];
            const propMatch = propLine.match(/^\s{4,}(\w[\w_]*)\s*:\s*"?(.*?)"?\s*$/);
            if (propMatch && !propLine.match(/^\s+-/)) {
              obj[propMatch[1]] = propMatch[2];
              i++;
            } else {
              break;
            }
          }
          arr.push(obj);
        } else if (arrLine.match(/^\s+-\s+"?(.*?)"?\s*$/)) {
          // 简单字符串数组项
          arr.push(arrLine.match(/^\s+-\s+"?(.*?)"?\s*$/)![1]);
          i++;
        } else {
          break; // 不再是数组项
        }
      }
      result[key] = arr;
    } else {
      // 标量值
      const scalar = inlineVal.replace(/^"(.*)"$/, '$1');
      let val: string | boolean | number = scalar;
      if (scalar === 'true') val = true;
      else if (scalar === 'false') val = false;
      else if (/^\d+$/.test(scalar)) val = parseInt(scalar, 10);
      result[key] = val;
      i++;
    }
  }
  return result;
}

/**
 * 从 frontmatter 对象解析 OntologySchema
 * @returns 解析成功返回 schema，失败返回 null
 */
export function parseOntologySchema(frontmatter: unknown): OntologySchema | null {
  if (!isRecord(frontmatter)) return null;
  if (frontmatter.knowledge_artifact_type !== 'ontology_schema') return null;

  const version = typeof frontmatter.version === 'number' ? frontmatter.version : 1;
  const categories = parseCategories(frontmatter.categories);
  const entityTypes = parseEntityTypes(frontmatter.entity_types);

  // 至少需要 categories 或 entity_types 之一非空
  if (categories.length === 0 && entityTypes.length === 0) return null;

  return { version, categories, entity_types: entityTypes };
}

function parseCategories(raw: unknown): OntologyCategory[] {
  if (!Array.isArray(raw)) return [];
  const result: OntologyCategory[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = item.name;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    const description = item.description;
    result.push({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
    });
  }
  return result;
}

function parseEntityTypes(raw: unknown): OntologyEntityType[] {
  if (!Array.isArray(raw)) return [];
  const result: OntologyEntityType[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = item.name;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    const description = item.description;
    result.push({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
    });
  }
  return result;
}

/**
 * 验证 schema 结构完整性
 * @returns 错误消息数组，空数组表示通过
 */
export function validateOntologySchema(schema: OntologySchema): string[] {
  const errors: string[] = [];

  if (schema.categories.length === 0 && schema.entity_types.length === 0) {
    errors.push('Schema must have at least one category or entity_type');
  }

  // 检查 category name 唯一性
  const catNames = new Set<string>();
  for (const c of schema.categories) {
    if (catNames.has(c.name)) {
      errors.push(`Duplicate category name: "${c.name}"`);
    }
    catNames.add(c.name);
  }

  // 检查 entity_type name 唯一性
  const etNames = new Set<string>();
  for (const e of schema.entity_types) {
    if (etNames.has(e.name)) {
      errors.push(`Duplicate entity_type name: "${e.name}"`);
    }
    etNames.add(e.name);
  }

  return errors;
}

/**
 * 计算 schema 内容的 hash（前 8 位 hex）
 * 用于 summary frontmatter 的 schema_hash 字段，检测 schema drift
 */
export function computeSchemaHash(rawContent: string): string {
  // 简单但确定性的 hash：djb2 算法，输出 8 位 hex
  let hash = 5381;
  for (let i = 0; i < rawContent.length; i++) {
    hash = ((hash << 5) + hash + rawContent.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 构建 ontology discovery prompt
 * 从已有编译结果的聚合统计中，让 AI 生成 schema 草稿
 */
export function buildDiscoveryPrompt(stats: {
  totalCount: number;
  topTopics: { topic: string; count: number }[];
  topConcepts: { concept: string; count: number }[];
  recentClaims: string[];
}): string {
  let prompt = `你是一个知识本体分析师。以下是从 ${stats.totalCount} 篇文章中提取的聚合统计：\n\n`;

  prompt += '## 高频主题（出现 3 次以上）\n';
  for (const t of stats.topTopics) {
    prompt += `- "${t.topic}"（${t.count} 篇）\n`;
  }

  prompt += '\n## 高频概念（出现 2 次以上）\n';
  for (const c of stats.topConcepts) {
    prompt += `- "${c.concept}"（${c.count} 篇）\n`;
  }

  prompt += '\n## 核心观点样本（最近 20 条）\n';
  for (const claim of stats.recentClaims.slice(0, 20)) {
    prompt += `- ${claim}\n`;
  }

  prompt += `
请分析以上数据，生成一个知识本体 schema，包含：

1. categories（知识类别，5-8 个）：每个类别有 name 和 description
2. entity_types（实体类型，3-5 个）：每个类型有 name 和 description

要求：
- 类别应该能覆盖上述主题和观点的 80% 以上
- 类别之间不重叠，每个知识条目应该只属于一个类别
- 用中文命名，description 用一句话说明判定标准

以 JSON 格式返回：
{"categories": [{"name": "...", "description": "..."}], "entity_types": [{"name": "...", "description": "..."}]}`;

  return prompt;
}

/**
 * 解析 discovery AI 返回的 JSON
 */
export function parseDiscoveryResponse(response: string): OntologySchema | null {
  try {
    const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();
    const parsed: unknown = JSON.parse(jsonStr);
    if (!isRecord(parsed)) return null;

    const categories = parseCategories(parsed.categories);
    const entityTypes = parseEntityTypes(parsed.entity_types);
    if (categories.length === 0 && entityTypes.length === 0) return null;

    return { version: 1, categories, entity_types: entityTypes };
  } catch {
    return null;
  }
}

/**
 * 生成 _ontology.md 文件内容
 */
export function buildOntologyFile(schema: OntologySchema): string {
  let fm = '---\n';
  fm += 'knowledge_generated: true\n';
  fm += 'knowledge_artifact_type: ontology_schema\n';
  fm += `version: ${schema.version}\n`;

  if (schema.categories.length > 0) {
    fm += 'categories:\n';
    for (const c of schema.categories) {
      fm += `  - name: "${c.name.replace(/"/g, '\\"')}"\n`;
      fm += `    description: "${c.description.replace(/"/g, '\\"')}"\n`;
    }
  }

  if (schema.entity_types.length > 0) {
    fm += 'entity_types:\n';
    for (const e of schema.entity_types) {
      fm += `  - name: "${e.name.replace(/"/g, '\\"')}"\n`;
      fm += `    description: "${e.description.replace(/"/g, '\\"')}"\n`;
    }
  }

  fm += '---\n';
  fm += '# Knowledge Ontology Schema\n\n';
  fm += '此文件定义知识提取的本体模型。编辑上方 frontmatter 中的 categories 和 entity_types 来定制提取规则。\n';
  fm += '编译器会自动读取此 schema 并按定义的类别提取知识。\n';

  return fm;
}
