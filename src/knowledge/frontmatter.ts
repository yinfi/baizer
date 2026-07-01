// src/knowledge/frontmatter.ts
// 通过 Obsidian frontmatter 管理知识编译状态，替代外部 registry

import { App, TFile } from 'obsidian';
import { extractFrontmatter } from './ontology';

export type KnowledgeStatus = 'pending' | 'processing' | 'done' | 'failed';
export type KnowledgePendingReason = 'new' | 'content_changed' | 'manual' | 'legacy' | 'interrupted';

/** frontmatter 中的知识编译字段 */
export interface KnowledgeFrontmatter {
  knowledge_status?: KnowledgeStatus;
  knowledge_source_id?: string;
  knowledge_compiled_at?: string;
  knowledge_summary?: string;
  knowledge_error?: string;
  knowledge_pending_reason?: KnowledgePendingReason;
}

/** 生成 ksrc_xxx 格式的 source ID */
export function generateSourceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 12; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ksrc_${suffix}`;
}

/** 通过 metadataCache 读取文件的 knowledge_status */
export function getKnowledgeStatus(app: App, file: TFile): KnowledgeStatus | null {
  const cache = app.metadataCache.getFileCache(file);
  const status = cache?.frontmatter?.knowledge_status;
  if (!status) return null;
  if (['pending', 'processing', 'done', 'failed'].includes(status)) {
    return status as KnowledgeStatus;
  }
  return null;
}

/** 通过 metadataCache 读取文件的 knowledge_source_id */
export function getSourceId(app: App, file: TFile): string | null {
  const cache = app.metadataCache.getFileCache(file);
  return cache?.frontmatter?.knowledge_source_id ?? null;
}

export function getPendingReason(app: App, file: TFile): KnowledgePendingReason | null {
  const cache = app.metadataCache.getFileCache(file);
  const reason = cache?.frontmatter?.knowledge_pending_reason;
  if (['new', 'content_changed', 'manual', 'legacy', 'interrupted'].includes(reason)) {
    return reason as KnowledgePendingReason;
  }
  return null;
}

type KnowledgeStatusExtra = {
  source_id?: string;
  compiled_at?: string;
  summary?: string;
  error?: string;
  pending_reason?: KnowledgePendingReason;
};

/**
 * 判断本次写入是否会真正改变 frontmatter。
 * 若所有目标字段已等于期望值，返回 true（可跳过写盘，避免无谓 touch mtime，
 * 从而不触发 Remotely Save 等同步工具的假改动）。
 * 只用 metadataCache 里已解析的值比对；cache 缺失时保守返回 false（照常写）。
 */
function isKnowledgeStatusNoop(
  app: App,
  file: TFile,
  status: KnowledgeStatus,
  extra?: KnowledgeStatusExtra
): boolean {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return false;

  if (fm.knowledge_status !== status) return false;
  if (extra?.source_id && fm.knowledge_source_id !== extra.source_id) return false;
  if (extra?.compiled_at && fm.knowledge_compiled_at !== extra.compiled_at) return false;
  if (extra?.summary && fm.knowledge_summary !== extra.summary) return false;

  // pending_reason：仅 pending 状态下保留，其余状态应被删除
  const desiredReason = status === 'pending' && extra?.pending_reason
    ? extra.pending_reason
    : undefined;
  if ((fm.knowledge_pending_reason ?? undefined) !== desiredReason) return false;

  // error：失败时写入；done/pending 时清除；processing 时保持原值
  if (extra?.error) {
    if (fm.knowledge_error !== extra.error) return false;
  } else if (status === 'done' || status === 'pending') {
    if (fm.knowledge_error !== undefined) return false;
  }

  return true;
}

/**
 * 写入/更新 frontmatter 中的知识编译字段
 * 使用 Obsidian 原生 processFrontMatter API，安全地合并字段
 * 如果现有 frontmatter 解析失败（如含非法 YAML），先修复再写入
 *
 * 幂等：若所有字段已是目标值，直接跳过，避免无谓写盘触发外部同步。
 */
export async function setKnowledgeStatus(
  app: App,
  file: TFile,
  status: KnowledgeStatus,
  extra?: KnowledgeStatusExtra
): Promise<void> {
  // 幂等短路：字段已是目标值则不写盘，杜绝相同内容重复 touch 文件
  if (isKnowledgeStatusNoop(app, file, status, extra)) return;

  try {
    await app.fileManager.processFrontMatter(file, (fm: any) => {
      fm.knowledge_status = status;

      if (extra?.source_id) fm.knowledge_source_id = extra.source_id;
      if (extra?.compiled_at) fm.knowledge_compiled_at = extra.compiled_at;
      if (extra?.summary) fm.knowledge_summary = extra.summary;
      if (status === 'pending' && extra?.pending_reason) {
        fm.knowledge_pending_reason = extra.pending_reason;
      } else {
        delete fm.knowledge_pending_reason;
      }

      // error 字段：失败时写入，成功时清除
      if (extra?.error) {
        fm.knowledge_error = extra.error;
      } else if (status === 'done' || status === 'pending') {
        delete fm.knowledge_error;
      }
    });
  } catch (e) {
    // frontmatter 解析失败（如含非法 YAML），回退到手动修复
    console.warn(`[KnowledgeFrontmatter] processFrontMatter failed for ${file.path}, fixing YAML...`, e);
    await fixAndSetFrontmatter(app, file, status, extra);
  }
}

/**
 * 回退方案：当 processFrontMatter 因 YAML 解析失败时，
 * 手动修复 frontmatter 中含冒号等特殊字符的值（加引号包裹），
 * 然后追加 knowledge 字段
 */
async function fixAndSetFrontmatter(
  app: App,
  file: TFile,
  status: KnowledgeStatus,
  extra?: {
    source_id?: string;
    compiled_at?: string;
    summary?: string;
    error?: string;
    pending_reason?: KnowledgePendingReason;
  }
): Promise<void> {
  let content = await app.vault.read(file);
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (fmMatch) {
    // 修复含冒号的值：给 "key: value: more" 格式的行加引号
    const fixedFm = fmMatch[1].replace(
      /^(\s*\w[\w\s]*?):\s*(.+:.+)$/gm,
      (_, key, val) => `${key}: "${val.replace(/"/g, '\\"')}"`
    );
    content = content.replace(fmMatch[1], fixedFm);
  }

  // 构建要追加的 knowledge 字段
  const fields: string[] = [`knowledge_status: ${status}`];
  if (extra?.source_id) fields.push(`knowledge_source_id: "${extra.source_id}"`);
  if (extra?.compiled_at) fields.push(`knowledge_compiled_at: "${extra.compiled_at}"`);
  if (extra?.summary) fields.push(`knowledge_summary: "${extra.summary}"`);
  if (extra?.error) fields.push(`knowledge_error: "${extra.error.replace(/"/g, '\\"')}"`);
  if (status === 'pending' && extra?.pending_reason) {
    fields.push(`knowledge_pending_reason: "${extra.pending_reason}"`);
  }

  if (fmMatch) {
    // 在现有 frontmatter 末尾追加
    const insertPoint = content.indexOf('\n---', 4);
    content = content.slice(0, insertPoint) + '\n' + fields.join('\n') + content.slice(insertPoint);
  } else {
    // 没有 frontmatter，创建新的
    content = '---\n' + fields.join('\n') + '\n---\n' + content;
  }

  await app.vault.modify(file, content);
}

