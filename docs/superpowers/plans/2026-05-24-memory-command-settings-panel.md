# Memory Command And Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace memory-facing shell UX with `/memory` and add a Settings → Memory panel for Hindsight-lite overview, search, inspection, deletion, and privacy controls.

**Architecture:** Keep Hindsight storage private to `src/memory`; expose read-only and mutation facades through `MemoryManager` and `ModelService`; keep `ChatController` as a command parser/renderer; keep `SettingTab` as a stateful management UI. `/profile` and `/forget` remain compatibility aliases, but help, autocomplete, and runtime slash contracts promote `/memory`.

**Tech Stack:** TypeScript, Obsidian plugin settings UI, existing custom `tsx` test harness, local JSON-backed Hindsight-lite memory store.

---

## Supersedes

This plan supersedes `docs/superpowers/plans/2026-05-24-memory-profile-command.md`. Do not implement the older `/profile`-first plan separately.

---

## Target User Experience

### Shell Commands

```text
/memory
/memory overview
/memory observations
/memory search <query>
/memory forget <field>
/memory forget all
```

Compatibility aliases:

```text
/profile                 -> /memory overview
/profile observations    -> /memory observations
/forget all              -> /memory forget all
/forget profession       -> /memory forget profession
```

The aliases should work, but `/help`, autocomplete, and the runtime slash command contract should show `/memory` as the primary command.

### Settings Panel Prototype

The panel lives as a new top-level settings section named `Memory`. It is an operational management surface, not a marketing page.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Memory                                                              │
│ Inspect and manage local Hindsight memory used by shell responses.  │
├─────────────────────────────────────────────────────────────────────┤
│ Privacy Mode  [ On/Off toggle ]                                     │
│ When on, new conversation turns are not retained as Hindsight memory.│
│ Data folder: .obsidian/baizer-memory                          │
├─────────────────────────────────────────────────────────────────────┤
│ Total 42      Facts 15      Experiences 21      Observations 6      │
├─────────────────────────────────────────────────────────────────────┤
│ Search memories [ query-aware memory recall              ] [Search] │
├─────────────────────────────────────────────────────────────────────┤
│ Tabs:  Overview | Observations | Facts | Recent | Search Results    │
├─────────────────────────────────────────────────────────────────────┤
│ observation  confidence 0.75       updated 2026-05-24 10:15        │
│ User prefers local-first memory; this matters in current work...     │
│ tags: observation, project                         [Delete]          │
│                                                                     │
│ world        confidence 0.80       updated 2026-05-24 09:50         │
│ User stated: My project LaunchPlan uses query-aware memory search.   │
│ tags: project                                      [Delete]          │
├─────────────────────────────────────────────────────────────────────┤
│ Danger Zone                                                         │
│ Clear all remembered Hindsight memory                     [Clear]   │
└─────────────────────────────────────────────────────────────────────┘
```

Visual rules:

- Use the existing `baizer-settings-*` page structure and do not introduce a new visual system.
- Use full-width bands/rows inside the section, not nested cards.
- Keep row radius at 8px or less.
- Memory rows are dense and scan-friendly: type badge, confidence, updated timestamp, truncated text, tags, delete action.
- Search results should reuse the same row component as other memory lists.
- Delete and clear actions should use explicit confirmation via `Modal` or Obsidian `Notice` plus a confirmation button, not immediate destructive action.

---

## Command Behavior

| Command | Behavior |
|---|---|
| `/memory` | Render overview: privacy state, stats, top observations, recent facts. |
| `/memory overview` | Same as `/memory`. |
| `/memory observations` | Render only `type: observation`, with id and confidence. |
| `/memory search <query>` | Call query-aware recall and render selected records. Empty query returns usage. |
| `/memory forget <field>` | Reuse existing field-based forget logic and show confirmation text. |
| `/memory forget all` | Clear Hindsight memories and legacy profile fields, matching current `/forget all`. |
| `/profile ...` | Alias to `/memory ...` and include one compatibility note line. |
| `/forget ...` | Alias to `/memory forget ...` and include one compatibility note line. |

---

## File Structure

- Modify: `src/memory/types.ts`
  - Add memory view and mutation result types.
- Modify: `src/memory/memory-manager.ts`
  - Add `getMemoryView()`, `deleteMemoryById()`, and count-returning forget helpers.
- Modify: `src/memory/hindsight-store.ts`
  - Add safe read/mutation primitives only if current methods are not enough.
- Modify: `src/services/model-service.ts`
  - Add facade methods for settings UI and shell command.
- Modify: `src/ui/chat-controller.ts`
  - Add `/memory` parser and renderers; keep aliases for `/profile` and `/forget`.
- Modify: `src/ui/shell-view.ts`
  - Promote `/memory` in command suggestions.
- Modify: `src/runtime/chat-runtime.ts`
  - Promote `/memory` in the slash command contract.
- Modify: `src/settings.ts`
  - Add Memory section, state fields, render helpers, search, list rows, delete/clear actions.
- Modify: `styles.css`
  - Add compact memory panel styles under existing settings styles.
- Modify tests:
  - `test/memory-manager.test.ts`
  - `test/hindsight-memory.test.ts`
  - `test/model-service.test.ts`
  - `test/chat-controller.test.ts`
  - `test/settings-state.test.ts`
- Modify docs:
  - `README.md`
  - `docs/architecture/runtime.md` if command naming appears there.

---

### Task 1: Define Memory View And Mutation Types

**Files:**
- Modify: `src/memory/types.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: Add failing memory view test**

