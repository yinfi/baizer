# Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved sidebar prototype so Obsidian CLI reads as a chat-first assistant with compact execution status, clearer header actions, and a calmer composer.

**Architecture:** Keep the existing UI boundaries: `ShellView` owns layout and event wiring, `MessageRenderer` owns persisted chat messages, `ThinkingRenderer` and `ToolRenderer` own live stream detail rows, `InputToolbar` owns provider/model/image/send controls, and `styles.css` owns the visual treatment. Avoid a new UI abstraction unless a helper is needed for repeated message/status formatting.

**Tech Stack:** TypeScript, Obsidian plugin DOM helpers, Obsidian `setIcon`, custom `tsx` test harness, CSS in `styles.css`.

---

## Scope

Implement the visual and interaction changes represented by `docs/prototypes/sidebar-redesign-prototype.html`:

- Header right actions become search/history and settings.
- Session row keeps new chat creation; no duplicate new-chat button in the header.
- Floating bottom utility buttons are removed from the main composer surface.
- System updates render as compact status rows, not chat bubbles.
- Assistant messages become lighter, with the stream/thought summary collapsed by default.
- Tool and file-update information is readable in a narrow sidebar through basename-first truncation.
- Composer stays two-level: context/input above provider/model/image/send controls.

Out of scope:

- Changing model/provider runtime behavior.
- Changing approval security behavior.
- Adding new persistence fields for sessions.
- Replacing the custom DOM-rendered UI with a framework.

## File Structure

- Modify `src/ui/shell-view.ts`
  - Move header actions into the header.
  - Remove or repurpose `createInputUtilityActions`.
  - Keep history/settings wiring through existing methods.
  - Keep tab/session creation through `TabBar`.

- Modify `src/ui/tabs/tab-bar.ts`
  - Keep the `+` new-chat control in the session row.
  - Optionally render the active tab title next to the active badge if the layout has room.

- Modify `src/ui/renderers/message-renderer.ts`
  - Render system update messages as compact status rows.
  - Keep approval messages and cancelled messages behavior intact.
  - Add small parsing helpers for status action, basename, and shortened path.

- Modify `src/ui/renderers/thinking-renderer.ts`
  - Make finalized thinking blocks collapsed by default.
  - Ensure the visible label stays compact.

- Modify `src/ui/renderers/tool-renderer.ts`
  - Shorten tool summaries for file paths.
  - Preserve detail expansion for full input/result.

- Modify `src/ui/components/input-toolbar.ts`
  - Keep existing provider/model/image/send controls.
  - Ensure image and send controls have explicit accessible names and icon semantics matching the prototype.

- Modify `styles.css`
  - Apply the approved visual system.
  - Reduce nested card borders.
  - Add compact status row styling.
  - Add header action styling.
  - Tighten composer layout for 320-420px sidebars.

- Modify tests:
  - `test/message-renderer.test.ts`
  - `test/thinking-renderer.test.ts`
  - `test/tool-renderer.test.ts`
  - `test/input-toolbar.test.ts`
  - Add or extend a shell view scaffold test only if existing fakes can cover header actions without brittle setup.

## Chunk 1: Header Actions And Session Row

### Task 1: Move History And Settings To Header

**Files:**
- Modify: `src/ui/shell-view.ts`
- Modify: `styles.css`
- Test: existing shell-level tests if available; otherwise verify with `npm test` and manual Obsidian load.

- [ ] **Step 1: Add a failing layout-oriented test if practical**

Search for an existing shell scaffold test:

```powershell
rg -n "shell-header|createShellScaffold|shell-input-top-actions|history-btn|settings-btn" test src
```

If a suitable fake exists, add assertions that the header contains `.shell-history-btn` and `.shell-settings-btn`, and the input shell does not contain `.shell-input-top-actions`.

- [ ] **Step 2: Move utility action creation**

In `src/ui/shell-view.ts`, replace this pattern in `onOpen` and `createShellScaffold`:

```ts
const header = container.createDiv({ cls: 'shell-header' });
// ...
const inputShell = container.createDiv({ cls: 'shell-input-shell' });
this.createInputUtilityActions(inputShell);
```

