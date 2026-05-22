# Hindsight-Lite Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current static profile/session-summary memory with a local Hindsight-inspired memory layer that can retain, recall, and consolidate structured memories without depending on an external service.

**Architecture:** Keep `MemoryManager` as the public facade used by `ModelService` and `ChatRuntime`, but move storage, retrieval, migration, and consolidation into focused Hindsight-lite modules. Runtime memory becomes query-aware: each turn recalls relevant `world`, `experience`, and `observation` records under a token budget, then retains the completed turn as structured local memories.

**Tech Stack:** TypeScript, Obsidian Plugin API vault adapter storage, existing `IModelProvider`, existing custom `tsx` test harness, JSON files under `.obsidian/obsidian-cli-memory`.

---

## Scope

This plan implements the local Hindsight-lite version only. It does not call the hosted Hindsight API and does not add vector embeddings. It leaves a clean local boundary that can be swapped for a remote backend in a separate backend-integration pass.

The first implementation pass includes:

- Structured memory records with `world`, `experience`, and `observation` types.
- Local JSON store with deterministic IDs and safe read/write behavior.
- Legacy migration from `user-profile.json` and `session-summaries.json`.
- Query-aware recall with keyword, entity, recency, type, and access scoring.
- Turn retention from `ChatRuntime`.
- Observation consolidation from retained records.
- `/profile` and `/forget` compatibility through the existing `MemoryManager` API.

The first pass intentionally does not include:

- External databases.
- Hosted Hindsight API calls.
- Embedding search.
- New visual memory management UI.

---

## File Map

### Create

- `src/memory/hindsight-types.ts`
  - Owns Hindsight-lite data contracts and small pure helpers.
- `src/memory/hindsight-store.ts`
  - Owns local JSON persistence for banks, records, observations, and migration state.
- `src/memory/hindsight-retriever.ts`
  - Owns query-aware recall and scoring.
- `src/memory/hindsight-consolidator.ts`
  - Owns observation generation from recent memories.
- `src/memory/hindsight-migration.ts`
  - Owns one-time migration from legacy memory files.
- `test/hindsight-memory.test.ts`
  - Covers store, retrieval, consolidation, and migration behavior.

### Modify

- `src/memory/types.ts`
  - Remove duplicate `UserProfile` definition and keep legacy compatibility types.
- `src/memory/memory-manager.ts`
  - Convert into a facade over Hindsight-lite store/retriever/consolidator while preserving existing public methods.
- `src/runtime/runtime-types.ts`
  - Carry the original user request and memory context in `PreparedChatTurn`.
- `src/runtime/chat-runtime.ts`
  - Use query-aware recall in `prepareTurn()` and retain completed turns.
- `src/services/model-service.ts`
  - Pass memory options from plugin settings, including `privacyMode`.
- `src/ui/chat-controller.ts`
  - Keep `/profile` and `/forget` working with the new memory facade.
- `test/memory-manager.test.ts`
  - Update legacy tests to use new facade behavior.
- `test/chat-runtime.test.ts`
  - Assert query-aware recall and retain calls.
- `test/run-tests.ts`
  - Add `test/hindsight-memory.test.ts`.

---

## Data Contracts

Create `src/memory/hindsight-types.ts` with these contracts:

```ts
export type MemoryType = 'world' | 'experience' | 'observation';

export interface MemoryBank {
  id: string;
  name: string;
  mission: string;
  directives: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  kind: 'chat' | 'tool' | 'profile-migration' | 'summary-migration' | 'manual';
  messageId?: string;
  action?: string;
  target?: string;
}

export interface MemoryRecord {
  id: string;
  bankId: string;
  type: MemoryType;
  text: string;
  normalizedText: string;
  entities: string[];
  tags: string[];
  source: MemorySource;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  mentionedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  supersedes?: string[];
  evidenceIds?: string[];
}

export interface MemoryRecallRequest {
  bankId?: string;
  query: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  maxRecords?: number;
  maxChars?: number;
  includeTypes?: MemoryType[];
  now?: number;
}

export interface MemoryRecallResult {
  records: MemoryRecord[];
  promptBlock: string;
}

export interface RetainTurnInput {
  bankId?: string;
  userMessage: string;
  assistantMessage: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  contextPaths?: string[];
  toolResults?: Array<{ name: string; result: unknown }>;
  now?: number;
}
```

Add pure helpers in the same file:

```ts
export const DEFAULT_MEMORY_BANK_ID = 'default';

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tokenizeMemoryText(value: string): string[] {
  return normalizeMemoryText(value)
    .split(/[^a-z0-9\u4e00-\u9fff_.:/-]+/i)
    .filter((token) => token.length >= 2);
}

export function createMemoryId(input: {
  bankId: string;
  type: MemoryType;
  text: string;
  sourceKind: string;
}): string {
  const raw = `${input.bankId}|${input.type}|${input.sourceKind}|${normalizeMemoryText(input.text)}`;
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(index);
    hash |= 0;
  }
  return `mem_${Math.abs(hash).toString(36)}`;
}
```

---

## Task 1: Add Hindsight Store Contracts And Persistence

**Files:**