Append inside `runTests()` in `test/memory-manager.test.ts`:

```ts
  await test('getMemoryView returns stats and sections for command and settings UI', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'Acknowledged the local-first preference.',
      now: 1000,
    });

    const view = await (memory as any).getMemoryView({ mode: 'overview', limit: 5, now: 2000 });

    expect(view.stats.total).toBe(2);
    expect(view.stats.world).toBe(1);
    expect(view.stats.experience).toBe(1);
    expect(view.sections.facts.length).toBe(1);
    expect(view.privacyMode).toBe(false);
  });
```

- [ ] **Step 2: Run test to confirm failure**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: FAIL because `getMemoryView` is not defined.

- [ ] **Step 3: Add shared types**

Add to `src/memory/types.ts`:

```ts
import { MemoryRecord } from './hindsight-types';

export type MemoryViewMode =
    | 'overview'
    | 'observations'
    | 'facts'
    | 'recent'
    | 'search'
    | 'raw';

export interface MemoryViewRequest {
    mode?: MemoryViewMode;
    query?: string;
    limit?: number;
    now?: number;
}

export interface MemoryStats {
    total: number;
    world: number;
    experience: number;
    observation: number;
    lastUpdatedAt: number | null;
}

export interface MemoryViewSections {
    observations: MemoryRecord[];
    facts: MemoryRecord[];
    recent: MemoryRecord[];
    searchResults: MemoryRecord[];
    raw: MemoryRecord[];
}

export interface MemoryView {
    privacyMode: boolean;
    legacyProfile: UserProfile;
    stats: MemoryStats;
    sections: MemoryViewSections;
}

export interface MemoryMutationResult {
    success: boolean;
    deletedCount: number;
    message: string;
}
```

- [ ] **Step 4: Run test again**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: FAIL moves from missing types to missing `getMemoryView`.

- [ ] **Step 5: Commit**

```bash
git add src/memory/types.ts test/memory-manager.test.ts
git commit -m "test: specify memory view shape"
```

---

### Task 2: Implement MemoryManager View And Deletion APIs

**Files:**
- Modify: `src/memory/memory-manager.ts`
- Modify: `src/memory/hindsight-store.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: Update imports**

Modify the `./types` import in `src/memory/memory-manager.ts`:

```ts
import {
    UserProfile,
    SessionSummary,
    ChatMessage,
    DEFAULT_USER_PROFILE,
    MemoryMutationResult,
    MemoryView,
    MemoryViewRequest,
} from './types';
```

- [ ] **Step 2: Implement `getMemoryView()`**

Insert after `recallForPrompt(...)` in `src/memory/memory-manager.ts`:

```ts
    async getMemoryView(request: MemoryViewRequest = {}): Promise<MemoryView> {
        await this.ready();
        const limit = Math.max(1, Math.min(request.limit ?? 5, 25));
        const memories = await this.hindsightStore.listMemories(DEFAULT_MEMORY_BANK_ID);
        const sorted = [...memories].sort((a, b) => b.mentionedAt - a.mentionedAt);
        const query = request.query?.trim() || '';
        const searchResult = query
            ? await this.hindsightRetriever.recall({
                query,
                maxRecords: limit,
                maxChars: 4000,
                now: request.now,
            })
            : { records: [], promptBlock: '' };

        return {
            privacyMode: this.options.privacyMode === true,
            legacyProfile: this.getProfile(),
            stats: {
                total: memories.length,
                world: memories.filter((memory) => memory.type === 'world').length,
                experience: memories.filter((memory) => memory.type === 'experience').length,
                observation: memories.filter((memory) => memory.type === 'observation').length,
                lastUpdatedAt: memories.length
                    ? Math.max(...memories.map((memory) => memory.updatedAt || memory.mentionedAt))
                    : null,
            },
            sections: {
                observations: sorted.filter((memory) => memory.type === 'observation').slice(0, limit),
                facts: sorted.filter((memory) => memory.type === 'world').slice(0, limit),
                recent: sorted.filter((memory) => memory.type === 'experience').slice(0, limit),
                searchResults: searchResult.records,
                raw: sorted.slice(0, limit),
            },
        };
    }
```

- [ ] **Step 3: Implement count-returning forget wrapper**

Replace the body of `forgetMemory(field: string)` in `src/memory/memory-manager.ts` with:

```ts
    async forgetMemory(field: string): Promise<MemoryMutationResult> {
        await this.ready();
        const before = (await this.hindsightStore.listMemories()).length;
        const normalizedField = field.trim().toLowerCase() as ForgetMemoryField;
        if (normalizedField === 'all') {
            await this.hindsightStore.clearMemories();
            const after = (await this.hindsightStore.listMemories()).length;
            return {
                success: true,
                deletedCount: before - after,
                message: 'Cleared all remembered Hindsight memory.',
            };
        }

        await this.hindsightStore.deleteMemories((memory) => this.shouldForgetHindsightMemory(memory, normalizedField));
        const after = (await this.hindsightStore.listMemories()).length;
        return {
            success: true,
            deletedCount: before - after,
            message: `Forgot memory field: ${normalizedField}`,
        };
    }
