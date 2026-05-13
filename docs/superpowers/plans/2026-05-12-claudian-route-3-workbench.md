# Claudian Route 3 Workbench Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Obsidian CLI from a single shell sidebar into a Claudian-style multi-conversation AI workbench while preserving the current skill, tool, knowledge, Guardian, and provider runtime behavior.

**Architecture:** Keep `ShellView` as the public Obsidian `ItemView` entry point used by `main.ts`, but move most UI responsibility into focused workbench modules. Each chat tab owns a `ChatState`, `ChatController`, and `ContextManager`; shared UI pieces render tabs, messages, tool calls, thinking blocks, approvals, context chips, history, and the input toolbar. Conversation history is persisted outside `PluginSettings` in `.obsidian/obsidian-cli/conversations.json` so large chat data does not bloat settings.

**Tech Stack:** TypeScript, Obsidian Plugin API, existing `ModelService`, `ChatRuntime`, `ToolRegistry`, `SkillRegistry`, `KnowledgeRuntime`, custom `tsx` test harness, generated `styles.css`.

---

## Scope

Route 3 is intentionally broad. Implement it in layers so the plugin remains usable after each chunk.

The first releasable version includes:

- Multi-tab chat in the sidebar.
- Conversation history with create, restore, rename by generated title fallback, and delete.
- Modular message rendering for user, assistant, system, approval, thinking, and tool output.
- A Claudian-style input workbench with context chips, slash commands, file mentions, provider/model controls, and execution controls.
- A persistent status panel for tool progress and task-style outputs.
- Modular CSS source files compiled into the root `styles.css`.

The second releasable version adds:

- Fork and rewind affordances where provider/runtime support exists.
- Compact boundaries and richer saved-history replay.
- Provider capability-driven UI for optional features such as images, thinking, approval, and model listing.

Out of scope for the first implementation pass:

- Copying Claudian provider adapters.
- Replacing the existing `ModelService`/`ChatRuntime` boundary.
- Adding React, Svelte, or another frontend framework.

---

## File Map

### Modify

- `main.ts`
  - Pass enough plugin context into `ShellView` for conversation persistence and settings save callbacks.
- `src/ui/shell-view.ts`
  - Keep the exported `ShellView` class and Obsidian view type stable.
  - Convert it into a workbench assembly layer.
- `src/ui/chat-controller.ts`
  - Move `ChatMessage` to shared UI types.
  - Allow message storage to be delegated to `ChatState`.
  - Support per-tab lifecycle and cleanup.
- `src/ui/controllers/input-controller.ts`
  - Split suggestion detection from DOM rendering.
  - Add support for `/`, `@`, and future `$` skill triggers.
- `src/ui/controllers/context-controller.ts`
  - Make context resolution tab-aware.
  - Keep active-file and selection injection.
- `src/ui/controllers/stream-controller.ts`
  - Emit richer render events for message, thinking, tool, status panel, and finalization updates.
- `src/ui/renderers/thinking-renderer.ts`
  - Replace timeline-only rendering with reusable collapsible thinking blocks.
- `src/ui/renderers/tool-renderer.ts`
  - Replace raw JSON blocks with tool-specific summaries and collapsible details.
- `styles.css`
  - Become a generated or assembled output from modular CSS source files.
- `package.json`
  - Add CSS build script once modular styles are introduced.
- `test/run-tests.ts`
  - Register new UI logic tests.

### Create

