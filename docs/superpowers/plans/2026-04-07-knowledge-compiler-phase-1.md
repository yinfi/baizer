# Knowledge Compiler Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a phase-1 knowledge compiler that turns supported web clippings into a separate managed wiki layer with registry tracking, stateless summary generation, indexing, linting, and controlled background execution.

**Architecture:** Add a dedicated `src/knowledge/` subsystem instead of expanding `main.ts` or `src/mcp/tools.ts` further. The clipping flow remains the ingest entry, but a new knowledge runtime owns source registration, queue/registry persistence, compilation, indexing, linting, settings integration, and command wiring.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing provider/model layer via `ModelService`, Markdown/frontmatter files, JSON registry persistence, `tsx` for focused contract execution, `tsc` for scoped typechecking.

---

## Chunk 1: Foundation And Contracts

### Task 1: Add A Runnable Knowledge-Compiler Harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/knowledge/contracts.contract.ts`
- Create: `tsconfig.knowledge.json`

- [ ] **Step 1: Write the failing executable contract harness**

Create `test/knowledge/contracts.contract.ts` with executable assertions against planned runtime exports:
- registry file envelope shape
- registry/source status enum values
- summary required field list
- artifact type constants
- topic slug normalization
- exact path template exports from `src/knowledge/paths.ts`

Initial import surface to lock down:

```ts
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_REGISTRY_STATUSES,
  KNOWLEDGE_ARTIFACT_TYPES,
  REQUIRED_SUMMARY_FRONTMATTER_FIELDS,
  REQUIRED_REGISTRY_RECORD_FIELDS,
  REQUIRED_REGISTRY_FILE_FIELDS,
  REQUIRED_COMPILER_EXTRACTION_FIELDS,
} from '../../src/knowledge/types';
import { normalizeTopicLabel } from '../../src/knowledge/topic-utils';
```

```ts
assert.ok(KNOWLEDGE_REGISTRY_STATUSES.includes('pending'));
assert.ok(REQUIRED_SUMMARY_FRONTMATTER_FIELDS.includes('knowledge_source_id'));
assert.equal(normalizeTopicLabel('Second Brain'), 'second-brain');
```

- [ ] **Step 2: Add a TS-aware runner and scripts**

Add `tsx` as a dev dependency.

Add to `package.json`:
- `test:knowledge-compiler`: `tsx test/knowledge/contracts.contract.ts`
- `typecheck:knowledge-compiler`: `tsc --noEmit -p tsconfig.knowledge.json`

Create `tsconfig.knowledge.json` scoped to:
- `src/knowledge/**/*.ts`
- `src/mcp/types.ts`
- `src/settings.ts`
- `test/knowledge/**/*.ts`

It must extend the repository root TypeScript config so the focused harness uses the same compiler baseline.

- [ ] **Step 3: Run the executable harness to verify it fails**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL with missing module/function/constant errors

- [ ] **Step 4: Run the focused typecheck to verify TS wiring**

Run: `cmd /c npm.cmd run typecheck:knowledge-compiler`
Expected: FAIL with missing exports or source files, not missing script/runner wiring

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/knowledge/contracts.contract.ts tsconfig.knowledge.json
git commit -m "test: add runnable knowledge compiler harness"
```

### Task 2: Create Knowledge Module Types, Constants, And Paths

**Files:**
- Create: `src/knowledge/types.ts`
- Create: `src/knowledge/paths.ts`
- Create: `src/knowledge/topic-utils.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Extend the harness with exact contract assertions**

Add assertions for exact symbols and values:
- `KNOWLEDGE_SOURCE_TYPES`
- `KNOWLEDGE_REGISTRY_STATUSES`
- `KNOWLEDGE_ARTIFACT_TYPES`
- `REQUIRED_SUMMARY_FRONTMATTER_FIELDS`
- runtime field lists for:
  - registry records
  - registry file envelope
  - compiler extraction output
- normalization examples for:
  - leading/trailing spaces
  - punctuation removal
  - repeated whitespace collapse

```ts
assert.equal(normalizeTopicLabel('  Second Brain  '), 'second-brain');
assert.equal(normalizeTopicLabel('LLM Wiki!'), 'llm-wiki');
assert.equal(normalizeTopicLabel('AI   Knowledge   Base'), 'ai-knowledge-base');
```

