import { App } from 'obsidian';

export const OPERATION_AUDIT_LOG_DIR = '.obsidian/obsidian-cli';
export const OPERATION_AUDIT_LOG_PATH = `${OPERATION_AUDIT_LOG_DIR}/operations.json`;

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
}

export interface OperationRecordInput {
  action: string;
  target: string;
  provider?: string;
  model?: string;
  approvalSource: 'user-click' | 'direct-write';
  previousContentHash?: string;
  undoable: boolean;
  id?: string;
  timestamp?: number;
}

interface OperationAuditFile {
  version: 1;
  operations: OperationRecord[];
}

interface OperationAuditLogOptions {
  maxRecords?: number;
  path?: string;
}

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export class OperationAuditLog {
  private readonly maxRecords: number;
  private readonly path: string;
  private readonly dir: string;

  constructor(private readonly app: App, options: OperationAuditLogOptions = {}) {
    this.maxRecords = options.maxRecords ?? 200;
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
    const operations = [record, ...file.operations]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.maxRecords);

    await this.writeFile({
      version: 1,
      operations,
    });

    return this.cloneRecord(record);
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
    };
  }

  private async readFile(): Promise<OperationAuditFile> {
    const adapter = this.getAdapter();

    try {
      if (!await adapter.exists(this.path)) {
        return this.emptyFile();
      }

      const raw = await adapter.read(this.path);
      const parsed = JSON.parse(raw);
      if (!this.isOperationAuditFile(parsed)) {
        return this.emptyFile();
      }

      return {
        version: 1,
        operations: parsed.operations.map((record: OperationRecord) => this.cloneRecord(record)),
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
    return { version: 1, operations: [] };
  }

  private isOperationAuditFile(value: any): value is OperationAuditFile {
    return value
      && value.version === 1
      && Array.isArray(value.operations)
      && value.operations.every((record: any) => (
        typeof record?.id === 'string'
        && typeof record.action === 'string'
        && typeof record.target === 'string'
        && typeof record.timestamp === 'number'
        && (record.provider === undefined || typeof record.provider === 'string')
        && (record.model === undefined || typeof record.model === 'string')
        && (record.approvalSource === 'user-click' || record.approvalSource === 'direct-write')
        && (record.previousContentHash === undefined || typeof record.previousContentHash === 'string')
        && typeof record.undoable === 'boolean'
      ));
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
