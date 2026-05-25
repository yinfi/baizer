# Obsidian 原生 AI 操作层 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `baizer` 从 shell-first 的 AI 助手升级为 editor-first、knowledge-visible、preview-before-mutation 的 Obsidian 原生 AI 操作层。

**Architecture:** 保留现有 `ModelService -> ChatRuntime -> ToolRegistry / SkillRegistry -> KnowledgeRuntime` 执行链，在其上补三层产品抽象：`ObsidianContextService` 负责笔记语义上下文，`GenerationStrategyService` 负责任务解释与输出契约，`ChangePreview`/`OperationAuditLog` 负责可信写入链路。第一阶段不改动底层 provider、tool loop 和知识 frontmatter 基础格式，只在现有接口上增加可组合的服务和 UI。

**Tech Stack:** TypeScript, Obsidian Plugin API, CodeMirror 6, existing `tsx` test harness (`npm test` -> `test/run-tests.ts`), existing mock layer in `test/__mocks__/obsidian.ts`, no new runtime dependency unless a later task proves the current diff helper is insufficient.

---

## File Structure

### New Files

- `src/services/obsidian-context-service.ts`
  - 汇总 active note、selection、heading、frontmatter、tags、outgoing links、backlinks、recent notes、显式 `@scope`。
- `src/services/generation-strategy-service.ts`
  - 定义 `GenerationPlan`、`WritingProfile`、`GenerationSource`，负责 `interpret + plan`。
- `src/services/generation-quality.ts`
  - 对生成结果做最小质量门槛检查。
- `src/ui/diff/change-preview.ts`
  - 统一文件写入、选区替换、插件命令的预览模型。
- `src/ui/components/change-preview-card.ts`
  - 渲染 preview 卡片并复用现有 approval 动作。
- `src/knowledge/status-service.ts`
  - 暴露 UI 需要的 note 级和全局知识状态。
- `src/ui/components/knowledge-status-panel.ts`
  - 展示当前笔记知识状态和常用操作。
- `src/services/operation-audit-log.ts`
  - 记录用户可见的 AI 写入与插件执行。
- `test/obsidian-context-service.test.ts`
- `test/generation-strategy-service.test.ts`
- `test/generation-quality.test.ts`
- `test/change-preview.test.ts`
- `test/knowledge-status-service.test.ts`
- `test/operation-audit-log.test.ts`

### Modified Files

- `src/services/context-manager.ts:5-18,29-60`
- `src/ui/controllers/context-controller.ts:13-35`
- `src/ui/controllers/input-controller.ts:1-90`
- `src/ui/components/context-chips.ts:10-66`
- `src/ui/shell-view.ts:315-460,640-680`
- `src/runtime/runtime-types.ts:3-15`
- `src/runtime/chat-runtime.ts:46-76,132-308`
- `src/services/model-service.ts:237-365`
- `src/ui/chat-controller.ts:86-186,298-328,426-612`
- `src/ui/guardian-request.ts:1-6`
- `main.ts:321-443`
- `src/ui/approval-card.ts:1-33`
- `src/ui/types.ts:1-38`
- `src/ui/state/chat-state.ts:82-92`
- `src/ui/history/conversation-store.ts:133-145`
- `src/ui/renderers/message-renderer.ts:1-75`
- `src/ui/selection-menu.ts:20-205`
- `src/ui/diff-modal.ts:3-55`
- `src/skills/builtin/vault-ops.ts:31-169,293-424`
- `src/skills/builtin/plugin-ctrl/executor.ts:63-84`
- `src/skills/builtin/plugin-ctrl/skill-generator.ts:36-58,112-131,296-453`
- `src/knowledge/runtime.ts:46-47,104-178,265-320`
- `src/mcp/types.ts:70-133`
- `src/settings.ts:773-808`
- `README.md`
- `AGENTS.md`
- `test/run-tests.ts`

### Architectural Constraints To Keep

- Do **not** introduce a new top-level `src/generation/` directory. This repo already keeps orchestration services under `src/services/`; follow that pattern.
- Do **not** replace the existing `approval_required` tool contract. Add `preview` as structured metadata on top of the current contract so `ChatRuntime` and `ChatController` can evolve incrementally.
- Do **not** change `knowledge/frontmatter.ts` persisted status enum in this pass. `KnowledgeStatusService` should compute `unregistered` and `stale` as derived UI states from current data.
- Do **not** redesign `MemoryManager` storage first. Build `WritingProfile` from current `UserProfile.preferences` plus note-local heuristics, and only persist more if phase 1 proves it necessary.

