# API 文档 — Baizer（obsidian-cli）

## 0. 结论先行

Baizer **不暴露任何 HTTP / GraphQL / gRPC / WebSocket 服务端接口**——它是运行在 Obsidian 渲染进程内的客户端插件，没有自己的网络服务。

它的"API 面"由六类**进程内契约**构成：

| # | 契约 | 方向 | 稳定度 |
|---|---|---|---|
| 1 | LLM 供应方契约（`ProviderConfig` → pi `Model`） | 出站到 LLM 服务商 | 对外（用户可配） |
| 2 | 工具契约（25 个原子工具） | 模型 → 插件 | 对外（模型可见） |
| 3 | 斜杠命令契约 | 用户 → 插件 | 对外（用户可见） |
| 4 | `StreamEvent` 事件契约 | 运行时 → UI | 内部 |
| 5 | 门面 API（`ModelService` 公开方法） | UI → 运行时 | 内部 |
| 6 | 存储契约（vault 内文件路径与格式） | 插件 → 磁盘 | 内部（但用户可见） |

唯一的真正外部协议是 Obsidian 的 `obsidian://` 自定义协议处理器。

---

## 1. LLM 供应方契约

### 1.1 `ProviderConfig`（`src/mcp/types.ts:41-49`）

```ts
interface ProviderConfig {
  type: 'gemini' | 'openai-compatible';
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiFlavor?: 'completions' | 'responses';  // 仅 openai-compatible 有意义，缺省 'completions'
}
```

内置 provider（`DEFAULT_PROVIDERS`，不可删除）：