- `scripts/build-css.mjs`
- `src/style/index.css`
- `src/style/base/variables.css`
- `src/style/base/container.css`
- `src/style/components/header.css`
- `src/style/components/tabs.css`
- `src/style/components/messages.css`
- `src/style/components/input.css`
- `src/style/components/toolcalls.css`
- `src/style/components/thinking.css`
- `src/style/components/status-panel.css`
- `src/style/components/history.css`
- `src/style/features/context-chips.css`
- `src/style/features/approval.css`
- `src/style/accessibility.css`
- `src/ui/types.ts`
- `src/ui/state/chat-state.ts`
- `src/ui/history/conversation-store.ts`
- `src/ui/history/conversation-controller.ts`
- `src/ui/tabs/types.ts`
- `src/ui/tabs/tab.ts`
- `src/ui/tabs/tab-bar.ts`
- `src/ui/tabs/tab-manager.ts`
- `src/ui/renderers/message-renderer.ts`
- `src/ui/renderers/code-block-renderer.ts`
- `src/ui/components/input-toolbar.ts`
- `src/ui/components/context-chips.ts`
- `src/ui/components/status-panel.ts`
- `src/ui/components/history-menu.ts`
- `src/ui/components/command-dropdown.ts`
- `test/chat-state.test.ts`
- `test/conversation-store.test.ts`
- `test/tab-manager.test.ts`
- `test/message-renderer.test.ts`
- `test/tool-call-renderer.workbench.test.ts`
- `test/status-panel.test.ts`
- `test/command-dropdown.test.ts`
- `test/input-toolbar.test.ts`

---

## Data Contracts

Create `src/ui/types.ts`:

```ts
import { ApprovalRequest } from './approval-card';

export type ShellMessageRole = 'user' | 'ai' | 'system';

export interface ChatMessage {
  id: string;
  role: ShellMessageRole;
  content: string;
  timestamp: number;
  feedback?: 'up' | 'down' | null;
  approval?: ApprovalRequest;
  metadata?: {
    providerId?: string;
    modelId?: string;
    durationMs?: number;
    interrupted?: boolean;
  };
}

export interface ToolRunState {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error' | 'approval_required';
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface ConversationSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  modelId: string;
  messages: ChatMessage[];
  currentNote?: string;
}
```

Create `src/ui/tabs/types.ts`:

```ts
import { ChatController } from '../chat-controller';
import { ContextManager } from '../../services/context-manager';
import { ChatState } from '../state/chat-state';

export type TabId = string;

export interface TabData {
  id: TabId;
  index: number;
  title: string;
  isActive: boolean;
  isStreaming: boolean;
  needsAttention: boolean;
  state: ChatState;
  chatController: ChatController;
  contextManager: ContextManager;
  dom: {
    root: HTMLElement;
    messages: HTMLElement;
    input: HTMLTextAreaElement;
    inputWrapper: HTMLElement;
    contextRow: HTMLElement;
  };
}
```

---

## Chunk 1: Foundation State And Persistence

### Task 1: Move Shared UI Types

**Files:**

- Create: `src/ui/types.ts`
- Modify: `src/ui/chat-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Test: `test/chat-controller.test.ts`
- Test: `test/approval-flow.test.ts`

- [ ] **Step 1: Create `src/ui/types.ts` with `ChatMessage`, `ToolRunState`, and `ConversationSnapshot`.**
- [ ] **Step 2: Replace the local `ChatMessage` interface in `chat-controller.ts` with an import from `src/ui/types.ts`.**
- [ ] **Step 3: Update `shell-view.ts` imports to use the shared type.**
- [ ] **Step 4: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/approval-flow.test.ts
```

Expected: both tests pass with no behavior changes.

### Task 2: Add ChatState

**Files:**

- Create: `src/ui/state/chat-state.ts`
- Create: `test/chat-state.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tests for message append, replacement, clearing, active tool tracking, streaming flag, and dirty state.**

Test skeleton:

```ts
await test('tracks messages and streaming state', () => {
  const state = new ChatState('tab-1');
  state.addMessage({ id: 'm1', role: 'user', content: 'hi', timestamp: 1 });
  state.setStreaming(true);
  expect(state.getMessages().length).toBe(1);
  expect(state.isStreaming()).toBe(true);
});
```

- [ ] **Step 2: Run the new test and confirm it fails because `ChatState` does not exist.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/chat-state.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement `ChatState`.**

Minimum API:

```ts
export class ChatState {
  constructor(private readonly tabId: string) {}
  addMessage(message: ChatMessage): void;
  updateMessage(id: string, patch: Partial<ChatMessage>): void;
  removeMessage(id: string): void;
  clearMessages(): void;
  getMessages(): ChatMessage[];
  setStreaming(value: boolean): void;
  isStreaming(): boolean;
  upsertTool(run: ToolRunState): void;
  getTools(): ToolRunState[];
  markClean(): void;
  isDirty(): boolean;
}
```

- [ ] **Step 4: Add the test file to `test/run-tests.ts`.**
- [ ] **Step 5: Run the focused test again.**

Expected: PASS.

### Task 3: Add ConversationStore

**Files:**

- Create: `src/ui/history/conversation-store.ts`
- Create: `test/conversation-store.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tests for load-empty, save, list sorting by `updatedAt`, delete, and corrupted JSON fallback.**
- [ ] **Step 2: Implement storage using `app.vault.adapter` at `.obsidian/obsidian-cli/conversations.json`.**