```

Existing callers that ignore the returned value keep working.

- [ ] **Step 4: Add single-id deletion method**

Add after `forgetMemory(...)`:

```ts
    async deleteMemoryById(id: string): Promise<MemoryMutationResult> {
        await this.ready();
        const target = id.trim();
        if (!target) {
            return { success: false, deletedCount: 0, message: 'Missing memory id.' };
        }
        const before = (await this.hindsightStore.listMemories()).length;
        await this.hindsightStore.deleteMemories((memory) => memory.id === target);
        const after = (await this.hindsightStore.listMemories()).length;
        return {
            success: before !== after,
            deletedCount: before - after,
            message: before !== after ? `Deleted memory: ${target}` : `Memory not found: ${target}`,
        };
    }
```

- [ ] **Step 5: Add deletion tests**

Append inside `runTests()` in `test/memory-manager.test.ts`:

```ts
  await test('deleteMemoryById removes one retained memory', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'My project LaunchPlan needs memory row deletion.',
      assistantMessage: 'Captured LaunchPlan deletion need.',
      now: 1000,
    });
    const before = await (memory as any).getMemoryView({ mode: 'raw' });
    const targetId = before.sections.raw[0].id;

    const result = await (memory as any).deleteMemoryById(targetId);
    const after = await (memory as any).getMemoryView({ mode: 'raw' });

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(after.sections.raw.some((record: any) => record.id === targetId)).toBe(false);
  });
```

- [ ] **Step 6: Run memory tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/memory/memory-manager.ts test/memory-manager.test.ts
git commit -m "feat: expose memory view and deletion APIs"
```

---

### Task 3: Expose Memory APIs Through ModelService

**Files:**
- Modify: `src/services/model-service.ts`
- Test: `test/model-service.test.ts`

- [ ] **Step 1: Add failing facade test**

Append inside `runTests()` in `test/model-service.test.ts`:

```ts
  await test('ModelService exposes memory view and memory deletion facade methods', async () => {
    const service = createServiceWithSettings({ privacyMode: true } as any);
    (service as any).memoryManager = {
      getMemoryView: async (request: any) => ({ request, stats: { total: 0 }, sections: {} }),
      deleteMemoryById: async (id: string) => ({ success: true, deletedCount: 1, message: id }),
      forgetMemory: async (field: string) => ({ success: true, deletedCount: 2, message: field }),
    };

    const view = await (service as any).getMemoryView({ mode: 'observations', limit: 3 });
    const deleted = await (service as any).deleteMemoryById('mem_1');
    const forgotten = await (service as any).forgetMemory('projects');

    expect(view.request.mode).toBe('observations');
    expect(deleted.deletedCount).toBe(1);
    expect(forgotten.deletedCount).toBe(2);
  });
```

Use the existing service factory helper in `test/model-service.test.ts`; if it is named differently, keep the assertions and substitute the current helper.

- [ ] **Step 2: Run model-service test to confirm failure**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: FAIL because `getMemoryView` and `deleteMemoryById` are missing.

- [ ] **Step 3: Add imports**

Add to `src/services/model-service.ts`:

```ts
import { MemoryMutationResult, MemoryView, MemoryViewRequest } from '../memory/types';
```

- [ ] **Step 4: Add facade methods**

Add after `getUserProfile()`:

```ts
    async getMemoryView(request: MemoryViewRequest = {}): Promise<MemoryView | null> {
        return this.memoryManager ? await this.memoryManager.getMemoryView(request) : null;
    }
```

Change `forgetMemory(field: string)` to return the result:

```ts
    async forgetMemory(field: string): Promise<MemoryMutationResult | null> {
        return this.memoryManager ? await this.memoryManager.forgetMemory(field) : null;
    }
```

Add after `forgetMemory(...)`:

```ts
    async deleteMemoryById(id: string): Promise<MemoryMutationResult | null> {
        return this.memoryManager ? await this.memoryManager.deleteMemoryById(id) : null;
    }
```

- [ ] **Step 5: Run model-service tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/model-service.ts test/model-service.test.ts
git commit -m "feat: expose memory management facades"
```

---

### Task 4: Implement `/memory` Shell Command And Compatibility Aliases

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/runtime/chat-runtime.ts`
- Test: `test/chat-controller.test.ts`
- Test: `test/chat-runtime.test.ts`

- [ ] **Step 1: Add failing command tests**

Append inside `runTests()` in `test/chat-controller.test.ts`:

```ts
  await test('/memory renders overview from memory view', async () => {
    const messages: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: createMemoryCommandApi({
        getMemoryView: async () => sampleMemoryView(),
      }),
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/memory');

    expect(messages[messages.length - 1].content).toContain('## Memory');
    expect(messages[messages.length - 1].content).toContain('Total: 3');
    controller.cleanup();
  });

  await test('/memory search forwards query to memory view', async () => {
    const messages: any[] = [];
    const calls: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: createMemoryCommandApi({
        getMemoryView: async (request: any) => {
          calls.push(request);
          return sampleMemoryView({
            searchResults: [sampleMemoryRecord('mem_search', 'world', 'User works on LaunchPlan.')],
          });
        },
      }),
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/memory search LaunchPlan');

    expect(calls[0].mode).toBe('search');
    expect(calls[0].query).toBe('LaunchPlan');
    expect(messages[messages.length - 1].content).toContain('User works on LaunchPlan.');
    controller.cleanup();
  });

  await test('/memory forget delegates to existing forget flow', async () => {
    const calls: any[] = [];
    const messages: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: createMemoryCommandApi({
        getUserProfile: () => null,
        forgetMemory: async (field: string) => {
          calls.push(field);
          return { success: true, deletedCount: 2, message: `Forgot ${field}` };
        },
      }),
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/memory forget projects');

    expect(calls[0]).toBe('projects');
    expect(messages[messages.length - 1].content).toContain('Forgot projects');
    controller.cleanup();
  });
```

Add helpers near other test helpers in `test/chat-controller.test.ts`:

```ts
function sampleMemoryRecord(id: string, type: string, text: string) {
  return {
    id,
    type,
    text,
    confidence: 0.8,
    tags: ['project'],
    entities: [],
    source: { kind: 'chat' },
    bankId: 'default',
    normalizedText: text.toLowerCase(),
    createdAt: 1,
    updatedAt: 2,
    mentionedAt: 2,
    accessCount: 0,
  };
}

function sampleMemoryView(overrides: any = {}) {
  return {
    privacyMode: false,
    legacyProfile: {
      name: '',
      profession: 'Engineer',
      expertise: ['Obsidian'],
      preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
      workflows: [],
      context: { currentProjects: ['Memory'], goals: ['Ship memory'], challenges: [] },
      metadata: { createdAt: 1, updatedAt: 2, totalInteractions: 3, lastProfileUpdate: 2 },
    },
    stats: { total: 3, world: 1, experience: 1, observation: 1, lastUpdatedAt: 2 },
    sections: {
      observations: [sampleMemoryRecord('mem_obs', 'observation', 'User prefers local-first memory.')],
      facts: [sampleMemoryRecord('mem_fact', 'world', 'User stated: My project is Memory.')],
      recent: [sampleMemoryRecord('mem_exp', 'experience', 'User asked: How does memory work?')],
      searchResults: overrides.searchResults || [],
      raw: [],
    },
  };
}

function createMemoryCommandApi(overrides: any = {}) {
  return {
    getSkillCommands: () => [],
    executeSlashSkillCommand: async () => ({ success: true }),
    getUserProfile: () => null,
    getMemoryView: async () => sampleMemoryView(),
    updateProfile: async () => undefined,
    forgetMemory: async (field: string) => ({ success: true, deletedCount: 0, message: field }),
    getAvailableTools: () => [],
    clearSession: async () => undefined,
    ...overrides,
  } as any;
}
```

- [ ] **Step 2: Run controller tests to confirm failure**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected: FAIL because `/memory` is unknown.

- [ ] **Step 3: Add `/memory` switch cases**

In `src/ui/chat-controller.ts`, change the local command switch:

```ts
            case '/memory':
                await this.handleMemory(argStr);
                break;
            case '/profile':
                await this.handleMemory(argStr || 'overview', '/profile');
                break;
```

Change `/forget` case:

```ts
            case '/forget':
                await this.handleMemory(`forget ${argStr}`.trim(), '/forget');
                break;
```

- [ ] **Step 4: Add memory command helpers**

Add before `handleForget(...)`:

```ts
    private async handleMemory(argStr: string, legacyAlias?: string) {
        const parsed = this.parseMemoryArgs(argStr);
        if (parsed.action === 'forget') {
            await this.handleMemoryForget(parsed.query || '', legacyAlias);
            return;
        }

        if (parsed.action === 'search' && !parsed.query) {
            this.addMessage('system', 'Usage: `/memory search <query>`');
            return;
        }

        if (typeof (this.api as any).getMemoryView !== 'function') {
            this.addMessage('system', 'Memory view is not available.');
            return;
        }

        const view = await (this.api as any).getMemoryView({
            mode: parsed.action,
            query: parsed.query,
            limit: parsed.action === 'overview' ? 5 : 10,
        });
        if (!view) {
            this.addMessage('system', 'No memory data available.');
            return;
        }

        const content = this.renderMemoryView(view, parsed.action, parsed.query);
        this.addMessage('system', legacyAlias ? `${this.renderAliasNote(legacyAlias)}\n\n${content}` : content);
    }

    private parseMemoryArgs(argStr: string): { action: string; query?: string } {
        const trimmed = argStr.trim();
        if (!trimmed || trimmed === 'overview') return { action: 'overview' };
        const [first, ...rest] = trimmed.split(/\s+/);
        if (['observations', 'facts', 'recent', 'raw'].includes(first)) return { action: first };
        if (first === 'search') return { action: 'search', query: rest.join(' ').trim() };
        if (first === 'forget') return { action: 'forget', query: rest.join(' ').trim() };
        return { action: 'search', query: trimmed };
    }

    private async handleMemoryForget(field: string, legacyAlias?: string) {
        const normalized = field.trim().toLowerCase();
        if (!normalized) {
            this.addMessage('system', 'Usage: `/memory forget <field>` or `/memory forget all`');
            return;
        }

        const profile = this.api.getUserProfile();
        if (normalized === 'all' && profile) {
            await this.api.updateProfile({
                name: '',
                profession: '',
                expertise: [],
                preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
                workflows: [],
                context: { currentProjects: [], goals: [], challenges: [] },
            });
        } else if (profile) {
            await this.clearLegacyProfileField(normalized, profile);
        }

        const result = typeof (this.api as any).forgetMemory === 'function'
            ? await (this.api as any).forgetMemory(normalized)
            : null;
        const message = result?.message || (normalized === 'all'
            ? 'Cleared all remembered user data.'
            : `Forgot memory field: ${normalized}`);
        this.addMessage('system', legacyAlias ? `${this.renderAliasNote(legacyAlias)}\n\n${message}` : message);
    }

    private async clearLegacyProfileField(field: string, profile: any) {
        if (field === 'name') await this.api.updateProfile({ name: '' });
        else if (field === 'profession') await this.api.updateProfile({ profession: '' });
        else if (field === 'expertise') await this.api.updateProfile({ expertise: [] });
        else if (field === 'preferences') await this.api.updateProfile({ preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] } });
        else if (field === 'workflows') await this.api.updateProfile({ workflows: [] });
        else if (field === 'projects') await this.api.updateProfile({ context: { ...profile.context, currentProjects: [] } });
        else if (field === 'goals') await this.api.updateProfile({ context: { ...profile.context, goals: [] } });
    }

    private renderAliasNote(alias: string): string {
        return `Note: \`${alias}\` is supported for compatibility. Use \`/memory\` for memory commands.`;
    }