with a header action container:

```ts
const header = container.createDiv({ cls: 'shell-header' });
const headerTitle = header.createDiv({ cls: 'shell-header-title' });
// existing identity/title/tab setup
this.createHeaderActions(header);
```

Add:

```ts
private createHeaderActions(container: HTMLElement) {
    const actions = container.createDiv({ cls: 'shell-header-buttons' });
    this.createHeaderActionButton(actions, 'Search history', 'search', 'shell-history-btn', (event) => {
        event.stopPropagation();
        void this.toggleHistoryMenu();
    });
    this.createHeaderActionButton(actions, 'Settings', 'settings', 'shell-settings-btn', () => {
        this.openPluginSettings();
    });
}
```

Keep `createInputUtilityButton` only if it is reused, otherwise rename it to `createHeaderActionButton`.

- [ ] **Step 3: Preserve hidden functionality**

Do not create visible header buttons for clear chat or tools. Keep `/clear`, `/tools`, and existing command suggestions as the primary access path for those commands. If product feedback later requires them visually, add them to a menu instead of adding more top-level buttons.

- [ ] **Step 4: Update click exclusion logic**

In `handleContainerClickBound`, replace `.shell-input-top-actions` exclusion with `.shell-header-buttons`, and keep `.shell-history-btn` exclusion.

- [ ] **Step 5: Style header buttons**

In `styles.css`, make `.shell-header` a three-column layout compatible with the prototype:

```css
.shell-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 10px;
}

.shell-header-buttons {
    display: inline-flex;
    gap: 6px;
}
```

Delete or neutralize the absolute-positioned `.shell-input-top-actions` block.

- [ ] **Step 6: Verify**

Run:

```powershell
npm test
npm run build
```

Expected: all tests pass and build emits `main.js`.

## Chunk 2: Compact System Status Rows

### Task 2: Parse And Render System Updates

**Files:**
- Modify: `src/ui/renderers/message-renderer.ts`
- Modify: `test/message-renderer.test.ts`
- Modify: `styles.css`

- [ ] **Step 1: Write failing tests for compact update messages**

Add tests to `test/message-renderer.test.ts`:

```ts
await test('renders updated system messages as compact status rows', async () => {
  const container = new FakeElement();
  const renderer = new MessageRenderer({ app: {}, component: {} });

  await renderer.renderMessage(container as any, {
    id: 's-update',
    role: 'system',
    content: '✅ Updated: Study/财经理论入门课程/01_course_materials/02_supply_demand_price.md',
    timestamp: 1,
  });

  const entry = container.children[0];
  expect(entry.className).toContain('shell-system-status');
  expect(!!entry.querySelector('.shell-system-status-icon')).toBe(true);
  expect(entry.textContent).toContain('Updated');
  expect(entry.textContent).toContain('02_supply_demand_price.md');
});
```

Keep the existing cancelled-message test passing.

- [ ] **Step 2: Add parser helper**

In `message-renderer.ts`, add a helper that recognizes only known status messages:

```ts
private parseSystemStatus(content: string) {
  const normalized = content.trim();
  const updated = normalized.match(/^(?:✅\s*)?Updated:\s*(.+)$/i);
  if (updated) {
    return {
      kind: 'updated',
      label: 'Updated',
      target: updated[1].trim(),
    };
  }
  return null;
}
```

Add basename extraction without Node path APIs because production plugin code must remain mobile-compatible:

```ts
private basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
```

- [ ] **Step 3: Render compact row before fallback system text**

In the `message.role === 'system'` branch:

```ts
const status = this.parseSystemStatus(message.content);
if (status) {
  this.renderSystemStatus(entry, status);
} else {
  // existing cancelled and fallback behavior
}
```

`renderSystemStatus` should create:

- `.shell-system-status-icon`
- `.shell-system-status-main`
- `.shell-system-status-action`
- `.shell-system-status-target`

- [ ] **Step 4: Style as a lightweight row**

Add:

