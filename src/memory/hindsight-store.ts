import { App } from 'obsidian';
import {
  createDefaultMemoryBank,
  DEFAULT_MEMORY_BANK_ID,
  MemoryBank,
  MemoryRecord,
} from './hindsight-types';
import { MEMORY_DIR } from '../mcp/types';

const BANKS_PATH = `${MEMORY_DIR}/banks.json`;
const MEMORIES_PATH = `${MEMORY_DIR}/memories.json`;
const MEMORIES_TMP_PATH = `${MEMORIES_PATH}.tmp`;
const MEMORIES_BAK_PATH = `${MEMORIES_PATH}.bak`;
const MIGRATION_STATE_PATH = `${MEMORY_DIR}/migration-state.json`;

export interface MigrationState {
  legacyProfileMigrated?: boolean;
  legacySummariesMigrated?: boolean;
  previousProfileFileImported?: boolean;
  previousSummariesFileImported?: boolean;
  previousPluginProfileMigrated?: boolean;
  previousPluginSummariesMigrated?: boolean;
  previousPluginMemoriesMigrated?: boolean;
  // consolidate 触发计数:持久化到 migration-state.json,插件重载不归零,使"周期性合成"不依赖易失内存。
  consolidateTurnCounter?: number;
}

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export class HindsightStore {
  private banks: MemoryBank[] = [];
  private memories: MemoryRecord[] = [];
  private migrationState: MigrationState = {};
  private initPromise: Promise<void>;

  // 写序列化:所有落盘挂在这条 promise 链上,天然串行,永不并发写同一文件。
  private writeChain: Promise<void> = Promise.resolve();
  // 抖动合并标志:多次 scheduleWrite 之间只要有一次真正 flush 就够(取最新全量快照)。
  private dirty = false;
  // 只读降级:memories.json 损坏且无可用备份时置真,阻止 flush 用空态覆盖损坏文件。
  private corrupted = false;

  constructor(private app: App) {
    this.initPromise = this.initialize();
  }

  async ready(): Promise<void> {
    await this.initPromise;
  }

  /** 排空所有在途写入(设置变更重建 / 插件卸载前调用,确保内存态已落盘)。 */
  async flush(): Promise<void> {
    await this.ready();
    await this.scheduleWrite();
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

  /** 取某 bank 全部记忆的内部引用(只读用途,不克隆)。供去重/淘汰这类需遍历全表的内部逻辑用。 */
  async listMemoriesRaw(bankId: string = DEFAULT_MEMORY_BANK_ID): Promise<MemoryRecord[]> {
    await this.ready();
    return this.memories.filter((memory) => memory.bankId === bankId);
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
    await this.scheduleWrite();
  }

  async deleteMemories(predicate: (memory: MemoryRecord) => boolean): Promise<void> {
    await this.ready();
    const next = this.memories.filter((memory) => !predicate(memory));
    if (next.length === this.memories.length) return;
    this.memories = next;
    await this.scheduleWrite();
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
      // 读写分离:访问计数只标脏,不主动落盘。纯读会话零写盘;计数在下次真正写盘时搭车,
      // flush() 在设置变更/卸载前兜底持久化。最坏丢"上次写→退出之间"的计数增量,可接受。
      this.markDirty();
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

  /** 递增并持久化 consolidate 触发计数,返回递增后的值。跨重载不归零。 */
  async bumpConsolidateCounter(): Promise<number> {
    await this.ready();
    const next = (this.migrationState.consolidateTurnCounter ?? 0) + 1;
    await this.updateMigrationState({ consolidateTurnCounter: next });
    return next;
  }

  private async initialize(): Promise<void> {
    await this.ensureMemoryDir();
    this.banks = await this.readJson<MemoryBank[]>(BANKS_PATH, []);
    await this.loadMemories();
    this.migrationState = await this.readJson<MigrationState>(MIGRATION_STATE_PATH, {});

    if (!this.banks.some((bank) => bank.id === DEFAULT_MEMORY_BANK_ID)) {
      this.banks.push(createDefaultMemoryBank());
      await this.adapter().write(BANKS_PATH, JSON.stringify(this.banks, null, 2));
    }
  }

  /**
   * 加载 memories.json,严格区分「文件不存在(首启,正常)」与「解析失败(损坏)」:
   * - 不存在 -> 空库,正常。
   * - 损坏   -> 先尝试 .bak;仍失败则进入只读降级(corrupted=true),绝不静默清空后又覆盖,
   *             给用户/开发者手动抢救原文件的机会。
   * 顺带回收上次原子写残留的孤儿 .tmp(主文件正常时直接删)。
   */
  private async loadMemories(): Promise<void> {
    if (!await this.adapter().exists(MEMORIES_PATH)) {
      // 主文件不存在:可能是首启,也可能是上次在 remove→rename 窗口崩溃,tmp 里才是最新数据。
      if (await this.adapter().exists(MEMORIES_TMP_PATH)) {
        const recovered = await this.tryReadMemories(MEMORIES_TMP_PATH);
        if (recovered) {
          this.memories = recovered;
          await this.adapter().rename(MEMORIES_TMP_PATH, MEMORIES_PATH);
          return;
        }
      }
      this.memories = [];
      return;
    }

    const primary = await this.tryReadMemories(MEMORIES_PATH);
    if (primary) {
      this.memories = primary;
      // 主文件正常,清掉可能残留的孤儿 tmp,避免下次误判。
      if (await this.adapter().exists(MEMORIES_TMP_PATH)) {
        try { await this.adapter().remove(MEMORIES_TMP_PATH); } catch { /* 忽略 */ }
      }
      return;
    }

    // 主文件损坏:尝试备份。
    const backup = await this.tryReadMemories(MEMORIES_BAK_PATH);
    if (backup) {
      this.memories = backup;
      console.error('[Hindsight] memories.json 损坏,已从 .bak 恢复。');
      return;
    }

    // 无可用数据:进入只读降级,保留损坏文件不覆盖。
    this.corrupted = true;
    this.memories = [];
    console.error('[Hindsight] memories.json 损坏且无可用备份,已进入只读模式,不会覆盖原文件。');
  }

  /** 读并解析一个 memories 文件;成功返回数组,任何失败返回 null(不抛)。 */
  private async tryReadMemories(path: string): Promise<MemoryRecord[] | null> {
    try {
      if (!await this.adapter().exists(path)) return null;
      const parsed = JSON.parse(await this.adapter().read(path));
      return Array.isArray(parsed) ? (parsed as MemoryRecord[]) : null;
    } catch {
      return null;
    }
  }

  /**
   * 写入调度:合并抖动 + 串行落盘。多次调用挂在同一条 promise 链上,
   * 天然去重(只要 dirty 仍为真就 flush 当前最新全量快照)、天然串行(永不并发写)。
   */
  /**
   * 只标脏、不排落盘。用于"读的副作用"(访问计数)——不想为高频低价值更新触发全量写盘,
   * 而是攒着,等下一次 retain/consolidate/delete 的 scheduleWrite 搭车落盘;flush() 兜底退出前持久化。
   */
  private markDirty(): void {
    this.dirty = true;
  }

  private scheduleWrite(): Promise<void> {
    this.dirty = true;
    this.writeChain = this.writeChain
      .catch(() => { /* 前一次失败不阻断后续写 */ })
      .then(async () => {
        if (!this.dirty) return;   // 已被更晚的写合并
        this.dirty = false;
        await this.flushMemories();
      });
    return this.writeChain;
  }

  /**
   * 原子落盘:写 tmp -> 读回校验 parse -> 备份旧主文件 -> remove 主文件 -> rename tmp。
   * 任一步失败都不损坏主文件(数据仍在旧主文件或 .bak)。corrupted 时直接跳过,不覆盖损坏文件。
   */
  private async flushMemories(): Promise<void> {
    if (this.corrupted) return;
    await this.ensureMemoryDir();
    const sorted = [...this.memories].sort((a, b) => b.mentionedAt - a.mentionedAt);
    this.memories = sorted;
    const payload = JSON.stringify(sorted, null, 2);

    // 1) 写临时文件并立即读回校验,parse 失败则放弃本次(不动主文件)。
    await this.adapter().write(MEMORIES_TMP_PATH, payload);
    try {
      JSON.parse(await this.adapter().read(MEMORIES_TMP_PATH));
    } catch {
      console.error('[Hindsight] 临时文件写入校验失败,跳过本次落盘,主文件保持不变。');
      return;
    }

    // 2) 备份当前主文件(供损坏时回退),再原子替换。
    if (await this.adapter().exists(MEMORIES_PATH)) {
      try {
        if (await this.adapter().exists(MEMORIES_BAK_PATH)) {
          await this.adapter().remove(MEMORIES_BAK_PATH);
        }
        await this.adapter().rename(MEMORIES_PATH, MEMORIES_BAK_PATH);
      } catch {
        // 备份失败不阻断:直接删主文件后 rename tmp(退化为无备份的原子写)。
        try { await this.adapter().remove(MEMORIES_PATH); } catch { /* 忽略 */ }
      }
    }
    await this.adapter().rename(MEMORIES_TMP_PATH, MEMORIES_PATH);
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