```

- [ ] **Step 5: Add render helpers**

Add after the methods from Step 4:

```ts
    private renderMemoryView(view: any, mode: string, query?: string): string {
        const title = mode === 'search' ? `## Memory Search: ${query}` : '## Memory';
        const lines = [title, ''];
        lines.push(`Privacy Mode: ${view.privacyMode ? 'On' : 'Off'}`);
        lines.push(`Total: ${view.stats.total} | Facts: ${view.stats.world} | Experiences: ${view.stats.experience} | Observations: ${view.stats.observation}`);
        if (view.stats.lastUpdatedAt) lines.push(`Last Updated: ${new Date(view.stats.lastUpdatedAt).toLocaleString()}`);

        if (mode === 'observations') this.appendMemoryRecords(lines, 'Observations', view.sections.observations, true);
        else if (mode === 'facts') this.appendMemoryRecords(lines, 'Facts', view.sections.facts, true);
        else if (mode === 'recent') this.appendMemoryRecords(lines, 'Recent Experiences', view.sections.recent, true);
        else if (mode === 'raw') this.appendMemoryRecords(lines, 'Raw Memories', view.sections.raw, true);
        else if (mode === 'search') this.appendMemoryRecords(lines, 'Search Results', view.sections.searchResults, true);
        else {
            this.appendLegacyProfileSummary(lines, view.legacyProfile);
            this.appendMemoryRecords(lines, 'Top Observations', view.sections.observations, false);
            this.appendMemoryRecords(lines, 'Recent Durable Facts', view.sections.facts, false);
        }

        return lines.join('\n');
    }

    private appendLegacyProfileSummary(lines: string[], profile: any) {
        if (!profile) return;
        const items = [];
        if (profile.name) items.push(`Name: ${profile.name}`);
        if (profile.profession) items.push(`Profession: ${profile.profession}`);
        if (profile.expertise?.length) items.push(`Expertise: ${profile.expertise.join(', ')}`);
        if (profile.context?.currentProjects?.length) items.push(`Projects: ${profile.context.currentProjects.join(', ')}`);
        if (profile.context?.goals?.length) items.push(`Goals: ${profile.context.goals.join(', ')}`);
        if (items.length) lines.push('', '### Legacy Profile', ...items.map((item) => `- ${item}`));
    }

    private appendMemoryRecords(lines: string[], title: string, records: any[], showMeta: boolean) {
        lines.push('', `### ${title}`);
        if (!records || records.length === 0) {
            lines.push('- No matching memories.');
            return;
        }
        for (const record of records) {
            const text = this.truncateMemoryText(record.text || '', 220);
            const meta = showMeta
                ? ` _(id: ${record.id}, type: ${record.type}, confidence: ${Number(record.confidence || 0).toFixed(2)})_`
                : '';
            lines.push(`- ${text}${meta}`);
        }
    }

    private truncateMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }
```

- [ ] **Step 6: Update suggestions and slash contract**

In `src/ui/shell-view.ts`, replace `/profile` and `/forget` suggestions with:

```ts
{ label: '/memory', desc: 'View, search, and forget Hindsight memory' },
```

In `src/runtime/chat-runtime.ts`, replace local command entries:

```ts
{ command: '/memory [overview|observations|search <query>|forget <field>]', description: 'View, search, or forget Hindsight memory' },
```

Do not list `/profile` or `/forget` in `LOCAL_SLASH_COMMANDS`; they remain controller aliases, but the model should not recommend them.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/chat-controller.ts src/ui/shell-view.ts src/runtime/chat-runtime.ts test/chat-controller.test.ts test/chat-runtime.test.ts
git commit -m "feat: add memory shell command"
```

---

