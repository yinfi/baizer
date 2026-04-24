# Data Collection Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复网页/视频采集、聊天上下文采集和 memory 持久化链路中的错误结果、数据丢失和并发覆盖问题，并补上关键回归测试。

**Architecture:** 保持现有 skill/tool 结构不变，只做小范围加固：`save_webpage` 改为无状态视频摘要；`MemoryManager` 增加 ready 屏障和真实会话摘要；`ModelService` 在重配置前 flush memory session；WeChat Inbox 自动采集逻辑提取为可测试协调器；临时上下文复用正式视频抓取逻辑，并给网页/搜索链路补状态校验与轻量重试。

**Tech Stack:** TypeScript, Obsidian API, `tsx` test runner, existing lightweight test style, esbuild build script

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/skills/builtin/web-clipper/executor.ts` | Modify | 修复视频摘要调用、网页抓取失败降级和状态校验 |
| `src/memory/memory-manager.ts` | Modify | 初始化 ready 屏障、当前 session transcript、真实摘要生成 |
| `src/services/model-service.ts` | Modify | memory ready 等待、flush 生命周期管理、异步 settings 更新 |
| `src/services/inbox-autosave.ts` | Create | Inbox URL 匹配、串行队列、latest-content merge-safe 回写 |
| `main.ts` | Modify | 使用 Inbox 协调器替代内联自动采集 |
| `src/services/context-manager.ts` | Modify | 复用 `getVideoTranscript()`，补 URL 抓取状态校验 |
| `src/ui/shell-view.ts` | Modify | 清理陈旧 selection，允许普通 URL 成为 context |
| `src/skills/builtin/web-search/executor.ts` | Modify | DuckDuckGo 状态校验、202/短页重试 |
| `test/web-clipper.test.ts` | Create | `save_webpage` 视频摘要和网页错误路径回归 |
| `test/memory-manager.test.ts` | Create | memory ready / transcript summary / 持久化竞态回归 |
| `test/model-service.test.ts` | Create | provider/model/settings 切换前 flush 回归 |
| `test/inbox-autosave.test.ts` | Create | Inbox 串行处理与 merge-safe 替换回归 |
| `test/context-manager.test.ts` | Modify | 共享 transcript 路径和 URL 错误处理回归 |
| `test/web-search.test.ts` | Create | DuckDuckGo 202 重试与错误状态回归 |

---

## Chunk 1: Core Correctness

### Task 1: Fix `save_webpage` Video Summarization

**Files:**
- Modify: `src/skills/builtin/web-clipper/executor.ts`
- Test: `test/web-clipper.test.ts`

- [ ] **Step 1: Write the failing test for the current broken summary path**

Create `test/web-clipper.test.ts` with a case that:

- stubs `getVideoTranscript()` to return a valid transcript
- provides a `modelService` stub that exposes `generate()` and a trap `chat()` method
- executes the `save_webpage` tool
- asserts the saved note contains a summary returned by `generate()`
- asserts the fallback link note is used when `generate()` throws
- asserts no `"Error:"` string is written into the note body as the summary

Minimal test sketch:

```typescript
const modelService = {
  generate: async () => '## Summary\n\n- key point',
  chat: async () => {
    throw new Error('chat() should not be used for video summarization');
  },
};
```

- [ ] **Step 2: Run the test to verify it fails on current code**

Run: `cmd /c npx.cmd tsx test/web-clipper.test.ts`

Expected: FAIL because current code calls `modelService.chat(...)` with the wrong contract or writes an error string into the note.

- [ ] **Step 3: Implement a stateless summarization helper**

In `src/skills/builtin/web-clipper/executor.ts`:

- add an internal `summarizeTranscript()` helper
- use `modelService.generate(prompt, systemPrompt)` when available
- treat empty string and `Error:`-prefixed results as failure
- on failure, fall back to the existing “save video link” note format
- keep path resolution and frontmatter behavior unchanged

- [ ] **Step 4: Add lightweight HTTP status checks for webpage fetches**

Still in `src/skills/builtin/web-clipper/executor.ts`:

- reject non-200 responses from `requestUrl()`
- return a structured `{ success: false, error }` result for fetch failures
- avoid silently saving `Conversion failed.` as if it were a normal article

- [ ] **Step 5: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/web-clipper.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: build completes with no TypeScript or bundling errors

- [ ] **Step 6: Commit**

```bash
git add src/skills/builtin/web-clipper/executor.ts test/web-clipper.test.ts
git commit -m "fix(web-clipper): harden video summarization path"
```

---

### Task 2: Add Memory Readiness and Real Session Summaries

**Files:**
- Modify: `src/memory/memory-manager.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: Write failing tests for readiness and summary input**

Create `test/memory-manager.test.ts` with cases that verify:

- `recordMessage()` does not race with unresolved disk loads
- loaded history does not overwrite newly recorded messages
- `clearSession()` produces a session summary from the current session transcript
- `generateSessionSummary()` receives actual current-session message content

Test shape:

```typescript
await memory.ready();
await memory.recordMessage('user', 'I am fixing the inbox autosave flow');
await memory.recordMessage('model', 'Let us add a queue and merge-safe rewrite');
await memory.clearSession();
expect(savedSummary.summary).toContain('inbox');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx test/memory-manager.test.ts`

Expected: FAIL because current `MemoryManager` has no `ready()` barrier and summary generation has no conversation input.

- [ ] **Step 3: Implement `initPromise`, `ready()`, and current-session transcript tracking**

In `src/memory/memory-manager.ts`:

- create a single `initialize()` flow that loads profile, summaries, and history
- store it as `private initPromise`
- add `ready(): Promise<void>`
- maintain `currentSessionTranscript: ChatMessage[]`
- reset `currentSessionTranscript` when a new session starts
- append to it in `recordMessage()`
- use it in `generateSessionSummary()`

- [ ] **Step 4: Make summary generation use real content**

Still in `src/memory/memory-manager.ts`:

- build a bounded prompt from `currentSessionTranscript`
- include both user and model messages
- truncate to a safe length so the summary prompt does not balloon
- keep the existing fallback summary if the model call fails

