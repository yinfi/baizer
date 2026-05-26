# Knowledge Ontology Settings Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Knowledge Wiki ontology schema visible, configurable, recoverable, and useful for compilation and query.

**Architecture:** Introduce a focused `OntologyService` to own schema status, loading, discovery thresholds, and file writes. Keep `KnowledgeRuntime` as the lifecycle coordinator, `KnowledgeCompiler` as the extraction engine, and `settings.ts` as the user-facing policy surface.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing custom `tsx` test harness via `npm test`.

---

## File Structure

- Create: `src/knowledge/ontology-service.ts`
  - Owns ontology status, loading, discovery readiness, candidate generation, preview/write helpers, and schema hash.
- Modify: `src/knowledge/ontology.ts`
  - Keep pure parsing/building helpers; add small helpers only if needed.
- Modify: `src/knowledge/types.ts`
  - Add ontology settings types and status types.
- Modify: `src/mcp/types.ts`
  - Add default settings fields.
- Modify: `src/settings.ts`
  - Add Knowledge > Ontology Schema settings UI and status/action controls.
- Modify: `src/knowledge/runtime.ts`
  - Replace inline ontology loading/discovery with `OntologyService`.
  - Add commands for status/open/discover/regenerate preview.
- Modify: `src/knowledge/status-service.ts`
  - Mark done notes stale when current schema exists and summaries are missing `schema_hash`.
- Modify: `src/knowledge/metadata-index.ts`
  - Index `categorized_knowledge`, `entities`, and `schema_hash`.
- Modify: `src/knowledge/query.ts`
  - Include ontology fields in ranking and result context.
- Modify: `src/skills/builtin/knowledge/SKILL.md`
  - Document ontology commands if slash routing is added.
- Modify: `src/ui/chat-controller.ts`
  - Add slash handling only if implementing `/wiki:ontology`.
- Test: `test/knowledge/ontology-service.test.ts`
- Modify tests:
  - `test/knowledge/ontology.test.ts`
  - `test/knowledge-status-service.test.ts`
  - `test/knowledge/query.test.ts`
  - `test/settings-state.test.ts`
  - `test/knowledge/watcher.test.ts` if runtime construction defaults change.

---

## Chunk 1: Settings Contract And Defaults

### Task 1: Add ontology settings fields

**Files:**
- Modify: `src/mcp/types.ts`
- Modify: `src/knowledge/types.ts`
- Test: `test/settings-state.test.ts`

- [ ] **Step 1: Write failing settings-default tests**

Add expectations that default settings include:

```ts
knowledgeOntologyEnabled: true,
knowledgeOntologyUpdateMode: 'suggest',
knowledgeOntologyMinArticles: 10,
knowledgeOntologyMinTopicFrequency: 3,
knowledgeOntologyMinConceptFrequency: 2,
knowledgeOntologyAutoRecompileStale: false,
```

Why: these replace hard-coded runtime constants and make behavior explainable to users.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/settings-state.test.ts`

Expected: FAIL because settings do not exist yet.

- [ ] **Step 3: Add types and defaults**

Add:

```ts
export type OntologyUpdateMode = 'manual' | 'suggest' | 'auto';

export type OntologyStatusKind =
  | 'disabled'
  | 'missing'
  | 'empty'
  | 'invalid'
  | 'valid'
  | 'insufficient_articles'
  | 'insufficient_signal';
```

Add fields to plugin settings/defaults in `src/mcp/types.ts`.

- [ ] **Step 4: Run targeted test**

Run: `npm test -- test/settings-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/types.ts src/knowledge/types.ts test/settings-state.test.ts
git commit -m "feat: add ontology settings defaults"
```

---

## Chunk 2: Ontology Service

### Task 2: Create status and loading service

**Files:**
- Create: `src/knowledge/ontology-service.ts`
- Modify: `src/knowledge/ontology.ts`
- Test: `test/knowledge/ontology-service.test.ts`

- [ ] **Step 1: Write failing status tests**

Cover:

```ts
missing -> status.kind === 'missing'
empty file -> status.kind === 'empty'
invalid frontmatter -> status.kind === 'invalid'
valid schema -> status.kind === 'valid' and schema/hash returned
disabled setting -> status.kind === 'disabled'
```

Why: current runtime only checks file existence, which is why an empty `_ontology.md` blocks discovery forever.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/knowledge/ontology-service.test.ts`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement `OntologyService.getStatus()` and `loadSchema()`**