### Task 5: Register Settings → Memory Section

**Files:**
- Modify: `src/settings.ts`
- Test: `test/settings-state.test.ts`

- [ ] **Step 1: Add failing settings state tests**

Append inside `runTests()` in `test/settings-state.test.ts`:

```ts
  await test('settings search exposes the Memory section', () => {
    const { getMatchingSettingsSections } = require('../src/settings');
    expect(getMatchingSettingsSections('memory')).toEqual(['memory']);
  });

  await test('marks Memory as private when privacy mode is enabled', () => {
    const settings = cloneSettings();
    settings.privacyMode = true;

    const statuses = getSettingsSectionStatuses(settings);

    expect(statuses.memory).toEqual({ label: 'Private', tone: 'accent' });
  });
```

If CommonJS `require` is not acceptable in this test file, add `getMatchingSettingsSections` to the top-level import from `../src/settings` and call it directly.

- [ ] **Step 2: Run settings test to confirm failure**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/settings-state.test.ts
```

Expected: FAIL because `memory` section does not exist.

- [ ] **Step 3: Add section id and metadata**

In `src/settings.ts`, extend `SettingsSectionId`:

```ts
    | 'memory'
```

Add this object in `SETTINGS_SECTIONS` after `runtime`:

```ts
    {
        id: 'memory',
        title: 'Memory',
        description: 'Local Hindsight memory, recall, retention, and deletion.',
        keywords: ['memory', 'hindsight', 'recall', 'forget', 'profile', 'privacy', 'observation'],
    },
```

- [ ] **Step 4: Add status**

In `getSettingsSectionStatuses(...)`, add:

```ts
    if (settings.privacyMode) {
        statuses.memory = { label: 'Private', tone: 'accent' };
    }
```

- [ ] **Step 5: Route section render**

In `renderSectionContent(...)`, add:

```ts
            case 'memory':
                this.renderMemorySection(containerEl);
                return;
```

Add a placeholder method that renders the privacy toggle only:

```ts
    private renderMemorySection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Privacy Mode')
            .setDesc('When enabled, new conversation turns are not retained as Hindsight memory.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.privacyMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.privacyMode = value;
                    await this.persistSettings();
                    this.display();
                }));
    }
```

- [ ] **Step 6: Remove duplicate privacy toggle from Guardian**

Remove the existing `Privacy Mode` `new Setting(...)` block from `renderGuardianSection(...)`. The setting now belongs to Memory because current runtime usage is memory retention.

- [ ] **Step 7: Run settings test**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/settings-state.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts test/settings-state.test.ts
git commit -m "feat: add memory settings section"
```

---

### Task 6: Build Settings Memory Panel Prototype

**Files:**
- Modify: `src/settings.ts`
- Modify: `styles.css`
- Test: `test/settings-state.test.ts`

- [ ] **Step 1: Add state fields to SettingTab**

In `SettingTab`, add private fields near other state:

```ts
    private memoryView: any = null;
    private memorySearchQuery = '';
    private memoryActiveTab: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = 'overview';
    private memoryLoading = false;
    private memoryError = '';
```

- [ ] **Step 2: Replace `renderMemorySection` with full panel**

Replace the placeholder `renderMemorySection(...)` with:

```ts
    private renderMemorySection(containerEl: HTMLElement): void {
        const toolbar = containerEl.createDiv({ cls: 'baizer-memory-toolbar' });
        new Setting(toolbar)
            .setName('Privacy Mode')
            .setDesc('When enabled, new conversation turns are not retained as Hindsight memory.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.privacyMode)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.privacyMode = value;
                    await this.persistSettings();
                    void this.refreshMemoryView();
                }));

        toolbar.createDiv({
            cls: 'baizer-memory-path',
            text: 'Data folder: .obsidian/baizer-memory',
        });

        const actions = containerEl.createDiv({ cls: 'baizer-settings-actions' });
        this.createActionButton(actions, this.memoryLoading ? 'Refreshing...' : 'Refresh', async () => {
            await this.refreshMemoryView();
        }, 'default', this.memoryLoading);

        this.renderMemoryStats(containerEl);
        this.renderMemorySearch(containerEl);
        this.renderMemoryTabs(containerEl);
        this.renderMemoryList(containerEl);
        this.renderMemoryDangerZone(containerEl);

        if (!this.memoryView && !this.memoryLoading) {
            void this.refreshMemoryView();
        }
    }
```

- [ ] **Step 3: Add refresh and search helpers**

Add after `renderMemorySection(...)`:

```ts
    private async refreshMemoryView(mode: 'overview' | 'observations' | 'facts' | 'recent' | 'search' = this.memoryActiveTab): Promise<void> {
        if (typeof this.plugin.modelService?.getMemoryView !== 'function') {
            this.memoryError = 'Memory service is not available.';
            this.display();
            return;
        }
        this.memoryLoading = true;
        this.memoryError = '';
        this.display();
        try {
            this.memoryView = await this.plugin.modelService.getMemoryView({
                mode,
                query: mode === 'search' ? this.memorySearchQuery : undefined,
                limit: 25,
            });
        } catch (error: any) {
            this.memoryError = error?.message || 'Failed to load memory.';
        } finally {
            this.memoryLoading = false;
            this.display();
        }
    }

    private getVisibleMemoryRecords(): any[] {
        const sections = this.memoryView?.sections;
        if (!sections) return [];
        if (this.memoryActiveTab === 'observations') return sections.observations || [];
        if (this.memoryActiveTab === 'facts') return sections.facts || [];
        if (this.memoryActiveTab === 'recent') return sections.recent || [];
        if (this.memoryActiveTab === 'search') return sections.searchResults || [];
        return [...(sections.observations || []), ...(sections.facts || [])].slice(0, 10);
    }
```

