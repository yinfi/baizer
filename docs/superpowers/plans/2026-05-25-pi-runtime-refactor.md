# Pi Runtime Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a Pi-backed runtime behind Baizer's existing `ChatRuntime` interface while keeping the legacy runtime available as a rollback path.

**Architecture:** Keep `ModelService`, provider classes, skill registry, tool registry, approval cards, and workspace edit service intact. Add a Pi adapter layer under `src/runtime/pi/`, route runtime creation through an internal engine selector, and migrate tool execution plus streaming event mapping in small tested steps.

**Tech Stack:** TypeScript 4.7, esbuild, Obsidian plugin APIs, existing Baizer provider interfaces, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` types and low-level `agentLoop`.

---

## File Structure

- Modify `package.json` and `package-lock.json`: add Pi dependency during the compatibility spike.
- Modify `src/runtime/runtime-types.ts`: expose shared runtime dependency and runtime engine types.
- Modify `src/runtime/chat-runtime.ts`: consume shared runtime dependency type and export reusable helper behavior only when required by the adapter.
- Modify `src/runtime/runtime-factory.ts`: select legacy or Pi runtime through an internal engine selector.
- Create `src/runtime/runtime-engine.ts`: hold the internal runtime engine flag and test-only setters.
- Create `src/runtime/pi/pi-chat-runtime.ts`: implement `ChatRuntime` with Pi while reusing legacy `prepareTurn`.
- Create `src/runtime/pi/pi-provider-bridge.ts`: adapt Baizer `IChatSession` streams into Pi assistant message streams.
- Create `src/runtime/pi/pi-tool-adapter.ts`: adapt Baizer tool definitions and registries into Pi `AgentTool` objects.
- Create `src/runtime/pi/pi-event-adapter.ts`: map Pi events into Baizer `StreamEvent` objects.
- Create `src/runtime/pi/pi-approval-policy.ts`: preserve approval-stop and write-failure behavior.
- Modify `src/skills/types.ts`: add optional scheduling metadata to Baizer tools.
- Modify `test/run-tests.ts`: add new runtime adapter test files.
- Create `test/pi-runtime-factory.test.ts`: verify runtime selection and rollback behavior.
- Create `test/pi-event-adapter.test.ts`: verify Pi-to-Baizer event mapping.
- Create `test/pi-tool-adapter.test.ts`: verify tool scheduling, scope, workspace edit routing, and approval result wrapping.
- Create `test/pi-provider-bridge.test.ts`: verify provider stream bridging from Baizer events to Pi events.
- Create `test/pi-chat-runtime.test.ts`: verify end-to-end Pi runtime behavior for text, tools, approval, abort, and write failures.

---

## Task 1: Compatibility Spike

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm branch and dirty-worktree context**

Run:

```powershell
git branch --show-current
git status --short --branch
```

Expected:

```text
codex/pi-runtime-refactor
## codex/pi-runtime-refactor
```

The status may show unrelated existing modifications. Do not reset them.

- [ ] **Step 2: Add the Pi runtime package**

Run:

```powershell
npm install @earendil-works/pi-agent-core@0.75.5 --save
```

Expected:

```text
added
```

`package.json` must contain:

```json
"@earendil-works/pi-agent-core": "^0.75.5"
```

- [ ] **Step 3: Record the engine and dependency risk in the implementation notes**

Run:

```powershell
npm view @earendil-works/pi-agent-core version engines dependencies --json
npm view @earendil-works/pi-ai version engines dependencies --json
```

Expected facts to preserve in the task notes:

```text
@earendil-works/pi-agent-core version 0.75.5
@earendil-works/pi-agent-core engines.node >=22.19.0
@earendil-works/pi-agent-core depends on @earendil-works/pi-ai
@earendil-works/pi-ai brings multiple provider SDK dependencies
```

- [ ] **Step 4: Build immediately after installing**

Run:

```powershell
npm run build
```

Expected:

```text
done
```

If build fails because of ESM, Node engine, browser-incompatible imports, or package resolution, stop this plan and write the observed failure into `docs/superpowers/specs/2026-05-24-pi-runtime-refactor-design.md` under `Compatibility Spike`.

- [ ] **Step 5: Run the maintained test harness**

Run:

```powershell
npm test
```

Expected:

```text
Executed 65 test files successfully.
```

- [ ] **Step 6: Commit the dependency spike**

Run:

```powershell
git add package.json package-lock.json
git commit -m "chore: add pi agent runtime dependency"
```

Expected:

```text
[codex/pi-runtime-refactor ...] chore: add pi agent runtime dependency
```

---

## Task 2: Runtime Engine Selection

**Files:**
- Modify: `src/runtime/runtime-types.ts`
- Create: `src/runtime/runtime-engine.ts`
- Modify: `src/runtime/chat-runtime.ts`
- Create: `src/runtime/pi/pi-chat-runtime.ts`
- Modify: `src/runtime/runtime-factory.ts`
- Create: `test/pi-runtime-factory.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write the failing factory test**

Create `test/pi-runtime-factory.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Runtime Factory Tests ===');
  const {
    createChatRuntime,
  } = await import('../src/runtime/runtime-factory');
  const {
    resetRuntimeEngineForTesting,
    setRuntimeEngineForTesting,
  } = await import('../src/runtime/runtime-engine');

  const deps = {
    provider: {} as any,
    memoryManager: null,
    toolRegistry: {
      getAllDefinitions: () => [],
      execute: async () => ({}),
    } as any,
    skillRegistry: {
      resolveByIntent: () => null,
      getSkillSummaryText: () => '',
      activateSkill: () => null,
    } as any,
  };

  await test('defaults to the legacy runtime', () => {
    resetRuntimeEngineForTesting();
    const runtime = createChatRuntime(deps);
    expect(runtime.constructor.name).toBe('DefaultChatRuntime');
  });

  await test('can create the Pi runtime through the internal engine flag', () => {
    setRuntimeEngineForTesting('pi');
    const runtime = createChatRuntime(deps);
    expect(runtime.constructor.name).toBe('PiChatRuntime');
    resetRuntimeEngineForTesting();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add it to `test/run-tests.ts` immediately after `test/chat-runtime.test.ts`:

```ts
  'test/pi-runtime-factory.test.ts',
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-runtime-factory.test.ts
```

Expected:

```text
Cannot find module '../src/runtime/runtime-engine'
```

- [ ] **Step 3: Move runtime dependencies into shared types**

Modify `src/runtime/runtime-types.ts`:

```ts
import { ChatContextItem, IModelProvider, StreamEvent, ToolDefinition } from '../models/interfaces';
import { UserProfile } from '../memory/types';
import { MemoryManager } from '../memory/memory-manager';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import { GenerationPlan, GenerationSource, WritingProfile } from '../services/generation-strategy-service';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { WorkspaceEditService } from '../services/workspace-edit-service';