### Core Contracts To Lock First

`src/services/generation-strategy-service.ts`

```ts
export type GenerationSource = 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';

export type GenerationMode =
  | 'co-write'
  | 'rewrite'
  | 'structure'
  | 'summarize'
  | 'knowledge-link'
  | 'archive'
  | 'naming';

export interface WritingProfile {
  responseStyle: 'concise' | 'balanced' | 'detailed';
  prefersLists: boolean;
  headingDensity: 'low' | 'medium' | 'high';
  noteTone: 'neutral' | 'technical' | 'reflective' | 'action-oriented';
  bannedPhrases: string[];
}

export interface GenerationPlan {
  source: GenerationSource;
  mode: GenerationMode;
  targetShape: 'replacement' | 'outline' | 'answer' | 'knowledge-entry';
  previewRequired: boolean;
  mustPreserveVoice: boolean;
  mustUseObsidianMarkdown: boolean;
  qualityChecklist: string[];
}
```

`src/ui/diff/change-preview.ts`

```ts
export type ChangePreviewKind =
  | 'editor-selection-replace'
  | 'note-replace'
  | 'note-append'
  | 'note-create'
  | 'note-rename'
  | 'note-delete'
  | 'plugin-command';

export interface ChangePreview {
  kind: ChangePreviewKind;
  target: string;
  summary: string;
  oldContent?: string;
  newContent?: string;
  commandId?: string;
  preconditions?: string[];
  risk: 'low' | 'medium' | 'high';
  supportsPartialApply: boolean;
  undoable: boolean;
}
```

## Chunk 1: 上下文统一层与生成策略层

### Task 1: 新建 `ObsidianContextService`，把“当前笔记语义上下文”从控制器逻辑里抽出来

**Files:**
- Create: `src/services/obsidian-context-service.ts`
- Test: `test/obsidian-context-service.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试，锁定当前笔记上下文字段和裁切策略**

```ts
const result = await service.collect({
  includeBacklinks: true,
  explicitScopes: ['current', 'backlinks'],
});

expect(result.activeNote?.path).toBe('Projects/Native AI.md');
expect(result.selection?.text).toBe('selected text');
expect(result.activeHeading).toBe('## 背景');
expect(result.backlinks.length).toBe(2);
expect(result.contextItems.some((item) => item.data.includes('Backlinks summary'))).toBe(true);
```

Run: `npx tsx --tsconfig tsconfig.test.json test/obsidian-context-service.test.ts`
Expected: FAIL with missing module `src/services/obsidian-context-service.ts`

- [ ] **Step 2: 实现服务，先交付纯读取和裁切，不接 UI**

```ts
export interface ObsidianContextSnapshot {
  activeNote: { path: string; title: string } | null;
  selection: { text: string; from?: number; to?: number } | null;
  activeHeading: string | null;
  frontmatter: Record<string, unknown>;
  tags: string[];
  outgoingLinks: string[];
  backlinks: Array<{ path: string; summary: string }>;
  recentNotes: Array<{ path: string; title: string }>;
  explicitScopes: string[];
  contextItems: ContextItem[];
}
```

- [ ] **Step 3: 把测试加到总测试入口**

Run: `npx tsx --tsconfig tsconfig.test.json test/run-tests.ts`
Expected: FAIL only on the new context test until implementation is complete

- [ ] **Step 4: 跑单测确认通过**

Run: `npx tsx --tsconfig tsconfig.test.json test/obsidian-context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/obsidian-context-service.ts test/obsidian-context-service.test.ts test/run-tests.ts
git commit -m "feat: add obsidian context service"
```

### Task 2: 把 `@current` / `@backlinks` / `@recent` / `@tag:*` 变成真实上下文 scope，而不是纯文本占位

**Files:**
- Modify: `src/services/context-manager.ts:5-18,29-60`
- Modify: `src/ui/controllers/context-controller.ts:13-35`
- Modify: `src/ui/controllers/input-controller.ts:1-90`
- Modify: `src/ui/components/context-chips.ts:10-66`
- Modify: `src/ui/shell-view.ts:315-460`
- Test: `test/context-controller.test.ts`
- Test: `test/input-controller.test.ts`
- Test: `test/context-chips.test.ts`
- Test: `test/command-suggestions.test.ts`

- [ ] **Step 1: 写失败测试，锁定 `@scope` suggestion 和 context chip 展示**

```ts
expect(detectSuggestionTrigger('summarize @bac', 14)).toEqual({
  type: 'file',
  query: 'bac',
});

