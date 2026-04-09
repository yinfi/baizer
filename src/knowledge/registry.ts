// src/knowledge/registry.ts

import {
  KnowledgeRegistry,
  KnowledgeRegistryRecord,
  KnowledgeRegistryStatus,
  KNOWLEDGE_REGISTRY_PATH,
  isValidTransition
} from './types';

/**
 * 知识注册表管理器
 * 跟踪哪些笔记已进入知识管线及其当前状态
 * 存储位置：.obsidian/obsidian-cli/knowledge-registry.json
 */
export class KnowledgeRegistryManager {
  private registry: KnowledgeRegistry = { schema_version: 1, records: {} };
  private pathIndex: Map<string, string> = new Map();

  constructor(private adapter: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
  }) {}

  static generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 12; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `ksrc_${suffix}`;
  }

  async load(): Promise<void> {
    try {
      if (await this.adapter.exists(KNOWLEDGE_REGISTRY_PATH)) {
        const raw = await this.adapter.read(KNOWLEDGE_REGISTRY_PATH);
        this.registry = JSON.parse(raw);
      } else {
        this.registry = { schema_version: 1, records: {} };
      }
    } catch {
      this.registry = { schema_version: 1, records: {} };
    }
    this.rebuildPathIndex();
  }

  async save(): Promise<void> {
    const dir = KNOWLEDGE_REGISTRY_PATH.split('/').slice(0, -1).join('/');
    try { await this.adapter.mkdir(dir); } catch { /* already exists */ }
    await this.adapter.write(KNOWLEDGE_REGISTRY_PATH, JSON.stringify(this.registry, null, 2));
  }

  private rebuildPathIndex(): void {
    this.pathIndex.clear();
    for (const [id, record] of Object.entries(this.registry.records)) {
      this.pathIndex.set(record.path, id);
    }
  }

  register(path: string): KnowledgeRegistryRecord {
    const existing = this.findByPath(path);
    if (existing) return existing;

    const id = KnowledgeRegistryManager.generateId();
    if (this.registry.records[id]) {
      throw new Error(`Registry ID collision: ${id}`);
    }

    const now = new Date().toISOString();
    const record: KnowledgeRegistryRecord = {
      id,
      path,
      status: 'pending',
      created_at: now,
      updated_at: now,
      summary_path: null,
      error: null
    };

    this.registry.records[id] = record;
    this.pathIndex.set(path, id);
    return record;
  }

  transition(id: string, to: KnowledgeRegistryStatus, error?: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    if (!isValidTransition(record.status, to)) {
      throw new Error(`Invalid transition: ${record.status} -> ${to} for ${id}`);
    }
    record.status = to;
    record.updated_at = new Date().toISOString();
    record.error = error ?? null;
  }

  setSummaryPath(id: string, summaryPath: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    record.summary_path = summaryPath;
    record.updated_at = new Date().toISOString();
  }

  getRecord(id: string): KnowledgeRegistryRecord | null {
    return this.registry.records[id] ?? null;
  }

  findByPath(path: string): KnowledgeRegistryRecord | null {
    const id = this.pathIndex.get(path);
    if (!id) return null;
    return this.registry.records[id] ?? null;
  }

  getAllRecords(): Record<string, KnowledgeRegistryRecord> {
    return { ...this.registry.records };
  }

  getByStatus(status: KnowledgeRegistryStatus): KnowledgeRegistryRecord[] {
    return Object.values(this.registry.records).filter(r => r.status === status);
  }

  updatePath(id: string, newPath: string): void {
    const record = this.registry.records[id];
    if (!record) throw new Error(`Record not found: ${id}`);
    this.pathIndex.delete(record.path);
    record.path = newPath;
    record.updated_at = new Date().toISOString();
    this.pathIndex.set(newPath, id);
  }

  /** 插件重启时，processing 状态重置为 pending */
  resetProcessingOnStartup(): void {
    for (const record of Object.values(this.registry.records)) {
      if (record.status === 'processing') {
        record.status = 'pending';
        record.updated_at = new Date().toISOString();
      }
    }
  }

  /** 获取所有已完成编译且有 summary 的记录 */
  getCompletedRecords(): KnowledgeRegistryRecord[] {
    return Object.values(this.registry.records)
      .filter(r => r.status === 'done' && r.summary_path);
  }
}