Implement around existing helpers:

```ts
extractFrontmatter(rawContent)
parseOntologySchema(frontmatter)
computeSchemaHash(rawContent)
```

Return structured status with:

```ts
{
  kind,
  path,
  schema?,
  hash?,
  message?
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/knowledge/ontology-service.test.ts test/knowledge/ontology.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/ontology-service.ts src/knowledge/ontology.ts test/knowledge/ontology-service.test.ts
git commit -m "feat: add ontology status service"
```

### Task 3: Move discovery readiness into the service

**Files:**
- Modify: `src/knowledge/ontology-service.ts`
- Test: `test/knowledge/ontology-service.test.ts`

- [ ] **Step 1: Write failing discovery-readiness tests**

Cover:

```ts
article count below threshold -> insufficient_articles
enough articles but no frequent topics/concepts -> insufficient_signal
enough articles and signals -> returns discovery stats
thresholds come from settings
```

Why: hard-coded `10/3/2` thresholds should become settings-driven.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/knowledge/ontology-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `getDiscoveryReadiness()`**

Move the aggregation currently in `KnowledgeRuntime.discoverOntology()`:

- scan `${wikiFolder}/Articles`
- count topics
- count concepts
- collect recent claims
- apply configured thresholds

- [ ] **Step 4: Run targeted test**

Run: `npm test -- test/knowledge/ontology-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/ontology-service.ts test/knowledge/ontology-service.test.ts
git commit -m "feat: make ontology discovery thresholds configurable"
```

---

## Chunk 3: Runtime Integration

### Task 4: Replace runtime inline ontology loading

**Files:**
- Modify: `src/knowledge/runtime.ts`
- Test: `test/knowledge/watcher.test.ts`
- Test: `test/knowledge/ontology-service.test.ts`

- [ ] **Step 1: Write failing runtime behavior tests**

Cover:

```ts
compile loads schema through OntologyService
empty ontology file is not treated as valid schema
missing ontology with manual mode does not auto-discover
missing ontology with suggest mode does not auto-write schema
missing ontology with auto mode creates schema when ready
```

Why: runtime should coordinate policy but not own parsing/discovery internals.

- [ ] **Step 2: Run targeted tests**

Run: `npm test -- test/knowledge/watcher.test.ts test/knowledge/ontology-service.test.ts`

Expected: FAIL until runtime uses the service.

- [ ] **Step 3: Instantiate `OntologyService` in `KnowledgeRuntime`**

Add a private field:

```ts
private ontologyService: OntologyService;
```

Use it for:

- auto compile schema loading
- compile current note
- compile all pending
- compileByPath
- startup discovery

- [ ] **Step 4: Replace `loadOntologySchema()` implementation**

Keep public method if tests or UI use it, but delegate:

```ts
const status = await this.ontologyService.getStatus();
return status.kind === 'valid' ? { schema: status.schema, hash: status.hash } : null;
```

- [ ] **Step 5: Replace `discoverOntology()` implementation**

Delegate to service and obey settings:

```text
manual: never auto-write
suggest: compute readiness/candidate but do not write
auto: write only when schema is missing; do not overwrite valid/invalid user files
```

- [ ] **Step 6: Run targeted tests**

Run: `npm test -- test/knowledge/watcher.test.ts test/knowledge/ontology-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/runtime.ts src/knowledge/ontology-service.ts test/knowledge/watcher.test.ts test/knowledge/ontology-service.test.ts
git commit -m "refactor: route ontology lifecycle through service"
```

---

## Chunk 4: Settings UI

