import { App } from 'obsidian';

import { PLUGIN_DATA_DIR } from '../mcp/types';

export const OPERATION_AUDIT_LOG_DIR = PLUGIN_DATA_DIR;
export const OPERATION_AUDIT_LOG_PATH = `${OPERATION_AUDIT_LOG_DIR}/operations.json`;

/**
 * 操作记录的语义：真正落盘的成功，还是「尝试过但失败/中断」。
 *
 * 旧文件没有这个字段（只有成功记录），读取时按 `succeeded` 处理。
 */
export type OperationOutcome = 'succeeded' | 'attempt-failed';

export interface OperationRecord {
  id: string;
  action: string;
  target: string;
  timestamp: number;
  provider?: string;
  model?: string;
  approvalSource: 'user-click' | 'direct-write';
  previousContentHash?: string;
  undoable: boolean;
  /** 缺省视为 succeeded（旧版本只会在成功时写记录）。 */
  outcome?: OperationOutcome;
}

export interface OperationRecordInput {
  action: string;
  target: string;
  provider?: string;
  model?: string;
  approvalSource: 'user-click' | 'direct-write';
  previousContentHash?: string;
  undoable: boolean;
  outcome?: OperationOutcome;
  id?: string;
  timestamp?: number;
}

/**
 * 审批请求的持久化执行状态。
 *
 * 与 `OperationRecord` 分开保存的原因：一次请求的生命周期是
 * 「开始执行 → 成功 / 失败 / 进程中断」，而操作记录只描述「写过一次盘」。
 * 只有持久化请求状态，崩溃/重启之后才能区分：
 * - `succeeded`：确实写成功了 → 只读回看，绝不重放；
 * - `attempt-failed`：尝试明确失败 → 可安全重试；
 * - `attempting`：开始执行后没有落终态（进程中断）→ 结果未知，不能直接重试。
 */
export type ApprovalRequestState = 'attempting' | 'succeeded' | 'attempt-failed';

export interface ApprovalRequestRecord {
  id: string;
  action: string;
  target: string;
  state: ApprovalRequestState;
  /** 首次登记时间（= 开始执行时间）。 */
  timestamp: number;
  /** 最近一次状态更新时间。 */
  updatedAt: number;
}

export interface ApprovalRequestStateInput {
  id: string;
  action: string;
  target: string;
  outcome: OperationOutcome;
  provider?: string;
  model?: string;
  approvalSource?: 'user-click' | 'direct-write';
  previousContentHash?: string;
  undoable?: boolean;
  timestamp?: number;
}

interface OperationAuditFile {
  version: 1;
  operations: OperationRecord[];
  /**
   * 审批请求执行状态。字段是可选的：旧版本写出的文件没有它，按空处理。
   * 保持 version 1（纯增量字段），旧版本读到新文件也不会丢弃整个审计历史。
   */
  requests?: ApprovalRequestRecord[];
  /**
   * 被条数上限淘汰的最晚请求时间。用于区分「从无记录（从未执行）」
   * 与「记录已过期（无法确认，不能放行重试）」。
   */
  requestsPrunedBefore?: number;
}

export interface OperationAuditLogOptions {
  maxRecords?: number;
  /** 请求状态条数上限，与操作记录分开计。 */
  maxRequests?: number;
  path?: string;
}

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_REQUESTS = 500;

export class OperationAuditLog {
  private readonly maxRecords: number;
  private readonly maxRequests: number;
  private readonly path: string;
  private readonly dir: string;

  constructor(private readonly app: App, options: OperationAuditLogOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.path = options.path ?? OPERATION_AUDIT_LOG_PATH;
    this.dir = this.path.split('/').slice(0, -1).join('/');
  }

  async list(): Promise<OperationRecord[]> {
    const file = await this.readFile();
    return this.sortAndClone(file.operations);
  }

