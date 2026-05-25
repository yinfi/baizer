# 流式输出 + Think 时间线设计

## 概述

将 Baizer 的 AI 响应从一次性返回改为流式输出，同时将 thinking token 和 function call 步骤以可折叠的时间线形式展示。

## 需求

1. **流式文本输出** — AI 回复文本逐字流式显示，而非等待完整响应
2. **Think 时间线** — thinking/reasoning token 和 function call 执行步骤按时间线展示
3. **折叠交互** — 时间线节点默认折叠（一行摘要），可点击展开查看详情
4. **双 Provider 支持** — Gemini 和 OpenAI 兼容层都实现流式
5. **布局** — think 时间线在上，回复文本在下，同时更新

## 架构设计

### 1. 流式事件类型系统

在 `src/models/interfaces.ts` 新增 `StreamEvent` 联合类型：

```typescript
type StreamEvent =
  | { type: 'thinking'; content: string }          // thinking/reasoning 增量
  | { type: 'text_delta'; content: string }         // 正文文本增量
  | { type: 'tool_call'; name: string; args: any }  // 发起工具调用
  | { type: 'tool_result'; name: string; result: any; error?: string }
  | { type: 'done'; text: string }                  // 完成，附完整文本
  | { type: 'error'; message: string }
```

`IChatSession` 新增方法：

```typescript
sendMessageStream(text: string | ToolResult[]): AsyncGenerator<StreamEvent>;
```

原有 `sendMessage()` 保留，作为非流式 fallback（`/edit`、`/save` 等场景）。

### 2. Provider 层流式实现

#### Gemini Provider

- 使用 `@google/generative-ai` SDK 的 `sendMessageStream()` API
- 逐 chunk 解析 `candidates[0].content.parts`：
  - `thought: true` 的 part → `thinking` 事件
  - 普通 text part → `text_delta` 事件
  - function call 在流结束时从 `response.functionCalls()` 提取 → `tool_call` 事件

#### OpenAI Provider

- 使用原生 `fetch` + `ReadableStream` 解析 SSE（`requestUrl` 不支持流式）
- 请求体加 `stream: true`
- SSE 解析映射：
  - `delta.content` → `text_delta`
  - `delta.tool_calls` → `tool_call`
  - `delta.reasoning_content`（DeepSeek/o1 等）→ `thinking`
- tool_call 增量拼接：OpenAI SSE 中 `delta.tool_calls` 是分片的（name 和 arguments 分多个 chunk 到达），需在 session 内维护 `pendingToolCalls` Map，按 `index` 拼接完整后再 yield `tool_call` 事件
- 移动端 fallback：若流式 fetch 失败，退回 `sendMessage()` 非流式模式

### 3. ModelService 流式编排

新增 `chatStream()` 方法，返回 `AsyncGenerator<StreamEvent>`：

```
chatStream() 流程：
1. 构建 prompt（同现有 chat()）
2. 调用 session.sendMessageStream(prompt)
3. 消费 provider 事件流：
   - thinking / text_delta → 直接 yield 透传给 UI
   - 收到 function calls → yield tool_call 事件
4. 执行工具 → yield tool_result 事件
5. 有 function calls 时，用 tool results 再次调用 sendMessageStream()
6. 重复 3-5，最多 MAX_LOOPS(10) 轮
7. yield done 事件（附完整文本）
8. 记录到 MemoryManager
```

原有 `chat()` 保留，`/edit`、`/save`、file-back 继续用非流式。

### 4. ChatController 改动

- `processCommand()` 主对话路径改为调用 `this.api.chatStream()`
- 用 `for await (const event of stream)` 消费事件
- 每个事件通过新回调 `onStreamEvent` 推送给 ShellView
- `addMessage()` 在 `done` 事件时执行，把完整消息加入历史

```typescript
// ChatControllerOptions 新增
onStreamEvent?: (event: StreamEvent) => void;
```

### 5. ShellView 时间线 UI

#### 布局结构

```
┌─ shell-entry ai ──────────────────────┐
│ ┌─ shell-think-timeline ────────────┐ │  ← think 时间线（默认折叠）
│ │  ● 思考中...                      │ │
│ │  │ 分析用户需求...                │ │
│ │  ● 🔍 search_vault               │ │
│ │  │ 搜索: "项目架构"              │ │
│ │  ● 📖 read_note                  │ │
│ │  │ 读取: design.md               │ │
│ └───────────────────────────────────┘ │
│ ┌─ shell-response-content ──────────┐ │  ← 回复文本（流式追加）
│ │  根据你的项目架构，我建议...       │ │
│ │  █ (光标闪烁)                     │ │
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

#### 时间线节点类型

- **thinking 节点** — 左侧竖线 + 圆点，摘要取前 30 字符 + "..."，展开显示完整 thinking 文本
- **tool_call 节点** — 带工具图标，显示工具名，展开显示参数 JSON
- **tool_result 节点** — 附在对应 tool_call 下方，展开显示返回结果

#### 折叠行为

- 默认所有节点折叠，只显示一行摘要
- 点击节点展开/收起详细内容
- 整个 think 时间线有总开关，可一键折叠/展开全部
- `done` 事件后，时间线自动折叠为一行摘要（如"思考了 3 步"），回复区域完成渲染并添加反馈按钮

#### Markdown 增量渲染策略

- 维护 `accumulatedText` 字符串，每收到 `text_delta` 追加
- 100ms debounce 触发 `MarkdownRenderer.render()`
- 渲染时替换整个回复区域内容（MarkdownRenderer 不支持增量，但 debounce 保证流畅）

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/models/interfaces.ts` | 新增 `StreamEvent` 类型、`sendMessageStream` 方法 |
| `src/models/gemini.ts` | `GeminiChatSession` 实现 `sendMessageStream` |
| `src/models/openai.ts` | `OpenAIChatSession` 实现 `sendMessageStream`，引入 `fetch` + SSE 解析 |
| `src/services/model-service.ts` | 新增 `chatStream()` 方法 |
| `src/ui/chat-controller.ts` | `processCommand` 改用 `chatStream`，新增 `onStreamEvent` 回调 |
| `src/ui/shell-view.ts` | 新增时间线 UI 组件、流式渲染逻辑、折叠交互 |
| CSS（styles.css 或内联） | 时间线样式：竖线、节点、折叠动画 |

## 非目标

- 不改动 `/edit`、`/save`、file-back 等非主对话路径
- 不改动 Guardian Mode（ghost text）
- 不改动 Memory 系统的存储格式
- 不做消息历史的流式回放