export type RuntimeEngine = 'legacy' | 'pi';

export interface ChatRuntimeDeps {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
}
```

Keep the existing `ChatTurnRequest`, `PreparedChatTurn`, and `ChatRuntime` declarations below these imports.

- [ ] **Step 4: Create the runtime engine flag**

Create `src/runtime/runtime-engine.ts`:

```ts
import { RuntimeEngine } from './runtime-types';

let runtimeEngine: RuntimeEngine = 'legacy';

export function getRuntimeEngine(): RuntimeEngine {
  return runtimeEngine;
}

export function setRuntimeEngineForTesting(engine: RuntimeEngine): void {
  runtimeEngine = engine;
}

export function resetRuntimeEngineForTesting(): void {
  runtimeEngine = 'legacy';
}
```

- [ ] **Step 5: Update the legacy runtime to use shared dependency type**

Modify the imports and remove the local `ChatRuntimeDeps` interface from `src/runtime/chat-runtime.ts`:

```ts
import {
  PreparedChatTurn,
  ChatRuntime,
  ChatRuntimeDeps,
  ChatTurnRequest,
} from './runtime-types';
```

The constructor remains:

```ts
constructor(private deps: ChatRuntimeDeps) { }
```

- [ ] **Step 6: Create a Pi runtime skeleton that delegates to legacy behavior**

Create `src/runtime/pi/pi-chat-runtime.ts`:

```ts
import { StreamEvent } from '../../models/interfaces';
import { DefaultChatRuntime } from '../chat-runtime';
import {
  ChatRuntime,
  ChatRuntimeDeps,
  ChatTurnRequest,
  PreparedChatTurn,
} from '../runtime-types';

export class PiChatRuntime implements ChatRuntime {
  private readonly legacy: DefaultChatRuntime;

  constructor(private readonly deps: ChatRuntimeDeps) {
    this.legacy = new DefaultChatRuntime(deps);
  }

  getTools() {
    return this.legacy.getTools();
  }

  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    return this.legacy.prepareTurn(request);
  }

  query(turn: PreparedChatTurn): Promise<string> {
    return this.legacy.query(turn);
  }

  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    return this.legacy.queryStream(turn, signal);
  }
}
```

- [ ] **Step 7: Route factory creation through the engine selector**

Modify `src/runtime/runtime-factory.ts`:

```ts
import { DefaultChatRuntime } from './chat-runtime';
import { PiChatRuntime } from './pi/pi-chat-runtime';
import { getRuntimeEngine } from './runtime-engine';
import { ChatRuntimeDeps } from './runtime-types';

export function createChatRuntime(args: ChatRuntimeDeps) {
  return getRuntimeEngine() === 'pi'
    ? new PiChatRuntime(args)
    : new DefaultChatRuntime(args);
}
```

- [ ] **Step 8: Run targeted and full tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-runtime-factory.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
npm test
```

Expected:

```text
PASS defaults to the legacy runtime
PASS can create the Pi runtime through the internal engine flag
Executed 66 test files successfully.
```

- [ ] **Step 9: Commit runtime selection**

Run:

```powershell
git add src/runtime/runtime-types.ts src/runtime/runtime-engine.ts src/runtime/chat-runtime.ts src/runtime/pi/pi-chat-runtime.ts src/runtime/runtime-factory.ts test/pi-runtime-factory.test.ts test/run-tests.ts
git commit -m "feat: add selectable pi runtime shell"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: add selectable pi runtime shell
```

---

## Task 3: Pi Event Adapter

**Files:**
- Create: `src/runtime/pi/pi-event-adapter.ts`
- Create: `test/pi-event-adapter.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing event adapter tests**

Create `test/pi-event-adapter.test.ts`:

```ts
function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toBeUndefined: () => {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Event Adapter Tests ===');
  const {
    mapPiEventToStreamEvent,
    unwrapPiToolResult,
  } = await import('../src/runtime/pi/pi-event-adapter');

  await test('maps text deltas', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as any)).toEqual({ type: 'text_delta', content: 'hello' });
  });

  await test('maps thinking deltas', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' },
    } as any)).toEqual({ type: 'thinking', content: 'plan' });
  });

  await test('maps tool execution start', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'read_note',
      args: { path: 'note.md' },
    } as any)).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'read_note',
      args: { path: 'note.md' },
    });
  });

  await test('unwraps Baizer tool details from a Pi tool result', () => {
    expect(unwrapPiToolResult({
      content: [{ type: 'text', text: '{"success":true}' }],
      details: {
        baizerResponse: { success: true },
      },
    })).toEqual({ success: true });
  });

  await test('maps tool execution end', () => {
    expect(mapPiEventToStreamEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'read_note',
      result: {
        content: [{ type: 'text', text: '{"path":"note.md"}' }],
        details: {
          baizerResponse: { path: 'note.md' },
        },
      },
      isError: false,
    } as any)).toEqual({
      type: 'tool_result',
      name: 'read_note',
      result: { path: 'note.md' },
    });
  });

  await test('ignores non-delta message events', () => {
    expect(mapPiEventToStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start' },
    } as any)).toBeUndefined();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `test/run-tests.ts` after `test/pi-runtime-factory.test.ts`:

```ts
  'test/pi-event-adapter.test.ts',
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-event-adapter.test.ts
```

Expected:

```text
Cannot find module '../src/runtime/pi/pi-event-adapter'
```

- [ ] **Step 3: Implement the event adapter**

Create `src/runtime/pi/pi-event-adapter.ts`:

```ts
import { StreamEvent } from '../../models/interfaces';

export function unwrapPiToolResult(result: any): any {
  if (result?.details && Object.prototype.hasOwnProperty.call(result.details, 'baizerResponse')) {
    return result.details.baizerResponse;
  }
  if (typeof result?.content?.[0]?.text === 'string') {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return { message: result.content[0].text };
    }
  }
  return result;
}

export function mapPiEventToStreamEvent(event: any): StreamEvent | undefined {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent?.type === 'text_delta') {
      return { type: 'text_delta', content: assistantEvent.delta || '' };
    }
    if (assistantEvent?.type === 'thinking_delta') {
      return { type: 'thinking', content: assistantEvent.delta || '' };
    }
    return undefined;
  }

  if (event.type === 'tool_execution_start') {
    return {
      type: 'tool_call',
      id: event.toolCallId,
      name: event.toolName,
      args: event.args || {},
    };
  }

  if (event.type === 'tool_execution_end') {
    const streamEvent: StreamEvent = {
      type: 'tool_result',
      name: event.toolName,
      result: unwrapPiToolResult(event.result),
    };
    if (event.isError) {
      streamEvent.error = getToolErrorMessage(event.result);
    }
    return streamEvent;
  }

  return undefined;
}

function getToolErrorMessage(result: any): string | undefined {
  if (typeof result?.details?.error === 'string') return result.details.error;
  if (typeof result?.content?.[0]?.text === 'string') return result.content[0].text;
  return undefined;
}
```

- [ ] **Step 4: Run targeted and full tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-event-adapter.test.ts
npm test
```

Expected:

```text
PASS maps text deltas
PASS maps thinking deltas
PASS maps tool execution start
PASS maps tool execution end
Executed 67 test files successfully.
```

- [ ] **Step 5: Commit event adapter**

Run:

```powershell
git add src/runtime/pi/pi-event-adapter.ts test/pi-event-adapter.test.ts test/run-tests.ts
git commit -m "feat: map pi events to baizer stream events"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: map pi events to baizer stream events
```

---

## Task 4: Pi Tool Adapter And Scheduling Metadata

**Files:**
- Modify: `src/skills/types.ts`
- Create: `src/runtime/pi/pi-tool-adapter.ts`
- Create: `test/pi-tool-adapter.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing tool adapter tests**

Create `test/pi-tool-adapter.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Tool Adapter Tests ===');
  const {
    adaptToolDefinitionsToPi,
    inferToolExecutionMode,
  } = await import('../src/runtime/pi/pi-tool-adapter');

  await test('infers read tools as parallel', () => {
    expect(inferToolExecutionMode('read_note')).toBe('parallel');
    expect(inferToolExecutionMode('search_vault')).toBe('parallel');
    expect(inferToolExecutionMode('list_notes')).toBe('parallel');
  });

  await test('infers write and plugin tools as sequential', () => {
    expect(inferToolExecutionMode('create_file')).toBe('sequential');
    expect(inferToolExecutionMode('update_note')).toBe('sequential');
    expect(inferToolExecutionMode('execute_plugin_command')).toBe('sequential');
  });

  await test('uses explicit tool execution metadata first', () => {
    expect(inferToolExecutionMode('custom_tool', { executionMode: 'parallel' } as any)).toBe('parallel');
    expect(inferToolExecutionMode('custom_tool', { executionMode: 'sequential' } as any)).toBe('sequential');
  });

  await test('routes direct write tools through WorkspaceEditService', async () => {
    const registryCalls: any[] = [];
    const workspaceCalls: any[] = [];
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'update_file', description: 'Update file', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async (name: string, args: any) => {
          registryCalls.push({ name, args });
          return { success: true };
        },
      } as any,
      workspaceEditService: {
        executeWorkspaceTool: async (name: string, args: any) => {
          workspaceCalls.push({ name, args });
          return { success: true, path: args.path };
        },
      } as any,
      skillScope: { allowedToolNames: null },
    });

    const result = await piTools[0].execute('call_1', { path: 'Notes/a.md', content: 'after' } as any);
    expect(registryCalls).toEqual([]);
    expect(workspaceCalls).toEqual([{ name: 'update_file', args: { path: 'Notes/a.md', content: 'after' } }]);
    expect(result.details.baizerResponse).toEqual({ success: true, path: 'Notes/a.md' });
  });

  await test('blocks tools outside active skill scope', async () => {
    const piTools = adaptToolDefinitionsToPi({
      definitions: [{ name: 'search_vault', description: 'Search', parameters: { type: 'object', properties: {} } }],
      toolRegistry: {
        get: () => undefined,
        execute: async () => ({ success: true }),
      } as any,
      workspaceEditService: null,
      skillScope: {
        activeSkillName: 'web-search',
        allowedToolNames: new Set(['web_search']),
      },
    });

    const result = await piTools[0].execute('call_1', { query: 'obsidian' } as any);
    expect(result.details.baizerResponse).toEqual({
      error: 'Tool "search_vault" is not available for active skill "web-search"',
    });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `test/run-tests.ts` after `test/pi-event-adapter.test.ts`:

```ts
  'test/pi-tool-adapter.test.ts',
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-tool-adapter.test.ts
```

Expected:

```text
Cannot find module '../src/runtime/pi/pi-tool-adapter'
```

- [ ] **Step 3: Add optional scheduling metadata to Baizer tools**

Modify `src/skills/types.ts`:

```ts
export type ToolExecutionMode = 'parallel' | 'sequential';
export type ToolRisk = 'read' | 'write' | 'plugin-control' | 'network' | 'unknown';
```

Extend `Tool`:

```ts
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
  risk?: ToolRisk;
  execute(args: any, ctx: ToolContext): Promise<any>;
}
```

- [ ] **Step 4: Implement the tool adapter**

Create `src/runtime/pi/pi-tool-adapter.ts`:

```ts
import { AgentTool, ToolExecutionMode as PiToolExecutionMode } from '@earendil-works/pi-agent-core';
import { ToolDefinition } from '../../models/interfaces';
import { ToolRegistry } from '../../skills/tool-registry';
import { Tool } from '../../skills/types';
import { WorkspaceEditService, isDirectApplyWorkspaceTool } from '../../services/workspace-edit-service';

export interface PiSkillScope {
  activeSkillName?: string;
  allowedToolNames: Set<string> | null;
}