Persistence shape:

```ts
export interface ConversationFile {
  version: 1;
  conversations: ConversationSnapshot[];
}
```

- [ ] **Step 3: Use atomic enough writes for Obsidian adapter constraints: read current, merge in memory, write full JSON.**
- [ ] **Step 4: Cap history to a default of 100 conversations, newest first.**
- [ ] **Step 5: Run the focused test.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/conversation-store.test.ts
```

Expected: PASS.

---

## Chunk 2: Tab Workbench

### Task 4: Add TabManager And TabBar

**Files:**

- Create: `src/ui/tabs/types.ts`
- Create: `src/ui/tabs/tab.ts`
- Create: `src/ui/tabs/tab-bar.ts`
- Create: `src/ui/tabs/tab-manager.ts`
- Create: `test/tab-manager.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tests for creating first tab, creating another tab, switching tabs, closing inactive tab, preventing last tab close, and preserving active tab.**
- [ ] **Step 2: Implement `TabManager` without DOM rendering first.**

Minimum API:

```ts
export class TabManager {
  createTab(snapshot?: ConversationSnapshot): TabData;
  getActiveTab(): TabData | null;
  getAllTabs(): TabData[];
  switchTab(id: TabId): void;
  closeTab(id: TabId): boolean;
  markStreaming(id: TabId, streaming: boolean): void;
  markAttention(id: TabId, attention: boolean): void;
}
```

- [ ] **Step 3: Implement `TabBar` as a DOM renderer that consumes plain tab item data and emits callbacks.**
- [ ] **Step 4: Add keyboard/accessibility attributes: `role="tablist"`, `role="tab"`, `aria-selected`, and focus-visible support.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/tab-manager.test.ts
```

Expected: PASS.

### Task 5: Wire ShellView To Tabs

**Files:**

- Modify: `main.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/ui/chat-controller.ts`
- Test: `test/command-suggestions.test.ts`
- Test: `test/chat-controller.test.ts`
- Test: `test/tab-manager.test.ts`

- [ ] **Step 1: Change `main.ts` view registration to `new ShellView(leaf, this.modelService, this)`.**
- [ ] **Step 2: Update `ShellView` constructor to accept the plugin as an optional third dependency for storage and settings callbacks.**
- [ ] **Step 3: Preserve current constructor behavior in tests by making the plugin dependency optional.**
- [ ] **Step 4: Move single `ChatController` and `ContextManager` ownership into per-tab data.**
- [ ] **Step 5: Ensure `processCommand()` uses `tab.chatController` and `tab.contextManager` from the active tab.**
- [ ] **Step 6: Keep `/clear`, `/profile`, `/tools`, and skill commands behavior unchanged.**
- [ ] **Step 7: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/command-suggestions.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/tab-manager.test.ts
```

Expected: PASS.

---

## Chunk 3: Message Rendering Pipeline

### Task 6: Add MessageRenderer

**Files:**

- Create: `src/ui/renderers/message-renderer.ts`
- Create: `src/ui/renderers/code-block-renderer.ts`
- Create: `test/message-renderer.test.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tests for user message rendering, assistant Markdown rendering callback, system message rendering, approval card rendering, and copy/action toolbar creation.**
- [ ] **Step 2: Move `appendMessage()` rendering logic from `shell-view.ts` into `MessageRenderer`.**
- [ ] **Step 3: Move `postProcessAiContent()` code-block header logic into `CodeBlockRenderer`.**
- [ ] **Step 4: Preserve the current diff review behavior for code blocks against the active file.**
- [ ] **Step 5: Add message metadata footer for duration/provider later, but render nothing when metadata is absent.**
- [ ] **Step 6: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/approval-flow.test.ts
```