Required field lists must include:
- registry record:
  - `knowledge_source_id`
  - `path`
  - `status`
  - `source_type`
  - `created_at`
  - `updated_at`
- registry file envelope:
  - `schema_version`
  - `records`
- compiler extraction output:
  - `title`
  - `source_url`
  - `author`
  - `created_at`
  - `topics`
  - `topic_candidates`
  - `concepts`
  - `key_claims`
  - `review_flags`

- [ ] **Step 2: Run the executable harness to verify it still fails**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing exports or wrong values

- [ ] **Step 3: Add core knowledge contracts**

Create `src/knowledge/types.ts` with:
- `KnowledgeSourceType`
- `KnowledgeRegistryStatus`
- `KnowledgeRegistryRecord`
- `KnowledgeRegistryFile`
- `KnowledgeTopicRef`
- `KnowledgeCompilerExtraction`
- `KnowledgeLintIssue`
- runtime constants for all spec-required enums and field lists

Create `src/knowledge/paths.ts` with fixed phase-1 paths:
- `.obsidian/obsidian-cli/knowledge-registry.json`
- `Knowledge Wiki/index.md`
- `Knowledge Wiki/Articles/`
- `Knowledge Wiki/Articles/<knowledge_source_id>.md`
- `Knowledge Wiki/Topics/`
- `Knowledge Wiki/Topics/<topic-slug>.md`
- `Knowledge Wiki/Health/report.md`

Create `src/knowledge/topic-utils.ts` with the shared slug function.

```ts
export const KNOWLEDGE_SOURCE_TYPES = ['web_clipping'] as const;
export const KNOWLEDGE_REGISTRY_STATUSES = ['pending', 'processing', 'partial', 'done', 'failed', 'missing_source'] as const;
export const KNOWLEDGE_ARTIFACT_TYPES = ['summary', 'topic_page', 'global_index', 'health_report'] as const;
export const REQUIRED_SUMMARY_FRONTMATTER_FIELDS = ['knowledge_generated', 'knowledge_artifact_type', 'knowledge_source_id', 'source_url', 'title', 'compiled_at'] as const;
```

- [ ] **Step 4: Re-run the harness and focused typecheck**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for the runtime contract assertions added in Steps 1-3

Run: `cmd /c npm.cmd run typecheck:knowledge-compiler`
Expected: PASS for the scoped TS surface

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/types.ts src/knowledge/paths.ts src/knowledge/topic-utils.ts test/knowledge/contracts.contract.ts tsconfig.knowledge.json
git commit -m "feat: add knowledge compiler core contracts"
```

### Task 3: Add Settings Contract And Repo-Local Fixture

**Files:**
- Modify: `src/mcp/types.ts`
- Modify: `src/settings.ts`
- Create: `src/knowledge/settings-meta.ts`
- Create: `test/fixtures/knowledge-clippings/karpathy-second-brain.md`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Extend the harness with settings and fixture assertions**

Add executable assertions for:
- `knowledgeCompilerAutoRun` default `false`
- exported settings keys/constants from `src/knowledge/settings-meta.ts`
- no extra raw-folder config introduced in phase 1
- fixture file exists and parses as valid clipping-style frontmatter
- string-style `tags: clipping, ...` normalizes correctly in fixture parsing helpers
- settings UI section exposes a stable `Knowledge Compiler` label/helper constant

- [ ] **Step 2: Run the harness to verify it fails**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing settings contract

- [ ] **Step 3: Add settings contract and UI section**

Update `src/mcp/types.ts`:
- add `knowledgeCompilerAutoRun: boolean`
- update `DEFAULT_SETTINGS`

Create `src/knowledge/settings-meta.ts`:
- export stable keys/labels used by the settings UI

Update `src/settings.ts`:
- add a dedicated `Knowledge Compiler` section
- expose the auto-run toggle
- make copy explicit that `confirmExecutions` does not govern background compiler writes

```ts
knowledgeCompilerAutoRun: false,
```

- [ ] **Step 4: Add the repo-local clipping fixture with valid frontmatter**

Create `test/fixtures/knowledge-clippings/karpathy-second-brain.md`:

```md
---
created: 2026-04-05T09:46:50.416Z
source: https://mp.weixin.qq.com/s/zOAsp5uZh_JTUb4VDliC0A
author: Xinzhiyuan
tags:
  - clipping
