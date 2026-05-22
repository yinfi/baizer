import { App } from 'obsidian';
import {
  createDefaultMemoryBank,
  DEFAULT_MEMORY_BANK_ID,
  MemoryBank,
  MemoryRecord,
} from './hindsight-types';

const MEMORY_DIR = '.obsidian/obsidian-cli-memory';
const BANKS_PATH = `${MEMORY_DIR}/banks.json`;
const MEMORIES_PATH = `${MEMORY_DIR}/memories.json`;
const MIGRATION_STATE_PATH = `${MEMORY_DIR}/migration-state.json`;

interface MigrationState {
  legacyProfileMigrated?: boolean;
  legacySummariesMigrated?: boolean;
}

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export class HindsightStore {
  private banks: MemoryBank[] = [];
  private memories: MemoryRecord[] = [];
  private migrationState: MigrationState = {};
  private initPromise: Promise<void>;

  constructor(private app: App) {
    this.initPromise = this.initialize();
  }

  async ready(): Promise<void> {
    await this.initPromise;
  }

  async listBanks(): Promise<MemoryBank[]> {
    await this.ready();
    return this.banks.map((bank) => ({
      ...bank,
      directives: [...bank.directives],
    }));
  }

  async listMemories(bankId: string = DEFAULT_MEMORY_BANK_ID): Promise<MemoryRecord[]> {
    await this.ready();
    return this.memories
      .filter((memory) => memory.bankId === bankId)
      .map((memory) => this.cloneMemory(memory));
  }

  async upsertMemory(memory: MemoryRecord): Promise<void> {
    await this.upsertMemories([memory]);
  }

  async upsertMemories(memories: MemoryRecord[]): Promise<void> {
    await this.ready();
    for (const memory of memories) {
      const index = this.memories.findIndex((item) => item.id === memory.id);
      const next = this.cloneMemory(memory);
      if (index >= 0) {
        this.memories[index] = next;
      } else {
        this.memories.push(next);
      }
    }
    await this.writeMemories();
  }

  async deleteMemories(predicate: (memory: MemoryRecord) => boolean): Promise<void> {
    await this.ready();
    const next = this.memories.filter((memory) => !predicate(memory));
    if (next.length === this.memories.length) return;
    this.memories = next;
    await this.writeMemories();
  }

  async clearMemories(bankId: string = DEFAULT_MEMORY_BANK_ID): Promise<void> {
    await this.deleteMemories((memory) => memory.bankId === bankId);
  }

  async markMemoriesAccessed(ids: string[], now: number = Date.now()): Promise<void> {
    await this.ready();
    const idSet = new Set(ids);
    if (idSet.size === 0) return;

    let changed = false;
    this.memories = this.memories.map((memory) => {
      if (!idSet.has(memory.id)) return memory;
      changed = true;
      return {
        ...memory,
        accessCount: memory.accessCount + 1,
        lastAccessedAt: now,
      };
    });

    if (changed) {
      await this.writeMemories();
    }
  }

  async getMigrationState(): Promise<MigrationState> {
    await this.ready();
    return { ...this.migrationState };
  }

  async updateMigrationState(update: Partial<MigrationState>): Promise<void> {
    await this.ready();
    this.migrationState = { ...this.migrationState, ...update };
    await this.ensureMemoryDir();
    await this.adapter().write(MIGRATION_STATE_PATH, JSON.stringify(this.migrationState, null, 2));
  }

  private async initialize(): Promise<void> {
    await this.ensureMemoryDir();
    this.banks = await this.readJson<MemoryBank[]>(BANKS_PATH, []);
    this.memories = await this.readJson<MemoryRecord[]>(MEMORIES_PATH, []);
    this.migrationState = await this.readJson<MigrationState>(MIGRATION_STATE_PATH, {});

    if (!this.banks.some((bank) => bank.id === DEFAULT_MEMORY_BANK_ID)) {
      this.banks.push(createDefaultMemoryBank());
      await this.adapter().write(BANKS_PATH, JSON.stringify(this.banks, null, 2));
    }
  }

  private async writeMemories(): Promise<void> {
    await this.ensureMemoryDir();
    const sorted = [...this.memories].sort((a, b) => b.mentionedAt - a.mentionedAt);
    this.memories = sorted;
    await this.adapter().write(MEMORIES_PATH, JSON.stringify(sorted, null, 2));
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      if (!await this.adapter().exists(path)) return fallback;
      const raw = await this.adapter().read(path);
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async ensureMemoryDir(): Promise<void> {
    if (!await this.adapter().exists(MEMORY_DIR)) {
      await this.adapter().mkdir(MEMORY_DIR);
    }
  }

  private adapter(): VaultAdapter {
    return this.app.vault.adapter as unknown as VaultAdapter;
  }

  private cloneMemory(memory: MemoryRecord): MemoryRecord {
    return {
      ...memory,
      entities: [...memory.entities],
      tags: [...memory.tags],
      source: { ...memory.source },
      supersedes: memory.supersedes ? [...memory.supersedes] : undefined,
      evidenceIds: memory.evidenceIds ? [...memory.evidenceIds] : undefined,
    };
  }
}