- [ ] **Step 4: Add render helpers**

Add:

```ts
    private renderMemoryStats(containerEl: HTMLElement): void {
        const stats = this.memoryView?.stats;
        const row = containerEl.createDiv({ cls: 'baizer-memory-stats' });
        this.createMemoryStat(row, 'Total', stats?.total ?? 0);
        this.createMemoryStat(row, 'Facts', stats?.world ?? 0);
        this.createMemoryStat(row, 'Experiences', stats?.experience ?? 0);
        this.createMemoryStat(row, 'Observations', stats?.observation ?? 0);
    }

    private createMemoryStat(parent: HTMLElement, label: string, value: number): void {
        const item = parent.createDiv({ cls: 'baizer-memory-stat' });
        item.createDiv({ cls: 'baizer-memory-stat-value', text: String(value) });
        item.createDiv({ cls: 'baizer-memory-stat-label', text: label });
    }

    private renderMemorySearch(containerEl: HTMLElement): void {
        const row = containerEl.createDiv({ cls: 'baizer-memory-search' });
        const input = row.createEl('input', {
            cls: 'baizer-settings-search',
            attr: { type: 'search', placeholder: 'Search memories' },
        }) as HTMLInputElement;
        input.value = this.memorySearchQuery;
        input.addEventListener('input', () => {
            this.memorySearchQuery = input.value;
        });
        this.createActionButton(row, 'Search', async () => {
            this.memoryActiveTab = 'search';
            await this.refreshMemoryView('search');
        }, 'accent', !this.memorySearchQuery.trim());
    }

    private renderMemoryTabs(containerEl: HTMLElement): void {
        const tabs = containerEl.createDiv({ cls: 'baizer-memory-tabs' });
        const entries: Array<[typeof this.memoryActiveTab, string]> = [
            ['overview', 'Overview'],
            ['observations', 'Observations'],
            ['facts', 'Facts'],
            ['recent', 'Recent'],
            ['search', 'Search Results'],
        ];
        for (const [id, label] of entries) {
            const button = tabs.createEl('button', {
                text: label,
                cls: `baizer-memory-tab${this.memoryActiveTab === id ? ' is-active' : ''}`,
                attr: { type: 'button' },
            });
            button.addEventListener('click', () => {
                this.memoryActiveTab = id;
                void this.refreshMemoryView(id);
            });
        }
    }
```

- [ ] **Step 5: Add list and danger-zone helpers**

Add:

```ts
    private renderMemoryList(containerEl: HTMLElement): void {
        if (this.memoryError) {
            containerEl.createDiv({ cls: 'baizer-settings-inline-note is-warning', text: this.memoryError });
            return;
        }
        const list = containerEl.createDiv({ cls: 'baizer-memory-list' });
        const records = this.getVisibleMemoryRecords();
        if (records.length === 0) {
            list.createDiv({ cls: 'baizer-settings-empty-state', text: this.memoryLoading ? 'Loading memory...' : 'No memories to show.' });
            return;
        }
        for (const record of records) {
            const row = list.createDiv({ cls: 'baizer-memory-row' });
            const meta = row.createDiv({ cls: 'baizer-memory-row-meta' });
            meta.createSpan({ cls: `baizer-memory-type is-${record.type}`, text: record.type });
            meta.createSpan({ text: `confidence ${Number(record.confidence || 0).toFixed(2)}` });
            meta.createSpan({ text: `updated ${new Date(record.updatedAt || record.mentionedAt).toLocaleString()}` });
            row.createDiv({ cls: 'baizer-memory-row-text', text: this.truncateSettingMemoryText(record.text || '', 260) });
            if (record.tags?.length) row.createDiv({ cls: 'baizer-memory-row-tags', text: `tags: ${record.tags.join(', ')}` });
            this.createActionButton(row, 'Delete', async () => {
                await this.deleteMemoryRecord(record.id);
            }, 'danger');
        }
    }

    private renderMemoryDangerZone(containerEl: HTMLElement): void {
        const zone = containerEl.createDiv({ cls: 'baizer-memory-danger' });
        zone.createDiv({ cls: 'baizer-settings-workspace-title', text: 'Danger Zone' });
        zone.createDiv({ cls: 'baizer-settings-workspace-subtitle', text: 'Clear all remembered Hindsight memory.' });
        this.createActionButton(zone, 'Clear Memory', async () => {
            await this.clearAllMemory();
        }, 'danger');
    }

    private truncateSettingMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }
```

- [ ] **Step 6: Add mutation handlers**

Add:

```ts
    private async deleteMemoryRecord(id: string): Promise<void> {
        if (typeof this.plugin.modelService?.deleteMemoryById !== 'function') {
            new Notice('Memory deletion is not available.');
            return;
        }
        const result = await this.plugin.modelService.deleteMemoryById(id);
        new Notice(result?.message || `Deleted memory: ${id}`);
        await this.refreshMemoryView();
    }

    private async clearAllMemory(): Promise<void> {
        if (typeof this.plugin.modelService?.forgetMemory !== 'function') {
            new Notice('Memory clearing is not available.');
            return;
        }
        const result = await this.plugin.modelService.forgetMemory('all');
        new Notice(result?.message || 'Cleared all remembered Hindsight memory.');
        await this.refreshMemoryView();
    }
```

- [ ] **Step 7: Add styles**

Add near existing settings styles in `styles.css`:

```css
.baizer-memory-toolbar,
.baizer-memory-search,
.baizer-memory-danger {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
}

.baizer-memory-path {
    color: var(--text-muted);
    font-size: 12px;
}

.baizer-memory-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 12px 0;
}

.baizer-memory-stat {
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 10px 12px;
}

.baizer-memory-stat-value {
    font-size: 18px;
    font-weight: 700;
}

.baizer-memory-stat-label,
.baizer-memory-row-meta,
.baizer-memory-row-tags {
    color: var(--text-muted);
    font-size: 12px;
}

.baizer-memory-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 12px 0;
}

.baizer-memory-tab {
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-primary);
    color: var(--text-muted);
    padding: 6px 10px;
}

.baizer-memory-tab.is-active {
    color: var(--text-normal);
    border-color: var(--interactive-accent);
}

.baizer-memory-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.baizer-memory-row {
    border-top: 1px solid var(--background-modifier-border);
    padding: 10px 0;
}

.baizer-memory-row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 6px;
}

.baizer-memory-row-text {
    color: var(--text-normal);
    line-height: 1.45;
}

.baizer-memory-type {
    border-radius: 999px;
    padding: 2px 7px;
    background: var(--background-modifier-hover);
    color: var(--text-normal);
}

.baizer-memory-danger {
    justify-content: space-between;
    border-top: 1px solid var(--background-modifier-border);
    margin-top: 16px;
}
```

- [ ] **Step 8: Run build smoke test**

Run:

```bash
npm run build
```

Expected: build passes. If TypeScript reports missing method types on `modelService`, adjust `IPlugin` or use guarded `any` consistently in `settings.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/settings.ts styles.css main.js
git commit -m "feat: add memory settings panel"
```

---

### Task 7: Documentation And Command Cleanup

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/runtime.md`
- Test: `test/chat-runtime.test.ts`

- [ ] **Step 1: Update README commands**

Replace README command entries:

```md
- `/memory`
- `/memory search <query>`
- `/memory forget <field|all>`
```

Remove primary listings for `/profile` and `/forget`, or move them to a sentence:

```md
Legacy aliases `/profile` and `/forget` remain available for compatibility.
```

- [ ] **Step 2: Update runtime architecture memory section**

In `docs/architecture/runtime.md`, add:

```md
The primary user-facing command is `/memory`. `/profile` and `/forget` are compatibility aliases and should not be suggested by the runtime slash command contract.
```

- [ ] **Step 3: Update chat-runtime slash command assertion**

In `test/chat-runtime.test.ts`, ensure the command contract test expects `/memory` and does not expect `/profile` or `/forget`.

Use assertions:

```ts
expect(turn.prompt).toContain('/memory');
expect(turn.prompt.includes('/profile')).toBe(false);
expect(turn.prompt.includes('/forget')).toBe(false);
```

- [ ] **Step 4: Run docs-adjacent tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture/runtime.md test/chat-runtime.test.ts
git commit -m "docs: promote memory command"
```

---

### Task 8: Final Verification

**Files:**
- Verify all changed behavior.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/settings-state.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run maintained harness**

Run:

```bash
npm test
```

Expected: all maintained tests PASS.

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected: build passes and regenerates `main.js` if needed.

- [ ] **Step 4: Inspect command references**

Run:

```bash
rg -n '/profile|/forget|/memory' src test README.md docs
```

Expected:

- `/memory` appears in help, autocomplete, runtime contract, docs, and tests.
- `/profile` and `/forget` appear only in compatibility alias code/tests/docs, not as primary suggestions.

- [ ] **Step 5: Inspect diff**

Run:

```bash
git diff --stat
git diff -- src/memory src/services/model-service.ts src/ui/chat-controller.ts src/ui/shell-view.ts src/runtime/chat-runtime.ts src/settings.ts styles.css README.md docs/architecture/runtime.md
```

Expected: changes are scoped to memory APIs, memory command UX, settings panel, docs, tests, and bundle output.

---

## Self-Review

- Spec coverage: The plan covers `/memory` overview/search/observations/forget, compatibility aliases, Settings → Memory prototype, deletion, clear-all, privacy state, autocomplete, help, runtime command contract, docs, and tests.
- Placeholder scan: The plan contains concrete commands, file paths, method signatures, UI structure, styles, and expected outputs.
- Type consistency: `MemoryViewRequest`, `MemoryView`, and `MemoryMutationResult` are introduced before use by `MemoryManager`, `ModelService`, `ChatController`, and `SettingTab`.
- Scope check: This is a single coherent memory UX migration. It does not include future memory banks, retention policies, or import/export.