expect(chipLabels).toEqual(['@current', '@backlinks', '@tag:project-x']);
```

Run: `npx tsx --tsconfig tsconfig.test.json test/input-controller.test.ts`
Expected: FAIL because scope suggestions and chip labels do not exist yet

- [ ] **Step 2: 在 `ContextItem` 上增加 scope 语义，避免用字符串猜类型**

```ts
export interface ContextItem {
  id: string;
  type: 'file' | 'image' | 'url' | 'youtube' | 'text' | 'scope';
  data: string;
  summary?: string;
  content?: string;
  scope?: 'current' | 'backlinks' | 'recent' | 'tag';
}
```

- [ ] **Step 3: 改造 `ContextController.collectCommandContext()`，由 `ObsidianContextService` 负责把 scope 解析成真实上下文**

Run: `npx tsx --tsconfig tsconfig.test.json test/context-controller.test.ts`
Expected: PASS with active note + explicit scope results merged in deterministic order

- [ ] **Step 4: 在 `ShellView` suggestion 分支里补 scope suggestions，并让命中结果生成 chip 而不是只写回输入框**

Run: `npx tsx --tsconfig tsconfig.test.json test/command-suggestions.test.ts test/context-chips.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-manager.ts src/ui/controllers/context-controller.ts src/ui/controllers/input-controller.ts src/ui/components/context-chips.ts src/ui/shell-view.ts test/context-controller.test.ts test/input-controller.test.ts test/context-chips.test.ts test/command-suggestions.test.ts
git commit -m "feat: add scoped obsidian context mentions"
```

### Task 3: 新建 `GenerationStrategyService` 与 `generation-quality`，统一解释 Shell、Guardian、selection、`/edit`

**Files:**
- Create: `src/services/generation-strategy-service.ts`
- Create: `src/services/generation-quality.ts`
- Modify: `src/runtime/runtime-types.ts:3-15`
- Modify: `src/runtime/chat-runtime.ts:46-76,132-308`
- Modify: `src/services/model-service.ts:237-365`
- Modify: `src/ui/chat-controller.ts:594-612`
- Modify: `src/ui/guardian-request.ts:1-6`
- Modify: `main.ts:321-443`
- Test: `test/generation-strategy-service.test.ts`
- Test: `test/generation-quality.test.ts`
- Test: `test/chat-runtime.test.ts`
- Test: `test/chat-controller.test.ts`
- Test: `test/guardian-request.test.ts`
- Test: `test/model-service.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试，先锁定 mode 推断和运行时注入**

```ts
expect(service.resolvePlan({
  userMessage: '把这段话改写得更清楚',
  source: 'selection-menu',
  context,
})).toMatchObject({
  mode: 'rewrite',
  targetShape: 'replacement',
  previewRequired: true,
});
```

Run: `npx tsx --tsconfig tsconfig.test.json test/generation-strategy-service.test.ts`
Expected: FAIL with missing module `src/services/generation-strategy-service.ts`

- [ ] **Step 2: 实现计划解析器，先做纯函数，不直接依赖 provider**

```ts
resolvePlan(input: {
  userMessage: string;
  source: GenerationSource;
  context: ObsidianContextSnapshot;
  profile?: UserProfile | null;
}): GenerationPlan
```

- [ ] **Step 3: 实现最小质量检查器，拦截“只做同义改写”和“不符合输出形态”的结果**

```ts
export function evaluateGenerationQuality(input: {
  originalText?: string;
  generatedText: string;
  plan: GenerationPlan;
}): { ok: boolean; reasons: string[] }
```

- [ ] **Step 4: 把 `PreparedChatTurn` 扩展为携带 `generationPlan`，并让 `prepareTurn()` 明确注入 mode、target shape、quality checklist**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts`
Expected: PASS with prompt containing generation-plan metadata instead of generic write-only prompt

- [ ] **Step 5: 让 Guardian 和 `/edit` 也走同一套策略服务**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts test/guardian-request.test.ts test/model-service.test.ts`
Expected: PASS