/**
 * 确保文件有 knowledge_source_id，没有则生成并写入
 * 返回 source_id
 */
export async function ensureSourceId(app: App, file: TFile): Promise<string> {
  const existing = getSourceId(app, file);
  if (existing) return existing;

  const newId = generateSourceId();
  try {
    await app.fileManager.processFrontMatter(file, (fm: any) => {
      fm.knowledge_source_id = newId;
    });
  } catch {
    // YAML 解析失败，用回退方案
    await fixAndSetFrontmatter(app, file, 'pending', { source_id: newId });
  }
  return newId;
}

/**
 * 查询指定状态的所有文件
 * 可选限定在特定文件夹内
 */
export function getFilesByKnowledgeStatus(
  app: App,
  status: KnowledgeStatus,
  folders?: string[]
): TFile[] {
  const results: TFile[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    if (folders && folders.length > 0) {
      const inFolder = folders.some(f => {
        const normalized = f.endsWith('/') ? f : f + '/';
        return file.path.startsWith(normalized);
      });
      if (!inFolder) continue;
    }

    const cache = app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.knowledge_status === status) {
      results.push(file);
    }
  }
  return results;
}

/**
 * 查询监听目录中未注册的文件（无 knowledge_status 字段）
 */
export function getUnregisteredFiles(
  app: App,
  watchedFolders: string[],
  wikiFolder: string
): TFile[] {
  if (watchedFolders.length === 0) return [];

  const results: TFile[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    // 排除 wiki 目录
    if (file.path.startsWith(wikiFolder + '/')) continue;

    // 必须在监听目录内
    const inWatched = watchedFolders.some(f => {
      const normalized = f.endsWith('/') ? f : f + '/';
      return file.path.startsWith(normalized);
    });
    if (!inWatched) continue;

    // 没有 knowledge_status = 未注册
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter?.knowledge_status) {
      results.push(file);
    }
  }
  return results;
}

/**
 * 读取 summary 文件的 frontmatter 字段（用于 stale 检测）
 * 返回 schema_hash, content_hash, compiled_at，或 null（文件不存在/无 frontmatter）
 */
export function getSummaryFrontmatter(
  app: App,
  summaryPath: string
): { schema_hash?: string; content_hash?: string; compiled_at?: string } | null {
  const file = app.vault.getAbstractFileByPath(summaryPath);
  if (!file || !(file instanceof TFile)) return null;

  const cache = app.metadataCache.getFileCache(file);
  if (!cache?.frontmatter) return null;

  return {
    schema_hash: cache.frontmatter.schema_hash || undefined,
    content_hash: cache.frontmatter.content_hash || undefined,
    compiled_at: cache.frontmatter.compiled_at || undefined,
  };
}

export async function readSummaryFrontmatter(
  app: App,
  summaryPath: string
): Promise<{ schema_hash?: string; content_hash?: string; compiled_at?: string } | null> {
  const cached = getSummaryFrontmatter(app, summaryPath);
  if (cached?.schema_hash && cached?.content_hash && cached?.compiled_at) {
    return cached;
  }

  const file = app.vault.getAbstractFileByPath(summaryPath);
  if (!file || !(file instanceof TFile)) return cached;

  try {
    const content = await app.vault.read(file);
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) return cached;

    return {
      schema_hash: cached?.schema_hash || frontmatter.schema_hash || undefined,
      content_hash: cached?.content_hash || frontmatter.content_hash || undefined,
      compiled_at: cached?.compiled_at || frontmatter.compiled_at || undefined,
    };
  } catch {
    return cached;
  }
}