Expected: PASS.

### Task 7: Upgrade Thinking Renderer

**Files:**

- Modify: `src/ui/renderers/thinking-renderer.ts`
- Modify: `src/ui/controllers/stream-controller.ts`
- Modify: `test/thinking-renderer.test.ts`
- Test: `test/stream-controller.test.ts`

- [ ] **Step 1: Add tests for timer label, collapsed state, keyboard toggling, and final label.**
- [ ] **Step 2: Replace raw timeline nodes with `.ocli-thinking-block`, `.ocli-thinking-header`, and `.ocli-thinking-content`.**
- [ ] **Step 3: Add `tabindex`, `role="button"`, and `aria-expanded`.**
- [ ] **Step 4: Keep existing stream callbacks compatible with `ShellView`.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/thinking-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/stream-controller.test.ts
```

Expected: PASS.

### Task 8: Upgrade Tool Renderer

**Files:**

- Modify: `src/ui/renderers/tool-renderer.ts`
- Create: `test/tool-call-renderer.workbench.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write tests for file tools, web tools, knowledge tools, plugin tools, unknown tools, successful results, and error results.**
- [ ] **Step 2: Add `getToolSummary(name, input)` and `getToolStatus(result, error)` helpers.**
- [ ] **Step 3: Render file tools as `Read: file.md`, `Write: file.md`, `Edit: file.md`.**
- [ ] **Step 4: Render search tools with query snippets instead of raw JSON first.**
- [ ] **Step 5: Keep raw JSON in collapsible details for debugging.**
- [ ] **Step 6: Push all tool updates into `ChatState.upsertTool()` so the status panel can subscribe later.**
- [ ] **Step 7: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/tool-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/tool-call-renderer.workbench.test.ts
```

Expected: PASS.

---

## Chunk 4: Input Workbench

### Task 9: Add CommandDropdown

**Files:**

- Create: `src/ui/components/command-dropdown.ts`
- Create: `test/command-dropdown.test.ts`
- Modify: `src/ui/controllers/input-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `test/input-controller.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tests for `/` commands, `@` file suggestions, no results, keyboard selection, and click selection.**
- [ ] **Step 2: Keep `detectSuggestionTrigger()` pure and add `$` trigger support behind tests.**

Expected behavior:

```ts
detectSuggestionTrigger('/wiki', 5)
// { type: 'command', query: 'wiki' }

detectSuggestionTrigger('@daily', 6)
// { type: 'file', query: 'daily' }
```

- [ ] **Step 3: Move DOM rendering from `ShellView.renderSuggestions()` into `CommandDropdown`.**
- [ ] **Step 4: Show command source labels: `local`, `skill`, or `file`.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/input-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/command-dropdown.test.ts
```

Expected: PASS.

### Task 10: Add ContextChips Component

**Files:**