---

# Karpathy Second Brain

Karpathy proposes an LLM Wiki that keeps raw sources explicit while continuously compiling them into a structured knowledge layer with indexes, links, and health checks.

## Key Points

- raw sources stay explicit
- knowledge pages are generated
- users keep local control
```

- [ ] **Step 5: Re-run the harness, typecheck, and build sanity**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for settings, fixture existence/parsing, and label assertions

Run: `cmd /c npm.cmd run typecheck:knowledge-compiler`
Expected: PASS

Run: `cmd /c npm.cmd run build`
Expected: PASS without introducing new build errors from the settings surface

- [ ] **Step 6: Commit**

```bash
git add src/mcp/types.ts src/settings.ts src/knowledge/settings-meta.ts test/fixtures/knowledge-clippings/karpathy-second-brain.md test/knowledge/contracts.contract.ts
git commit -m "feat: add knowledge compiler settings and fixture"
```

## Chunk 2: Registry, Source Registration, And Runtime Wiring

### Task 4: Implement Source ID And Registry Persistence

**Files:**
- Create: `src/knowledge/source-id.ts`
- Create: `src/knowledge/registry.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing registry tests**

Add contract tests for:
- registry bootstrap creates empty file envelope
- ID generation prefix format
- duplicate ID collision failure
- `processing -> pending` reset after restart bootstrap
- file-envelope schema version behavior

- [ ] **Step 2: Run the harness and confirm failure**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing registry/source-id implementations

- [ ] **Step 3: Implement ID and registry services**

`src/knowledge/source-id.ts`
- generate `ksrc_<suffix>`
- reject collisions
- reuse IDs only for the same physical note during relink/manual compile

`src/knowledge/registry.ts`
- bootstrap `KnowledgeRegistryFile`
- read/write JSON atomically
- expose:
  - `loadRegistry()`
  - `saveRegistry()`
  - `registerSource(...)`
  - `updateSourcePath(...)`
  - `markMissingSource(...)`
  - `setStatus(...)`
  - `requeue(...)`
  - `findBySourceId(...)`

```ts
export interface KnowledgeRegistryFile {
  schema_version: 1;
  records: Record<string, KnowledgeRegistryRecord>;
}
```

- [ ] **Step 4: Re-run the harness and focused typecheck**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for registry bootstrap and ID tests

Run: `cmd /c npm.cmd run typecheck:knowledge-compiler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/source-id.ts src/knowledge/registry.ts test/knowledge/contracts.contract.ts
git commit -m "feat: add knowledge registry persistence"
```

### Task 5: Integrate Supported Web Clipping Registration Into Save Flow

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `main.ts`
- Modify: `src/knowledge/source-id.ts`
- Modify: `src/knowledge/registry.ts`
- Test: `test/plugin-tools.test.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing integration tests for supported source registration**

Add tests proving:
- new web clippings receive `knowledge_source_id`
- registration uses final path after any immediate relocation
- video-derived notes do not register or queue in phase 1

- [ ] **Step 2: Run the relevant tests**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing `save_webpage` registration integration

- [ ] **Step 3: Modify the clipping flow**

In `src/mcp/tools.ts`:
- detect supported web clipping path vs excluded video note path
- inject `knowledge_source_id` into newly created supported web clipping content at creation time
- hand off enough metadata for final-path registration instead of registering too early
- do not queue or register video-derived notes

In `main.ts`:
- finish registration only after the inbox relocation flow resolves the final path
- avoid duplicate registration between direct save and inbox-move paths

Direct-save rule:
- direct `save_webpage` saves that are not immediately relocated may register right after creation
- inbox-driven saves must defer registration until relocation resolves the final path

Keep `tools.ts` thin and push helper logic into `src/knowledge/` services.

- [ ] **Step 4: Re-run tests**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for web/video registration contract checks

Run: `cmd /c npx.cmd tsx test/plugin-tools.test.ts`
Expected: PASS for plugin tool integration assertions touched in this task

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts main.ts src/knowledge/source-id.ts src/knowledge/registry.ts test/plugin-tools.test.ts test/knowledge/contracts.contract.ts
git commit -m "feat: register supported web clippings for knowledge compile"
```