| key | type | baseUrl | 默认模型 |
|---|---|---|---|
| `gemini` | `gemini` | `https://generativelanguage.googleapis.com` | `gemini-2.5-flash` |
| `openai` | `openai-compatible` | `https://api.openai.com/v1` | `gpt-4o` |
| `deepseek` | `openai-compatible` | `https://api.deepseek.com` | `deepseek-chat` |
| `qwen` | `openai-compatible` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo` |

用户可新增任意 provider；`deletedProviderIds` 记录被删的内置 key，`mergeProviderDefaults()` 在加载时按此恢复/剔除。

### 1.2 映射为 pi-ai `Model`（`src/runtime/pi/pi-native-model.ts`）

| 导出函数 | 输入 | 输出 `Model.api` | 备注 |
|---|---|---|---|
| `buildGeminiModel(config, contextWindow?, thinkingLevel?)` | `type: 'gemini'` | `google-generative-ai` | `baseUrl` 固定为 Gemini 官方端点；`reasoning = thinkingLevel !== 'off'`；`maxTokens: 8192` |
| `buildOpenAICompatModel(config, contextWindow?, thinkingLevel?)` | `type: 'openai-compatible'` | `openai-responses`（`apiFlavor: 'responses'`）或 `openai-completions`（缺省） | `maxTokens: 16384`；带 `thinkingLevelMap` |
| `createNativeCompleteFn(model, apiKey)` | pi `Model` + key | `NativeCompleteFn` | 无状态单次生成，底层 `completeSimple` |
| `isOpenCodeGoBaseUrl(baseUrl)` | URL 串 | `boolean` | 匹配 `opencode.ai` 主机 + `/zen/go` 路径前缀 |
| `buildOpenCodeGoHeaders(baseUrl, sessionId)` | URL + 会话 id | `Record<string,string>` 或 `undefined` | 返回 `x-opencode-session` 头 |

**思考档位映射**（`OPENAI_COMPAT_THINKING_LEVEL_MAP`）：

| 项目档位 | OpenAI `reasoning_effort` |
|---|---|
| `off` | `null`（不发送该字段） |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

上下文窗口缺省回落 `DEFAULT_CONTEXT_WINDOW = 100000`（与 `DEFAULT_SETTINGS.contextWindow` 对齐）。

### 1.3 无状态生成契约

```ts
type NativeCompleteFn = (
  prompt: string,
  systemPrompt?: string,
  options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
) => Promise<string>;
```

- `prompt` 被包成**单条 user 消息**；`systemPrompt` 放进 pi `Context.systemPrompt`
- 返回值从 `AssistantMessage.content` 中**只抽 `text` 块**拼接（忽略 thinking 与 tool_call 块）
- `signal` 直接透传给 pi 做**原生硬中断**（取代旧 `raceWithAbort` 软取消）
- `timeoutMs` 已废弃（`GenerationOptions.timeoutMs` 标 `@deprecated`，不再消费）

---

## 2. 工具契约（模型可见的 25 个原子工具）

### 2.1 工具定义形状（`src/skills/types.ts:52-63`）

```ts
interface Tool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, ParameterDef>; required?: string[] };
  executionMode?: 'parallel' | 'sequential';
  timeoutMs?: number;
  risk?: 'read' | 'write' | 'plugin-control' | 'network' | 'unknown';
  execute(args: any, ctx: ToolContext): Promise<any>;
}
```

`ToolContext = { app: App; settings: PluginSettings; signal?: AbortSignal }`。`signal` 由运行时透传，网络类工具应接入 `fetch` 以支持真正的中断/超时取消。

### 2.2 工具清单

| 工具 | 风险 | 执行模式 | 必填参数 | 权限门 |
|---|---|---|---|---|
| `read_note` | read | parallel | `path` | 无（内容截断 5000 字符） |
| `create_note` | write | sequential | `filename`, `content` | 写入范围 + `allowFileCreation` + `confirmExecutions` |
| `update_note` | write | sequential | `path`, `content` | 写入范围 + `allowFileModification` + 审批 |
| `append_to_note` | write | sequential | `path`, `content` | 同上 |
| `delete_note` | write | sequential | `path` | 同上（高风险载荷，不可撤销） |
| `rename_note` | write | sequential | `path` / 新名 | 同上（不可撤销） |
| `list_notes` | read | parallel | `folder?` | 无 |
| `search_vault` | read | parallel | `query` | 无 |
| `open_file` | unknown | — | `path` | 无（打开编辑器视图） |
| `read_file` | read | parallel | `path` | 无 |
| `create_file` | write | sequential | `filename`, `content` | 同 `create_note` |
| `update_file` | write | sequential | `path`, `content` | 同 `update_note` |
| `read_skill` | read | parallel | `name` | 无（渐进式披露入口，**始终注册、始终可用**） |
| `query_knowledge` | read | parallel | `query` | 无 |
| `file_back_knowledge` | write | sequential | 内容与来源 | 写入范围 |
| `list_plugins` | plugin-control | — | 无 | `allowPluginControl` |
| `get_plugin_commands` | plugin-control | — | `pluginId` | `allowPluginControl` |
| `get_plugin_settings` | plugin-control | — | `pluginId` | `allowPluginControl`（值受 `allowPluginConfigValues` 二次约束，敏感字段恒脱敏） |
| `execute_plugin_command` | plugin-control | — | `pluginId`, `commandId` | `allowPluginControl` + 审批 |
| `validate_json_canvas` | read | — | JSON 内容 | 无 |
| `validate_base_yaml` | read | — | YAML 内容 | 无 |
| `save_webpage` | write | — | `url` | 写入范围 |
| `web_search` | network | — | `query`, `time_range?` | 无（`confirmExecutions` 下 network 免批） |

### 2.3 工具返回值约定

工具返回 `any`，但有几条被运行时识别的约定形状：

| 形状 | 含义 | 消费方 |
|---|---|---|
| `{ success: false, error: string }` | 失败 | 文件写入契约 |
| `{ status: 'success', message: string }` | 成功 | 文件写入契约 |
| `{ approval_required: true, action?, target?, message? }` | 需用户批准 | `pi-approval-policy.isPiApprovalResponse`；`pi-tool-adapter` 据此置 `terminate` |
| `{ error: string }` | 通用错误 | `pi-event-adapter.getToolErrorMessage` |
| `{ path, content }` | 读取结果 | 模型消费 |

### 2.4 权限决策契约（`src/permissions/permission-service.ts`，全部为纯函数）

```ts
checkWriteScope(target: string, settings, activeNote?: string | null): string | null
checkFileCapability(operation: 'create' | 'modify', settings): string | null
checkPluginControl(settings): string | null
needsApproval(risk: ToolRisk, settings): boolean
canWriteToVaultTarget(input: VaultWriteTargetCheck): boolean   // 更底层的纯判定
```

**策略来源唯一**：配置页 ⚡ Permissions 的 6 个设置（`vaultWriteScope` / `vaultWriteAllowedFolders` / `allowFileCreation` / `allowFileModification` / `allowPluginControl` / `confirmExecutions`）。本层不含任何硬编码策略常量。

写入范围语义：`read-only` 恒拒；`current-note` 仅当前活动笔记；`configured-folders` 按路径前缀匹配（反斜杠归一为正斜杠）；`all-vault` 放行。

审批语义：`confirmExecutions` 关 = 全自动；只读/网络类免批；`write` / `plugin-control` 在开启时需批。

---

## 3. 斜杠命令契约

### 3.1 本地命令（`src/runtime/base-chat-runtime.ts:20-32`）

| 命令 | 说明 |
|---|---|
| `/clear` | 清空会话历史（并为该会话开一个新的持久会话文件） |
| `/memory [overview\|observations\|search <query>\|forget <field>]` | 查看/搜索/遗忘 Hindsight 记忆（`/profile`、`/forget` 为兼容别名） |
| `/file-back <message-id>` | 把某条 AI 回答归档进知识 Wiki |
| `/new <title>` | 新建笔记 |
| `/edit <instruction>` | AI 编辑选中文本 |
| `/open <file>` | 按名打开文件 |
| `/tools` | 列出可用工具 |
| `/wiki:compile [path]` | 编译笔记进知识 Wiki |
| `/wiki:index` | 打开知识 Wiki 索引 |
| `/wiki:lint` | 知识 Wiki 健康检查 |
| `/help` | 显示命令列表 |

### 3.2 技能命令（来自各 SKILL.md 的 `triggers.commands`）

| 命令 | 所属技能 |
|---|---|
| `/save` | `web-clipper` |
| `/wiki:query` | `knowledge` |

### 3.3 用户自定义命令

来源：`.obsidian/baizer-commands/*.md`，经 pi 的 `loadPromptTemplates` / `parseCommandArgs` / `substituteArgs` 解析。`PromptTemplateService.resolve(command, argsString)` 把模板展开成 prompt 后当普通对话轮发送。

### 3.4 契约注入方式

`buildSlashCommandContract()` 把上述三类命令合并、按命令名去重后，以 `[Slash Command Contract]` 块注入 systemPrompt，并附硬约束：

> Only these slash commands exist in this shell: ... Do not mention or recommend slash commands that are not listed here. Do not invent generic commands like `/do` or `/ask`. If no listed command fits, suggest a plain-language request instead.

---

## 4. `StreamEvent` 事件契约（`src/models/interfaces.ts:65-84`）

运行时产出、UI 消费的唯一事件类型：

```ts
type StreamEvent =
  | { type: 'thinking';    content: string }
  | { type: 'text_delta';  content: string }
  | { type: 'tool_call';   name: string; args: any; id?: string }
  | { type: 'tool_result'; name: string; result: any; error?: string }
  | { type: 'step_boundary' }
  | { type: 'done';  text: string; interrupted?: boolean;
      entryIds?: { userEntryId?: string; assistantEntryId?: string } }
  | { type: 'error'; message: string };
```

### 4.1 pi 事件 → `StreamEvent` 映射表（`src/runtime/pi/pi-event-adapter.ts:17-57`）

| pi 事件 | `StreamEvent` |
|---|---|
| `turn_start` | `step_boundary` |
| `message_update` + `assistantMessageEvent.type === 'text_delta'` | `text_delta` |
| `message_update` + `assistantMessageEvent.type === 'thinking_delta'` | `thinking` |
| `tool_execution_start` | `tool_call`（`id` 取 `toolCallId`，`name` 取 `toolName`） |
| `tool_execution_end` | `tool_result`（`isError` 时附 `error`） |
| `message_end` + `stopReason === 'error'` | 不进事件流；在 `HarnessChatRuntime` 内累计为运行错误，最终转为 `error` 事件 |
| 其它 pi 事件 | 丢弃（返回 `undefined`） |

`done` 事件由 `HarnessChatRuntime` 自己产出（不在映射表内），`entryIds` 只在"持久会话 + 正常完成"路径出现。

### 4.2 结果解包

`unwrapPiToolResult(result)` 按优先级解包：`result.details.baizerResponse` → `JSON.parse(result.content[0].text)` → 原文。

---

## 5. 门面 API（`src/services/model-service.ts`）

### 5.1 构造与生命周期

| 方法 | 说明 |
|---|---|
| `constructor(app, settings, toolRegistry, skillRegistry)` | 装配审计日志、工作区编辑服务、provider、错误处理、会话管理器；异步预热用户命令缓存 |
| `updateSettings(settings)` | 落盘前先 flush 记忆；重建 provider；清模型缓存 |
| `switchProvider(id, saveFn?)` / `switchModel(id, saveFn?)` | 切换后 flush + cleanup + 重建 |
| `shutdown()` | 移除全局错误监听、flush 记忆 |
| `onProviderChanged(cb)` | 返回取消订阅函数 |

### 5.2 LLM 入口

| 方法 | 路径 | 说明 |
|---|---|---|
| `chat(userMessage, contextItems, selection?, source?, obsidianContext?, userProfile?, systemPromptOverride?, conversationId?)` | 会话型 | 非流式；内部消费 `queryStream` 直到 `done` |
| `chatStream(...)` | 会话型 | 流式，产出 `AsyncGenerator<StreamEvent>`；支持 `AbortSignal` |
| `generate(prompt, systemPrompt?, source?, obsidianContext?, userProfile?, options?)` | 无状态 | 单次生成；`options.skipGenerationPlan` 跳过写作策略装饰 |
| `getAvailableTools()` | — | 经新建 runtime 取 `getTools()` |
| `isGenerationConfigured()` | — | 当前 provider 是否有非空 apiKey |

### 5.3 会话与分支

| 方法 | 说明 |
|---|---|
| `clearSession(conversationId?)` | 清记忆会话 + 为该会话开新持久会话文件 |
| `releaseSession(conversationId)` | 仅释放内存态（关 tab 时） |
| `purgeSession(conversationId)` | 删磁盘 JSONL + 清 ref（删除历史对话时） |
| `getBranchProjection(conversationId?)` | 取当前活跃分支的 `ChatMessage[]` 投影 |
| `switchBranch(conversationId, targetLeafEntryId)` | 切兄弟分支（移动 leaf + 重投影，不生成） |
| `prepareRetryFromUser(conversationId, userEntryId, { supersede? })` | 定位到该 user 消息之前（`supersede: true` 为"重试=换掉旧答案"语义） |

### 5.4 运行中控制

| 方法 | 说明 |
|---|---|
| `steerActiveRun(text)` | 转发给活跃 harness 的原生 `steer()`；返回 `false` 表示模型不会看到（无活跃 run 或空文本） |
| `setActiveTools(toolNames)` | 转发 `setActiveTools()`，自动补回 `read_skill` |
| `hasPendingSteering()` | 当前是否有可补话的活跃 run |

### 5.5 记忆、知识、审批、工具执行

| 方法 | 说明 |
|---|---|
| `getMemoryView(request?)` / `forgetMemory(field)` / `deleteMemoryById(id)` | 记忆查看与变更 |
| `recallGuardianMemory(query, maxChars=500)` | Guardian 深补的个人记忆召回 |
| `retainLesson(input)` | 点踩时把"应避免"教训写入记忆 |
| `executeApprovedAction(action, args, conversationId?)` | 带 `approved: true` 直执工具 + 记审计 + 把结果回灌 session |
| `executeWorkspaceTool` / `undoWorkspaceEdit` / `undoAllWorkspaceEdits` / `listWorkspaceEdits` | 工作区编辑与撤销 |
| `recordDirectWrite(input)` | 记录一次直接写入审计 |
| `getSkillList()` / `getSkillCommands()` / `executeSlashSkillCommand(...)` | 技能列表与斜杠执行 |
| `getUserCommands()` / `getUserCommandsSync()` / `reloadUserCommands()` / `executeUserCommand(...)` | 用户自定义命令 |
| `getProviderCapabilities()` / `checkAvailability()` / `getAvailableModels(force?)` / `getAllProviderModels(force?)` | provider 元数据与模型列表（10 分钟 TTL 缓存 + fallback） |

---

## 6. 存储契约（vault 内路径）

| 路径 | 内容 | 写入方 |
|---|---|---|
| `.obsidian/baizer-memory/`（`MEMORY_DIR`） | Hindsight 记忆库 JSON | `HindsightStore` |
| `.obsidian/baizer-sessions/`（`DEFAULT_SESSIONS_ROOT`） | 每会话一个 JSONL 会话文件（pi `JsonlSessionRepo`） | `HarnessSessionManager` |
| `.obsidian/baizer/`（`PLUGIN_DATA_DIR`） | 插件 data.json（设置 + `sessionRefs`） | Obsidian `loadData` / `saveData` |
| `.obsidian/baizer/operations.json` | 操作审计日志 | `OperationAuditLog` |
| `.obsidian/baizer/conversations.json` | 历史对话索引 | `ConversationStore` |
| `.obsidian/baizer/skills/<name>/SKILL.md` | 内置技能物化副本（**是缓存，每次启动覆写**）+ `.builtin-source.json` | `SkillRegistry.materializeBuiltins` |
| `.obsidian/baizer/skills/<name>/`（用户技能） | 用户手写技能（**磁盘即原件**） | 用户 |
| `.obsidian/baizer/skills/plugin-<id>/` | 派生技能（缓存，随来源变动重写）+ `generated-from.json` / `.skip-generation.json` | `PluginSkillGenerator` |
| `.obsidian/baizer-commands/*.md` | 用户自定义 slash 命令模板 | 用户 |
| `.obsidian/baizer-tmp/`（`TEMP_ROOT`） | 运行时临时文件 | `HarnessExecutionEnv` |
| `<knowledgeWikiFolder>/Articles/` | 编译产出文章 | `KnowledgeCompiler` |
| `<knowledgeWikiFolder>/Topics/`、`Health/`、`index.md`、`index.base`、`_ontology.md` | 主题、健康报告、索引、本体模式 | `WikiIndexer` / `KnowledgeLinter` / `OntologyService` |
| 源笔记 frontmatter | 每篇笔记的编译状态（`pending`/`processing`/`done`/`failed`）、`sourceId`、内容哈希 | `frontmatter.ts` |

**会话文件与记忆是隐私敏感数据**：`purgeSession` 会真删 JSONL；`privacyMode` 开启时整体跳过旧记忆迁移导入。

---

## 7. Obsidian 协议处理器

`src/services/clip-protocol.ts`：

```
obsidian://baizer-clip?url=<encoded-url>
```

| 导出 | 说明 |
|---|---|
| `parseBaizerClipProtocolParams(params)` | 解析协议参数，返回 `{ url: string \| null }` |
| `class BaizerClipProtocolHandler` | 协议处理器（去重、串行化） |
| `registerBaizerClipProtocolHandler(registrar, options)` | 向 Obsidian 注册 |

用于从浏览器/系统分享菜单把 URL 直接送进剪藏管线。

---

## 8. 设置契约（`src/mcp/types.ts:91-205`）

`PluginSettings` 共 8 个分组：

| 分组 | 关键字段 |
|---|---|
| 🤖 Core Connection | `activeProvider`、`providers`、`deletedProviderIds`、`contextWindow` |
| 💾 Session Persistence | `sessionRefs`（per-conversation）、`sessionRef`（`@deprecated`，仅迁移用） |
| 🛡️ Guardian | `enableSelectionMenu`、`enableGuardian`、`guardianAutoMode`、`guardianSensitivity`、`guardianUIStyle`、`guardianAutoDeepEscalation`、`ignoredFolders`、`privacyMode`、`memoryQueryExpansion`、`memoryGraphRecall`、`memoryConflictUpdate` |
| ⚡ Permissions | `vaultWriteScope`、`vaultWriteAllowedFolders`、`allowFileCreation`、`allowFileModification`、`allowPluginControl`、`allowPluginConfigValues`、`confirmExecutions` |
| 🧩 Skills | `disabledSkills`（空 = 全部可用；可用性的**唯一来源**） |
| 🖥️ Terminal Appearance | `terminalTheme`、`terminalFont`、`terminalFontSize`、`terminalOpacity` |
| 🌐 Language | `language: 'auto' \| 'en' \| 'zh'` |
| 🧠 System Prompt | `customizePrompt`、`systemPrompt` |
| 📨 WeChat Inbox | `wechatInboxPath`、`wechatStoragePath` |
| 📚 Knowledge Compiler | `knowledgeSourceFolders`、`knowledgeAutoCompile`、`knowledgeWikiFolder`、`knowledgeMaxCompileBatch`、`knowledgeOntology*`（5 项） |
| 🧠 Thinking Level | `thinkingLevel: 'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` |
| 🔌 Plugin Skill Generator | `autoGeneratePluginSkills`、`pluginSkillExcludeList` |

---

## 9. CodeMirror 6 扩展契约

| 导出 | 类型 | 说明 |
|---|---|---|
| `ghostTextExtension()` | `Extension` | Ghost Text 装饰字段 + 键映射（Tab 接受、Esc 丢弃） |
| `showGhostText` / `storeGhostText` / `showThinkingGhostText` / `showDiagnosticGhostText` / `hideGhostText` | 函数 | 视图侧命令式入口 |
| `disposeGhostLiveRegion()` | 函数 | 释放 aria-live 区域 |
| `guardianGutterExtension()` | `Extension` | 行内状态点 gutter |
| `setGuardianMode` / `setGuardianLineState` | `StateEffect` | 模式与逐行状态变更 |
| `guardianModeField` | `StateField<boolean>` | 全局启用态 |
| `updateGuardianState(view, line, state)` | 函数 | 更新某行状态 |
| `selectionMenuExtension(pluginContext)` | `Extension` | 选区悬浮菜单（含 `@` 触发） |
| `setSelectionMenuState` | `StateEffect` | 菜单状态变更 |
| `findAtTrigger(text, cursor)` | 函数 | 定位 `@` 触发点 |

---

## 10. 内部关键接口（跨模块契约）

```ts
// 运行时（src/runtime/runtime-types.ts）
interface ChatRuntime {
  getTools(): ToolDefinition[];
  prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn>;
  query(turn: PreparedChatTurn): Promise<string>;
  queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}

// 可 steering 的最小 harness 契约（src/runtime/active-run-controller.ts）
interface SteerableHarness {
  steer(text: string, options?: { images?: unknown[] }): Promise<void>;
  setActiveTools(toolNames: string[]): Promise<void>;
}

// 可压缩的最小 harness 契约（src/runtime/pi/harness-session-manager.ts）
interface CompactableHarness { compact(customInstructions?: string): Promise<unknown>; }

// pi 会话契约（本项目手写的结构镜像，src/runtime/pi/harness-session-manager.ts:20-43）
interface PiSession {
  getMetadata(): Promise<{ id: string; path: string }>;
  getBranch(fromId?: string): Promise<PiSessionTreeEntry[]>;
  getEntries(): Promise<PiSessionTreeEntry[]>;
  getEntry(id: string): Promise<PiSessionTreeEntry | undefined>;
  getLeafId(): Promise<string | null>;
  moveTo(entryId: string | null): Promise<string | undefined>;
  appendLabel(targetId: string, label: string | undefined): Promise<string>;
  buildContext(): Promise<{ messages: unknown[] }>;
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): Promise<string>;
}

// 技能注册表路由句柄（src/skills/types.ts）
interface ResolvedSkill {
  name: string;
  executionMode: 'direct' | 'instructions';
  execute(args: any, ctx: ToolContext): Promise<any>;
}

// 工作区编辑（src/services/workspace-edit-service.ts）
type WorkspaceEditKind = 'create' | 'update';
interface WorkspaceEditSummary { /* id, kind, path, ... */ }
interface WorkspaceEditResult { /* ... */ }
```

**注意**：`PiSession` / `PiSessionRepo` / `CompactionSettings` 是对上游 pi 会话 API 的**人工结构镜像**（注释说明是为了避免 ESM-only 的 value import）。上游变更不会被 TypeScript 捕获——这是本仓最重要的类型安全缺口。