### Task 5: Add Knowledge Ontology settings section

**Files:**
- Modify: `src/settings.ts`
- Test: existing settings tests if available

- [ ] **Step 1: Inspect existing Knowledge settings rendering**

Read `renderKnowledgeSection()` in `src/settings.ts`.

Why: keep UI consistent with existing settings patterns.

- [ ] **Step 2: Add settings controls**

Add a subsection named `Ontology Schema` with:

- enable toggle
- update mode dropdown: Manual, Suggest, Auto
- min articles numeric input
- min topic frequency numeric input
- min concept frequency numeric input
- auto recompile stale toggle

- [ ] **Step 3: Add explanatory descriptions**

Descriptions should state:

- ontology changes extraction rules
- `suggest` is recommended
- auto should not overwrite existing valid user schema

Why: these settings affect generated knowledge structure, not just UI behavior.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat: add ontology settings controls"
```

### Task 6: Add status and actions to settings UI

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/knowledge/runtime.ts` if exposing status methods is needed

- [ ] **Step 1: Add runtime accessors**

Expose:

```ts
getOntologyStatus()
openOntologyFile()
discoverOntologyPreview()
applyOntologySchema()
```

Keep method names narrow and UI-oriented.

- [ ] **Step 2: Render status row**

Show:

```text
Status: Missing / Empty / Invalid / Valid / Disabled
Path: Knowledge Wiki/_ontology.md
Stale articles: N
```

- [ ] **Step 3: Add action buttons**

Add:

- Open ontology
- Discover now
- Regenerate preview
- Mark affected notes pending

Why: users need repair paths for empty/invalid schema, not only passive settings.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/knowledge/runtime.ts
git commit -m "feat: show ontology status in settings"
```

---

## Chunk 5: Stale Detection

### Task 7: Mark old summaries stale after ontology is enabled

**Files:**
- Modify: `src/knowledge/status-service.ts`
- Test: `test/knowledge-status-service.test.ts`

- [ ] **Step 1: Write failing stale tests**

Add:

```ts
current schema exists + summary missing schema_hash -> stale
current schema exists + summary schema_hash differs -> stale
current schema exists + summary schema_hash matches -> not stale unless content changed
no current schema + summary missing schema_hash -> not stale because ontology disabled/missing
```

Why: enabling ontology should cause old articles to be recompiled into the new schema.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/knowledge-status-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Update `isStaleFile()`**

Change schema logic to:

```ts
if (currentSchemaHash) {
  if (!summaryFrontmatter.schema_hash) return true;
  if (summaryFrontmatter.schema_hash !== currentSchemaHash) return true;
}
```

- [ ] **Step 4: Run targeted test**

Run: `npm test -- test/knowledge-status-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/status-service.ts test/knowledge-status-service.test.ts
git commit -m "fix: mark summaries stale when ontology is newly enabled"
```

---

## Chunk 6: Index And Query Value

### Task 8: Index ontology extraction fields

**Files:**
- Modify: `src/knowledge/metadata-index.ts`
- Test: `test/knowledge/query.test.ts`

- [ ] **Step 1: Write failing metadata index tests**

Create mock article frontmatter with:

```yaml
categorized_knowledge:
  - category: "方法论"
    items: ["渐进式采用", "预览优先"]
entities:
  - name: "Obsidian"
    type: "工具"
    description: "知识管理应用"
