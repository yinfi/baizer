# Streaming + Think Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add streaming output and a collapsible think timeline to Obsidian Shell, replacing the current wait-for-complete-response UX.

**Architecture:** New `StreamEvent` union type flows from provider → ModelService → ChatController → ShellView. Each provider implements `sendMessageStream()` as an AsyncGenerator. ModelService orchestrates multi-turn function call loops, yielding events in real-time. ShellView renders a timeline UI above the streaming response text.

**Tech Stack:** TypeScript, Obsidian API, `@google/generative-ai` SDK (Gemini streaming), native `fetch` + SSE parsing (OpenAI streaming), CSS for timeline UI.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/models/interfaces.ts` | Modify | Add `StreamEvent` type, `sendMessageStream` to `IChatSession` |
| `src/models/gemini.ts` | Modify | Implement `sendMessageStream` in `GeminiChatSession` |
| `src/models/openai.ts` | Modify | Implement `sendMessageStream` in `OpenAIChatSession` with SSE parser |
| `src/services/model-service.ts` | Modify | Add `chatStream()` method with function call loop |
| `src/ui/chat-controller.ts` | Modify | Wire `chatStream()`, add `onStreamEvent` callback |
| `src/ui/shell-view.ts` | Modify | Add timeline renderer, streaming text renderer |
| `styles.css` | Modify | Add timeline CSS styles |

---

### Task 1: Add StreamEvent type and sendMessageStream to interfaces

**Files:**
- Modify: `src/models/interfaces.ts`

- [ ] **Step 1: Add StreamEvent type after GenerationResult**

In `src/models/interfaces.ts`, add after line 39 (after `GenerationResult` interface closing brace):

```typescript
export type StreamEvent =
    | { type: 'thinking'; content: string }
    | { type: 'text_delta'; content: string }
    | { type: 'tool_call'; name: string; args: any }
    | { type: 'tool_result'; name: string; result: any; error?: string }
    | { type: 'done'; text: string }
    | { type: 'error'; message: string };