- Create: `src/ui/components/context-chips.ts`
- Create: `test/context-chips.test.ts`
- Modify: `src/ui/controllers/context-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `test/context-controller.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write tests for file chip, image chip, URL chip, YouTube chip, remove action, and open-file action.**
- [ ] **Step 2: Move `renderContextChips()` from `ShellView` into `ContextChips`.**
- [ ] **Step 3: Replace mojibake/emoji text icons with Obsidian `setIcon()` names where possible.**
- [ ] **Step 4: Make chip labels filename-first with full path in `title`.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/context-controller.test.ts
npx tsx --tsconfig tsconfig.test.json test/context-chips.test.ts
```

Expected: PASS.

### Task 11: Add InputToolbar

**Files:**

- Create: `src/ui/components/input-toolbar.ts`
- Create: `test/input-toolbar.test.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/services/model-service.ts`
- Modify: `test/model-service.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write tests for provider selector render, model loading state, model change callback, unavailable provider warning callback, and disabled image button when unsupported.**
- [ ] **Step 2: Move provider and model select DOM from `ShellView.onOpen()` into `InputToolbar`.**
- [ ] **Step 3: Add send button and stop button placeholders.**
- [ ] **Step 4: If no cancellation API exists yet, make stop button disabled unless `ModelService` exposes cancellation.**
- [ ] **Step 5: Keep Enter-to-send and Shift+Enter newline behavior in `ShellView` or a later `InputController` refactor.**
- [ ] **Step 6: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/input-toolbar.test.ts
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
```

Expected: PASS.

---

## Chunk 5: Conversation History

### Task 12: Add ConversationController And HistoryMenu

**Files:**

- Create: `src/ui/history/conversation-controller.ts`
- Create: `src/ui/components/history-menu.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/ui/tabs/tab-manager.ts`
- Test: `test/conversation-store.test.ts`
- Test: `test/tab-manager.test.ts`

- [ ] **Step 1: Write tests for saving active tab snapshot, restoring snapshot into a tab, deleting a conversation, and history sort order.**
- [ ] **Step 2: Implement `ConversationController.saveActiveTab(tab)` using `ConversationStore`.**
- [ ] **Step 3: Generate fallback titles from the first user message, max 60 characters.**
- [ ] **Step 4: Add header history button and dropdown.**
- [ ] **Step 5: Add new chat button.**
- [ ] **Step 6: Persist active tab when switching tabs, closing view, and finishing a stream.**
- [ ] **Step 7: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/conversation-store.test.ts
npx tsx --tsconfig tsconfig.test.json test/tab-manager.test.ts
```

Expected: PASS.

### Task 13: Add History Replay Rendering

**Files:**

- Modify: `src/ui/renderers/message-renderer.ts`
- Modify: `src/ui/history/conversation-controller.ts`
- Test: `test/message-renderer.test.ts`
- Test: `test/conversation-store.test.ts`

