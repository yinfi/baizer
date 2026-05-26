# Skill Optimization Finish Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining `skill` workflow gaps so `baizer` is genuinely skill-first across chat routing, slash commands, generated plugin skills, and UI affordances.

**Architecture:** Keep the current `ToolRegistry + SkillRegistry + ChatRuntime + ChatController` architecture intact and finish the missing links instead of introducing a new abstraction. The work falls into three closing moves: wire `resolveByIntent()` into the real runtime path, make `use_skill` materially change what the runtime can execute, and remove legacy slash/UI branches only after instruction-only skills and plugin-generated skills have parity with built-in skills.

**Tech Stack:** TypeScript, Obsidian Plugin API, current `ToolRegistry` / `SkillRegistry` / `ModelService` runtime, custom `tsx` test harness.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/runtime/chat-runtime.ts` | Modify | Attach intent routing to the live runtime loop and manage active-skill tool scope |
| `src/skills/skill-registry.ts` | Modify | Keep routing helpers deterministic and expose the activation contract used by runtime |
| `src/skills/types.ts` | Modify | Tighten types around activated-skill metadata if runtime needs explicit scoping state |
| `src/services/model-service.ts` | Modify | Make slash-command execution work for instruction-only skills as well as built-in executable skills |
| `src/skills/skill-loader.ts` | Modify | Align user-skill execution semantics with the final slash/runtime contract |
| `src/skills/builtin/plugin-ctrl/skill-generator.ts` | Modify | Improve generated skill metadata so plugin skills benefit from intent routing |
| `src/ui/chat-controller.ts` | Modify | Remove stale local slash behavior after registry-driven flow is complete |
| `src/ui/shell-view.ts` | Modify | Keep suggestions and help surfaces in sync with dynamic skill commands |
| `src/mcp/types.ts` | Modify | Align system prompt wording with the completed runtime behavior |
| `test/chat-runtime.test.ts` | Modify | Cover intent-triggered skill activation and scoped tool execution |
| `test/skill-routing.test.ts` | Modify | Lock down routing precedence and disabled-skill behavior |
| `test/model-service.test.ts` | Modify | Cover instruction-only slash-skill dispatch |
| `test/chat-controller.test.ts` | Modify | Verify slash commands do not fall back into stale local handlers |
| `test/command-suggestions.test.ts` | Modify | Keep dynamic command suggestions and help output stable |
| `test/plugin-skill-generator.test.ts` | Modify | Verify generated skill metadata supports runtime routing |

---

## Chunk 1: Close The Runtime Routing Loop

### Task 1: Route matched intent into the real runtime path

**Files:**
- Modify: `src/runtime/chat-runtime.ts:26-197`
- Modify: `src/skills/skill-registry.ts:286-328`
- Test: `test/chat-runtime.test.ts`
- Test: `test/skill-routing.test.ts`

- [ ] **Step 1: Add a failing runtime test for pre-call intent routing**

Cover the case where a user message like "save this webpage" matches `resolveByIntent()` and the runtime activates the matching skill before or during the first provider turn, without relying only on prompt prose.

- [ ] **Step 2: Implement the minimum runtime hook**

In `src/runtime/chat-runtime.ts`, introduce a deterministic handoff that checks `skillRegistry.resolveByIntent(request.userMessage)` and feeds that result into the runtime loop in a way the provider can immediately use.

- [ ] **Step 3: Preserve disabled-skill and no-match behavior**

Ensure the new hook is a no-op when no enabled skill matches, and that existing chat behavior stays unchanged for ordinary requests.

- [ ] **Step 4: Run the focused routing tests**

Run: `cmd /c npx.cmd tsx test/chat-runtime.test.ts`

Expected: intent-routed and non-routed cases both pass.

Run: `cmd /c npx.cmd tsx test/skill-routing.test.ts`

Expected: routing precedence remains deterministic and disabled skills stay excluded.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/chat-runtime.ts src/skills/skill-registry.ts test/chat-runtime.test.ts test/skill-routing.test.ts
git commit -m "refactor: wire skill intent routing into runtime"
```