- [ ] **Step 6: 把新测试加到总入口并提交**

```bash
git add src/services/generation-strategy-service.ts src/services/generation-quality.ts src/runtime/runtime-types.ts src/runtime/chat-runtime.ts src/services/model-service.ts src/ui/chat-controller.ts src/ui/guardian-request.ts main.ts test/generation-strategy-service.test.ts test/generation-quality.test.ts test/chat-runtime.test.ts test/chat-controller.test.ts test/guardian-request.test.ts test/model-service.test.ts test/run-tests.ts
git commit -m "feat: unify generation planning across entry points"
```

## Chunk 2: 预览链路与编辑器内应用

### Task 4: 定义 `ChangePreview`，并把 preview 挂到现有 approval / message 持久化结构上

**Files:**
- Create: `src/ui/diff/change-preview.ts`
- Modify: `src/ui/approval-card.ts:1-33`
- Modify: `src/ui/types.ts:1-38`
- Modify: `src/ui/state/chat-state.ts:82-92`
- Modify: `src/ui/history/conversation-store.ts:133-145`
- Test: `test/change-preview.test.ts`
- Test: `test/chat-state.test.ts`
- Test: `test/conversation-store.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试，锁定 preview 字段会在消息克隆与会话持久化里保留下来**

```ts
expect(saved.messages[0].approval?.preview?.kind).toBe('note-create');
expect(restored.messages[0].approval?.preview?.target).toBe('Plans/Native-AI.md');
```

Run: `npx tsx --tsconfig tsconfig.test.json test/change-preview.test.ts`
Expected: FAIL with missing `ChangePreview` module

- [ ] **Step 2: 给 `ApprovalRequest` 增加可选 `preview` 字段，不改掉原有 `approval_required` 语义**

```ts
export interface ApprovalRequest {
  action: string;
  target: string;
  args: Record<string, any>;
  message: string;
  preview?: ChangePreview;
}
```

- [ ] **Step 3: 修复 `ChatState` 与 `ConversationStore` 的 clone 逻辑，避免 preview 在 copy 时丢失**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-state.test.ts test/conversation-store.test.ts`
Expected: PASS

- [ ] **Step 4: 把测试加入总入口并提交**

```bash
git add src/ui/diff/change-preview.ts src/ui/approval-card.ts src/ui/types.ts src/ui/state/chat-state.ts src/ui/history/conversation-store.ts test/change-preview.test.ts test/chat-state.test.ts test/conversation-store.test.ts test/run-tests.ts
git commit -m "feat: add change preview contract"
```

### Task 5: 让 vault 工具和 plugin command 在审批前返回结构化 preview，而不是只返回一句 message

**Files:**
- Create: `src/ui/components/change-preview-card.ts`
- Modify: `src/skills/builtin/vault-ops.ts:31-169,293-424`
- Modify: `src/skills/builtin/plugin-ctrl/executor.ts:63-84`
- Modify: `src/ui/approval-card.ts:1-33`
- Modify: `src/ui/renderers/message-renderer.ts:1-75`
- Modify: `src/ui/chat-controller.ts:86-186,298-328`
- Test: `test/approval-flow.test.ts`
- Test: `test/file-tools.test.ts`
- Test: `test/vault-permissions.test.ts`
- Test: `test/plugin-tools.test.ts`
- Test: `test/message-renderer.test.ts`

- [ ] **Step 1: 写失败测试，要求 `create_file` / `update_file` / `execute_plugin_command` 返回 preview**

```ts
expect(result.preview).toMatchObject({
  kind: 'note-create',
  target: 'Docs/summary.md',
  risk: 'medium',
});
```

Run: `npx tsx --tsconfig tsconfig.test.json test/file-tools.test.ts`
Expected: FAIL because approval payload currently has no preview

- [ ] **Step 2: 在 `vault-ops.ts` 里统一通过 `buildApprovalResponse()` 生成 preview**

```ts
return buildApprovalResponse('update_file', path, args, 'update file', {
  kind: 'note-replace',
  target: path,
  oldContent,
  newContent: args.content,
  risk: 'medium',
  supportsPartialApply: false,
  undoable: true,
});
```

- [ ] **Step 3: 给 `execute_plugin_command` 增加 `plugin-command` preview 和 `preconditions` 字段**