- [ ] **Step 1: Add a test that restores a conversation and renders user/AI/system messages in order.**
- [ ] **Step 2: Ensure approval messages do not replay as actionable approvals unless they are still pending.**
- [ ] **Step 3: Ensure tool/thinking data is optional in old conversations.**
- [ ] **Step 4: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/conversation-store.test.ts
```

Expected: PASS.

---

## Chunk 6: Status Panel And Workbench Feedback

### Task 14: Add StatusPanel

**Files:**

- Create: `src/ui/components/status-panel.ts`
- Create: `test/status-panel.test.ts`
- Modify: `src/ui/renderers/tool-renderer.ts`
- Modify: `src/ui/state/chat-state.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write tests for hidden empty state, running tool row, completed tool row, error tool row, collapsed/expanded behavior, and keyboard toggling.**
- [ ] **Step 2: Render latest tool progress outside the message body in a persistent bottom panel.**
- [ ] **Step 3: Keep full tool details in the message stream, but show short progress in the panel.**
- [ ] **Step 4: Add max retained tool rows to avoid unbounded DOM growth.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/status-panel.test.ts
npx tsx --tsconfig tsconfig.test.json test/tool-call-renderer.workbench.test.ts
```

Expected: PASS.

### Task 15: Improve Approval Rendering

**Files:**

- Modify: `src/ui/approval-card.ts`
- Modify: `src/ui/renderers/message-renderer.ts`
- Modify: `test/approval-flow.test.ts`
- Create: `test/approval-card.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write tests for title, action name, target, message, approve callback, cancel callback, and keyboard focus.**
- [ ] **Step 2: Add visible fields for action and target when present.**
- [ ] **Step 3: Add risk copy based on action type without changing tool execution logic.**
- [ ] **Step 4: Preserve current `approveApproval()` and `cancelApproval()` behavior.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/approval-flow.test.ts
npx tsx --tsconfig tsconfig.test.json test/approval-card.test.ts
```

Expected: PASS.

---

## Chunk 7: Modular CSS

### Task 16: Add CSS Build Script

**Files:**

- Create: `scripts/build-css.mjs`
- Create: `src/style/index.css`
- Modify: `package.json`
- Modify: `styles.css`

- [ ] **Step 1: Create `src/style/index.css` with `@import` lines for base, components, features, and accessibility files.**
- [ ] **Step 2: Create `scripts/build-css.mjs` that reads imports in order and writes root `styles.css`.**
- [ ] **Step 3: Update scripts.**

Expected `package.json` script shape:

```json
{
  "scripts": {
    "build:css": "node scripts/build-css.mjs",
    "dev": "npm run build:css && node esbuild.config.mjs",
    "build": "npm run build:css && node esbuild.config.mjs production",
    "test": "tsx --tsconfig tsconfig.test.json test/run-tests.ts"
  }
}
```

- [ ] **Step 4: Preserve existing Guardian styles by moving them into `src/style/features/guardian.css` or leaving them in a clearly marked generated block.**
- [ ] **Step 5: Run CSS build and verify `styles.css` changes are expected.**

Run:

```bash
npm run build:css
```

Expected: generated `styles.css` exists and contains all imported modules in order.

### Task 17: Port Workbench Styles

**Files:**

- Create: `src/style/base/variables.css`
- Create: `src/style/base/container.css`
- Create: `src/style/components/header.css`
- Create: `src/style/components/tabs.css`
- Create: `src/style/components/messages.css`
- Create: `src/style/components/input.css`
- Create: `src/style/components/toolcalls.css`
- Create: `src/style/components/thinking.css`
- Create: `src/style/components/status-panel.css`
- Create: `src/style/components/history.css`
- Create: `src/style/features/context-chips.css`
- Create: `src/style/features/approval.css`
- Create: `src/style/accessibility.css`
- Modify: `styles.css`

- [ ] **Step 1: Define an `ocli-` class naming convention for new workbench UI.**
- [ ] **Step 2: Keep card radius at 8px or less.**
- [ ] **Step 3: Use Obsidian variables for colors and typography.**
- [ ] **Step 4: Avoid one-hue styling; keep the interface quiet and native to Obsidian.**
- [ ] **Step 5: Add focus-visible styles for tabs, toolbar buttons, tool headers, thinking headers, approvals, and chips.**
- [ ] **Step 6: Run CSS build.**

Run:

```bash
npm run build:css
```

Expected: no missing import error.

---

## Chunk 8: Provider Capability Driven UI

### Task 18: Centralize UI Capability Checks

**Files:**

- Modify: `src/runtime/provider-capabilities.ts`
- Modify: `src/services/model-service.ts`
- Modify: `src/ui/components/input-toolbar.ts`
- Modify: `src/ui/shell-view.ts`
- Test: `test/provider-capabilities.test.ts`
- Test: `test/input-toolbar.test.ts`

- [ ] **Step 1: Add tests that image controls hide or disable when `supportsImageInput` is false.**
- [ ] **Step 2: Add tests that thinking controls only show when provider capabilities expose thinking support.**
- [ ] **Step 3: Add `getProviderCapabilities()` reads to `InputToolbar` instead of provider-name checks.**
- [ ] **Step 4: Add capability snapshot to `TabData` so restored tabs can render before async model refresh finishes.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/provider-capabilities.test.ts
npx tsx --tsconfig tsconfig.test.json test/input-toolbar.test.ts
```

Expected: PASS.

---

## Chunk 9: Route 3 Advanced Controls

### Task 19: Add Fork And Rewind UI Guards

**Files:**

- Modify: `src/runtime/provider-capabilities.ts`
- Modify: `src/ui/renderers/message-renderer.ts`
- Modify: `src/ui/history/conversation-controller.ts`
- Create: `test/conversation-actions.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Add capability flags `supportsConversationFork` and `supportsConversationRewind`, default false.**
- [ ] **Step 2: Render fork/rewind buttons only when the capability is true and the message has enough persisted context.**
- [ ] **Step 3: For unsupported providers, do not render disabled buttons.**
- [ ] **Step 4: Implement local fork first: duplicate conversation messages up to selected user message into a new tab.**
- [ ] **Step 5: Defer provider-native rewind until runtime exposes a stable API.**
- [ ] **Step 6: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/conversation-actions.test.ts
```