  async record(input: OperationRecordInput): Promise<OperationRecord> {
    const file = await this.readFile();
    const record = this.createRecord(input);
    const operations = this.trimOperations([record, ...file.operations]);

    await this.writeFile({
      ...file,
      operations,
    });

    return this.cloneRecord(record);
  }

  /**
   * 执行前登记「这次请求开始执行了」。
   *
   * 必须在调用工具之前落盘：否则进程在工具执行中途被杀，重启后没有任何线索，
   * 只能把「可能已经写成」误判成「从未执行」。
   */
  async beginRequest(input: { id: string; action: string; target: string; timestamp?: number }): Promise<void> {
    const file = await this.readFile();
    const now = input.timestamp ?? Date.now();
    // 重试会再次 begin：保留首次登记时间，重试不改变「这条请求什么时候开始过」。
    const previous = (file.requests ?? []).find(item => item.id === input.id);
    const requests = this.upsertRequest(file.requests, {
      id: input.id,
      action: input.action,
      target: input.target,
      state: 'attempting',
      timestamp: previous?.timestamp ?? now,
      updatedAt: now,
    });
    const trimmed = this.trimRequests(requests, file.requestsPrunedBefore);

    await this.writeFile({
      ...file,
      requests: trimmed.requests,
      requestsPrunedBefore: trimmed.prunedBefore,
    });
  }

  /**
   * 执行结束：一次写入同时落「操作记录」与「请求状态」。
   *
   * 成功写 `succeeded`，明确失败写 `attempt-failed`；两者都必须留痕，
   * 否则重启后「失败」会被读成「从未执行」，「成功」会被读成「可重试」。
   */
  async finishRequest(input: ApprovalRequestStateInput): Promise<OperationRecord> {
    const file = await this.readFile();
    const now = input.timestamp ?? Date.now();
    const record = this.createRecord({
      ...input,
      approvalSource: input.approvalSource ?? 'user-click',
      undoable: input.undoable ?? true,
      timestamp: now,
    });
    const previous = (file.requests ?? []).find(item => item.id === input.id);
    const requests = this.upsertRequest(file.requests, {
      id: input.id,
      action: input.action,
      target: input.target,
      state: input.outcome,
      timestamp: previous?.timestamp ?? now,
      updatedAt: now,
    });
    const trimmed = this.trimRequests(requests, file.requestsPrunedBefore);

    await this.writeFile({
      version: 1,
      operations: this.trimOperations([record, ...file.operations]),
      requests: trimmed.requests,
      requestsPrunedBefore: trimmed.prunedBefore,
    });

    return this.cloneRecord(record);
  }

  /** 查一条审批请求的持久化执行状态；没有记录返回 undefined。 */
  async getRequestState(id: string): Promise<ApprovalRequestRecord | undefined> {
    const file = await this.readFile();
    const record = (file.requests ?? []).find(item => item.id === id);
    return record ? { ...record } : undefined;
  }

  /** 被条数上限淘汰的最晚请求时间；0 表示从未淘汰过请求状态。 */
  async getPrunedRequestBefore(): Promise<number> {
    const file = await this.readFile();
    return file.requestsPrunedBefore ?? 0;
  }