Run: `npx tsx --tsconfig tsconfig.test.json test/plugin-tools.test.ts`
Expected: PASS with approval payload describing command id and preconditions

- [ ] **Step 4: 渲染 `ChangePreviewCard`，并让 `renderApprovalCard()` 在 `preview` 存在时走新卡片**

Run: `npx tsx --tsconfig tsconfig.test.json test/approval-flow.test.ts test/message-renderer.test.ts test/vault-permissions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/change-preview-card.ts src/skills/builtin/vault-ops.ts src/skills/builtin/plugin-ctrl/executor.ts src/ui/approval-card.ts src/ui/renderers/message-renderer.ts src/ui/chat-controller.ts test/approval-flow.test.ts test/file-tools.test.ts test/vault-permissions.test.ts test/plugin-tools.test.ts test/message-renderer.test.ts
git commit -m "feat: add preview-driven approvals"
```

### Task 6: 让 selection rewrite 走 preview + apply，而不是直接替换选区

**Files:**
- Modify: `src/ui/selection-menu.ts:20-205`
- Modify: `src/ui/diff-modal.ts:3-55`
- Modify: `src/ui/chat-controller.ts:426-612`
- Test: `test/chat-controller.test.ts`
- Test: `test/change-preview.test.ts`

- [ ] **Step 1: 写失败测试，锁定“最后一条 AI 回复”会先生成 `editor-selection-replace` preview**

```ts
const preview = buildSelectionPreview({
  target: 'current-selection',
  oldContent: 'before',
  newContent: 'after',
});

expect(preview.kind).toBe('editor-selection-replace');
expect(preview.supportsPartialApply).toBe(true);
```

Run: `npx tsx --tsconfig tsconfig.test.json test/change-preview.test.ts`
Expected: FAIL because no selection preview helper exists

- [ ] **Step 2: 复用现有 `DiffModal` 做局部预览，不另造一套 editor modal**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts`
Expected: PASS with helper behavior covered and no direct editor replacement path left

- [ ] **Step 3: 手动验证 selection menu**
  - 选中文本
  - 提问得到 AI 回复
  - 点击替换动作后先看到 diff
  - 点击 Apply 后才真正修改编辑器内容

- [ ] **Step 4: Commit**

```bash
git add src/ui/selection-menu.ts src/ui/diff-modal.ts src/ui/chat-controller.ts test/chat-controller.test.ts test/change-preview.test.ts
git commit -m "feat: preview selection rewrites before apply"
```

## Chunk 3: 知识状态前台化

### Task 7: 新建 `KnowledgeStatusService`，在不改 frontmatter 基础格式的前提下暴露 UI 状态

**Files:**
- Create: `src/knowledge/status-service.ts`
- Modify: `src/knowledge/runtime.ts:46-47,104-178,265-320`
- Test: `test/knowledge-status-service.test.ts`
- Test: `test/knowledge/watcher.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试，锁定 note 状态、stale 推导和全局统计**

```ts
expect(service.getNoteStatus('Projects/Native AI.md')).toMatchObject({
  state: 'stale',
  summaryPath: 'Knowledge Wiki/Projects/Native AI.md',
});
expect(service.getGlobalCounts()).toEqual({
  pending: 2,
  failed: 1,
  stale: 3,
});
```

Run: `npx tsx --tsconfig tsconfig.test.json test/knowledge-status-service.test.ts`
Expected: FAIL with missing module `src/knowledge/status-service.ts`

- [ ] **Step 2: 实现服务，注意 `stale` 和 `unregistered` 是派生状态，不写回 frontmatter**

```ts
export type KnowledgePanelState =
  | 'unregistered'
  | 'pending'
  | 'processing'
  | 'done'
  | 'failed'
  | 'stale';
```

- [ ] **Step 3: 让 `KnowledgeRuntime` 持有并暴露 `statusService`，不要让 UI 直接读 compiler / watcher 内部对象**

Run: `npx tsx --tsconfig tsconfig.test.json test/knowledge-status-service.test.ts test/knowledge/watcher.test.ts`
Expected: PASS

- [ ] **Step 4: 把测试加到总入口并提交**

```bash
git add src/knowledge/status-service.ts src/knowledge/runtime.ts test/knowledge-status-service.test.ts test/knowledge/watcher.test.ts test/run-tests.ts
git commit -m "feat: add knowledge status service"
```