### Task 6: Add Knowledge Runtime Owner And Plugin Wiring

**Files:**
- Create: `src/knowledge/runtime.ts`
- Modify: `main.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing runtime wiring checks**

Add checks for:
- command IDs registered
- runtime bootstrap resets stale `processing` items
- runtime owner is responsible for rename/delete hooks and queue scheduling entry

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing runtime owner

- [ ] **Step 3: Implement runtime owner and minimal plugin integration**

Create `src/knowledge/runtime.ts` responsible for:
- command registration:
  - `obsidian-cli:compile-this-clipping`
  - `obsidian-cli:compile-pending-knowledge-items`
  - `obsidian-cli:open-knowledge-index`
  - `obsidian-cli:run-knowledge-lint`
- registry bootstrap
- rename/delete listeners
- queue drain trigger entrypoints
- manual legacy onboarding for `Compile this clipping`, including:
  - recognize registerable clipping notes
  - inject `knowledge_source_id` on first registration when allowed
  - relink existing IDs before compile when applicable

Modify `main.ts`:
- instantiate the knowledge runtime after settings/model/tool setup
- delegate plugin lifecycle hooks

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for runtime owner contract checks

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/runtime.ts main.ts test/knowledge/contracts.contract.ts
git commit -m "feat: wire knowledge runtime owner into plugin"
```

## Chunk 3: Stateless Compiler, Indexer, And Managed Artifacts

### Task 7: Add Stateless Compiler Adapter And Summary Compiler

**Files:**
- Create: `src/knowledge/compiler-adapter.ts`
- Create: `src/knowledge/compiler.ts`
- Modify: `src/services/model-service.ts`
- Modify: `tsconfig.knowledge.json`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing compiler-adapter tests**

Add tests for:
- stateless compile call shape
- no memory-backed session usage
- structured extraction validation
- valid compiled artifact criteria

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing compiler adapter/runtime path

- [ ] **Step 3: Implement a dedicated stateless compiler runtime**

Create `src/knowledge/compiler-adapter.ts`:
- accept raw clipping content + source metadata
- produce validated `KnowledgeCompilerExtraction`
- wrap provider access behind a one-shot interface

Modify `src/services/model-service.ts` minimally:
- expose a stateless generation method that bypasses `MemoryManager`
- keep `chat()` behavior unchanged

Update `tsconfig.knowledge.json` to include:
- `src/services/model-service.ts`

Create `src/knowledge/compiler.ts`:
- build summary frontmatter
- build summary body with sections:
  - `# Title`
  - `## Summary`
  - `## Key Claims`
  - `## Concepts`
  - `## Raw Source`
- enforce the same managed-artifact overwrite/collision rule used elsewhere:
  - rewrite only notes carrying managed markers
  - fail on user-authored note collisions at generated summary paths

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for stateless compile adapter and summary-shape tests

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/compiler-adapter.ts src/knowledge/compiler.ts src/services/model-service.ts test/knowledge/contracts.contract.ts
git commit -m "feat: add stateless knowledge compiler adapter"
```

### Task 8: Implement Wiki Indexer And Topic Cleanup Rules

**Files:**
- Create: `src/knowledge/indexer.ts`
- Modify: `src/knowledge/topic-utils.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing indexer tests**

Add tests for:
- global index structure
- topic page creation/update
- stale topic page deletion when no summaries remain
- suppression of `missing_source` links

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing indexer implementation

- [ ] **Step 3: Implement indexer**

Create `src/knowledge/indexer.ts`:
- rebuild global index from summary artifacts
- rebuild topic pages from summary `topics`
- delete empty generated topic pages
- refuse to take over non-managed notes at generated paths

