# Video Transcription Fallback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为视频保存链路增加“平台字幕优先、音频转写兜底”的能力，让无字幕视频也能尽量生成真实内容摘要。

**Architecture:** 保持现有 `save_webpage -> video_utils -> web-clipper` 主链路不变，只新增一个独立的 `video-transcription` 服务。`video_utils` 继续优先尝试平台字幕；若字幕缺失，再由 `web-clipper` 调用音频下载与转写服务；若转写失败，再退回 metadata 摘要而不是纯链接。

**Tech Stack:** TypeScript, Obsidian API, `fetch`, OpenAI-compatible audio transcription endpoint, `tsx` regression tests

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/video_utils.ts` | Modify | 暴露字幕缺失状态、描述信息、平台优先结果 |
| `src/services/video-transcription.ts` | Create | 提取音频 URL、下载音频字节、调用转写接口 |
| `src/skills/builtin/web-clipper/executor.ts` | Modify | 接入转写兜底，统一“链接 + 摘要 + 摘录”模板 |
| `test/video-utils.test.ts` | Create | 平台字幕缺失和描述提取回归 |
| `test/video-transcription.test.ts` | Create | 音频下载与 OpenAI-compatible 转写回归 |
| `test/web-clipper.test.ts` | Modify | 无字幕视频走转写兜底回归 |

---

## Chunk 1: Platform State Modeling

### Task 1: Extend `VideoTranscript` to Represent Missing Platform Subtitles

**Files:**
- Modify: `src/utils/video_utils.ts`
- Test: `test/video-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/video-utils.test.ts` with cases that verify:

- a video with platform subtitles returns `text` plus `transcriptSource = 'platform-subtitle'`
- a video with no platform subtitles still returns `title`, `description`, and `needsTranscription = true`

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-utils.test.ts`

Expected: FAIL because `VideoTranscript` does not yet expose `description`, `transcriptSource`, or `needsTranscription`.

- [ ] **Step 3: Implement minimal state extensions**

In `src/utils/video_utils.ts`:

- extend `VideoTranscript` with:
  - `description?: string`
  - `transcriptSource?: 'platform-subtitle' | 'audio-transcription' | 'metadata'`
  - `needsTranscription?: boolean`
- mark subtitle-missing cases as `needsTranscription = true`
- keep existing title / author / URL extraction behavior

- [ ] **Step 4: Run the test and build**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-utils.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

---

## Chunk 2: Audio Transcription Service

### Task 2: Add OpenAI-Compatible Audio Transcription Helper

**Files:**
- Create: `src/services/video-transcription.ts`
- Test: `test/video-transcription.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/video-transcription.test.ts` with cases that verify:

- the helper downloads audio bytes from a resolved media URL
- it submits a multipart request to `/audio/transcriptions`
- it reads the common `{ text: "..." }` response shape
- it surfaces a clear error when the provider returns non-200

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-transcription.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service**

Create `src/services/video-transcription.ts` with:

- audio URL fetch helper
- byte download helper
- multipart transcription helper
- minimal dependency injection for tests

- [ ] **Step 4: Run the test and build**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-transcription.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

---

## Chunk 3: Clipper Integration

### Task 3: Use Audio Transcription When Platform Subtitles Are Missing

**Files:**
- Modify: `src/skills/builtin/web-clipper/executor.ts`
- Modify: `test/web-clipper.test.ts`

- [ ] **Step 1: Write the failing regression**

Extend `test/web-clipper.test.ts` with a case that verifies:

- a video with `text = ''` and `needsTranscription = true`
- calls the new transcription service
- saves a note containing:
  - the original video link
  - `Play with Media Extended`
  - `## Summary`
  - `## Transcript Excerpt`

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/web-clipper.test.ts`

Expected: FAIL because the clipper currently falls back from missing subtitles directly to metadata or link-only behavior.

- [ ] **Step 3: Implement minimal integration**

In `src/skills/builtin/web-clipper/executor.ts`:

- keep platform subtitle path first
- when `needsTranscription = true`, call the new transcription helper
- if transcription succeeds, build the same “link + summary + transcript excerpt” note shape as subtitle-based saves
- if transcription fails, fall back to metadata summary

- [ ] **Step 4: Run the focused test and build**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/web-clipper.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

---

## Chunk 4: Real-World Failure Handling

### Task 4: Make Unsupported Providers Fail Clearly but Safely

**Files:**
- Modify: `src/services/video-transcription.ts`
- Modify: `src/skills/builtin/web-clipper/executor.ts`
- Test: `test/video-transcription.test.ts`

- [ ] **Step 1: Write the failing test**

Add a case that verifies:

- when the current provider does not support `/audio/transcriptions`
- the code returns a clear diagnostic error internally
- but the saved note still falls back to metadata summary instead of link-only

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-transcription.test.ts`

Expected: FAIL because unsupported-provider handling is not explicit yet.

- [ ] **Step 3: Implement minimal failure mapping**

Ensure:

- unsupported transcription endpoint is surfaced as a typed or clearly prefixed error
- `web-clipper` catches it and continues to metadata summary fallback

- [ ] **Step 4: Run the test and build**

Run: `cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-transcription.test.ts`

Expected: PASS

Run: `cmd /c npm.cmd run build`

Expected: PASS

---

## Chunk 5: Final Verification

### Task 5: Verify End-to-End Behavior

**Files:**
- Test only

- [ ] **Step 1: Run focused regression suite**

Run separately:

`cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-utils.test.ts`

`cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/video-transcription.test.ts`

`cmd /c npx.cmd tsx --tsconfig tsconfig.test.json test/web-clipper.test.ts`

Expected: PASS

- [ ] **Step 2: Run production build**

Run: `cmd /c npm.cmd run build`

Expected: PASS

- [ ] **Step 3: Manual smoke check**

Verify with one video of each type:

1. YouTube with subtitles
2. Bilibili with subtitles
3. Bilibili without subtitles but with available audio stream

Expected:

- all saved notes keep the playable link
- subtitle or transcription based notes contain `## Summary`
- failures degrade to metadata summary, not pure link-only notes

---

Plan complete and saved to `docs/superpowers/plans/2026-04-22-video-transcription-fallback.md`. Ready to execute?