export interface AdaptToolDefinitionsInput {
  definitions: ToolDefinition[];
  toolRegistry: Pick<ToolRegistry, 'get' | 'execute'>;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
  skillScope: PiSkillScope;
}

export function inferToolExecutionMode(name: string, tool?: Partial<Tool>): PiToolExecutionMode {
  if (tool?.executionMode) return tool.executionMode;
  if (tool?.risk === 'write' || tool?.risk === 'plugin-control') return 'sequential';
  if (isDirectApplyWorkspaceTool(name)) return 'sequential';
  if (name.includes('plugin') || name === 'execute_plugin_command') return 'sequential';
  if (/^(read|search|query|get|list)_/.test(name)) return 'parallel';
  return 'sequential';
}

export function adaptToolDefinitionsToPi(input: AdaptToolDefinitionsInput): AgentTool<any>[] {
  return input.definitions.map((definition) => {
    const registeredTool = input.toolRegistry.get(definition.name);
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: inferToolExecutionMode(definition.name, registeredTool),
      execute: async (_toolCallId: string, params: any) => {
        const response = await executeBaizerTool(definition.name, params, input);
        return {
          content: [{ type: 'text', text: stringifyToolResponse(response) }],
          details: { baizerResponse: response },
          terminate: response?.approval_required === true,
        };
      },
    } as AgentTool<any>;
  });
}

async function executeBaizerTool(
  name: string,
  args: any,
  input: AdaptToolDefinitionsInput,
): Promise<any> {
  if (input.skillScope.allowedToolNames && !input.skillScope.allowedToolNames.has(name)) {
    return {
      error: `Tool "${name}" is not available for active skill "${input.skillScope.activeSkillName}"`,
    };
  }

  if (input.workspaceEditService && isDirectApplyWorkspaceTool(name)) {
    return input.workspaceEditService.executeWorkspaceTool(name, args);
  }

  return input.toolRegistry.execute(name, args);
}

function stringifyToolResponse(response: any): string {
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}
```

- [ ] **Step 5: Run targeted and full tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-tool-adapter.test.ts
npm test
```

Expected:

```text
PASS infers read tools as parallel
PASS infers write and plugin tools as sequential
PASS routes direct write tools through WorkspaceEditService
Executed 68 test files successfully.
```

- [ ] **Step 6: Commit tool adapter**

Run:

```powershell
git add src/skills/types.ts src/runtime/pi/pi-tool-adapter.ts test/pi-tool-adapter.test.ts test/run-tests.ts
git commit -m "feat: adapt baizer tools for pi scheduling"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: adapt baizer tools for pi scheduling
```

---

## Task 5: Baizer Provider Bridge For Pi