- [ ] **Step 5: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/memory-manager.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/memory-manager.ts test/memory-manager.test.ts
git commit -m "fix(memory): add readiness barrier and real session summaries"
```

---

## Chunk 2: Lifecycle Safety

### Task 3: Flush Memory Before Provider / Model / Settings Reconfiguration

**Files:**
- Modify: `src/services/model-service.ts`
- Modify: `main.ts`
- Test: `test/model-service.test.ts`

- [ ] **Step 1: Write failing tests for reconfiguration lifecycle**

Create `test/model-service.test.ts` with cases that verify:

- `switchProvider()` waits for memory readiness and flushes the active session before cleanup
- `switchModel()` does the same
- `updateSettings()` does the same before replacing the provider/memory pair
- `shutdown()` still persists memory

Test sketch:

```typescript
expect(order).toEqual([
  'ready',
  'clearSession',
  'save',
  'cleanup',
  'initializeProvider',
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx test/model-service.test.ts`

Expected: FAIL because current implementation drops `memoryManager` without flushing.

- [ ] **Step 3: Implement `flushMemorySession()` and async update flow**

In `src/services/model-service.ts`:

- add `private async flushMemorySession()`
- call it from `switchProvider()`, `switchModel()`, `updateSettings()`, and `shutdown()`
- if `updateSettings()` becomes async, update call sites accordingly

In `main.ts`:

- update `saveSettings()` to await the async `modelService.updateSettings(...)`

- [ ] **Step 4: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/model-service.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/model-service.ts main.ts test/model-service.test.ts
git commit -m "fix(model-service): flush memory before reconfiguration"
```

---

## Chunk 3: Inbox Concurrency and Merge Safety

### Task 4: Extract an Inbox Autosave Coordinator

**Files:**
- Create: `src/services/inbox-autosave.ts`
- Modify: `main.ts`
- Test: `test/inbox-autosave.test.ts`

- [ ] **Step 1: Write failing tests for URL extraction and merge-safe replacement**

Create `test/inbox-autosave.test.ts` with cases that verify:

- only raw URLs are collected, not wiki links or markdown links
- replacements happen from the latest content, not an old snapshot
- if the raw URL was removed before write-back, it is skipped
- repeated calls for the same file are serialized

Minimal cases:

```typescript
expect(extractRawUrls('[[Saved]] https://a.com [x](https://b.com)')).toEqual([
  { url: 'https://a.com', ... }
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx test/inbox-autosave.test.ts`

Expected: FAIL because the coordinator does not exist yet.

- [ ] **Step 3: Implement `src/services/inbox-autosave.ts`**

Create a small coordinator that:

- exposes pure helpers for raw URL extraction and replacement
- maintains a per-file promise chain or queue
- re-reads the latest file content before applying saved-link replacements
- skips URLs that were already converted or removed

- [ ] **Step 4: Wire `main.ts` to delegate Inbox processing**

In `main.ts`:

- instantiate the coordinator during plugin startup
- replace inline `onFileModify()` autosave logic with a call into the coordinator
- preserve existing notices and `save_webpage` tool execution behavior

- [ ] **Step 5: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/inbox-autosave.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/inbox-autosave.ts main.ts test/inbox-autosave.test.ts
git commit -m "fix(inbox): serialize autosave and merge latest content"
```

---

## Chunk 4: Context Consistency

### Task 5: Reuse Shared Video Transcript Logic in `ContextManager`

**Files:**
- Modify: `src/services/context-manager.ts`
- Modify: `test/context-manager.test.ts`

- [ ] **Step 1: Extend the existing context tests**

Update `test/context-manager.test.ts` with async cases that verify:

- `youtube` context resolves through the shared video transcript utility
- `url` context returns an explicit error marker for failed fetches
- resolved context content is cached on the context item

- [ ] **Step 2: Run the test to verify the new assertions fail**

Run: `cmd /c npx.cmd tsx test/context-manager.test.ts`

Expected: FAIL because current code uses its own ad-hoc YouTube parser and lacks response-status checks.

- [ ] **Step 3: Update `ContextManager` to reuse `getVideoTranscript()`**

In `src/services/context-manager.ts`:

- remove the duplicated YouTube transcript scraping logic
- call `getVideoTranscript()` from `src/utils/video_utils.ts`
- normalize the returned transcript into a bounded text block for prompt context
- add HTTP status checks in `fetchWebContent()`

- [ ] **Step 4: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/context-manager.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-manager.ts test/context-manager.test.ts
git commit -m "fix(context): reuse shared transcript and harden URL fetches"
```

---

### Task 6: Clear Stale Selection and Accept Plain URL Context in `ShellView`

**Files:**
- Modify: `src/ui/shell-view.ts`

- [ ] **Step 1: Implement the selection reset**

In `src/ui/shell-view.ts`:

- set `this.currentSelection = ''` before probing the active editor
- only pass a non-empty selection when an editor is present and `getSelection()` returns text

- [ ] **Step 2: Expand paste handling for plain URLs**

Still in `src/ui/shell-view.ts`:

- when pasted plain text is a valid URL:
  - classify YouTube URLs as `youtube`
  - classify all other URLs as `url`
- keep image paste behavior unchanged

- [ ] **Step 3: Build and do a manual smoke check**

Run: `cmd /c npm.cmd run build`

Expected: PASS

Manual verification:

1. Select text in an editor, send one message, then clear the selection.
2. Send a second message from a context with no selection.
3. Confirm the second request does not reuse the old selected text.
4. Paste a normal webpage URL and confirm a context chip appears.

- [ ] **Step 4: Commit**

```bash
git add src/ui/shell-view.ts
git commit -m "fix(shell-view): clear stale selection and accept plain URL context"
```

---

## Chunk 5: Search and Request Hardening

### Task 7: Harden `web_search` Against 202 / Empty / Error Pages

**Files:**
- Modify: `src/skills/builtin/web-search/executor.ts`
- Test: `test/web-search.test.ts`

- [ ] **Step 1: Write failing tests for DuckDuckGo retry and error handling**

Create `test/web-search.test.ts` with cases that verify:

- `202` pages retry up to the configured limit
- short / obviously invalid HTML returns a “no results or parsing failed” result
- thrown request errors return `{ error: ... }`

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx test/web-search.test.ts`

Expected: FAIL because current implementation performs a single request and blindly parses the response body.

- [ ] **Step 3: Implement response checks and bounded retries**

In `src/skills/builtin/web-search/executor.ts`:

- check `response.status`
- retry on `202` or suspiciously short HTML up to 3 times
- preserve the existing result shape
- do not throw raw parse errors to callers

- [ ] **Step 4: Re-run the focused test and build**

Run: `cmd /c npx.cmd tsx test/web-search.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/builtin/web-search/executor.ts test/web-search.test.ts
git commit -m "fix(web-search): add response validation and retries"
```

---

## Chunk 6: Final Verification

### Task 8: Run Regression Pass Across Hardened Collection Paths

**Files:**
- Test only

- [ ] **Step 1: Run all focused regression tests**

Run each command separately:

`cmd /c npx.cmd tsx test/web-clipper.test.ts`

`cmd /c npx.cmd tsx test/memory-manager.test.ts`

`cmd /c npx.cmd tsx test/model-service.test.ts`

`cmd /c npx.cmd tsx test/inbox-autosave.test.ts`

`cmd /c npx.cmd tsx test/context-manager.test.ts`

`cmd /c npx.cmd tsx test/web-search.test.ts`

Expected: PASS for all files

- [ ] **Step 2: Run the production build**

Run: `cmd /c npm.cmd run build`

Expected: PASS and `main.js` regenerated successfully

- [ ] **Step 3: Manual smoke test the user-facing flows**

Verify:

1. `/save <YouTube URL>` creates a valid note with summary or clean fallback.
2. `/save <normal webpage>` does not save obvious error pages as articles.
3. Editing `Inbox.md` during autosave does not lose newer user edits.
4. Pasted YouTube and normal URLs both become usable context chips.
5. Switching provider/model does not lose the current memory session.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test: verify hardened data collection flows"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-04-21-data-collection-hardening.md`. Ready to execute?
