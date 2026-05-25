# Memory Profile Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `/profile` from a legacy profile viewer into a read-only Memory Profile command that exposes Hindsight-lite memory stats, observations, and query-aware search.

**Architecture:** Keep storage and ranking inside `src/memory`; expose a read-only profile view through `MemoryManager` and `ModelService`; keep `ChatController` responsible only for slash-command parsing and Markdown rendering. The default command shows a compact overview, while subcommands reuse the same profile view without exposing `HindsightStore` directly to UI code.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing custom `tsx` test harness, current Hindsight-lite memory modules.

---

## File Structure

- Modify: `src/memory/types.ts`
  - Add read-only profile view types used by `MemoryManager`, `ModelService`, and `ChatController`.
- Modify: `src/memory/memory-manager.ts`
  - Add `getMemoryProfileView()` and helper methods that read from `HindsightStore`.
- Modify: `src/services/model-service.ts`
  - Add `getMemoryProfileView()` facade method.
- Modify: `src/ui/chat-controller.ts`
  - Parse `/profile` subcommands and render Markdown output.
- Modify: `test/memory-manager.test.ts`
  - Cover profile view aggregation and search behavior.
- Modify: `test/chat-controller.test.ts`
  - Cover `/profile`, `/profile observations`, and `/profile search <query>`.
- Optional docs update: `README.md`
  - Add one line describing `/profile` subcommands if the UI behavior changes enough to document.

---

### Task 1: Add Memory Profile View Types

**Files:**
- Modify: `src/memory/types.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: Write the failing type-level usage test**

Append this test inside `runTests()` in `test/memory-manager.test.ts`:

```ts
  await test('getMemoryProfileView returns legacy profile and hindsight stats', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'I prefer local-first memory for Baizer.',
      assistantMessage: 'Acknowledged the local-first preference.',
      now: 1000,
    });

    const view = await (memory as any).getMemoryProfileView();

    expect(view.legacyProfile.preferences.responseStyle).toBe('balanced');
    expect(view.stats.total).toBe(2);
    expect(view.stats.world).toBe(1);
    expect(view.stats.experience).toBe(1);
    expect(view.sections.facts.length).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: FAIL because `getMemoryProfileView` is not defined.

- [ ] **Step 3: Add view types**

Add to `src/memory/types.ts`:

```ts
import { MemoryRecord } from './hindsight-types';

export type MemoryProfileMode = 'overview' | 'observations' | 'facts' | 'recent' | 'search' | 'raw';

export interface MemoryProfileRequest {
    mode?: MemoryProfileMode;
    query?: string;
    limit?: number;
    now?: number;
}

export interface MemoryProfileStats {
    total: number;
    world: number;
    experience: number;
    observation: number;
    lastUpdatedAt: number | null;
}

export interface MemoryProfileSections {
    observations: MemoryRecord[];
    facts: MemoryRecord[];
    recent: MemoryRecord[];
    searchResults: MemoryRecord[];
    raw: MemoryRecord[];
}

export interface MemoryProfileView {
    privacyMode: boolean;
    legacyProfile: UserProfile;
    stats: MemoryProfileStats;
    sections: MemoryProfileSections;
}
```

- [ ] **Step 4: Run test to verify failure moves to implementation**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: FAIL because `MemoryManager.getMemoryProfileView` is still missing.

- [ ] **Step 5: Commit**

```bash
git add src/memory/types.ts test/memory-manager.test.ts
git commit -m "test: specify memory profile view shape"
```

---

### Task 2: Implement Read-Only Memory Profile View