```css
.shell-entry.system.shell-system-status {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: none;
    padding: 0 2px 0 31px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-style: normal;
}

.shell-system-status-target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

- [ ] **Step 5: Run focused test**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/message-renderer.test.ts
```

Expected: `Message Renderer Tests` pass.

## Chunk 3: Thinking And Tool Compaction

### Task 3: Make Thought Details Visually Secondary

**Files:**
- Modify: `src/ui/renderers/thinking-renderer.ts`
- Modify: `src/ui/renderers/tool-renderer.ts`
- Modify: `test/thinking-renderer.test.ts`
- Modify: `test/tool-renderer.test.ts`
- Modify: `styles.css`

- [ ] **Step 1: Update thinking test expectations**

In `test/thinking-renderer.test.ts`, add or update a test so `finalizeCurrentThinking()` marks the block complete and collapsed:

```ts
expect(block.hasClass('is-complete')).toBe(true);
expect(block.hasClass('is-collapsed')).toBe(true);
expect(header.attributes['aria-expanded']).toBe('false');
```

- [ ] **Step 2: Collapse finalized thinking blocks**

In `ThinkingRenderer.finalizeCurrentThinking()`, after setting `is-complete`, add `is-collapsed` and set `aria-expanded` to `false`.

- [ ] **Step 3: Keep active thinking expandable**

Do not collapse while streaming. Only collapse on finalize, so users can inspect live thinking/tool progress during a response if the provider emits it.

- [ ] **Step 4: Shorten file-heavy tool labels**

In `ToolRenderer.getToolSummary`, when `path` is present, show basename in the header and leave full path in the detail block:

```ts
return `Edit: ${basename(path)}`;
```

Add a local `basename` helper using string splitting, not Node path.

- [ ] **Step 5: Test tool summary shortening**

Add to `test/tool-renderer.test.ts`:

```ts
expect(getToolSummary('edit_file', { path: 'Study/a/b/02_supply_demand_price.md' }))
  .toBe('Edit: 02_supply_demand_price.md');
```

- [ ] **Step 6: Style compact thought/tool rows**

In `styles.css`, make `.shell-think-summary`, `.ocli-thinking-header`, and `.ocli-tool-header` look like compact rows instead of nested cards. Ensure `.ocli-thinking-content` and `.ocli-tool-detail` are hidden when collapsed.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/thinking-renderer.test.ts
npx tsx --tsconfig tsconfig.test.json test/tool-renderer.test.ts
```

Expected: both focused test files pass.

## Chunk 4: Composer Layout

### Task 4: Match The Two-Level Composer

**Files:**
- Modify: `src/ui/components/input-toolbar.ts`
- Modify: `test/input-toolbar.test.ts`
- Modify: `styles.css`

- [ ] **Step 1: Keep semantic controls stable**

Do not change provider/model change handlers. Do not add visible labels into the compact composer. The accessible names remain:

- `Add image context`
- `Send message`
- `Stop response`

- [ ] **Step 2: Confirm existing toolbar tests cover icon controls**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/input-toolbar.test.ts
```

Expected before styling: existing tests pass.

- [ ] **Step 3: Update CSS for two-level composer**

In `styles.css`, preserve DOM order:

```text
context chips
textarea
provider/model/action toolbar
```

Style it as:

```css
.shell-input-container {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    overflow: hidden;
}

.shell-input-context-bar {
    padding: 8px 9px 2px;
}

.shell-input-wrapper {
    padding: 0;
}

.shell-input-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    padding: 7px;
    border-top: 1px solid var(--ocli-border);
}
```

Ensure `.shell-model-select-container` remains a two-column grid and `.shell-action-buttons` remains the right-side image/send group.

- [ ] **Step 4: Make image and send icons visually distinct**

Use existing `image` and `send-horizontal` icons from `InputToolbar`. In CSS:

- image button: muted square button
- send button: high-contrast primary button
- stop state: red/muted stop button

- [ ] **Step 5: Verify narrow widths**

In Obsidian, test sidebar widths around 320px, 392px, and 520px:

- provider select remains usable
- model select truncates instead of pushing buttons offscreen
- context chip truncates
- send button remains visible

## Chunk 5: Assistant Message Visual Hierarchy

### Task 5: Reduce Card Weight Without Breaking Markdown

**Files:**
- Modify: `styles.css`
- Test: `npm test`
- Manual verify: rendered Markdown, code blocks, approval cards.

- [ ] **Step 1: Keep Markdown renderer unchanged**

Do not change `MessageRenderer.renderAiContent` unless a test proves it is necessary. Markdown, internal links, and code-block post-processing already have coverage.

- [ ] **Step 2: Update assistant message styling**

In `styles.css`, make `.shell-entry.ai` lighter:

- Remove heavy border/shadow for normal assistant messages.
- Preserve stronger card treatment for approval cards and code blocks.
- Keep stream container readable.

Target:

```css
.shell-entry.ai {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 9px;
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
}
```

If the current DOM does not include an assistant avatar for normal AI messages, choose the lower-risk option:

- Style without avatar first.
- Add avatar markup only if the final layout needs it and tests can cover it.

- [ ] **Step 3: Keep user bubbles**

Keep `.shell-entry.user` as a right-aligned blue bubble with fixed max-width and no layout shift.

- [ ] **Step 4: Keep approval card emphasis**

Do not remove `.shell-approval-card` border/background. Approval requests are intentionally higher-friction UI.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected: all tests pass and production bundle builds.

## Chunk 6: Visual Verification

### Task 6: Compare Against Prototype

**Files:**
- Reference: `docs/prototypes/sidebar-redesign-prototype.html`
- Reference: `docs/prototypes/sidebar-redesign-prototype.png`
- Modify only if needed: `styles.css`, focused UI files.

- [ ] **Step 1: Load plugin in Obsidian dev vault**

Run:

```powershell
npm run build
```

Then reload Obsidian or the plugin.

- [ ] **Step 2: Exercise the target flow**

Use the same flow as the screenshot:

- clear chat
- ask to beautify current note
- trigger an update system message
- ask a second same-style request
- observe streaming thought/tool state
- attach or check current note context chip

- [ ] **Step 3: Validate acceptance criteria**

The implementation is acceptable when:

- Header right actions are search/history and settings.
- New chat exists only in the session row.
- No floating action strip overlaps the transcript.
- System update messages do not look like chat bubbles.
- Long paths show basename first and do not wrap into noisy multi-line logs.
- Thought/tool rows are collapsed and visually secondary after completion.
- Composer controls do not overlap at 320px sidebar width.
- Approval cards remain prominent and unchanged in behavior.

- [ ] **Step 4: Final full verification**

Run:

```powershell
npm test
npm run build
git diff -- src/ui styles.css test docs/prototypes docs/superpowers/plans
```

Expected:

- Tests pass.
- Build passes.
- Diff is limited to sidebar UI implementation, tests, and this plan.

## Risks And Guardrails

- **Risk:** Removing visible clear/tools buttons may surprise users.
  - Guardrail: `/clear` and `/tools` stay in command suggestions. If needed later, add a compact overflow menu, not more top-level icons.

- **Risk:** CSS-only assistant avatar styling may not match the prototype if markup lacks an avatar.
  - Guardrail: Prefer lightweight no-avatar assistant messages first. Add avatar markup only with tests.

- **Risk:** System message parsing could hide unknown system messages.
  - Guardrail: Parse only known update patterns. Unknown system messages keep the existing `[System] ...` fallback.

- **Risk:** Path parsing with Node APIs would break mobile compatibility.
  - Guardrail: Use string splitting helpers only.

- **Risk:** Header history menu positioning may need adjustment after moving the button.
  - Guardrail: Keep `historyMenuContainerEl` under the header and test open/close manually after CSS updates.

## Execution Notes

- Use small commits per chunk if committing is requested.
- Do not commit generated `main.js` separately from source changes if the repository normally tracks build output; include it only after `npm run build` succeeds.
- Keep the prototype files as reference artifacts until the implementation is accepted.