  private createRecord(input: OperationRecordInput): OperationRecord {
    const timestamp = input.timestamp ?? Date.now();
    return {
      id: input.id ?? `${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
      action: input.action,
      target: input.target,
      timestamp,
      provider: input.provider,
      model: input.model,
      approvalSource: input.approvalSource,
      previousContentHash: input.previousContentHash,
      undoable: input.undoable,
      outcome: input.outcome ?? 'succeeded',
    };
  }

  /** 按时间倒序保留最新 maxRecords 条。 */
  private trimOperations(records: OperationRecord[]): OperationRecord[] {
    return [...records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.maxRecords);
  }

  /**
   * 请求状态按时间倒序保留最新 maxRequests 条，并记下被淘汰的最晚时间。
   * 水位只增不减，保证「记录已过期」不会被后续写入抹掉。
   */
  private trimRequests(
    records: ApprovalRequestRecord[],
    prunedBefore: number | undefined,
  ): { requests: ApprovalRequestRecord[]; prunedBefore: number } {
    const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const keep = sorted.slice(0, this.maxRequests);
    const removed = sorted.slice(this.maxRequests);
    let watermark = prunedBefore ?? 0;
    for (const record of removed) {
      watermark = Math.max(watermark, record.timestamp);
    }
    return { requests: keep, prunedBefore: watermark };
  }

  private upsertRequest(
    requests: ApprovalRequestRecord[] | undefined,
    next: ApprovalRequestRecord,
  ): ApprovalRequestRecord[] {
    return [next, ...(requests ?? []).filter(item => item.id !== next.id)];
  }

  private async readFile(): Promise<OperationAuditFile> {
    const adapter = this.getAdapter();

    try {
      if (!await adapter.exists(this.path)) {
        return this.emptyFile();
      }

      const raw = await adapter.read(this.path);
      const parsed: unknown = JSON.parse(raw);
      if (!isRecordObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.operations)) {
        return this.emptyFile();
      }

      // 逐条过滤而非「一条坏就整份丢弃」：旧数据/手改残留不应抹掉整段审计历史。
      const operations: unknown[] = parsed.operations;
      const requests: unknown[] | undefined = Array.isArray(parsed.requests) ? parsed.requests : undefined;
      return {
        version: 1,
        operations: operations
          .filter((record): record is OperationRecord => this.isOperationRecord(record))
          .map((record) => this.cloneRecord(record)),
        requests: requests
          ? requests
            .filter((record): record is ApprovalRequestRecord => this.isRequestRecord(record))
            .map((record) => ({ ...record }))
          : [],
        requestsPrunedBefore: typeof parsed.requestsPrunedBefore === 'number'
          ? parsed.requestsPrunedBefore
          : 0,
      };
    } catch {
      return this.emptyFile();
    }
  }

  private async writeFile(file: OperationAuditFile): Promise<void> {
    await this.ensureDirectory(this.dir);
    await this.getAdapter().write(this.path, JSON.stringify(file, null, 2));
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!path) return;

    const adapter = this.getAdapter();
    const parts = path.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await adapter.exists(current)) {
        await adapter.mkdir(current);
      }
    }
  }

  private getAdapter(): VaultAdapter {
    return this.app.vault.adapter as unknown as VaultAdapter;
  }

  private emptyFile(): OperationAuditFile {
    return { version: 1, operations: [], requests: [], requestsPrunedBefore: 0 };
  }

  private isOperationRecord(record: unknown): record is OperationRecord {
    return isRecordObject(record)
      && typeof record.id === 'string'
      && typeof record.action === 'string'
      && typeof record.target === 'string'
      && typeof record.timestamp === 'number'
      && (record.provider === undefined || typeof record.provider === 'string')
      && (record.model === undefined || typeof record.model === 'string')
      && (record.approvalSource === 'user-click' || record.approvalSource === 'direct-write')
      && (record.previousContentHash === undefined || typeof record.previousContentHash === 'string')
      && typeof record.undoable === 'boolean'
      && (record.outcome === undefined || record.outcome === 'succeeded' || record.outcome === 'attempt-failed');
  }

  private isRequestRecord(record: unknown): record is ApprovalRequestRecord {
    return isRecordObject(record)
      && typeof record.id === 'string'
      && typeof record.action === 'string'
      && typeof record.target === 'string'
      && (record.state === 'attempting' || record.state === 'succeeded' || record.state === 'attempt-failed')
      && typeof record.timestamp === 'number'
      && typeof record.updatedAt === 'number';
  }

  private sortAndClone(records: OperationRecord[]): OperationRecord[] {
    return [...records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((record) => this.cloneRecord(record));
  }

  private cloneRecord(record: OperationRecord): OperationRecord {
    return { ...record };
  }
}