**Files:**
- Modify: `src/memory/memory-manager.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: Add imports**

Modify the existing import from `./types` in `src/memory/memory-manager.ts`:

```ts
import {
    UserProfile,
    SessionSummary,
    ChatMessage,
    DEFAULT_USER_PROFILE,
    MemoryProfileRequest,
    MemoryProfileView,
} from './types';
```

- [ ] **Step 2: Add public profile view method**

Insert after `recallForPrompt(...)` in `src/memory/memory-manager.ts`:

```ts
    async getMemoryProfileView(request: MemoryProfileRequest = {}): Promise<MemoryProfileView> {
        await this.ready();
        const limit = Math.max(1, Math.min(request.limit ?? 5, 25));
        const memories = await this.hindsightStore.listMemories(DEFAULT_MEMORY_BANK_ID);
        const sorted = [...memories].sort((a, b) => b.mentionedAt - a.mentionedAt);
        const searchResult = request.query?.trim()
            ? await this.hindsightRetriever.recall({
                query: request.query.trim(),
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

- [ ] **Step 3: Run memory manager tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: PASS for the new profile view test and all existing memory manager tests.

- [ ] **Step 4: Add search-specific test**

Append this test inside `runTests()` in `test/memory-manager.test.ts`:

```ts
  await test('getMemoryProfileView search returns query-ranked memories', async () => {
    const promptLog: string[] = [];
    const { app } = createApp();
    const memory = new MemoryManager(app, createModelProvider(promptLog));
    await memory.ready();

    await (memory as any).retainTurn({
      userMessage: 'My project LaunchPlan uses query-aware memory search.',
      assistantMessage: 'Captured LaunchPlan as a memory project.',
      now: 2000,
    });

    const view = await (memory as any).getMemoryProfileView({
      mode: 'search',
      query: 'LaunchPlan query-aware',
      limit: 3,
      now: 3000,
    });

    expect(view.sections.searchResults.length > 0).toBe(true);
    expect(view.sections.searchResults[0].text).toContain('LaunchPlan');
  });
```

- [ ] **Step 5: Run memory manager tests again**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/memory-manager.ts test/memory-manager.test.ts
git commit -m "feat: expose memory profile view"
```

---

### Task 3: Expose Profile View Through ModelService

**Files:**
- Modify: `src/services/model-service.ts`
- Test: `test/model-service.test.ts`

- [ ] **Step 1: Write failing facade test**

Append inside `runTests()` in `test/model-service.test.ts`:

```ts
  await test('ModelService exposes memory profile view when memory is available', async () => {
    const service = createServiceWithSettings({
      privacyMode: true,
    } as any);
    const expected = { stats: { total: 0 }, sections: {} };
    (service as any).memoryManager = {
      getMemoryProfileView: async (request: any) => ({
        ...expected,
        request,
      }),
    };

    const view = await (service as any).getMemoryProfileView({ mode: 'observations', limit: 3 });

    expect(view.request.mode).toBe('observations');
    expect(view.request.limit).toBe(3);
  });
```

If `createServiceWithSettings` is not available in this test file, use the existing local helper that creates `ModelService` instances; keep the assertion body identical.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: FAIL because `getMemoryProfileView` is missing.

- [ ] **Step 3: Add imports and facade method**

Add to `src/services/model-service.ts` imports:

```ts
import { MemoryProfileRequest, MemoryProfileView } from '../memory/types';
```

Add after `getUserProfile()`:

```ts
    async getMemoryProfileView(request: MemoryProfileRequest = {}): Promise<MemoryProfileView | null> {
        return this.memoryManager
            ? await this.memoryManager.getMemoryProfileView(request)
            : null;
    }
```

- [ ] **Step 4: Run facade test**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/model-service.ts test/model-service.test.ts
git commit -m "feat: expose memory profile through model service"
```

---

### Task 4: Render `/profile` Overview, Observations, and Search

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: Add failing controller tests**

Append inside `runTests()` in `test/chat-controller.test.ts`:

```ts
  await test('/profile renders memory stats and observations when profile view is available', async () => {
    const messages: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => null,
        getMemoryProfileView: async () => ({
          privacyMode: false,
          legacyProfile: {
            name: '',
            profession: 'Engineer',
            expertise: ['Obsidian'],
            preferences: { language: 'zh-CN', responseStyle: 'balanced', topics: [] },
            workflows: [],
            context: { currentProjects: ['Memory'], goals: ['Ship profile'], challenges: [] },
            metadata: { createdAt: 1, updatedAt: 2, totalInteractions: 3, lastProfileUpdate: 2 },
          },
          stats: { total: 3, world: 1, experience: 1, observation: 1, lastUpdatedAt: 2000 },
          sections: {
            observations: [{ id: 'mem_obs', type: 'observation', text: 'User prefers local-first memory.', confidence: 0.75, tags: ['observation'], entities: [], source: { kind: 'manual' }, bankId: 'default', normalizedText: '', createdAt: 1, updatedAt: 2, mentionedAt: 2, accessCount: 0 }],
            facts: [],
            recent: [],
            searchResults: [],
            raw: [],
          },
        }),
        updateProfile: async () => undefined,
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/profile');

    const content = messages[messages.length - 1].content;
    expect(content).toContain('Memory Profile');
    expect(content).toContain('Total: 3');
    expect(content).toContain('User prefers local-first memory.');
    controller.cleanup();
  });

  await test('/profile search passes query to memory profile view', async () => {
    const messages: any[] = [];
    const calls: any[] = [];
    const controller = new ChatController({
      app: {} as any,
      api: {
        getSkillCommands: () => [],
        executeSlashSkillCommand: async () => ({ success: true }),
        getUserProfile: () => null,
        getMemoryProfileView: async (request: any) => {
          calls.push(request);
          return {
            privacyMode: false,
            legacyProfile: null,
            stats: { total: 1, world: 1, experience: 0, observation: 0, lastUpdatedAt: 1 },
            sections: {
              observations: [],
              facts: [],
              recent: [],
              searchResults: [{ id: 'mem_launch', type: 'world', text: 'User works on LaunchPlan.', confidence: 0.8, tags: ['project'], entities: ['LaunchPlan'], source: { kind: 'chat' }, bankId: 'default', normalizedText: '', createdAt: 1, updatedAt: 1, mentionedAt: 1, accessCount: 0 }],
              raw: [],
            },
          };
        },
        updateProfile: async () => undefined,
        getAvailableTools: () => [],
        clearSession: async () => undefined,
      } as any,
      onMessageAdded: (message) => messages.push(message),
    });

    await controller.processCommand('/profile search LaunchPlan');

    expect(calls[0].mode).toBe('search');
    expect(calls[0].query).toBe('LaunchPlan');
    expect(messages[messages.length - 1].content).toContain('User works on LaunchPlan.');
    controller.cleanup();
  });
```

- [ ] **Step 2: Run controller tests to verify they fail**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected: FAIL because `/profile` does not call `getMemoryProfileView`.

- [ ] **Step 3: Replace `/profile` case**

In `src/ui/chat-controller.ts`, replace the current `/profile` case with:

```ts
            case '/profile':
                await this.handleProfile(argStr);
                break;
```

- [ ] **Step 4: Add profile command helpers**

Add these private methods before `handleForget(...)`:

```ts
    private async handleProfile(argStr: string) {
        const parsed = this.parseProfileArgs(argStr);
        if (typeof (this.api as any).getMemoryProfileView === 'function') {
            const view = await (this.api as any).getMemoryProfileView(parsed);
            if (view) {
                this.addMessage('system', this.renderMemoryProfile(view, parsed.mode || 'overview'));
                return;
            }
        }

        const profile = this.api.getUserProfile();
        if (profile) {
            let text = '## User Profile\n\n';
            if (profile.name) text += `**Name**: ${profile.name}\n`;
            if (profile.profession) text += `**Profession**: ${profile.profession}\n`;
            if (profile.expertise?.length) text += `**Expertise**: ${profile.expertise.join(', ')}\n`;
            this.addMessage('system', text);
        } else {
            this.addMessage('system', 'No profile data available.');
        }
    }

    private parseProfileArgs(argStr: string) {
        const trimmed = argStr.trim();
        if (!trimmed) return { mode: 'overview', limit: 5 };
        const [first, ...rest] = trimmed.split(/\s+/);
        if (first === 'observations') return { mode: 'observations', limit: 10 };
        if (first === 'facts') return { mode: 'facts', limit: 10 };
        if (first === 'recent') return { mode: 'recent', limit: 10 };
        if (first === 'raw') return { mode: 'raw', limit: 10 };
        if (first === 'search') return { mode: 'search', query: rest.join(' ').trim(), limit: 10 };
        return { mode: 'search', query: trimmed, limit: 10 };
    }

    private renderMemoryProfile(view: any, mode: string): string {
        const lines: string[] = ['## Memory Profile', ''];
        lines.push(`Privacy Mode: ${view.privacyMode ? 'On' : 'Off'}`);
        lines.push(`Total: ${view.stats.total} | World: ${view.stats.world} | Experience: ${view.stats.experience} | Observations: ${view.stats.observation}`);
        if (view.stats.lastUpdatedAt) {
            lines.push(`Last Updated: ${new Date(view.stats.lastUpdatedAt).toLocaleString()}`);
        }

        const profile = view.legacyProfile;
        if (profile) {
            const legacy: string[] = [];
            if (profile.name) legacy.push(`Name: ${profile.name}`);
            if (profile.profession) legacy.push(`Profession: ${profile.profession}`);
            if (profile.expertise?.length) legacy.push(`Expertise: ${profile.expertise.join(', ')}`);
            if (profile.context?.currentProjects?.length) legacy.push(`Projects: ${profile.context.currentProjects.join(', ')}`);
            if (profile.context?.goals?.length) legacy.push(`Goals: ${profile.context.goals.join(', ')}`);
            if (legacy.length) {
                lines.push('', '### Legacy Profile', ...legacy.map((item) => `- ${item}`));
            }
        }

        if (mode === 'observations') {
            this.appendMemoryRecords(lines, 'Observations', view.sections.observations, true);
        } else if (mode === 'facts') {
            this.appendMemoryRecords(lines, 'Facts', view.sections.facts, true);
        } else if (mode === 'recent') {
            this.appendMemoryRecords(lines, 'Recent Experiences', view.sections.recent, true);
        } else if (mode === 'raw') {
            this.appendMemoryRecords(lines, 'Raw Memories', view.sections.raw, true);
        } else if (mode === 'search') {
            this.appendMemoryRecords(lines, 'Search Results', view.sections.searchResults, true);
        } else {
            this.appendMemoryRecords(lines, 'Top Observations', view.sections.observations, false);
            this.appendMemoryRecords(lines, 'Recent Durable Facts', view.sections.facts, false);
        }

        return lines.join('\n');
    }

    private appendMemoryRecords(lines: string[], title: string, records: any[], showMeta: boolean) {
        lines.push('', `### ${title}`);
        if (!records || records.length === 0) {
            lines.push('- No matching memories.');
            return;
        }

        for (const record of records) {
            const text = this.truncateProfileMemoryText(record.text || '', 220);
            const meta = showMeta
                ? ` _(id: ${record.id}, type: ${record.type}, confidence: ${Number(record.confidence || 0).toFixed(2)})_`
                : '';
            lines.push(`- ${text}${meta}`);
        }
    }

    private truncateProfileMemoryText(text: string, max: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
    }
```

- [ ] **Step 5: Run controller tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/chat-controller.ts test/chat-controller.test.ts
git commit -m "feat: render hindsight memory profile command"
```

---

### Task 5: Update Help Text And Documentation

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Modify: `README.md`
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: Update command list entries**

In `src/ui/chat-controller.ts`, change the command suggestion/help text for `/profile` to:

```ts
{ command: '/profile [observations|facts|recent|search <query>]', description: 'View Hindsight memory profile' },
```

In the help table, change the `/profile` row to:

```md
| `/profile [observations|facts|recent|search <query>]` | View Hindsight memory profile |
```

- [ ] **Step 2: Add README command note**

In `README.md`, under the command list, change `/profile` to:

```md
- `/profile [observations|facts|recent|search <query>]`
```

- [ ] **Step 3: Run controller tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/chat-controller.ts README.md
git commit -m "docs: describe memory profile command"
```

---

### Task 6: Final Verification

**Files:**
- No new files.
- Verify all modified behavior.

- [ ] **Step 1: Run focused memory tests**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/hindsight-memory.test.ts
npx tsx --tsconfig tsconfig.test.json test/memory-manager.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run maintained test harness**

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

Expected: build completes and regenerates `main.js`.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff -- src/memory/types.ts src/memory/memory-manager.ts src/services/model-service.ts src/ui/chat-controller.ts test/memory-manager.test.ts test/model-service.test.ts test/chat-controller.test.ts README.md
```

Expected: diff only contains Memory Profile command changes.

- [ ] **Step 5: Commit build output if project convention requires it**

If `npm run build` changes `main.js`, include it in the final implementation commit:

```bash
git add main.js
git commit -m "build: regenerate bundle for memory profile command"
```

If `main.js` is unchanged, skip this commit.

---

## Self-Review

- Spec coverage: The plan covers `/profile` overview, `/profile observations`, `/profile search <query>`, backward compatibility with legacy `getUserProfile()`, privacy-mode visibility, and read-only Hindsight access.
- Placeholder scan: The plan contains concrete file paths, method names, test snippets, commands, and expected outcomes.
- Type consistency: `MemoryProfileRequest`, `MemoryProfileView`, `MemoryProfileStats`, and `MemoryProfileSections` are introduced before use by `MemoryManager`, `ModelService`, and `ChatController`.