- Create: `src/memory/hindsight-types.ts`
- Create: `src/memory/hindsight-store.ts`
- Create: `test/hindsight-memory.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write the failing store tests**

Add this initial test file:

```ts
import { App } from 'obsidian';
import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
} from '../src/memory/hindsight-types';
import { HindsightStore } from '../src/memory/hindsight-store';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toContain: (expected: string) => {
      if (!String(actual).includes(expected)) throw new Error(`Expected "${actual}" to contain "${expected}"`);
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (error: any) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
}

function createApp(existing: Record<string, string> = {}) {
  const writes: Record<string, string> = {};
  const files = { ...existing };
  const adapter = {
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
    read: async (path: string) => files[path],
    write: async (path: string, content: string) => {
      files[path] = content;
      writes[path] = content;
    },
    mkdir: async (_path: string) => undefined,
  };
  return { app: { vault: { adapter } } as unknown as App, files, writes };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1000;
  return {
    id: overrides.id || 'mem_test',
    bankId: overrides.bankId || DEFAULT_MEMORY_BANK_ID,
    type: overrides.type || 'world',
    text: overrides.text || 'User prefers local-first memory.',
    normalizedText: overrides.normalizedText || 'user prefers local-first memory.',
    entities: overrides.entities || ['local-first'],
    tags: overrides.tags || ['preference'],
    source: overrides.source || { kind: 'manual' },
    confidence: overrides.confidence ?? 0.8,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    mentionedAt: overrides.mentionedAt || now,
    accessCount: overrides.accessCount ?? 0,
    ...overrides,
  };
}

async function runTests() {
  console.log('=== Hindsight Memory Tests ===');

  await test('store initializes a default bank and persists memories', async () => {
    const { app, writes } = createApp();
    const store = new HindsightStore(app);
    await store.ready();

    await store.upsertMemory(makeMemory());

    const memories = await store.listMemories();
    const banks = await store.listBanks();

    expect(banks[0].id).toBe(DEFAULT_MEMORY_BANK_ID);
    expect(memories.length).toBe(1);
    expect(memories[0].normalizedText).toBe('user prefers local-first memory.');
    expect(writes['.obsidian/obsidian-cli-memory/memories.json']).toContain('local-first');
  });

  await test('store treats duplicate ids as updates instead of duplicate rows', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();

    await store.upsertMemory(makeMemory({ id: 'mem_same', text: 'First value' }));
    await store.upsertMemory(makeMemory({ id: 'mem_same', text: 'Second value' }));

    const memories = await store.listMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].text).toBe('Second value');
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected failure:

```text
Cannot find module '../src/memory/hindsight-types'
```

- [ ] **Step 3: Create `hindsight-types.ts`**

Add the contracts from the Data Contracts section exactly, plus this default bank helper:

```ts
export function createDefaultMemoryBank(now: number = Date.now()): MemoryBank {
  return {
    id: DEFAULT_MEMORY_BANK_ID,
    name: 'Default Vault Memory',
    mission: 'Help Obsidian CLI personalize answers and remember durable user preferences, projects, decisions, and prior work.',
    directives: [
      'Prefer facts grounded in user messages or approved operations.',
      'Do not store secrets, API keys, tokens, passwords, or long private note excerpts.',
      'Prefer concise, reusable memories over raw transcript dumps.',
    ],
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: Create `hindsight-store.ts`**

Implement this local JSON store:

```ts
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
    return this.banks.map((bank) => ({ ...bank, directives: [...bank.directives] }));
  }

  async listMemories(bankId: string = DEFAULT_MEMORY_BANK_ID): Promise<MemoryRecord[]> {
    await this.ready();
    return this.memories
      .filter((memory) => memory.bankId === bankId)
      .map((memory) => this.cloneMemory(memory));
  }

  async upsertMemory(memory: MemoryRecord): Promise<void> {
    await this.ready();
    const index = this.memories.findIndex((item) => item.id === memory.id);
    const next = this.cloneMemory(memory);
    if (index >= 0) {
      this.memories[index] = next;
    } else {
      this.memories.push(next);
    }
    await this.writeMemories();
  }

  async upsertMemories(memories: MemoryRecord[]): Promise<void> {
    await this.ready();
    for (const memory of memories) {
      const index = this.memories.findIndex((item) => item.id === memory.id);
      const next = this.cloneMemory(memory);
      if (index >= 0) this.memories[index] = next;
      else this.memories.push(next);
    }
    await this.writeMemories();
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

  private adapter() {
    return this.app.vault.adapter as any;
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
```

- [ ] **Step 5: Add the test file to the harness**

In `test/run-tests.ts`, add:

```ts
'test/hindsight-memory.test.ts',
```

Place it immediately after:

```ts
'test/memory-manager.test.ts',
```

- [ ] **Step 6: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected:

```text
=== Hindsight Memory Tests ===
  PASS store initializes a default bank and persists memories
  PASS store treats duplicate ids as updates instead of duplicate rows
```

- [ ] **Step 7: Commit**

```bash
git add src/memory/hindsight-types.ts src/memory/hindsight-store.ts test/hindsight-memory.test.ts test/run-tests.ts
git commit -m "feat: add local hindsight memory store"
```

---

## Task 2: Add Query-Aware Recall Ranking

**Files:**

- Create: `src/memory/hindsight-retriever.ts`
- Modify: `test/hindsight-memory.test.ts`

- [ ] **Step 1: Write failing retriever tests**

Append these tests inside `runTests()` in `test/hindsight-memory.test.ts`:

```ts
  await test('retriever ranks entity and keyword matches above unrelated records', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_obsidian',
        type: 'world',
        text: 'User is working on the Obsidian CLI memory layer.',
        normalizedText: 'user is working on the obsidian cli memory layer.',
        entities: ['obsidian-cli', 'memory'],
        tags: ['project'],
        mentionedAt: 1000,
      }),
      makeMemory({
        id: 'mem_food',
        type: 'experience',
        text: 'User discussed lunch plans.',
        normalizedText: 'user discussed lunch plans.',
        entities: ['lunch'],
        tags: ['chat'],
        mentionedAt: 2000,
      }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({
      query: 'How should we improve Obsidian CLI memory?',
      maxRecords: 2,
      now: 3000,
    });

    expect(result.records[0].id).toBe('mem_obsidian');
    expect(result.promptBlock).toContain('Obsidian CLI memory layer');
  });

  await test('retriever respects max character budget', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({ id: 'mem_one', text: 'Short memory about local storage.', normalizedText: 'short memory about local storage.' }),
      makeMemory({ id: 'mem_two', text: 'Another short memory about local recall.', normalizedText: 'another short memory about local recall.' }),
    ]);

    const { HindsightRetriever } = await import('../src/memory/hindsight-retriever');
    const retriever = new HindsightRetriever(store);
    const result = await retriever.recall({ query: 'local memory', maxChars: 90, now: 3000 });

    expect(result.promptBlock.length <= 90).toBe(true);
    expect(result.records.length).toBe(1);
  });
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected failure:

```text
Cannot find module '../src/memory/hindsight-retriever'
```

- [ ] **Step 3: Implement `hindsight-retriever.ts`**

Create:

```ts
import {
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryType,
  tokenizeMemoryText,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

const TYPE_WEIGHT: Record<MemoryType, number> = {
  observation: 1.25,
  world: 1.1,
  experience: 1,
};

export class HindsightRetriever {
  constructor(private store: HindsightStore) {}

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const bankId = request.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = request.now ?? Date.now();
    const maxRecords = request.maxRecords ?? 6;
    const maxChars = request.maxChars ?? 2500;
    const includeTypes = new Set(request.includeTypes || ['observation', 'world', 'experience']);
    const queryTokens = new Set(tokenizeMemoryText(request.query));
    const records = (await this.store.listMemories(bankId))
      .filter((record) => includeTypes.has(record.type));

    const ranked = records
      .map((record) => ({ record, score: this.score(record, queryTokens, now) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.record);

    const selected = this.applyBudget(ranked, maxRecords, maxChars);
    return {
      records: selected,
      promptBlock: this.formatPromptBlock(selected, maxChars),
    };
  }

  private score(record: MemoryRecord, queryTokens: Set<string>, now: number): number {
    const memoryTokens = new Set(tokenizeMemoryText(record.text));
    const entityTokens = new Set(record.entities.flatMap((entity) => tokenizeMemoryText(entity)));
    let score = 0;

    for (const token of queryTokens) {
      if (memoryTokens.has(token)) score += 2;
      if (entityTokens.has(token)) score += 3;
      if (record.tags.some((tag) => tag.toLowerCase().includes(token))) score += 1.5;
    }

    if (queryTokens.size === 0 && record.type !== 'experience') score += 0.5;
    if (score === 0) return 0;

    const ageMs = Math.max(0, now - record.mentionedAt);
    const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 14));
    const access = Math.min(record.accessCount, 10) * 0.05;
    return (score * TYPE_WEIGHT[record.type]) + recency + access + record.confidence;
  }

  private applyBudget(records: MemoryRecord[], maxRecords: number, maxChars: number): MemoryRecord[] {
    const selected: MemoryRecord[] = [];
    let used = '[Relevant Memory]\n'.length;

    for (const record of records) {
      if (selected.length >= maxRecords) break;
      const line = this.formatLine(record);
      if (selected.length > 0 && used + line.length > maxChars) continue;
      selected.push(record);
      used += line.length;
      if (used >= maxChars) break;
    }

    return selected;
  }

  private formatPromptBlock(records: MemoryRecord[], maxChars: number): string {
    if (records.length === 0) return '';
    const text = `[Relevant Memory]\n${records.map((record) => this.formatLine(record)).join('')}`;
    return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 3)) + '...';
  }

  private formatLine(record: MemoryRecord): string {
    return `- ${record.type}: ${record.text} (confidence: ${record.confidence.toFixed(2)})\n`;
  }
}
```

- [ ] **Step 4: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected:

```text
PASS retriever ranks entity and keyword matches above unrelated records
PASS retriever respects max character budget
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/hindsight-retriever.ts test/hindsight-memory.test.ts
git commit -m "feat: add hindsight memory recall ranking"
```

---

## Task 3: Add Legacy Memory Migration

**Files:**

- Create: `src/memory/hindsight-migration.ts`
- Modify: `test/hindsight-memory.test.ts`

- [ ] **Step 1: Write failing migration test**

Append this test inside `runTests()`:

```ts
  await test('migration converts legacy profile and summaries exactly once', async () => {
    const profilePath = '.obsidian/obsidian-cli-memory/user-profile.json';
    const summariesPath = '.obsidian/obsidian-cli-memory/session-summaries.json';
    const { app } = createApp({
      [profilePath]: JSON.stringify({
        profession: 'Product engineer',
        expertise: ['Obsidian plugins'],
        preferences: { responseStyle: 'concise', language: 'zh-CN', topics: [] },
        context: { currentProjects: ['Obsidian CLI memory'], goals: ['local-first recall'], challenges: [] },
        workflows: [],
        metadata: { totalInteractions: 4, createdAt: 1, updatedAt: 2, lastProfileUpdate: 2 },
      }),
      [summariesPath]: JSON.stringify([
        { timestamp: 10, messageCount: 2, summary: 'Discussed Hindsight-lite memory.' },
      ]),
    });
    const store = new HindsightStore(app);
    await store.ready();

    const { migrateLegacyMemory } = await import('../src/memory/hindsight-migration');
    await migrateLegacyMemory(app, store, 5000);
    await migrateLegacyMemory(app, store, 6000);

    const memories = await store.listMemories();
    expect(memories.filter((memory) => memory.source.kind === 'profile-migration').length).toBe(5);
    expect(memories.filter((memory) => memory.source.kind === 'summary-migration').length).toBe(1);
    expect(memories.some((memory) => memory.text.includes('Product engineer'))).toBe(true);
  });
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected failure:

```text
Cannot find module '../src/memory/hindsight-migration'
```

- [ ] **Step 3: Implement `hindsight-migration.ts`**

Create:

```ts
import { App } from 'obsidian';
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  normalizeMemoryText,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

const MEMORY_DIR = '.obsidian/obsidian-cli-memory';
const PROFILE_PATH = `${MEMORY_DIR}/user-profile.json`;
const SUMMARIES_PATH = `${MEMORY_DIR}/session-summaries.json`;