Expected: PASS.

### Task 20: Add Compact Boundary Display

**Files:**

- Modify: `src/ui/types.ts`
- Modify: `src/ui/renderers/message-renderer.ts`
- Modify: `src/ui/history/conversation-store.ts`
- Test: `test/message-renderer.test.ts`
- Test: `test/conversation-store.test.ts`

- [ ] **Step 1: Add optional `metadata.compactedBoundary` to `ChatMessage`.**
- [ ] **Step 2: Render a centered boundary row when a compact marker exists.**
- [ ] **Step 3: Persist compact marker in conversation snapshots.**
- [ ] **Step 4: Do not implement actual model-side compaction in this task.**
- [ ] **Step 5: Run focused tests.**

Run:

```bash
npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/conversation-store.test.ts
```

Expected: PASS.

---

## Chunk 10: Integration And Verification

### Task 21: Full Test Pass

**Files:**

- Modify only files needed to fix regressions discovered by tests.

- [ ] **Step 1: Run the full maintained test harness.**

Run:

```bash
npm test
```

Expected: all registered tests pass.

- [ ] **Step 2: Run production build.**

Run:

```bash
npm run build
```

Expected: `main.js` builds successfully and `styles.css` is current.

### Task 22: Manual Obsidian Smoke Test

**Files:**

- No code changes unless manual testing reveals defects.

- [ ] **Step 1: Open Obsidian Shell from ribbon or command palette.**
- [ ] **Step 2: Verify initial tab renders and input focuses on click.**
- [ ] **Step 3: Send a normal chat message.**
- [ ] **Step 4: Trigger `/tools` and verify command routing.**
- [ ] **Step 5: Type `/wiki` and verify command dropdown filters skills.**
- [ ] **Step 6: Type `@` and verify file mention dropdown.**
- [ ] **Step 7: Paste a URL and verify context chip.**
- [ ] **Step 8: Create a second tab, switch tabs, and verify state isolation.**
- [ ] **Step 9: Close and reopen the view, then restore a conversation from history.**
- [ ] **Step 10: Trigger an approval-required action and verify approval card behavior.**

Expected: no broken layout, no duplicate listeners, no lost active-tab state, no console errors.

---

## Implementation Order

1. Chunk 1: state and persistence.
2. Chunk 2: tabs wired into the current shell.
3. Chunk 3: message, thinking, and tool renderers.
4. Chunk 4: input workbench.
5. Chunk 5: conversation history.
6. Chunk 6: status panel and approval polish.
7. Chunk 7: modular CSS.
8. Chunk 8: capability-driven controls.
9. Chunk 9: fork, rewind guardrails, compact display.
10. Chunk 10: full verification.

Do not begin Chunk 9 until Chunks 1-8 pass `npm test` and `npm run build`.

---

## Risk Controls

- Keep `VIEW_TYPE_SHELL` unchanged.
- Keep `ShellView` exported from `src/ui/shell-view.ts`.
- Do not remove current slash commands until the new command dropdown and skill routing tests pass.
- Do not persist conversation history inside `PluginSettings`.
- Do not add provider-specific UI branches unless a capability is missing and a test proves the need.
- Do not enable stop/cancel UI until `ModelService` exposes a real cancellation contract.
- Do not rewrite Guardian UI in this pass; only preserve and rehome styles if CSS modularization requires it.

---

## Final Acceptance Criteria

- `npm test` passes.
- `npm run build` passes.
- The shell supports multiple tabs with isolated messages and contexts.
- Conversation history can save and restore at least 100 recent conversations.
- Message rendering no longer lives directly in `ShellView`.
- Tool and thinking blocks are collapsible and keyboard accessible.
- Provider/model controls are implemented by `InputToolbar`.
- Context chips are reusable and no longer duplicated between `ShellView` and `ContextController`.
- Approval cards still replay through `ModelService.executeApprovedAction(...)`.
- The root `styles.css` is generated or consistently assembled from modular style files.