```

- [ ] **Step 2: Add sendMessageStream to IChatSession**

In `IChatSession` interface, add after `sendMessage`:

```typescript
export interface IChatSession {
    sendMessage(text: string | ToolResult[]): Promise<GenerationResult>;
    sendMessageStream(text: string | ToolResult[]): AsyncGenerator<StreamEvent, void, unknown>;
    getHistory(): Promise<ChatMessage[]>;
    clearHistory(): Promise<void>;
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build fails because GeminiChatSession and OpenAIChatSession don't implement `sendMessageStream` yet. This is expected — we'll fix it in Tasks 2 and 3.

- [ ] **Step 4: Commit**

```bash
git add src/models/interfaces.ts
git commit -m "feat: add StreamEvent type and sendMessageStream to IChatSession"
```

---

### Task 2: Implement Gemini streaming

**Files:**
- Modify: `src/models/gemini.ts`

- [ ] **Step 1: Add StreamEvent import**

At the top of `src/models/gemini.ts`, update the import from `./interfaces`:

```typescript
import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage, ModelOption, StreamEvent } from './interfaces';
```

- [ ] **Step 2: Add sendMessageStream to GeminiChatSession**

In `src/models/gemini.ts`, add this method to `GeminiChatSession` class after the existing `sendMessage` method (after line 130):

```typescript
async *sendMessageStream(text: string | ToolResult[]): AsyncGenerator<StreamEvent, void, unknown> {
    let streamResult;
    if (typeof text === 'string') {
        streamResult = await this.chat.sendMessageStream(text);
    } else {
        const toolResponse = text.map(t => ({
            functionResponse: {
                name: t.name,
                response: t.response
            }
        }));
        streamResult = await this.chat.sendMessageStream(toolResponse);
    }

    let fullText = '';

    for await (const chunk of streamResult.stream) {
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        for (const part of candidate.content.parts) {
            if ((part as any).thought === true && (part as any).text) {
                yield { type: 'thinking' as const, content: (part as any).text };
            } else if (part.text) {
                fullText += part.text;
                yield { type: 'text_delta' as const, content: part.text };
            }
        }
    }

    // 流结束后检查 function calls
    const response = await streamResult.response;
    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
        for (const fc of functionCalls) {
            yield { type: 'tool_call' as const, name: fc.name, args: fc.args };
        }
    }

    yield { type: 'done' as const, text: fullText };
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build fails only for OpenAIChatSession (missing `sendMessageStream`). Gemini side should compile.

- [ ] **Step 4: Commit**

```bash
git add src/models/gemini.ts
git commit -m "feat: implement Gemini streaming via sendMessageStream"
```

---

### Task 3: Implement OpenAI streaming with SSE parser

**Files:**
- Modify: `src/models/openai.ts`

- [ ] **Step 1: Add StreamEvent import**

Update the import at top of `src/models/openai.ts`:

```typescript
import { IModelProvider, ModelConfig, IChatSession, GenerationResult, ToolDefinition, ToolResult, ChatMessage, ModelOption, StreamEvent } from './interfaces';
```

- [ ] **Step 2: Add chatCompletionStream method to OpenAIProvider**

Add this method to `OpenAIProvider` class after `chatCompletionRaw` (after line 134):

```typescript
async *chatCompletionStream(messages: any[], tools?: ToolDefinition[]): AsyncGenerator<StreamEvent, void, unknown> {
    const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;

    const body: any = {
        model: this.config.modelName,
        messages,
        temperature: 0.7,
        stream: true
    };

    if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        }));
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`OpenAI API Error: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    const pendingToolCalls = new Map<number, { name: string; arguments: string }>();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.reasoning_content) {
                    yield { type: 'thinking' as const, content: delta.reasoning_content };
                }

                if (delta.content) {
                    fullText += delta.content;
                    yield { type: 'text_delta' as const, content: delta.content };
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!pendingToolCalls.has(idx)) {
                            pendingToolCalls.set(idx, { name: '', arguments: '' });
                        }
                        const pending = pendingToolCalls.get(idx)!;
                        if (tc.function?.name) pending.name += tc.function.name;
                        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
                    }
                }
            } catch {
                // 忽略解析错误的行
            }
        }
    }

    for (const [, tc] of pendingToolCalls) {
        if (tc.name) {
            try {
                const args = tc.arguments ? JSON.parse(tc.arguments) : {};
                yield { type: 'tool_call' as const, name: tc.name, args };
            } catch {
                yield { type: 'tool_call' as const, name: tc.name, args: {} };
            }
        }
    }

    yield { type: 'done' as const, text: fullText };
}
```

- [ ] **Step 3: Add sendMessageStream to OpenAIChatSession**

Add this method to `OpenAIChatSession` class after `sendMessage` (after line 193):