export async function migrateLegacyMemory(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const records: MemoryRecord[] = [];

  if (!state.legacyProfileMigrated) {
    const profile = await readJson<any>(app, PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    await store.updateMigrationState({ legacyProfileMigrated: true });
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readJson<any[]>(app, SUMMARIES_PATH, []);
    records.push(...summariesToMemories(summaries, now));
    await store.updateMigrationState({ legacySummariesMigrated: true });
  }

  if (records.length > 0) {
    await store.upsertMemories(records);
  }
}

function profileToMemories(profile: any, now: number): MemoryRecord[] {
  const texts: string[] = [];
  if (profile.profession) texts.push(`User profession: ${profile.profession}`);
  for (const expertise of arrayOf(profile.expertise)) texts.push(`User expertise: ${expertise}`);
  if (profile.preferences?.responseStyle) texts.push(`User response style preference: ${profile.preferences.responseStyle}`);
  for (const project of arrayOf(profile.context?.currentProjects)) texts.push(`Current project: ${project}`);
  for (const goal of arrayOf(profile.context?.goals)) texts.push(`User goal: ${goal}`);

  return texts.map((text) => makeMemory(text, 'world', 'profile-migration', now, 0.8));
}

function summariesToMemories(summaries: any[], now: number): MemoryRecord[] {
  return summaries
    .filter((summary) => typeof summary?.summary === 'string' && summary.summary.trim())
    .map((summary) => makeMemory(
      `Previous session: ${summary.summary.trim()}`,
      'experience',
      'summary-migration',
      typeof summary.timestamp === 'number' ? summary.timestamp : now,
      0.65,
    ));
}

function makeMemory(
  text: string,
  type: 'world' | 'experience',
  sourceKind: 'profile-migration' | 'summary-migration',
  timestamp: number,
  confidence: number,
): MemoryRecord {
  return {
    id: createMemoryId({ bankId: DEFAULT_MEMORY_BANK_ID, type, text, sourceKind }),
    bankId: DEFAULT_MEMORY_BANK_ID,
    type,
    text,
    normalizedText: normalizeMemoryText(text),
    entities: extractSimpleEntities(text),
    tags: [sourceKind],
    source: { kind: sourceKind },
    confidence,
    createdAt: timestamp,
    updatedAt: timestamp,
    mentionedAt: timestamp,
    accessCount: 0,
  };
}

function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function extractSimpleEntities(text: string): string[] {
  return text
    .split(/[,;，；]/)
    .map((part) => part.replace(/^[^:]+:\s*/, '').trim())
    .filter((part) => part.length >= 2)
    .slice(0, 5);
}

async function readJson<T>(app: App, path: string, fallback: T): Promise<T> {
  try {
    const adapter = app.vault.adapter as any;
    if (!await adapter.exists(path)) return fallback;
    return JSON.parse(await adapter.read(path)) as T;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected:

```text
PASS migration converts legacy profile and summaries exactly once
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/hindsight-migration.ts test/hindsight-memory.test.ts
git commit -m "feat: migrate legacy memory into hindsight records"
```

---

## Task 4: Add Observation Consolidation

**Files:**

- Create: `src/memory/hindsight-consolidator.ts`
- Modify: `test/hindsight-memory.test.ts`

- [ ] **Step 1: Write failing consolidation test**

Append:

```ts
  await test('consolidator creates observations with evidence ids', async () => {
    const { app } = createApp();
    const store = new HindsightStore(app);
    await store.ready();
    await store.upsertMemories([
      makeMemory({
        id: 'mem_local',
        type: 'world',
        text: 'User prefers local-first implementations.',
        normalizedText: 'user prefers local-first implementations.',
        entities: ['local-first'],
        tags: ['preference'],
      }),
      makeMemory({
        id: 'mem_tests',
        type: 'experience',
        text: 'User confirmed a TDD implementation plan for memory.',
        normalizedText: 'user confirmed a tdd implementation plan for memory.',
        entities: ['tdd', 'memory'],
        tags: ['plan'],
      }),
    ]);

    const { HindsightConsolidator } = await import('../src/memory/hindsight-consolidator');
    const consolidator = new HindsightConsolidator(store);
    const created = await consolidator.consolidate({ now: 7000 });

    expect(created.length).toBe(1);
    expect(created[0].type).toBe('observation');
    expect(created[0].evidenceIds).toEqual(['mem_local', 'mem_tests']);
    expect(created[0].text).toContain('local-first');
  });
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected failure:

```text
Cannot find module '../src/memory/hindsight-consolidator'
```

- [ ] **Step 3: Implement `hindsight-consolidator.ts`**

Create:

```ts
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  normalizeMemoryText,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

interface ConsolidateOptions {
  bankId?: string;
  now?: number;
  maxEvidence?: number;
}

export class HindsightConsolidator {
  constructor(private store: HindsightStore) {}

  async consolidate(options: ConsolidateOptions = {}): Promise<MemoryRecord[]> {
    const bankId = options.bankId || DEFAULT_MEMORY_BANK_ID;
    const now = options.now ?? Date.now();
    const maxEvidence = options.maxEvidence ?? 8;
    const memories = (await this.store.listMemories(bankId))
      .filter((memory) => memory.type !== 'observation')
      .sort((a, b) => b.mentionedAt - a.mentionedAt)
      .slice(0, maxEvidence);

    if (memories.length < 2) return [];

    const preference = memories.find((memory) => /prefer|preference|偏好|喜欢|local-first/i.test(memory.text));
    const project = memories.find((memory) => /project|goal|plan|memory|项目|目标|计划/i.test(memory.text));
    if (!preference && !project) return [];

    const evidenceIds = memories.map((memory) => memory.id);
    const text = this.buildObservationText(preference, project);
    const observation: MemoryRecord = {
      id: createMemoryId({ bankId, type: 'observation', text, sourceKind: 'manual' }),
      bankId,
      type: 'observation',
      text,
      normalizedText: normalizeMemoryText(text),
      entities: [...new Set(memories.flatMap((memory) => memory.entities))].slice(0, 8),
      tags: ['observation'],
      source: { kind: 'manual' },
      confidence: 0.75,
      createdAt: now,
      updatedAt: now,
      mentionedAt: now,
      accessCount: 0,
      evidenceIds,
    };

    await this.store.upsertMemory(observation);
    return [observation];
  }

  private buildObservationText(preference?: MemoryRecord, project?: MemoryRecord): string {
    if (preference && project) {
      return `${preference.text} This matters in current work: ${project.text}`;
    }
    if (preference) return preference.text;
    return project?.text || 'User has recurring memory-related work patterns.';
  }
}
```

- [ ] **Step 4: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected:

```text
PASS consolidator creates observations with evidence ids
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/hindsight-consolidator.ts test/hindsight-memory.test.ts
git commit -m "feat: consolidate memories into observations"
```

---

## Task 5: Refactor MemoryManager Into Hindsight-Lite Facade

**Files:**

- Modify: `src/memory/memory-manager.ts`
- Modify: `src/memory/types.ts`
- Modify: `test/memory-manager.test.ts`

- [ ] **Step 1: Write failing facade tests**

In `test/memory-manager.test.ts`, add tests after the existing `buildContext applies a budget...` test:

```ts
  await test('recallForPrompt returns relevant hindsight memories', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await memory.retainTurn({
      userMessage: 'I prefer local-first memory for Obsidian CLI.',
      assistantMessage: 'We will keep memory local.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await memory.recallForPrompt({
      query: 'How should Obsidian CLI memory work?',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toContain('[Relevant Memory]');
    expect(promptBlock).toContain('local-first');
  });

  await test('privacy mode prevents retaining new turn memories', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog), { privacyMode: true });
    await memory.ready();

    await memory.retainTurn({
      userMessage: 'Remember that my project is private.',
      assistantMessage: 'Acknowledged.',
      source: 'shell',
      now: 1000,
    });

    const promptBlock = await memory.recallForPrompt({
      query: 'private project',
      maxChars: 500,
      now: 2000,
    });

    expect(promptBlock).toBe('');
  });
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected failure:

```text
memory.retainTurn is not a function
```

- [ ] **Step 3: Clean `src/memory/types.ts`**

Remove the duplicate `UserProfile` declaration at the top of the file. Keep one `UserProfile`, `SessionSummary`, `ChatMessage`, `MemoryContext`, and `DEFAULT_USER_PROFILE`.

- [ ] **Step 4: Update `MemoryManager` constructor and fields**

In `src/memory/memory-manager.ts`, add imports:

```ts
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  normalizeMemoryText,
  RetainTurnInput,
} from './hindsight-types';
import { HindsightConsolidator } from './hindsight-consolidator';
import { migrateLegacyMemory } from './hindsight-migration';
import { HindsightRetriever } from './hindsight-retriever';
import { HindsightStore } from './hindsight-store';
```

Change the constructor signature:

```ts
interface MemoryManagerOptions {
  privacyMode?: boolean;
}

constructor(
  private app: App,
  private model: IModelProvider,
  private options: MemoryManagerOptions = {},
) {
  this.userProfile = { ...DEFAULT_USER_PROFILE };
  this.hindsightStore = new HindsightStore(app);
  this.hindsightRetriever = new HindsightRetriever(this.hindsightStore);
  this.hindsightConsolidator = new HindsightConsolidator(this.hindsightStore);
  this.initPromise = this.initialize();
}
```

Add private fields:

```ts
private hindsightStore: HindsightStore;
private hindsightRetriever: HindsightRetriever;
private hindsightConsolidator: HindsightConsolidator;
private retainedUserTurns = 0;
```

- [ ] **Step 5: Update `initialize()`**

After the existing legacy file loads, migrate once:

```ts
private async initialize() {
  await this.loadProfile();
  await this.loadSummaries();
  await this.loadChatHistory();
  await this.hindsightStore.ready();
  await migrateLegacyMemory(this.app, this.hindsightStore);
}
```

- [ ] **Step 6: Add `retainTurn()` and `recallForPrompt()`**

Add:

```ts
async recallForPrompt(input: {
  query: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  maxChars?: number;
  now?: number;
}): Promise<string> {
  await this.ready();
  const includeTypes = input.source === 'guardian'
    ? ['observation', 'world'] as const
    : ['observation', 'world', 'experience'] as const;
  const result = await this.hindsightRetriever.recall({
    query: input.query,
    source: input.source,
    maxChars: input.maxChars ?? 2500,
    includeTypes: [...includeTypes],
    now: input.now,
  });
  return result.promptBlock;
}

async retainTurn(input: RetainTurnInput): Promise<void> {
  await this.ready();
  if (this.options.privacyMode) return;

  const now = input.now ?? Date.now();
  const records = this.buildTurnMemories(input, now);
  if (records.length === 0) return;

  await this.hindsightStore.upsertMemories(records);
  this.retainedUserTurns += 1;
  if (this.retainedUserTurns % 5 === 0) {
    await this.hindsightConsolidator.consolidate({ now });
  }
}
```

Add the helper:

```ts
private buildTurnMemories(input: RetainTurnInput, now: number) {
  const records = [];
  const userText = input.userMessage.trim();
  if (userText) {
    records.push(this.createMemoryRecord({
      type: this.looksDurable(userText) ? 'world' : 'experience',
      text: this.memoryTextForUserMessage(userText),
      sourceKind: 'chat',
      tags: this.tagsForText(userText),
      now,
    }));
  }

  const assistantText = input.assistantMessage.trim();
  if (assistantText) {
    records.push(this.createMemoryRecord({
      type: 'experience',
      text: `Assistant outcome: ${assistantText.slice(0, 400)}`,
      sourceKind: 'chat',
      tags: ['assistant-outcome'],
      now,
      confidence: 0.55,
    }));
  }

  return records;
}
```

Add the record builder and small classifiers:

```ts
private createMemoryRecord(input: {
  type: 'world' | 'experience';
  text: string;
  sourceKind: 'chat' | 'manual';
  tags: string[];
  now: number;
  confidence?: number;
}) {
  return {
    id: createMemoryId({
      bankId: DEFAULT_MEMORY_BANK_ID,
      type: input.type,
      text: input.text,
      sourceKind: input.sourceKind,
    }),
    bankId: DEFAULT_MEMORY_BANK_ID,
    type: input.type,
    text: input.text,
    normalizedText: normalizeMemoryText(input.text),
    entities: this.extractEntities(input.text),
    tags: input.tags,
    source: { kind: input.sourceKind },
    confidence: input.confidence ?? (input.type === 'world' ? 0.75 : 0.6),
    createdAt: input.now,
    updatedAt: input.now,
    mentionedAt: input.now,
    accessCount: 0,
  };
}

private looksDurable(text: string): boolean {
  return /\bI prefer\b|\bmy project\b|\bmy goal\b|\bremember\b|偏好|喜欢|目标|项目|我是|我正在/i.test(text);
}

private memoryTextForUserMessage(text: string): string {
  return this.looksDurable(text) ? `User stated: ${text}` : `User asked: ${text}`;
}

private tagsForText(text: string): string[] {
  const tags = [];
  if (/prefer|偏好|喜欢/i.test(text)) tags.push('preference');
  if (/project|项目/i.test(text)) tags.push('project');
  if (/goal|目标/i.test(text)) tags.push('goal');
  if (tags.length === 0) tags.push('chat');
  return tags;
}

private extractEntities(text: string): string[] {
  const matches = text.match(/[A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*/g) || [];
  const dotted = text.match(/[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+\.[a-z0-9_.-]+/gi) || [];
  return [...new Set([...matches, ...dotted])]
    .map((entity) => entity.trim())
    .filter((entity) => entity.length >= 2)
    .slice(0, 8);
}
```

- [ ] **Step 7: Preserve legacy public methods**

Keep `buildContext()`, `getUserProfile()`, `updateProfile()`, `learnFromRecentMessages()`, `recordMessage()`, `clearSession()`, and `save()` so callers do not break during this task. The new runtime integration in Task 6 will stop relying on `recordMessage()` for final turn storage.

- [ ] **Step 8: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected:

```text
PASS recallForPrompt returns relevant hindsight memories
PASS privacy mode prevents retaining new turn memories
```

- [ ] **Step 9: Commit**

```bash
git add src/memory/types.ts src/memory/memory-manager.ts test/memory-manager.test.ts
git commit -m "feat: expose hindsight memory through manager"
```

---

## Task 6: Integrate Query-Aware Memory With ChatRuntime

**Files:**

- Modify: `src/runtime/runtime-types.ts`
- Modify: `src/runtime/chat-runtime.ts`
- Modify: `test/chat-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

In `test/chat-runtime.test.ts`, add or update the mock memory manager to include:

```ts
const memoryCalls: any[] = [];
const memoryManager = {
  ready: async () => undefined,
  recallForPrompt: async (input: any) => {
    memoryCalls.push({ type: 'recallForPrompt', input });
    return '[Relevant Memory]\n- world: User prefers local-first memory.\n';
  },
  retainTurn: async (input: any) => {
    memoryCalls.push({ type: 'retainTurn', input });
  },
};
```

Add this test:

```ts
await test('runtime recalls relevant memory and retains completed turns', async () => {
  const provider = createProviderThatReturns('Done');
  const runtime = new DefaultChatRuntime({
    provider,
    memoryManager: memoryManager as any,
    toolRegistry: createEmptyToolRegistry(),
    skillRegistry: createEmptySkillRegistry(),
  });

  const turn = await runtime.prepareTurn({
    userMessage: 'Design memory for Obsidian CLI',
    contextItems: [],
    selection: '',
    source: 'shell',
  });
  const response = await runtime.query(turn);

  expect(turn.prompt).toContain('[Relevant Memory]');
  expect(response).toBe('Done');
  expect(memoryCalls[0].type).toBe('recallForPrompt');
  expect(memoryCalls[memoryCalls.length - 1].type).toBe('retainTurn');
});
```

Use the local helper style already present in `test/chat-runtime.test.ts`; if helper names differ, add small local helpers instead of importing new test libraries.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
```

Expected failure:

```text
Expected prompt to contain [Relevant Memory]
```

- [ ] **Step 3: Update `PreparedChatTurn`**

In `src/runtime/runtime-types.ts`, add:

```ts
  userRequest?: string;
  memoryContext?: string;
```

to `PreparedChatTurn`.

- [ ] **Step 4: Use query-aware recall in `prepareTurn()`**

In `src/runtime/chat-runtime.ts`, replace:

```ts
memoryContext = this.deps.memoryManager.buildContext();
```

with:

```ts
if (typeof (this.deps.memoryManager as any).recallForPrompt === 'function') {
  memoryContext = await (this.deps.memoryManager as any).recallForPrompt({
    query: request.userMessage,
    source: request.source,
    maxChars: 2500,
  });
} else {
  memoryContext = this.deps.memoryManager.buildContext();
}
```

When returning the prepared turn, include:

```ts
userRequest: request.userMessage,
memoryContext,
```

- [ ] **Step 5: Stop using MemoryManager as the provider chat session owner**

In both `query()` and `queryStream()`, replace:

```ts
const chat = this.deps.memoryManager
  ? this.deps.memoryManager.getOrCreateSession(turn.tools)
  : this.deps.provider.startChat(turn.tools);
```

with:

```ts
const chat = this.deps.provider.startChat(turn.tools);
```

This keeps the provider session scoped to one turn and prevents stale tool definitions from leaking across skill scopes.

- [ ] **Step 6: Retain completed turns**

In `query()`, replace the two `recordMessage(...)` calls at the end with:

```ts
await this.retainCompletedTurn(turn, qualityCheckedText);
```

In approval return path, replace the two `recordMessage(...)` calls with:

```ts
await this.retainCompletedTurn(turn, approvalMessage);
```

In `queryStream()`, replace the two `recordMessage(...)` calls with:

```ts
await this.retainCompletedTurn(turn, approvalMessage || fullResponseText);
```

Add helper:

```ts
private async retainCompletedTurn(turn: PreparedChatTurn, assistantMessage: string): Promise<void> {
  if (!this.deps.memoryManager) return;
  if (typeof (this.deps.memoryManager as any).retainTurn === 'function') {
    await (this.deps.memoryManager as any).retainTurn({
      userMessage: turn.userRequest || this.extractUserRequest(turn.prompt),
      assistantMessage,
      source: turn.generationPlan?.source || 'shell',
    });
    return;
  }

  const userRequest = this.extractUserRequest(turn.prompt);
  await this.deps.memoryManager.recordMessage('user', userRequest);
  await this.deps.memoryManager.recordMessage('model', assistantMessage);
}
```

- [ ] **Step 7: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
```

Expected:

```text
PASS runtime recalls relevant memory and retains completed turns
```

- [ ] **Step 8: Commit**

```bash
git add src/runtime/runtime-types.ts src/runtime/chat-runtime.ts test/chat-runtime.test.ts
git commit -m "feat: use query-aware hindsight memory in runtime"
```

---

## Task 7: Wire Privacy Mode And Commands

**Files:**

- Modify: `src/services/model-service.ts`
- Modify: `src/ui/chat-controller.ts`
- Modify: `test/model-service.test.ts`
- Modify: `test/chat-controller.test.ts`

- [ ] **Step 1: Write failing ModelService privacy test**

In `test/model-service.test.ts`, add a constructor-focused test following the existing `ModelService` object-pattern tests:

```ts
await test('ModelService passes privacyMode into MemoryManager options', async () => {
  const service: any = Object.create(ModelService.prototype);
  service.app = createMockApp();
  service.settings = {
    activeProvider: 'gemini',
    providers: { gemini: { type: 'gemini', apiKey: 'key', baseUrl: '', model: 'gemini-2.5-flash', label: 'Gemini' } },
    privacyMode: true,
  };

  const options = (service as any).buildMemoryOptions();
  expect(options).toEqual({ privacyMode: true });
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected failure:

```text
service.buildMemoryOptions is not a function
```

- [ ] **Step 3: Implement memory options in `ModelService`**

In `src/services/model-service.ts`, add:

```ts
private buildMemoryOptions() {
  return {
    privacyMode: this.settings.privacyMode === true,
  };
}
```

Replace:

```ts
this.memoryManager = new MemoryManager(this.app, this.provider);
```

with:

```ts
this.memoryManager = new MemoryManager(this.app, this.provider, this.buildMemoryOptions());
```

- [ ] **Step 4: Add `/profile` and `/forget` compatibility tests**

In `test/chat-controller.test.ts`, add:

```ts
await test('/profile renders hindsight memory profile text when available', async () => {
  const messages: any[] = [];
  const controller = new ChatController({
    app: {} as any,
    api: {
      getSkillCommands: () => [],
      getUserProfile: () => ({ profession: 'Engineer', expertise: ['Obsidian'], preferences: { responseStyle: 'balanced' }, context: { currentProjects: ['Memory'], goals: [] } }),
      updateProfile: async () => undefined,
      getAvailableTools: () => [],
      clearSession: async () => undefined,
    } as any,
    onMessageAdded: (message) => messages.push(message),
  });

  await controller.processCommand('/profile');

  expect(messages[messages.length - 1].content).toContain('Engineer');
  controller.cleanup();
});
```

This test should already pass after Task 5 if `getUserProfile()` remains compatible.

- [ ] **Step 5: Run GREEN verification**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected:

```text
PASS ModelService passes privacyMode into MemoryManager options
PASS /profile renders hindsight memory profile text when available
```

- [ ] **Step 6: Commit**

```bash
git add src/services/model-service.ts src/ui/chat-controller.ts test/model-service.test.ts test/chat-controller.test.ts
git commit -m "feat: wire privacy mode into memory"
```

---

## Task 8: Full Regression And Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/runtime.md`
- Modify: `docs/architecture/skills.md` only if slash command text changes during implementation.

- [ ] **Step 1: Update README memory section**

In `README.md`, replace the memory bullet:

```md
- Local memory and knowledge compilation stored in the vault
```

with:

```md
- Local Hindsight-inspired memory with retained facts, experiences, observations, and query-aware recall
```

Add this subsection under `## Interaction Model`:

```md
### Memory Model

Obsidian CLI keeps memory local in `.obsidian/obsidian-cli-memory/`. The memory layer retains durable user facts, prior interaction outcomes, and synthesized observations. Each model turn recalls only memories relevant to the current request, under a prompt budget, instead of injecting the entire history.
```

- [ ] **Step 2: Update runtime architecture doc**

In `docs/architecture/runtime.md`, add this after the main flow:

```md
## Memory Flow

The runtime uses `MemoryManager` as a local Hindsight-lite facade.

1. `prepareTurn(...)` calls query-aware memory recall with the current user request.
2. Relevant memory records are formatted into `[Relevant Memory]`.
3. The provider chat session is scoped to the current turn and tool set.
4. After the turn completes, the runtime retains the user request and assistant outcome as structured memories.
5. Every few retained turns, the memory layer consolidates raw records into observations with evidence IDs.
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected: all five commands exit `0`.

- [ ] **Step 4: Run full suite**

Run:

```bash
npm test
```

Expected:

```text
Executed 65 test files successfully.
```

If the exact number changes because `test/hindsight-memory.test.ts` was added, accept:

```text
Executed 66 test files successfully.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture/runtime.md docs/architecture/skills.md test/run-tests.ts
git commit -m "docs: describe hindsight-lite memory flow"
```

---

## Implementation Notes

- Keep JSON writes small and deterministic. The existing Obsidian vault adapter is enough for this implementation.
- Do not store API keys, tokens, passwords, or long note excerpts in memory records.
- `privacyMode` must prevent new turn retention. It may still allow migrated legacy memory to exist; if product direction requires stricter privacy, add a separate task to suppress recall in privacy mode too.
- Keep the hosted Hindsight integration out of this pass. The local contracts should make a future `MemoryBackend` interface straightforward, but this plan should not add network calls.
- Do not remove legacy memory files. Keep them for rollback and compatibility.
- If provider-session scoping causes a regression in follow-up prompts such as "what about that?", improve `recallForPrompt()` by always including the latest two `experience` records within the prompt budget.

---

## Self-Review

- Spec coverage: The plan covers local store, recall, migration, consolidation, runtime integration, privacy mode, command compatibility, and documentation.
- Placeholder scan: No task uses placeholder markers or open-ended implementation instructions.
- Type consistency: `MemoryRecord`, `MemoryRecallRequest`, `RetainTurnInput`, `HindsightStore`, `HindsightRetriever`, and `HindsightConsolidator` are introduced before dependent tasks use them.
- Test discipline: Each production change begins with a failing test and includes a focused verification command.
- Scope check: Hosted Hindsight, embeddings, and visual memory management are intentionally excluded from this implementation pass.