### Task 8: 增加知识状态面板和“归档到知识库”消息动作

**Files:**
- Create: `src/ui/components/knowledge-status-panel.ts`
- Modify: `src/ui/shell-view.ts:640-680`
- Modify: `src/ui/renderers/message-renderer.ts:1-75`
- Modify: `src/ui/chat-controller.ts:308-328`
- Test: `test/message-renderer.test.ts`
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: 写失败测试，要求消息渲染器出现归档动作，且控制器能走现有 `file_back_knowledge`**

```ts
expect(actions).toContain('归档到知识库');
expect(executedTool.action).toBe('file_back_knowledge');
```

Run: `npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts`
Expected: FAIL because archive action is not rendered yet

- [ ] **Step 2: 实现 `KnowledgeStatusPanel`，展示当前 note 状态、backlinks 数量、最近编译时间和常用动作**

- [ ] **Step 3: 把 panel 接到 `ShellView`，不要把知识状态逻辑塞回 `ChatController`**

Run: `npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts test/message-renderer.test.ts`
Expected: PASS

- [ ] **Step 4: 手动验证**
  - 当前 note 打开时能看到知识状态
  - stale / pending / failed 文案可区分
  - AI 回答可以一键归档

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/knowledge-status-panel.ts src/ui/shell-view.ts src/ui/renderers/message-renderer.ts src/ui/chat-controller.ts test/message-renderer.test.ts test/chat-controller.test.ts
git commit -m "feat: surface knowledge status and archive actions"
```

## Chunk 4: 插件工作流、审计与权限收口

### Task 9: 强化 plugin skill 生成结果和 plugin command 前置条件表达

**Files:**
- Modify: `src/skills/builtin/plugin-ctrl/skill-generator.ts:36-58,112-131,296-453`
- Modify: `src/skills/builtin/plugin-ctrl/executor.ts:63-84`
- Test: `test/plugin-skill-generator.test.ts`
- Test: `test/plugin-tools.test.ts`

- [ ] **Step 1: 写失败测试，要求生成的 skill 文档明确说出 active file / selection / UI focus 前提**

```ts
expect(skillMd).toContain('前置条件');
expect(skillMd).toContain('先打开目标笔记');
expect(skillMd).not.toContain('execute_plugin_command(commandId, path)');
```

Run: `npx tsx --tsconfig tsconfig.test.json test/plugin-skill-generator.test.ts`
Expected: FAIL because generated skill text does not require preconditions yet

- [ ] **Step 2: 收紧 SYSTEM_PROMPT 和命令分类逻辑，让生成内容优先写前置条件和 vault 协作方式**

- [ ] **Step 3: 把 plugin command preview 中的 `preconditions` 与生成文档保持同源表达**

Run: `npx tsx --tsconfig tsconfig.test.json test/plugin-skill-generator.test.ts test/plugin-tools.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/skill-generator.ts src/skills/builtin/plugin-ctrl/executor.ts test/plugin-skill-generator.test.ts test/plugin-tools.test.ts
git commit -m "fix: clarify plugin workflow preconditions"
```

### Task 10: 增加 `OperationAuditLog`，记录所有用户可见变更和已批准执行

**Files:**
- Create: `src/services/operation-audit-log.ts`
- Modify: `src/services/model-service.ts:339-365`
- Modify: `src/ui/chat-controller.ts:308-328,426-470`
- Test: `test/operation-audit-log.test.ts`
- Test: `test/approval-flow.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: 写失败测试，锁定记录格式、最近操作读取和 undo 元数据判断**

```ts
expect(records[0]).toMatchObject({
  action: 'update_file',
  target: 'Docs/summary.md',
  approvalSource: 'user-click',
  undoable: true,
});
```

Run: `npx tsx --tsconfig tsconfig.test.json test/operation-audit-log.test.ts`
Expected: FAIL with missing module `src/services/operation-audit-log.ts`

- [ ] **Step 2: 实现轻量审计存储，格式参考 `ConversationStore`，但单独落盘**

```ts
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
```

- [ ] **Step 3: 在 `executeApprovedAction()` 和需要即时应用的本地 selection preview 上都写审计**

Run: `npx tsx --tsconfig tsconfig.test.json test/operation-audit-log.test.ts test/approval-flow.test.ts`
Expected: PASS