```typescript
async *sendMessageStream(text: string | ToolResult[]): AsyncGenerator<StreamEvent, void, unknown> {
    if (typeof text === 'string') {
        this.history.push({ role: 'user', content: text });
    } else {
        const lastMsg = this.history[this.history.length - 1];
        if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
            text.forEach(t => {
                const call = lastMsg.tool_calls.find((tc: any) => tc.function.name === t.name);
                if (call) {
                    this.history.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        name: t.name,
                        content: JSON.stringify(t.response)
                    });
                }
            });
        }
    }

    let fullText = '';
    const toolCalls: any[] = [];

    for await (const event of this.provider.chatCompletionStream(this.history, this.tools)) {
        if (event.type === 'text_delta') {
            fullText += event.content;
        } else if (event.type === 'tool_call') {
            toolCalls.push({
                id: `call_${Date.now()}_${toolCalls.length}`,
                type: 'function',
                function: { name: event.name, arguments: JSON.stringify(event.args) }
            });
        }
        if (event.type !== 'done') {
            yield event;
        }
    }

    const assistantMsg: any = { role: 'assistant', content: fullText || null };
    if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
    }
    this.history.push(assistantMsg);

    yield { type: 'done' as const, text: fullText };
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS — all providers now implement `sendMessageStream`.

- [ ] **Step 5: Commit**

```bash
git add src/models/openai.ts
git commit -m "feat: implement OpenAI streaming with SSE parser and tool_call assembly"
```

---

### Task 4: Add chatStream to ModelService

**Files:**
- Modify: `src/services/model-service.ts`

- [ ] **Step 1: Add StreamEvent import**

Update the import at top of `src/services/model-service.ts`:

```typescript
import { IModelProvider, ModelOption, ToolDefinition, StreamEvent } from '../models/interfaces';
```

- [ ] **Step 2: Add chatStream method after chat()**

Add after line 367 (after `chat()` method closing brace):

```typescript
async *chatStream(userMessage: string, contextItems: any[], selection: string = ""): AsyncGenerator<StreamEvent, void, unknown> {
    logger.info(`Processing streaming chat: ${userMessage.substring(0, 50)}...`, 'ModelService.chatStream');

    if (!this.hasValidConfig()) {
        const providerLabel = this.getActiveProviderConfig()?.label || 'AI';
        yield { type: 'error' as const, message: `${providerLabel} API Key not configured!` };
        return;
    }

    try {
        // 1. Build prompt (same as chat())
        let memoryContext = '';
        if (this.memoryManager) {
            memoryContext = this.memoryManager.buildContext();
        }

        let fullPrompt = '';
        if (memoryContext) fullPrompt += `${memoryContext}\n\n`;
        fullPrompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;

        let contextStr = '';
        if (contextItems && contextItems.length > 0) {
            contextStr = contextItems.map(item => {
                if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`;
                return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
            }).join('\n\n');
        }
        fullPrompt += `[Context: ${contextStr}]\n`;
        if (selection) fullPrompt += `[Selected Text: ${selection}]\n`;
        fullPrompt += `User Request: ${userMessage}`;

        // 2. Get or Create Session
        const tools = this.buildSkillModeTools();
        const chat = this.memoryManager
            ? this.memoryManager.getOrCreateSession(tools)
            : this.provider.startChat(tools);

        // 3. Stream with function call loop
        let loopCount = 0;
        const MAX_LOOPS = 10;
        let input: string | { name: string; response: any }[] = fullPrompt;
        let fullResponseText = '';

        while (loopCount <= MAX_LOOPS) {
            const pendingCalls: { name: string; args: any }[] = [];

            for await (const event of chat.sendMessageStream(input)) {
                if (event.type === 'tool_call') {
                    pendingCalls.push({ name: event.name, args: event.args });
                    yield event;
                } else if (event.type === 'text_delta') {
                    fullResponseText += event.content;
                    yield event;
                } else if (event.type === 'thinking') {
                    yield event;
                } else if (event.type === 'done') {
                    // don't yield done yet — check for tool calls first
                }
            }

            if (pendingCalls.length === 0) break;

            loopCount++;
            if (loopCount > MAX_LOOPS) {
                logger.warn(`Stream function call loop limit reached (${MAX_LOOPS})`, 'ModelService.chatStream');
                break;
            }

            // Execute tools sequentially (yield requires generator context)
            const toolResults: { name: string; response: any }[] = [];
            for (const call of pendingCalls) {
                try {
                    let toolResult: any;
                    if (call.name === 'use_skill') {
                        toolResult = await this.executeSkill(call.args);
                    } else {
                        toolResult = await this.withTimeout(
                            this.toolRegistry.execute(call.name, call.args),
                            30000,
                            `Tool ${call.name} execution timed out`
                        );
                    }
                    yield { type: 'tool_result' as const, name: call.name, result: toolResult };
                    toolResults.push({ name: call.name, response: toolResult });
                } catch (error: any) {
                    logger.error(`Tool execution failed: ${call.name}`, error, 'ModelService.chatStream');
                    yield { type: 'tool_result' as const, name: call.name, result: null, error: error.message };
                    toolResults.push({ name: call.name, response: { error: error.message || "Unknown error" } });
                }
            }

            input = toolResults;
            fullResponseText = '';
        }

        // 4. Record to memory
        if (this.memoryManager) {
            await this.memoryManager.recordMessage('user', userMessage);
            await this.memoryManager.recordMessage('model', fullResponseText);
        }

        yield { type: 'done' as const, text: fullResponseText };

    } catch (e: any) {
        logger.error('Stream chat failed', e, 'ModelService.chatStream');
        yield { type: 'error' as const, message: e.message };
    }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/model-service.ts
git commit -m "feat: add chatStream method to ModelService with function call loop"
```

---

### Task 5: Wire streaming into ChatController

**Files:**
- Modify: `src/ui/chat-controller.ts`

- [ ] **Step 1: Add StreamEvent import**

At the top of `src/ui/chat-controller.ts`, add:

```typescript
import { StreamEvent } from '../models/interfaces';
```

- [ ] **Step 2: Update ChatControllerOptions**

```typescript
export interface ChatControllerOptions {
    app: App;
    api: ModelService;
    onMessageAdded?: (message: ChatMessage) => void;
    onStatusChanged?: (isResponding: boolean) => void;
    onStreamEvent?: (event: StreamEvent) => void;
}
```

- [ ] **Step 3: Add field and wire in constructor**

Add field after line 26:

```typescript
    private onStreamEvent?: (event: StreamEvent) => void;
```

In constructor, add after `this.onStatusChanged = options.onStatusChanged;`:

```typescript
        this.onStreamEvent = options.onStreamEvent;
```

- [ ] **Step 4: Replace Normal Chat in processCommand**

Replace lines 86-97 (the "Normal Chat" section):

```typescript
        // 2. Normal Chat
        this.addMessage('user', query);
        this.setResponding(true);

        try {
            if (this.onStreamEvent) {
                let fullText = '';
                for await (const event of this.api.chatStream(query, context, selection)) {
                    this.onStreamEvent(event);
                    if (event.type === 'done') {
                        fullText = event.text;
                    } else if (event.type === 'error') {
                        this.addMessage('system', `Error: ${event.message}`);
                        return;
                    }
                }
                this.addMessage('ai', fullText);
            } else {
                const response = await this.api.chat(query, context, selection);
                this.addMessage('ai', response);
            }
        } catch (error: any) {
            this.handleError(error);
        } finally {
            this.setResponding(false);
        }
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/chat-controller.ts
git commit -m "feat: wire chatStream into ChatController with onStreamEvent callback"
```

---

### Task 6: Add timeline CSS styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Append timeline styles to styles.css**

Add at the end of `styles.css`:

```css
/* ==================== Think Timeline ==================== */

.shell-stream-container {
    display: flex;
    flex-direction: column;
    gap: 0;
}

.shell-think-timeline {
    position: relative;
    padding: 8px 0 8px 20px;
    margin-bottom: 8px;
    border-left: 2px solid var(--background-modifier-border);
    font-size: 0.85em;
    color: var(--text-muted);
}

.shell-think-timeline.is-collapsed .think-node {
    display: none;
}

.shell-think-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 2px 0;
    user-select: none;
}

.shell-think-summary:hover {
    color: var(--text-normal);
}

.shell-think-summary .think-toggle {
    transition: transform 0.15s ease;
    font-size: 10px;
}

.shell-think-timeline.is-collapsed .think-toggle {
    transform: rotate(-90deg);
}

.think-node {
    position: relative;
    padding: 4px 0 4px 12px;
    margin: 2px 0;
}

.think-node::before {
    content: '';
    position: absolute;
    left: -21px;
    top: 10px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--background-modifier-border);
}

.think-node.is-thinking::before {
    background: var(--text-accent);
    animation: think-pulse 1.5s ease-in-out infinite;
}

.think-node.is-tool::before {
    background: var(--interactive-accent);
}

@keyframes think-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
}

.think-node-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
}

.think-node-header:hover {
    color: var(--text-normal);
}

.think-node-icon {
    font-size: 12px;
    flex-shrink: 0;
}

.think-node-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.think-node-detail {
    display: none;
    margin-top: 4px;
    padding: 6px 8px;
    background: var(--background-secondary);
    border-radius: 4px;
    font-family: var(--font-monospace);
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
}

.think-node.is-expanded .think-node-detail {
    display: block;
}

.shell-response-content {
    min-height: 1em;
}

.shell-stream-cursor {
    display: inline-block;
    width: 2px;
    height: 1.1em;
    background: var(--text-accent);
    margin-left: 1px;
    vertical-align: text-bottom;
    animation: cursor-blink 0.8s step-end infinite;
}

@keyframes cursor-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: add think timeline and streaming cursor CSS styles"
```

---

### Task 7: Implement streaming UI in ShellView

**Files:**
- Modify: `src/ui/shell-view.ts`

- [ ] **Step 1: Add StreamEvent import**

Update imports at top of `src/ui/shell-view.ts`:

```typescript
import { StreamEvent } from '../models/interfaces';
```

- [ ] **Step 2: Add streaming state fields**

Add after line 35 (after `unsubscribeProvider` field):

```typescript
    // Streaming state
    private streamContainer: HTMLElement | null = null;
    private streamTimeline: HTMLElement | null = null;
    private streamContent: HTMLElement | null = null;
    private streamAccumulatedText: string = '';
    private streamRenderTimer: number | null = null;
    private streamNodeCount: number = 0;
    private currentThinkingNode: HTMLElement | null = null;
```

- [ ] **Step 3: Wire onStreamEvent in onOpen**

Update ChatController init (lines 113-118):

```typescript
        this.chatController = new ChatController({
            app: this.app,
            api: this.modelService,
            onMessageAdded: (msg) => this.appendMessage(msg),
            onStatusChanged: (status) => this.handleStatusChange(status),
            onStreamEvent: (event) => this.handleStreamEvent(event)
        });
```

- [ ] **Step 4: Add handleStreamEvent method**

Add after `handleStatusChange` method:

```typescript
    private handleStreamEvent(event: StreamEvent) {
        this.updateActivity();

        switch (event.type) {
            case 'thinking':
                this.ensureStreamContainer();
                this.handleThinkingEvent(event.content);
                break;
            case 'tool_call':
                this.ensureStreamContainer();
                this.addToolCallNode(event.name, event.args);
                break;
            case 'tool_result':
                this.updateToolResultNode(event.name, event.result, event.error);
                break;
            case 'text_delta':
                this.ensureStreamContainer();
                this.handleTextDelta(event.content);
                break;
            case 'done':
                this.finalizeStream();
                break;
            case 'error':
                this.finalizeStream();
                break;
        }

        this.scrollToEnd();
    }
```

- [ ] **Step 5: Add ensureStreamContainer**

```typescript
    private ensureStreamContainer() {
        if (this.streamContainer) return;

        const loadingDiv = document.getElementById('loading-indicator');
        if (loadingDiv) loadingDiv.remove();

        this.streamContainer = this.outputContainer.createDiv({ cls: 'shell-entry ai shell-stream-container' });
        this.streamTimeline = this.streamContainer.createDiv({ cls: 'shell-think-timeline' });

        const summary = this.streamTimeline.createDiv({ cls: 'shell-think-summary' });
        summary.createSpan({ cls: 'think-toggle', text: '\u25BC' });
        summary.createSpan({ cls: 'think-summary-text', text: '思考中...' });
        summary.addEventListener('click', () => {
            this.streamTimeline?.toggleClass('is-collapsed', !this.streamTimeline.hasClass('is-collapsed'));
        });

        this.streamContent = this.streamContainer.createDiv({ cls: 'shell-response-content' });
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
        this.currentThinkingNode = null;
    }
```

- [ ] **Step 6: Add handleThinkingEvent**

```typescript
    private handleThinkingEvent(content: string) {
        if (!this.streamTimeline) return;

        if (!this.currentThinkingNode) {
            this.currentThinkingNode = this.streamTimeline.createDiv({ cls: 'think-node is-thinking' });
            const header = this.currentThinkingNode.createDiv({ cls: 'think-node-header' });
            header.createSpan({ cls: 'think-node-icon', text: '\uD83D\uDCA1' });
            header.createSpan({ cls: 'think-node-label' });
            this.currentThinkingNode.createDiv({ cls: 'think-node-detail' });
            header.addEventListener('click', () => {
                this.currentThinkingNode?.toggleClass('is-expanded', !this.currentThinkingNode.hasClass('is-expanded'));
            });
            this.streamNodeCount++;
        }

        const detail = this.currentThinkingNode.querySelector('.think-node-detail') as HTMLElement;
        const label = this.currentThinkingNode.querySelector('.think-node-label') as HTMLElement;
        if (detail) detail.textContent = (detail.textContent || '') + content;
        if (label) {
            const fullText = detail?.textContent || '';
            label.textContent = fullText.length > 30 ? fullText.substring(0, 30) + '...' : fullText;
        }
    }
```

- [ ] **Step 7: Add tool call/result handlers**

```typescript
    private addToolCallNode(name: string, args: any) {
        if (!this.streamTimeline) return;

        if (this.currentThinkingNode) {
            this.currentThinkingNode.removeClass('is-thinking');
            this.currentThinkingNode = null;
        }

        const node = this.streamTimeline.createDiv({ cls: 'think-node is-tool' });
        node.dataset.toolName = name;
        const header = node.createDiv({ cls: 'think-node-header' });
        header.createSpan({ cls: 'think-node-icon', text: '\uD83D\uDD27' });
        header.createSpan({ cls: 'think-node-label', text: name });
        const detail = node.createDiv({ cls: 'think-node-detail' });
        detail.textContent = JSON.stringify(args, null, 2);
        header.addEventListener('click', () => {
            node.toggleClass('is-expanded', !node.hasClass('is-expanded'));
        });
        this.streamNodeCount++;
    }

    private updateToolResultNode(name: string, result: any, error?: string) {
        if (!this.streamTimeline) return;

        const nodes = this.streamTimeline.querySelectorAll('.think-node.is-tool');
        let targetNode: HTMLElement | null = null;
        for (let i = nodes.length - 1; i >= 0; i--) {
            if ((nodes[i] as HTMLElement).dataset.toolName === name) {
                targetNode = nodes[i] as HTMLElement;
                break;
            }
        }
        if (!targetNode) return;

        const detail = targetNode.querySelector('.think-node-detail') as HTMLElement;
        if (detail) {
            const resultText = error ? `Error: ${error}` : JSON.stringify(result, null, 2);
            detail.textContent += '\n--- Result ---\n' + resultText;
        }
    }
```

- [ ] **Step 8: Add text delta handler with debounced rendering**

```typescript
    private handleTextDelta(content: string) {
        this.streamAccumulatedText += content;

        if (this.streamRenderTimer !== null) {
            window.clearTimeout(this.streamRenderTimer);
        }
        this.streamRenderTimer = window.setTimeout(() => {
            this.renderStreamContent();
        }, 100);
    }

    private renderStreamContent() {
        if (!this.streamContent) return;

        this.streamContent.empty();
        MarkdownRenderer.render(
            this.app,
            this.streamAccumulatedText,
            this.streamContent,
            '',
            this as any
        ).then(() => {
            const cursor = document.createElement('span');
            cursor.className = 'shell-stream-cursor';
            this.streamContent?.appendChild(cursor);
            this.scrollToEnd();
        });
    }
```

- [ ] **Step 9: Add finalizeStream**

```typescript
    private finalizeStream() {
        if (this.streamRenderTimer !== null) {
            window.clearTimeout(this.streamRenderTimer);
            this.streamRenderTimer = null;
        }

        if (this.currentThinkingNode) {
            this.currentThinkingNode.removeClass('is-thinking');
            this.currentThinkingNode = null;
        }

        if (this.streamContent && this.streamAccumulatedText) {
            this.streamContent.empty();
            MarkdownRenderer.render(
                this.app,
                this.streamAccumulatedText,
                this.streamContent,
                '',
                this as any
            ).then(() => {
                if (this.streamContent) {
                    this.postProcessAiContent(this.streamContent);
                }
                this.scrollToEnd();
            });
        }

        if (this.streamTimeline && this.streamNodeCount > 0) {
            const summaryText = this.streamTimeline.querySelector('.think-summary-text') as HTMLElement;
            if (summaryText) summaryText.textContent = `思考了 ${this.streamNodeCount} 步`;
            this.streamTimeline.addClass('is-collapsed');
        } else if (this.streamTimeline && this.streamNodeCount === 0) {
            this.streamTimeline.style.display = 'none';
        }

        if (this.streamContainer) {
            this.addFeedbackBar(this.streamContainer, this.streamAccumulatedText);
        }

        this.streamContainer = null;
        this.streamTimeline = null;
        this.streamContent = null;
        this.streamAccumulatedText = '';
        this.streamNodeCount = 0;
    }
```

- [ ] **Step 10: Extract postProcessAiContent and addFeedbackBar**

Extract from `appendMessage` into two reusable methods:

```typescript
    private postProcessAiContent(container: HTMLElement) {
        const codeBlocks = container.querySelectorAll('pre > code');
        codeBlocks.forEach((codeBlock) => {
            const pre = codeBlock.parentElement;
            if (pre) {
                const header = pre.createDiv({ cls: 'shell-code-block-header' });
                const langClass = Array.from(codeBlock.classList).find(cls => cls.startsWith('language-'));
                const lang = langClass ? langClass.replace('language-', '') : 'text';
                header.createDiv({ cls: 'shell-code-block-filename', text: `untitled.${lang === 'text' ? 'txt' : lang}` });
                const buttons = header.createDiv({ cls: 'shell-code-block-buttons' });
                const btn = buttons.createEl('button', { cls: 'shell-apply-btn clickable-icon', title: 'Review Changes' });
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="16" x2="12" y2="12"></line><line x1="10" y1="14" x2="10" y2="10"></line></svg>';
                btn.addEventListener('click', async () => {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (!activeFile) { new Notice('No active file to apply changes to.'); return; }
                    const originalContent = await this.app.vault.read(activeFile);
                    const newContent = codeBlock.textContent || '';
                    new DiffModal(this.app, originalContent, newContent, async () => {
                        await this.app.vault.modify(activeFile, newContent);
                        new Notice('Changes applied.');
                    }).open();
                });
                pre.insertBefore(header, codeBlock);
            }
        });

        container.querySelectorAll('a.internal-link').forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
                if (href) this.app.workspace.openLinkText(href, '', false);
            });
        });
    }

    private addFeedbackBar(container: HTMLElement, content: string) {
        const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const feedbackBar = container.createDiv({ cls: 'shell-feedback-bar' });
        const thumbsUpBtn = feedbackBar.createEl('button', { cls: 'shell-feedback-btn shell-thumbs-up', title: 'Useful - save to knowledge wiki' });
        thumbsUpBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>';
        const thumbsDownBtn = feedbackBar.createEl('button', { cls: 'shell-feedback-btn shell-thumbs-down', title: 'Not useful' });
        thumbsDownBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>';
        thumbsUpBtn.addEventListener('click', () => {
            thumbsUpBtn.addClass('active');
            thumbsDownBtn.removeClass('active');
            this.chatController.processCommand(`/file-back ${msgId}`, [], '');
        });
        thumbsDownBtn.addEventListener('click', () => {
            thumbsDownBtn.addClass('active');
            thumbsUpBtn.removeClass('active');
        });
    }
```

Then update `appendMessage` for `msg.role === 'ai'` to call these extracted methods instead of inline code. In the `.then()` callback, replace the code block processing (lines 472-527) with:

```typescript
                this.postProcessAiContent(entry);
```

And replace the feedback bar creation (lines 534-563) with:

```typescript
                this.addFeedbackBar(entry, msg.content);
```

- [ ] **Step 11: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 12: Manual test**

1. Open Obsidian, open Gemini Shell
2. Send a message — verify text streams in real-time
3. Send a complex question that triggers thinking — verify timeline nodes appear
4. Send a question that triggers tool calls — verify tool nodes with expand/collapse
5. After response completes — verify timeline collapses to "思考了 N 步"
6. Click timeline summary — verify it expands to show all nodes
7. Verify feedback buttons work

- [ ] **Step 13: Commit**

```bash
git add src/ui/shell-view.ts
git commit -m "feat: implement streaming timeline UI in ShellView"
```