**Files:**
- Create: `src/runtime/pi/pi-provider-bridge.ts`
- Create: `test/pi-provider-bridge.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing provider bridge tests**

Create `test/pi-provider-bridge.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
  };
}

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Provider Bridge Tests ===');
  const {
    createBaizerStreamFn,
    createPiBridgeModel,
  } = await import('../src/runtime/pi/pi-provider-bridge');

  await test('bridges Baizer text deltas into Pi assistant events', async () => {
    const inputs: any[] = [];
    const session = {
      sendMessageStream: async function* (input: any) {
        inputs.push(input);
        yield { type: 'text_delta', content: 'hi' };
        yield { type: 'done', text: 'hi' };
      },
    };

    const streamFn = createBaizerStreamFn(session as any);
    const stream = await streamFn(createPiBridgeModel(), {
      systemPrompt: '',
      tools: [],
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    } as any, {});

    const events = await collect(stream);
    expect(inputs).toEqual(['hello']);
    expect(events.map(event => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
    expect((await stream.result()).content[0].text).toBe('hi');
  });

  await test('bridges Baizer tool calls into Pi toolcall events', async () => {
    const session = {
      sendMessageStream: async function* () {
        yield { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'a.md' } };
        yield { type: 'done', text: '' };
      },
    };

    const streamFn = createBaizerStreamFn(session as any);
    const stream = await streamFn(createPiBridgeModel(), {
      systemPrompt: '',
      tools: [],
      messages: [{ role: 'user', content: 'read', timestamp: 1 }],
    } as any, {});

    const events = await collect(stream);
    expect(events.map(event => event.type)).toEqual(['start', 'toolcall_start', 'toolcall_end', 'done']);
    const final = await stream.result();
    expect(final.stopReason).toBe('toolUse');
    expect((final.content[0] as any).name).toBe('read_note');
  });

  await test('bridges Pi tool result messages back to Baizer tool results', async () => {
    const inputs: any[] = [];
    const session = {
      sendMessageStream: async function* (input: any) {
        inputs.push(input);
        yield { type: 'text_delta', content: 'done' };
        yield { type: 'done', text: 'done' };
      },
    };

    const streamFn = createBaizerStreamFn(session as any);
    await collect(await streamFn(createPiBridgeModel(), {
      systemPrompt: '',
      tools: [],
      messages: [{
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read_note',
        content: [{ type: 'text', text: '{"ok":true}' }],
        details: { baizerResponse: { ok: true } },
        isError: false,
        timestamp: 2,
      }],
    } as any, {}));

    expect(inputs).toEqual([[{
      id: 'call_1',
      name: 'read_note',
      response: { ok: true },
    }]]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `test/run-tests.ts` after `test/pi-tool-adapter.test.ts`:

```ts
  'test/pi-provider-bridge.test.ts',
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-provider-bridge.test.ts
```

Expected:

```text
Cannot find module '../src/runtime/pi/pi-provider-bridge'
```

- [ ] **Step 3: Implement the provider bridge**

Create `src/runtime/pi/pi-provider-bridge.ts`:

```ts
import {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolResultMessage,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { IChatSession, StreamEvent, ToolResult } from '../../models/interfaces';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function createPiBridgeModel(): Model<any> {
  return {
    id: 'baizer-provider-bridge',
    name: 'Baizer Provider Bridge',
    api: 'baizer-bridge',
    provider: 'baizer',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

export function createBaizerStreamFn(session: IChatSession) {
  return (_model: Model<any>, context: Context, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    void bridgeBaizerStream(session, context, stream, options?.signal);
    return stream;
  };
}

async function bridgeBaizerStream(
  session: IChatSession,
  context: Context,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  const input = getBaizerInput(context);
  const assistant = createEmptyAssistant();
  stream.push({ type: 'start', partial: assistant });

  let textStarted = false;
  let text = '';
  let toolIndex = 0;

  try {
    for await (const event of session.sendMessageStream(input, signal)) {
      if (event.type === 'text_delta') {
        if (!textStarted) {
          textStarted = true;
          assistant.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: { ...assistant, content: [...assistant.content] } });
        }
        text += event.content;
        assistant.content[0] = { type: 'text', text };
        stream.push({ type: 'text_delta', contentIndex: 0, delta: event.content, partial: { ...assistant, content: [...assistant.content] } });
      } else if (event.type === 'thinking') {
        assistant.content.push({ type: 'thinking', thinking: event.content });
        const index = assistant.content.length - 1;
        stream.push({ type: 'thinking_delta', contentIndex: index, delta: event.content, partial: { ...assistant, content: [...assistant.content] } });
      } else if (event.type === 'tool_call') {
        const index = assistant.content.length;
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: { ...assistant, content: [...assistant.content] } });
        const toolCall = {
          type: 'toolCall' as const,
          id: event.id || `call_${toolIndex++}`,
          name: event.name,
          arguments: event.args || {},
        };
        assistant.content.push(toolCall);
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: { ...assistant, content: [...assistant.content] } });
      } else if (event.type === 'error') {
        assistant.stopReason = 'error';
        assistant.errorMessage = event.message;
        stream.push({ type: 'error', reason: 'error', error: assistant });
        stream.end(assistant);
        return;
      }
    }

    if (textStarted) {
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...assistant, content: [...assistant.content] } });
    }
    assistant.stopReason = assistant.content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
    stream.push({ type: 'done', reason: assistant.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: assistant });
    stream.end(assistant);
  } catch (error: any) {
    assistant.stopReason = error?.name === 'AbortError' ? 'aborted' : 'error';
    assistant.errorMessage = error?.message || 'Provider bridge failed';
    stream.push({
      type: 'error',
      reason: assistant.stopReason,
      error: assistant,
    });
    stream.end(assistant);
  }
}

function getBaizerInput(context: Context): string | ToolResult[] {
  const last = context.messages[context.messages.length - 1] as any;
  if (last?.role === 'toolResult') {
    const toolResults = context.messages
      .filter((message): message is ToolResultMessage => message.role === 'toolResult')
      .map((message) => ({
        id: message.toolCallId,
        name: message.toolName,
        response: (message.details as any)?.baizerResponse ?? parseToolResultText(message.content?.[0]?.text),
      }));
    return toolResults;
  }
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.map((part: any) => part.text || '').join('\n');
  }
  return '';
}

function parseToolResultText(text: string | undefined): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function createEmptyAssistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'baizer-bridge',
    provider: 'baizer',
    model: 'baizer-provider-bridge',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
```

- [ ] **Step 4: Run targeted and full tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-provider-bridge.test.ts
npm test
```

Expected:

```text
PASS bridges Baizer text deltas into Pi assistant events
PASS bridges Baizer tool calls into Pi toolcall events
PASS bridges Pi tool result messages back to Baizer tool results
Executed 69 test files successfully.
```

- [ ] **Step 5: Commit provider bridge**

Run:

```powershell
git add src/runtime/pi/pi-provider-bridge.ts test/pi-provider-bridge.test.ts test/run-tests.ts
git commit -m "feat: bridge baizer providers into pi loop"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: bridge baizer providers into pi loop
```

---

## Task 6: Pi Approval And Write-State Policy

**Files:**
- Create: `src/runtime/pi/pi-approval-policy.ts`
- Create: `test/pi-approval-policy.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Write failing approval policy tests**

Create `test/pi-approval-policy.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Approval Policy Tests ===');
  const {
    createPiFileWriteState,
    formatPiApprovalMessage,
    recordPiFileWriteResult,
    resolvePiFinalText,
  } = await import('../src/runtime/pi/pi-approval-policy');

  await test('formats approval messages', () => {
    expect(formatPiApprovalMessage({
      approval_required: true,
      action: 'create_file',
      target: 'Assets/a.canvas',
    })).toBe('Approval required to create_file: Assets/a.canvas');
  });

  await test('returns model text when no write is required', () => {
    const state = createPiFileWriteState(false);
    expect(resolvePiFinalText(state, 'done')).toBe('done');
  });

  await test('returns failure warning when required write fails', () => {
    const state = createPiFileWriteState(true);
    recordPiFileWriteResult(state, 'create_file', { success: false, error: 'Unsafe vault path' });
    const text = resolvePiFinalText(state, 'I created it');
    expect(text).toContain('No file was created or modified');
    expect(text).toContain('Unsafe vault path');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `test/run-tests.ts` after `test/pi-provider-bridge.test.ts`:

```ts
  'test/pi-approval-policy.test.ts',
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-approval-policy.test.ts
```

Expected:

```text
Cannot find module '../src/runtime/pi/pi-approval-policy'
```

- [ ] **Step 3: Implement approval and write-state policy**

Create `src/runtime/pi/pi-approval-policy.ts`:

```ts
import {
  buildFileWriteFailureMessage,
  getFileWriteError,
  isFileWriteToolName,
  isSuccessfulWriteToolResult,
} from '../../utils/file-operation-contract';

export interface PiFileWriteState {
  required: boolean;
  attempted: boolean;
  succeeded: boolean;
  lastError: string;
}

export function isPiApprovalResponse(result: any): boolean {
  return result?.approval_required === true;
}

export function formatPiApprovalMessage(result: { action?: string; target?: string; message?: string }): string {
  if (result.message) return result.message;
  const action = result.action || 'perform this action';
  const target = result.target ? `: ${result.target}` : '';
  return `Approval required to ${action}${target}`;
}

export function createPiFileWriteState(required: boolean): PiFileWriteState {
  return {
    required,
    attempted: false,
    succeeded: false,
    lastError: '',
  };
}

export function recordPiFileWriteResult(state: PiFileWriteState, toolName: string, result: any): void {
  if (!state.required || !isFileWriteToolName(toolName)) return;
  state.attempted = true;
  if (isSuccessfulWriteToolResult(result)) {
    state.succeeded = true;
    return;
  }
  const error = getFileWriteError(result);
  if (error) state.lastError = error;
}

export function resolvePiFinalText(state: PiFileWriteState, modelText: string): string {
  if (!state.required) return modelText;
  if (state.succeeded) return modelText;
  return buildFileWriteFailureMessage(state.attempted, state.lastError);
}
```

- [ ] **Step 4: Run targeted and full tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-approval-policy.test.ts
npm test
```

Expected:

```text
PASS formats approval messages
PASS returns failure warning when required write fails
Executed 70 test files successfully.
```

- [ ] **Step 5: Commit approval policy**

Run:

```powershell
git add src/runtime/pi/pi-approval-policy.ts test/pi-approval-policy.test.ts test/run-tests.ts
git commit -m "feat: preserve approval and write policy for pi runtime"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: preserve approval and write policy for pi runtime
```

---

## Task 7: Pi Chat Runtime Loop

**Files:**
- Modify: `src/runtime/pi/pi-chat-runtime.ts`
- Modify: `src/runtime/chat-runtime.ts`
- Create: `test/pi-chat-runtime.test.ts`
- Modify: `test/run-tests.ts`

- [ ] **Step 1: Expose legacy preparation and retention helpers without changing behavior**

Modify `src/runtime/chat-runtime.ts` so these methods become `protected` instead of `private`:

```ts
protected createSkillScope(turn: PreparedChatTurn): ActiveSkillScope
protected applyGenerationQuality(turn: PreparedChatTurn, modelText: string): string
protected async retainCompletedTurn(turn: PreparedChatTurn, assistantMessage: string): Promise<void>
```

Keep signatures and bodies unchanged.

- [ ] **Step 2: Write failing Pi runtime tests**

Create `test/pi-chat-runtime.test.ts`:

```ts
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
  };
}

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Chat Runtime Tests ===');
  const { PiChatRuntime } = await import('../src/runtime/pi/pi-chat-runtime');

  await test('streams a no-tool response through Pi', async () => {
    const runtime = new PiChatRuntime({
      provider: {
        startChat: () => ({
          sendMessageStream: async function* () {
            yield { type: 'text_delta', content: 'Hello' };
            yield { type: 'done', text: 'Hello' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: { getAllDefinitions: () => [], get: () => undefined, execute: async () => ({}) } as any,
      skillRegistry: { resolveByIntent: () => null, getSkillSummaryText: () => '', activateSkill: () => null } as any,
    });

    const events = await collect(runtime.queryStream({ prompt: 'Say hi', tools: [] } as any));
    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello' },
      { type: 'done', text: 'Hello' },
    ]);
  });

  await test('executes a tool and returns the follow-up response', async () => {
    const inputs: any[] = [];
    const runtime = new PiChatRuntime({
      provider: {
        startChat: () => ({
          sendMessageStream: async function* (input: any) {
            inputs.push(input);
            if (typeof input === 'string') {
              yield { type: 'tool_call', id: 'call_1', name: 'read_note', args: { path: 'a.md' } };
              yield { type: 'done', text: '' };
              return;
            }
            yield { type: 'text_delta', content: 'Read done' };
            yield { type: 'done', text: 'Read done' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} } }],
        get: () => undefined,
        execute: async () => ({ success: true, content: 'A' }),
      } as any,
      skillRegistry: { resolveByIntent: () => null, getSkillSummaryText: () => '', activateSkill: () => null } as any,
    });

    const events = await collect(runtime.queryStream({
      prompt: 'Read a note',
      tools: [{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} } }],
    } as any));

    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'text_delta', 'done']);
    expect(inputs[1]).toEqual([{ id: 'call_1', name: 'read_note', response: { success: true, content: 'A' } }]);
  });

  await test('stops before a success claim when approval is required', async () => {
    const runtime = new PiChatRuntime({
      provider: {
        startChat: () => ({
          sendMessageStream: async function* (input: any) {
            if (typeof input === 'string') {
              yield { type: 'tool_call', id: 'call_1', name: 'create_file', args: { path: 'a.md' } };
              yield { type: 'done', text: '' };
              return;
            }
            yield { type: 'text_delta', content: 'Created' };
            yield { type: 'done', text: 'Created' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [{ name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {} } }],
        get: () => undefined,
        execute: async () => ({
          approval_required: true,
          action: 'create_file',
          target: 'a.md',
          args: { path: 'a.md' },
          message: 'Approval required to create file: a.md',
        }),
      } as any,
      skillRegistry: { resolveByIntent: () => null, getSkillSummaryText: () => '', activateSkill: () => null } as any,
    });

    const events = await collect(runtime.queryStream({
      prompt: 'Create file',
      tools: [{ name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {} } }],
    } as any));

    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result', 'done']);
    expect(events[2]).toEqual({ type: 'done', text: '' });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `test/run-tests.ts` after `test/pi-approval-policy.test.ts`:

```ts
  'test/pi-chat-runtime.test.ts',
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-chat-runtime.test.ts
```

Expected:

```text
Expected Pi runtime events but got legacy delegated behavior
```

- [ ] **Step 4: Implement Pi-backed `queryStream` and `query`**

Replace the delegated methods in `src/runtime/pi/pi-chat-runtime.ts`:

```ts
import { agentLoop, AgentMessage } from '@earendil-works/pi-agent-core';
import { StreamEvent } from '../../models/interfaces';
import { evaluateGenerationQuality } from '../../services/generation-quality';
import { DefaultChatRuntime } from '../chat-runtime';
import {
  ChatRuntime,
  ChatRuntimeDeps,
  ChatTurnRequest,
  PreparedChatTurn,
} from '../runtime-types';
import {
  createPiFileWriteState,
  formatPiApprovalMessage,
  isPiApprovalResponse,
  recordPiFileWriteResult,
  resolvePiFinalText,
} from './pi-approval-policy';
import { mapPiEventToStreamEvent, unwrapPiToolResult } from './pi-event-adapter';
import { createBaizerStreamFn, createPiBridgeModel } from './pi-provider-bridge';
import { adaptToolDefinitionsToPi } from './pi-tool-adapter';

export class PiChatRuntime implements ChatRuntime {
  private readonly legacy: DefaultChatRuntime;

  constructor(private readonly deps: ChatRuntimeDeps) {
    this.legacy = new DefaultChatRuntime(deps);
  }

  getTools() {
    return this.legacy.getTools();
  }

  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    return this.legacy.prepareTurn(request);
  }

  async query(turn: PreparedChatTurn): Promise<string> {
    let doneText = '';
    for await (const event of this.queryStream(turn)) {
      if (event.type === 'done') doneText = event.text;
    }
    return doneText;
  }

  async *queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const chat = this.deps.provider.startChat(turn.tools);
    const fileWriteState = createPiFileWriteState(turn.requiresFileWrite === true);
    const skillScope = {
      activeSkillName: turn.activeSkillName,
      allowedToolNames: turn.activeSkillName ? new Set(turn.allowedToolNames || []) : null,
    };
    const tools = adaptToolDefinitionsToPi({
      definitions: turn.tools,
      toolRegistry: this.deps.toolRegistry,
      workspaceEditService: this.deps.workspaceEditService || null,
      skillScope,
    });
    const prompt: AgentMessage = {
      role: 'user',
      content: turn.prompt,
      timestamp: Date.now(),
    };
    const context = {
      systemPrompt: '',
      messages: [],
      tools,
    };
    const config = {
      model: createPiBridgeModel(),
      convertToLlm: async (messages: AgentMessage[]) => messages as any,
      toolExecution: 'parallel' as const,
    };
    const stream = agentLoop([prompt], context, config, signal, createBaizerStreamFn(chat));
    let fullResponseText = '';
    let approvalMessage = '';

    for await (const piEvent of stream) {
      const mapped = mapPiEventToStreamEvent(piEvent);
      if (!mapped) continue;

      if (mapped.type === 'text_delta') {
        fullResponseText += mapped.content;
        yield mapped;
      } else if (mapped.type === 'tool_result') {
        recordPiFileWriteResult(fileWriteState, mapped.name, mapped.result);
        yield mapped;
        if (isPiApprovalResponse(mapped.result)) {
          approvalMessage = formatPiApprovalMessage(mapped.result);
          fullResponseText = '';
          break;
        }
      } else {
        yield mapped;
      }
    }

    if (!approvalMessage) {
      fullResponseText = resolvePiFinalText(fileWriteState, fullResponseText);
      fullResponseText = this.applyGenerationQuality(turn, fullResponseText);
    }

    await this.retainCompletedTurn(turn, approvalMessage || fullResponseText);
    yield { type: 'done', text: approvalMessage ? '' : fullResponseText };
  }

  private applyGenerationQuality(turn: PreparedChatTurn, modelText: string): string {
    if (!turn.generationPlan) return modelText;
    const evaluation = evaluateGenerationQuality({
      originalText: turn.selection,
      generatedText: modelText,
      plan: turn.generationPlan,
    });
    if (evaluation.ok) return modelText;
    return `Generation quality check failed:\n- ${evaluation.reasons.join('\n- ')}`;
  }

  private async retainCompletedTurn(turn: PreparedChatTurn, assistantMessage: string): Promise<void> {
    await (this.legacy as any).retainCompletedTurn(turn, assistantMessage);
  }
}
```

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/approval-flow.test.ts
```

Expected:

```text
PASS streams a no-tool response through Pi
PASS executes a tool and returns the follow-up response
PASS stops before a success claim when approval is required
```

- [ ] **Step 6: Run full tests and build**

Run:

```powershell
npm test
npm run build
```

Expected:

```text
Executed 71 test files successfully.
done
```

- [ ] **Step 7: Commit Pi runtime loop**

Run:

```powershell
git add src/runtime/chat-runtime.ts src/runtime/pi/pi-chat-runtime.ts test/pi-chat-runtime.test.ts test/run-tests.ts
git commit -m "feat: run chat turns through pi runtime"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: run chat turns through pi runtime
```

---

## Task 8: Runtime Parity Tests For Factory-Selected Pi

**Files:**
- Modify: `test/pi-chat-runtime.test.ts`
- Modify: `test/model-service.test.ts`
- Modify: `test/chat-runtime.test.ts`

- [ ] **Step 1: Add factory-selected Pi parity tests**

Append to `test/pi-chat-runtime.test.ts`:

```ts
  await test('factory-selected Pi runtime preserves write failure warnings', async () => {
    const {
      createChatRuntime,
    } = await import('../src/runtime/runtime-factory');
    const {
      resetRuntimeEngineForTesting,
      setRuntimeEngineForTesting,
    } = await import('../src/runtime/runtime-engine');

    setRuntimeEngineForTesting('pi');
    const runtime = createChatRuntime({
      provider: {
        startChat: () => ({
          sendMessageStream: async function* (input: any) {
            if (typeof input === 'string') {
              yield { type: 'tool_call', id: 'call_1', name: 'create_file', args: { path: '../bad.md' } };
              yield { type: 'done', text: '' };
              return;
            }
            yield { type: 'text_delta', content: 'Created' };
            yield { type: 'done', text: 'Created' };
          },
        }),
      } as any,
      memoryManager: null,
      toolRegistry: {
        getAllDefinitions: () => [{ name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {} } }],
        get: () => undefined,
        execute: async () => ({ success: false, error: 'Unsafe vault path' }),
      } as any,
      skillRegistry: { resolveByIntent: () => null, getSkillSummaryText: () => '', activateSkill: () => null } as any,
    });

    const prepared = await runtime.prepareTurn({
      userMessage: 'Create a canvas file',
      contextItems: [],
    });
    const text = await runtime.query(prepared);
    expect(text).toContain('No file was created or modified');
    expect(text).toContain('Unsafe vault path');
    resetRuntimeEngineForTesting();
  });
```

- [ ] **Step 2: Ensure tests reset the runtime engine after Pi-specific cases**

At the end of every Pi-specific test that calls `setRuntimeEngineForTesting('pi')`, call:

```ts
resetRuntimeEngineForTesting();
```

- [ ] **Step 3: Run parity tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/model-service.test.ts
npm test
```

Expected:

```text
PASS factory-selected Pi runtime preserves write failure warnings
Executed 71 test files successfully.
```

- [ ] **Step 4: Commit parity tests**

Run:

```powershell
git add test/pi-chat-runtime.test.ts test/model-service.test.ts test/chat-runtime.test.ts
git commit -m "test: cover pi runtime parity through factory"
```

Expected:

```text
[codex/pi-runtime-refactor ...] test: cover pi runtime parity through factory
```

---

## Task 9: Classify Built-In Tool Scheduling

**Files:**
- Modify: `src/skills/builtin/vault-ops.ts`
- Modify: `src/skills/builtin/web-clipper/executor.ts`
- Modify: `src/skills/builtin/web-search/executor.ts`
- Modify: `src/skills/builtin/knowledge/executor.ts`
- Modify: `src/skills/builtin/plugin-ctrl/executor.ts`
- Modify: `test/pi-tool-adapter.test.ts`

- [ ] **Step 1: Add assertions for explicit scheduling metadata**

Add to `test/pi-tool-adapter.test.ts`:

```ts
  await test('treats metadata risk write as sequential', () => {
    expect(inferToolExecutionMode('custom_writer', { risk: 'write' } as any)).toBe('sequential');
  });

  await test('treats metadata risk read as parallel when execution mode is explicit', () => {
    expect(inferToolExecutionMode('custom_reader', { risk: 'read', executionMode: 'parallel' } as any)).toBe('parallel');
  });
```

- [ ] **Step 2: Run the test**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-tool-adapter.test.ts
```

Expected:

```text
PASS treats metadata risk write as sequential
PASS treats metadata risk read as parallel when execution mode is explicit
```

- [ ] **Step 3: Mark built-in tools with scheduling metadata**

For each registered read-only tool in `src/skills/builtin/vault-ops.ts`, add:

```ts
executionMode: 'parallel',
risk: 'read',
```

For each registered write tool in `src/skills/builtin/vault-ops.ts`, add:

```ts
executionMode: 'sequential',
risk: 'write',
```

For `src/skills/builtin/web-search/executor.ts` registered tools, add:

```ts
executionMode: 'parallel',
risk: 'network',
```

For `src/skills/builtin/web-clipper/executor.ts` tools that write to the vault, add:

```ts
executionMode: 'sequential',
risk: 'write',
```

For `src/skills/builtin/knowledge/executor.ts` query-only tools, add:

```ts
executionMode: 'parallel',
risk: 'read',
```

For `src/skills/builtin/plugin-ctrl/executor.ts` plugin execution/control tools, add:

```ts
executionMode: 'sequential',
risk: 'plugin-control',
```

- [ ] **Step 4: Run focused tool tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-tool-adapter.test.ts
npx tsx --tsconfig tsconfig.test.json test/file-tools.test.ts
npx tsx --tsconfig tsconfig.test.json test/plugin-tools.test.ts
npx tsx --tsconfig tsconfig.test.json test/web-search.test.ts
npx tsx --tsconfig tsconfig.test.json test/web-clipper.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 5: Run full tests and build**

Run:

```powershell
npm test
npm run build
```

Expected:

```text
Executed 71 test files successfully.
done
```

- [ ] **Step 6: Commit scheduling metadata**

Run:

```powershell
git add src/skills/builtin/vault-ops.ts src/skills/builtin/web-clipper/executor.ts src/skills/builtin/web-search/executor.ts src/skills/builtin/knowledge/executor.ts src/skills/builtin/plugin-ctrl/executor.ts test/pi-tool-adapter.test.ts
git commit -m "feat: classify built-in tool scheduling"
```

Expected:

```text
[codex/pi-runtime-refactor ...] feat: classify built-in tool scheduling
```

---

## Task 10: Final Verification And Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-05-24-pi-runtime-refactor-design.md`
- Modify: `README.md` only if the runtime flag becomes user-visible in this branch

- [ ] **Step 1: Confirm legacy remains the default**

Run:

```powershell
npx tsx --tsconfig tsconfig.test.json test/pi-runtime-factory.test.ts
```

Expected:

```text
PASS defaults to the legacy runtime
PASS can create the Pi runtime through the internal engine flag
```

- [ ] **Step 2: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected:

```text
Executed 71 test files successfully.
done
```

- [ ] **Step 3: Inspect bundle impact**

Run:

```powershell
Get-Item dist\\main.js | Select-Object Length
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai
```

Expected:

```text
@earendil-works/pi-agent-core@0.75.5
@earendil-works/pi-ai@0.75.5
```

Record the `dist/main.js` byte length in the final implementation summary.

- [ ] **Step 4: Update the design spec with spike outcome**

Append this section to `docs/superpowers/specs/2026-05-24-pi-runtime-refactor-design.md`:

```md
## Compatibility Spike Result

- `npm run build`: passed
- `npm test`: passed
- Pi package version: `@earendil-works/pi-agent-core@0.75.5`
- Runtime default: `legacy`
- Pi runtime access: internal engine selector only
```

Add one more bullet named `Bundle size after integration` and set it to the exact byte length printed by `Get-Item dist\main.js | Select-Object Length`.

- [ ] **Step 5: Run documentation diff check**

Run:

```powershell
git diff -- docs\\superpowers\\specs\\2026-05-24-pi-runtime-refactor-design.md
```

Expected:

```text
## Compatibility Spike Result
```

- [ ] **Step 6: Commit final documentation**

Run:

```powershell
git add docs\\superpowers\\specs\\2026-05-24-pi-runtime-refactor-design.md
git commit -m "docs: record pi runtime compatibility result"
```

Expected:

```text
[codex/pi-runtime-refactor ...] docs: record pi runtime compatibility result
```

---

## Self-Review Checklist

- Spec coverage: Tasks 1-10 cover dependency spike, runtime selection, adapter files, provider bridge, tool scheduling, approval policy, event mapping, tests, build, and final documentation.
- Rollback path: Task 2 keeps `legacy` as default and adds a test-only Pi selector.
- Provider boundary: Task 5 delegates to existing Baizer `IChatSession`; no task replaces providers with Pi provider SDKs.
- Approval safety: Tasks 4, 6, 7, and 8 preserve `approval_required`, workspace edit routing, write-failure warnings, and no-success-claim behavior.
- Test coverage: New tests cover factory selection, event mapping, tool scheduling, provider bridging, approval policy, and Pi runtime behavior.
- Verification: Task 10 requires `npm test`, `npm run build`, and bundle size recording.