- [ ] **Step 4: 把测试加入总入口并提交**

```bash
git add src/services/operation-audit-log.ts src/services/model-service.ts src/ui/chat-controller.ts test/operation-audit-log.test.ts test/approval-flow.test.ts test/run-tests.ts
git commit -m "feat: add operation audit log"
```

### Task 11: 增加“写入范围”设置并统一 direct vault write 权限判断

**Files:**
- Modify: `src/mcp/types.ts:70-133`
- Modify: `src/settings.ts:773-808`
- Modify: `src/skills/builtin/vault-ops.ts:31-169,293-424`
- Test: `test/settings-state.test.ts`
- Test: `test/vault-permissions.test.ts`

- [ ] **Step 1: 写失败测试，锁定四档写入范围**

```ts
expect(canWrite({ scope: 'current-note', target: 'Projects/A.md', activeNote: 'Projects/A.md' })).toBe(true);
expect(canWrite({ scope: 'current-note', target: 'Projects/B.md', activeNote: 'Projects/A.md' })).toBe(false);
```

Run: `npx tsx --tsconfig tsconfig.test.json test/vault-permissions.test.ts`
Expected: FAIL because write scope does not exist yet

- [ ] **Step 2: 在设置类型里增加 scope 字段，不移除现有布尔开关**

```ts
export type VaultWriteScope =
  | 'read-only'
  | 'current-note'
  | 'configured-folders'
  | 'all-vault';
```

- [ ] **Step 3: 在 `vault-ops.ts` 里统一先判 scope，再判 create/modify 布尔开关和 `.obsidian` 路径**

Run: `npx tsx --tsconfig tsconfig.test.json test/settings-state.test.ts test/vault-permissions.test.ts`
Expected: PASS

- [ ] **Step 4: 更新设置面板文案，用 Obsidian 术语解释范围**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/types.ts src/settings.ts src/skills/builtin/vault-ops.ts test/settings-state.test.ts test/vault-permissions.test.ts
git commit -m "feat: add vault write scope controls"
```

### Task 12: 文档与整体验证

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Verify: `package.json`, `test/run-tests.ts`

- [ ] **Step 1: 更新 README，明确 editor-first、knowledge-visible、preview-before-mutation**

- [ ] **Step 2: 更新 AGENTS.md，补充新的服务边界和“优先走 skill / preview / context service”的约束**

- [ ] **Step 3: 跑完整测试**

Run: `npm test`
Expected: PASS with new test files included in `test/run-tests.ts`

- [ ] **Step 4: 跑构建**

Run: `npm run build`
Expected: PASS and regenerate `main.js`

- [ ] **Step 5: 手动验收四个核心场景**
  - selection rewrite 先预览再应用
  - Guardian 输出明显贴近当前 note 结构
  - Shell 的 `@current` / `@backlinks` / `@tag:*` 可形成真实上下文
  - 文件写入和插件命令都有 preview + approval + audit

- [ ] **Step 6: Final Commit**

```bash
git add README.md AGENTS.md package.json test/run-tests.ts
git commit -m "docs: finalize native ai layer rollout plan"
```

## Rollout Order

1. 先做 Chunk 1。没有统一上下文和生成策略，后面的 UI 强化只会继续堆 prompt 特例。
2. 再做 Chunk 2。只有 preview 链路稳了，编辑器内 AI 才适合前移为主入口。
3. 再做 Chunk 3。知识状态前台化应建立在上下文和 preview 已经稳定的基础上。
4. 最后做 Chunk 4。插件、审计和权限跨面更广，适合在核心交互稳定后收口。

## Assumptions

- 设计基线只来自 `docs/superpowers/specs/2026-05-13-obsidian-native-ai-design.md`。
- 第一轮不引入 Plan Mode、subagent UI、bash 执行增强、MCP server manager 或复杂知识图谱界面。
- 当前 `DiffModal` 足够支撑第一版 selection preview；如果手动验收发现局部 diff 可读性不足，再单独立项升级 diff 算法。
- `KnowledgeStatusService` 的 `stale` 是派生 UI 状态，不作为新的 frontmatter 写回值。
- `WritingProfile` 第一轮只从 `UserProfile.preferences` 与当前 note markdown 形态推断，不新增长期训练或复杂风格存储。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-obsidian-native-ai-layer.md`. Ready to execute?