Use `knowledge_generated` and `knowledge_artifact_type` markers for overwrite safety.

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for index structure and topic cleanup checks

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/indexer.ts src/knowledge/topic-utils.ts test/knowledge/contracts.contract.ts
git commit -m "feat: add wiki indexer and topic cleanup"
```

### Task 9: Implement Raw-Source Backlink Refresh

**Files:**
- Modify: `src/knowledge/compiler.ts`
- Modify: `src/knowledge/indexer.ts`
- Modify: `src/knowledge/runtime.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing relink tests**

Add checks for:
- rename updates the stored raw path
- summary raw-source section is rewritten on relink
- missing source renders missing notice instead of stale path

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on stale backlink behavior

- [ ] **Step 3: Implement backlink refresh flow**

Use the registry as the mutable path source of truth.

Rules:
- summary `Raw Source` section is regenerated on compile/reindex/relink
- `missing_source` suppresses raw path link and renders a missing notice

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for relink and missing-source rendering checks

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/compiler.ts src/knowledge/indexer.ts src/knowledge/runtime.ts test/knowledge/contracts.contract.ts
git commit -m "feat: refresh raw-source backlinks from registry"
```

## Chunk 4: Linting, Orchestration, Commands, And Verification

### Task 10: Implement Knowledge Linter And Health Report

**Files:**
- Create: `src/knowledge/linter.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing lint tests**

Add tests for:
- missing summary detection
- low-confidence review flags
- concept island detection
- duplicate `topic_candidates` collapse detection
- stale compiled artifact reporting for `missing_source`

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing linter implementation

- [ ] **Step 3: Implement linter**

Create `src/knowledge/linter.ts`:
- scan registry + summary artifacts
- emit one managed health report note
- use explicit issue codes and severities
- do not mutate registry state for lint-only findings

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for lint issue generation checks

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/linter.ts test/knowledge/contracts.contract.ts
git commit -m "feat: add knowledge lint report generation"
```

### Task 11: Implement Queue Drain, Permission Backoff, And Manual Command Semantics

**Files:**
- Modify: `src/knowledge/runtime.ts`
- Modify: `src/settings.ts`
- Modify: `src/mcp/types.ts`
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Write failing orchestration tests**

Add tests for:
- `knowledgeCompilerAutoRun` default `false`
- pending items remain pending when permissions block wiki writes
- manual commands count as explicit user approval
- startup resets stale `processing`

- [ ] **Step 2: Run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: FAIL on missing orchestrator behavior

- [ ] **Step 3: Implement controlled orchestration**

In `src/knowledge/runtime.ts`:
- use one shared worker path for manual and queued compile
- keep blocked items `pending` with permission-blocked markers
- back off queue scheduling until settings change or user retries
- only auto-run when `knowledgeCompilerAutoRun === true`

Align settings copy in `src/settings.ts` and `src/mcp/types.ts` so:
- manual commands are explicit approval
- `confirmExecutions` is not described as background compiler control

- [ ] **Step 4: Re-run the harness**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS for permission-blocked and command semantics tests

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/runtime.ts src/settings.ts src/mcp/types.ts test/knowledge/contracts.contract.ts
git commit -m "feat: add controlled knowledge queue semantics"
```

### Task 12: Final Verification And Documentation Alignment

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-06-knowledge-compiler-design.md` only if plan-driven clarifications are needed
- Test: `test/knowledge/contracts.contract.ts`

- [ ] **Step 1: Update README feature narrative**

Document:
- clipping-first knowledge compiler
- separate wiki layer
- manual commands
- controlled automation

- [ ] **Step 2: Run feature-specific verification**

Run: `cmd /c npm.cmd run test:knowledge-compiler`
Expected: PASS

Run: `cmd /c npm.cmd run typecheck:knowledge-compiler`
Expected: PASS

Run: `cmd /c npm.cmd run build`
Expected: PASS

- [ ] **Step 3: Run smoke verification flow**

Manual smoke flow in Obsidian:
1. save a supported web clipping
2. run `Compile this clipping`
3. open knowledge index
4. run knowledge lint
5. rename the raw clipping and confirm backlink refresh after relink/recompile

Expected:
- one summary page
- index entry present
- topic page present
- no duplicate artifacts on re-run

- [ ] **Step 4: Commit**

```bash
git add README.md test/knowledge/contracts.contract.ts
git commit -m "docs: align knowledge compiler behavior and verification"
```
