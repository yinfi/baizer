# Testing

## Snapshot

- The repository has a `test/` directory, but it does not have a wired test runner in `package.json`. `package.json` only defines `dev` and `build`.
- There is no checked-in Jest, Vitest, Mocha, or Node `--test` configuration. A repository search also turns up no `jest.config.*`, `vitest.config.*`, or ESLint test setup files.
- Current testing is ad hoc: some files use handwritten async runners, some rely on direct Node execution, and one file uses Jest-style globals that are not installed in the project.

## Test Layout

- `test/mcp-integration.test.ts` uses a custom `runTests()` function, inline `test()` helper, and inline `expect()` implementation to exercise `ToolManager`.
- `test/plugin-tools.test.ts` follows the same pattern: custom runner, inline assertions, and hard-coded Obsidian/plugin mocks.
- `test/gemini-api-chat.test.ts` also uses a handwritten runner, but it targets `../src/gemini-api`, which no longer exists in the current `src/` tree.
- `test/functional-test.ts` is another manual integration-style script that constructs mock app/view instances and drives shell commands. It also imports `../src/gemini-api`, so it is stale relative to the current codebase.
- `test/context-manager.test.ts` is the outlier. It uses Jest-style `describe`, `beforeEach`, `test`, `expect`, and `jest.mock`, but `package.json` does not include Jest or `@types/jest`.
- `test/functional-test.js` looks like a generated or bundled artifact derived from the older TypeScript test flow rather than a source-of-truth test file.

## Utilities And Mocks

- `test/mock-obsidian.ts` provides a broader hand-rolled Obsidian shim with classes like `App`, `Vault`, `Workspace`, `Modal`, `ItemView`, `PluginSettingTab`, and `Setting`.
- `test/obsidian-mock.ts` is a second, lighter mock implementation for Obsidian view and app objects.
- `test/setup-mock.js` monkey-patches Node module loading so `require('obsidian')` resolves to a local mock, which suggests some tests were intended to run directly under Node.
- Several tests avoid shared utilities and instead define their own inline helpers, for example `mockFn()` and `expect()` in `test/plugin-tools.test.ts`, or per-file `setup()` functions in `test/mcp-integration.test.ts`.
- Mocking style is inconsistent across files:
  - Inline object literals for `app`, `vault`, `commands`, and `workspace` in `test/mcp-integration.test.ts` and `test/plugin-tools.test.ts`.
  - Global monkey-patching in `test/setup-mock.js`.
  - Jest mocking syntax in `test/context-manager.test.ts`.

## How Tests Are Run Today

- There is no single supported command such as `npm test`.
- Based on `package.json`, `test/setup-mock.js`, and the handwritten `runTests()` functions, tests appear intended to be executed file-by-file and manually.
- The closest thing to a repository-wide verification command is `npx tsc --noEmit`, because `tsconfig.json` includes all `**/*.ts` files. In this mapping pass, that command fails.
- Example current verification paths:
  - Build the plugin with `npm run build`.
  - Type-check the repository with `npx tsc --noEmit`.
  - Run individual JavaScript test artifacts manually where they exist, such as `test/functional-test.js`.
- The TypeScript test files are not currently runnable as-is without adding a runner or a TS execution layer such as Jest + ts-jest, Vitest, tsx, or ts-node.

## What Is Covered

- `test/mcp-integration.test.ts` and `test/plugin-tools.test.ts` focus on `src/mcp/tools.ts` behavior:
  - tool definition inventory
  - note CRUD-like commands
  - plugin listing/settings commands
  - simple `web_search`
  - time helper behavior
- `test/context-manager.test.ts` is intended to cover URL and YouTube context resolution in `src/services/context-manager.ts`, plus transcript mocking.
- `test/functional-test.ts` is intended to cover shell-level flows in `src/ui/shell-view.ts`, including note creation and edit commands.
- `test/gemini-api-chat.test.ts` targets an older API orchestration layer and no longer matches the current service/provider split in `src/services/model-service.ts` plus `src/models/`.

## Current Breakages

- `npx tsc --noEmit` currently fails across both app code and tests.
- App-code failures include unused imports and stale method references in files such as `main.ts`, `src/ui/shell-view.ts`, `src/ui/selection-menu.ts`, `src/models/openai.ts`, and `src/mcp/tools.ts`.
- Test-code failures include:
  - missing Jest globals in `test/context-manager.test.ts`
  - imports of missing `../src/gemini-api` in `test/functional-test.ts` and `test/gemini-api-chat.test.ts`
  - stale constructor calls that pass booleans where `GeminiSettings` is now required in `test/mcp-integration.test.ts`, `test/plugin-tools.test.ts`, `test/gemini-api-chat.test.ts`, and `test/functional-test.ts`
- The result is that the repository has test intent and test artifacts, but not a currently working automated test pipeline.

## Coverage Gaps

- There is little or no current test coverage for `src/services/model-service.ts`, especially provider switching, looped tool execution, and timeout/error behavior.
- `src/models/gemini.ts` and `src/models/openai.ts` do not have active provider contract tests.
- `src/mcp/mcp-client.ts` has no visible tests for stdio framing, request timeouts, pending-request cleanup, or process shutdown behavior.
- The largest and riskiest runtime surface, `src/mcp/tools.ts`, only has partial coverage. The most complex path, `save_webpage`, spans HTML fetching, Readability extraction, transcript retrieval, file naming, frontmatter generation, and provider-assisted summarization.
- UI state machines in `src/ui/ghost-text.ts`, `src/ui/guardian-gutter.ts`, `src/ui/selection-menu.ts`, and `src/ui/shell-view.ts` are effectively untested in their current form.
- `src/memory/memory-manager.ts` persistence and profile-learning behavior are untested.
- There is no CI configuration in the checked-in repository, so even the existing tests are not enforced on every change.

## Practical Guidance

- Treat the current `test/` directory as reference material, not as a trustworthy safety net.
- If you need quick confidence today, `npm run build` and targeted manual smoke tests inside Obsidian are likely more informative than the stale test scripts.
- If automated testing becomes a priority, the first cleanup step is to choose one runner, update or delete stale tests, and align the tests with the current `ModelService` and `ToolManager` APIs before adding new coverage.