---

### Task 2: Make `use_skill` change executable tool scope

**Files:**
- Modify: `src/runtime/chat-runtime.ts:161-197`
- Modify: `src/skills/types.ts:101-129`
- Test: `test/chat-runtime.test.ts`

- [ ] **Step 1: Add a failing test for scoped tool execution after activation**

Cover the case where the runtime activates a skill and then only exposes or executes the subset of tools declared by that skill, while keeping `use_skill` available for subsequent switches.

- [ ] **Step 2: Implement active-skill tool scoping**

Adjust `buildSkillModeTools()` and the runtime loop so skill activation updates the working tool surface instead of returning instructions as inert metadata.

- [ ] **Step 3: Decide the least invasive compatibility rule**

Keep global tools available only when no skill is active, or explicitly whitelist a small shared set if the current workflows require it. Document the chosen rule inline in the plan implementation.

- [ ] **Step 4: Re-run focused runtime tests**

Run: `cmd /c npx.cmd tsx test/chat-runtime.test.ts`

Expected: tool calls after activation are limited to the active skill contract and existing `use_skill` loop tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/chat-runtime.ts src/skills/types.ts test/chat-runtime.test.ts
git commit -m "refactor: scope runtime tools by active skill"
```

---

## Chunk 2: Give Instruction-Only Skills Full Parity

### Task 3: Make slash commands work for user-defined and instruction-only skills

**Files:**
- Modify: `src/services/model-service.ts:328-350`
- Modify: `src/skills/skill-loader.ts:16-55`
- Modify: `src/ui/chat-controller.ts:127-230`
- Test: `test/model-service.test.ts`
- Test: `test/chat-controller.test.ts`

- [ ] **Step 1: Add a failing test for instruction-only slash skill dispatch**

Cover the case where a command resolved from `SkillRegistry` belongs to a user skill or generated plugin skill that only has instructions and tools, and the command still completes a real workflow instead of echoing instructions back to the shell.

- [ ] **Step 2: Choose one execution contract and apply it consistently**

Preferred path: in `ModelService.executeSlashSkillCommand()`, detect instruction-only skills and execute them through `ChatRuntime` with a structured prompt that forces the matching skill path, instead of calling `skill.execute()` and dumping the returned text.

- [ ] **Step 3: Keep built-in executable skills working unchanged**

Do not regress built-in skills like `web-clipper` or `plugin-ctrl` that already use dedicated executors.

- [ ] **Step 4: Run focused slash-command tests**

Run: `cmd /c npx.cmd tsx test/model-service.test.ts`

Expected: built-in and instruction-only slash skill paths both pass.

Run: `cmd /c npx.cmd tsx test/chat-controller.test.ts`

Expected: the controller still routes matching slash commands through the skill pipeline first.

- [ ] **Step 5: Commit**

```bash
git add src/services/model-service.ts src/skills/skill-loader.ts src/ui/chat-controller.ts test/model-service.test.ts test/chat-controller.test.ts
git commit -m "feat: unify slash execution for instruction-only skills"
```

---

### Task 4: Improve generated plugin-skill metadata for intent routing

**Files:**
- Modify: `src/skills/builtin/plugin-ctrl/skill-generator.ts:304-335`
- Test: `test/plugin-skill-generator.test.ts`
- Test: `test/skill-routing.test.ts`

- [ ] **Step 1: Add a failing test for generated-skill keyword quality**

Cover a representative plugin where the generated `keywords` should include stable plugin identity plus a small number of task-oriented terms that help `resolveByIntent()` match reliably.

- [ ] **Step 2: Harden generated frontmatter**

Improve `buildFrontmatter()` / `extractKeywords()` so generated plugin skills produce useful routing keywords without turning into noisy bag-of-words metadata.

- [ ] **Step 3: Keep the generator conservative**

Do not invent fake slash commands for plugin skills unless there is a clear command contract. The immediate goal is reliable chat routing, not a new command namespace.

- [ ] **Step 4: Run focused generator and routing tests**

Run: `cmd /c npx.cmd tsx test/plugin-skill-generator.test.ts`

Expected: generated metadata remains stable and the new keyword assertions pass.

Run: `cmd /c npx.cmd tsx test/skill-routing.test.ts`

Expected: routing still prefers the strongest enabled match.

- [ ] **Step 5: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/skill-generator.ts test/plugin-skill-generator.test.ts test/skill-routing.test.ts
git commit -m "refactor: strengthen generated plugin skill routing metadata"
```