schema_hash: "abc123"
```

Expect `ArticleMeta` to include those fields.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/knowledge/query.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement extraction helpers**

Add helpers similar to `extractTopics()` and `extractStringArray()`:

```ts
extractCategorizedKnowledge(fm)
extractEntities(fm)
```

Use defensive parsing because Obsidian metadata can normalize YAML in different ways.

- [ ] **Step 4: Run targeted test**

Run: `npm test -- test/knowledge/query.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/metadata-index.ts test/knowledge/query.test.ts
git commit -m "feat: index ontology fields"
```

### Task 9: Include ontology fields in query ranking

**Files:**
- Modify: `src/knowledge/query.ts`
- Modify: `src/knowledge/metadata-index.ts`
- Test: `test/knowledge/query.test.ts`

- [ ] **Step 1: Write failing query tests**

Cover:

```ts
query matches categorized_knowledge item
query matches entity name
query result mentions ontology match context
```

Why: ontology is only useful if it changes retrieval quality, not just generated markdown.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- test/knowledge/query.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extend search scoring**

Suggested weights:

```text
title: +5
topic: +4
concept: +3
entity name: +4
entity description: +2
categorized item: +3
key claim: +2
```

Keep simple keyword matching to match current implementation style.

- [ ] **Step 4: Extend result summary**

Include concise match context without overloading chat output:

```text
Ontology: 方法论 / Obsidian
```

- [ ] **Step 5: Run targeted test**

Run: `npm test -- test/knowledge/query.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/query.ts src/knowledge/metadata-index.ts test/knowledge/query.test.ts
git commit -m "feat: search ontology fields in knowledge query"
```

---

## Chunk 7: Commands And Slash Surface

### Task 10: Add Obsidian commands

**Files:**
- Modify: `src/knowledge/runtime.ts`

- [ ] **Step 1: Add commands**

Add:

- `knowledge-ontology-status`
- `knowledge-ontology-open`
- `knowledge-ontology-discover`
- `knowledge-ontology-regenerate-preview`

Why: users need quick repair and inspection paths outside settings.

- [ ] **Step 2: Ensure commands show preconditions**

Notices should say:

- not enough compiled articles
- no high-frequency signals
- schema empty/invalid
- schema already valid

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/knowledge/runtime.ts
git commit -m "feat: add ontology management commands"
```

### Task 11: Optional slash command support

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Modify: `src/runtime/chat-runtime.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/skills/builtin/knowledge/SKILL.md`
- Tests: command suggestion/controller tests

- [ ] **Step 1: Decide whether slash support is in scope**

If keeping scope smaller, skip this task.

Why: Obsidian commands and settings already cover core use. Slash support is convenience.

- [ ] **Step 2: Add suggestions and handlers**

Add:

```text
/wiki:ontology status
/wiki:ontology discover
/wiki:ontology open
```

- [ ] **Step 3: Add tests**

Update command suggestion tests and chat controller tests.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat-controller.ts src/runtime/chat-runtime.ts src/ui/shell-view.ts src/skills/builtin/knowledge/SKILL.md test
git commit -m "feat: add ontology slash commands"
```

---

## Chunk 8: Full Verification

### Task 12: End-to-end validation

**Files:**
- No planned source edits unless tests reveal defects.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: build succeeds and `main.js` is generated.

- [ ] **Step 3: Manual smoke test in Obsidian**

Use a vault with Knowledge Wiki enabled:

```text
1. Start with no _ontology.md.
2. Compile fewer than threshold articles.
3. Confirm settings status says insufficient articles.
4. Compile enough repeated-topic articles.
5. Confirm Discover now produces preview/status.
6. Apply schema.
7. Compile a note and verify generated article has schema_hash.
8. Verify categorized_knowledge/entities appear when model returns them.
9. Edit _ontology.md.
10. Confirm affected notes become stale.
```

- [ ] **Step 4: Check git diff**

Run: `git diff --stat`

Expected: only planned files changed.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add <changed-files>
git commit -m "test: verify ontology settings workflow"
```

---

## Implementation Notes

- Do not silently overwrite an existing valid `_ontology.md`.
- Treat empty `_ontology.md` as `empty`, not as `missing` and not as `valid`.
- `suggest` mode should not write files without user confirmation.
- `auto` mode may create a missing schema, but should not overwrite a user-edited valid schema.
- Keep AI-generated schema writes preview-first where user action is involved.
- Keep production plugin code mobile-compatible; do not add Node-only dependencies.
- Reuse existing `ModelService.generate()` and Obsidian vault APIs.
- Avoid broad refactors in `settings.ts`; add a focused subsection inside the current Knowledge settings section.