---

## Chunk 3: Remove Legacy UI Branches After Parity

### Task 5: Delete stale local slash fallbacks and make help output registry-driven

**Files:**
- Modify: `src/ui/chat-controller.ts:148-205`
- Modify: `src/ui/chat-controller.ts:451-488`
- Modify: `src/ui/shell-view.ts:49-61`
- Modify: `src/ui/shell-view.ts:360-372`
- Test: `test/chat-controller.test.ts`
- Test: `test/command-suggestions.test.ts`

- [ ] **Step 1: Add a failing test that stale `/save` fallback is never used when a skill command exists**

The controller should keep only truly local commands such as `/clear` and `/profile`, while registry-backed skill commands stay outside the hardcoded switch.

- [ ] **Step 2: Remove duplicated local skill behavior**

Delete or retire `handleSave()` once slash parity is complete, and keep `handleWikiCompile()` / `handleWikiIndex()` style helpers only for commands that are intentionally local to the plugin UI.

- [ ] **Step 3: Make help and suggestion surfaces dynamic**

Update `showHelp()` and the shell suggestion list so skill commands come from `SkillRegistry` rather than being duplicated in UI constants.

- [ ] **Step 4: Run focused UI tests**

Run: `cmd /c npx.cmd tsx test/chat-controller.test.ts`

Expected: matching skill commands never fall through into stale local handlers.

Run: `cmd /c npx.cmd tsx test/command-suggestions.test.ts`

Expected: local and dynamic commands still merge cleanly without duplicates.

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat-controller.ts src/ui/shell-view.ts test/chat-controller.test.ts test/command-suggestions.test.ts
git commit -m "refactor: remove legacy slash fallbacks from shell ui"
```

---

### Task 6: Align prompt text and run full regression

**Files:**
- Modify: `src/mcp/types.ts:143-150`
- Test: `test/run-tests.ts`

- [ ] **Step 1: Reconcile prompt wording with the completed runtime behavior**

After the runtime is doing real intent routing and skill activation, update the system prompt text so it describes the actual contract and does not rely on repeated hand-holding.

- [ ] **Step 2: Run the full maintained harness**

Run: `cmd /c npm.cmd test`

Expected: all maintained test files pass with no new regressions in runtime, approval flow, plugin generation, or shell UI.

- [ ] **Step 3: Run a production build**

Run: `cmd /c npm.cmd run build`

Expected: `main.js` builds successfully without type or bundling regressions.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/types.ts
git commit -m "docs: align skill runtime prompt contract"
```

---

## Exit Criteria

- [ ] A plain chat request can trigger `resolveByIntent()` in the live runtime, not just in tests.
- [ ] After `use_skill`, the runtime tool surface reflects the active skill instead of remaining fully global.
- [ ] Slash commands resolved through `SkillRegistry` work for built-in, user-defined, and generated plugin skills.
- [ ] The shell UI keeps only genuinely local commands in hardcoded branches.
- [ ] Dynamic help and command suggestions are registry-backed and do not duplicate stale command definitions.
- [ ] `cmd /c npm.cmd test` and `cmd /c npm.cmd run build` both pass at the end.

## Optional Follow-Ons

- [ ] Add weighted keyword scoring or aliases to `resolveByIntent()` only if real-world routing still feels weak after the above work.
- [ ] Add a compact debug trace for skill selection in development builds if routing becomes hard to reason about during future feature work.
