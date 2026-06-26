import {
  ChatContextItem,
  StreamEvent,
  ToolDefinition,
} from '../models/interfaces';
import {
  buildFileWriteFailureMessage,
  FILE_OPERATION_CONTRACT_TEXT,
  getFileWriteError,
  isFileWriteRequest,
  isFileWriteToolName,
  isSuccessfulWriteToolResult,
} from '../utils/file-operation-contract';
import { evaluateGenerationQuality } from '../services/generation-quality';
import { formatGenerationPlanBlock, GenerationStrategyService } from '../services/generation-strategy-service';
import { isDirectApplyWorkspaceTool } from '../services/workspace-edit-service';
import { PreparedChatTurn, ChatRuntime, ChatRuntimeDeps, ChatTurnRequest } from './runtime-types';

interface ActiveSkillScope {
  activeSkillName?: string;
  allowedToolNames: Set<string> | null;
}

interface FileWriteState {
  required: boolean;
  attempted: boolean;
  succeeded: boolean;
  lastError: string;
}

const LOCAL_SLASH_COMMANDS = [
  { command: '/clear', description: 'Clear session history' },
  { command: '/memory [overview|observations|search <query>|forget <field>]', description: 'View, search, or forget Hindsight memory' },
  { command: '/file-back <message-id>', description: 'Archive a previous AI answer to the knowledge wiki' },
  { command: '/new <title>', description: 'Create a new note' },
  { command: '/edit <instruction>', description: 'AI edit the selected text' },
  { command: '/open <file>', description: 'Open a file' },
  { command: '/tools', description: 'List available tools' },
  { command: '/wiki:compile [path]', description: 'Compile notes into the knowledge wiki' },
  { command: '/wiki:index', description: 'Open the knowledge wiki index' },
  { command: '/wiki:lint', description: 'Run the knowledge wiki health check' },
  { command: '/help', description: 'Show the command list' },
];

// [A] 给自动注入的当前笔记上下文加定性说明：它只是环境背景，可能与本轮请求无关。
// 意图由对话历史和 User Request 定义；二者与 Context 冲突时，以对话为准。
// 这样可避免模型在用户给出"需要/继续/用第二个"这类短回复时，被当前打开的文件带偏。
const CONTEXT_DISCLAIMER =
  "[Context Note] The Context above is ambient information about the user's current Obsidian workspace (the note open right now). It may be unrelated to this request. Use the conversation history and the User Request to determine intent; when they conflict with the Context, follow the conversation.";

// [B] 自动注入的"环境"上下文项前缀（当前笔记 / 反链）。用户短确认时剔除这些，
// 但保留用户显式选择的上下文与编辑器选区。
const AMBIENT_CONTEXT_PREFIXES = ['active-note:', 'backlinks:'];

// [B] 短确认 / 延续性回复的识别模式。命中且消息很短时，视为延续上一轮对话，
// 而非对当前打开文件的新请求。
const CONTINUATION_PATTERNS: RegExp[] = [
  /^(需要|不需要|好|好的|是|是的|对|对的|行|可以|可以的|继续|嗯+|确认|同意|没错|要|不用|可)$/,
  /^(ok|okay|yes|yep|yeah|sure|y|continue|go ahead|do it|proceed)$/i,
  /^(用|选|采用|使用|按|就用|就选|就)\s*(第\s*[一二三四五六七八九十\d]+|这|那|上面|前面|刚才|这个|那个|这样)/,
  /^第\s*[一二三四五六七八九十\d]+\s*(个|种|条|项|方法|方式|选项|步)?$/,
  /^(方法|方式|选项|option)\s*[一二三四五六七八九十\d]+$/i,
];

export class DefaultChatRuntime implements ChatRuntime {
  private readonly generationStrategyService = new GenerationStrategyService();

  constructor(private deps: ChatRuntimeDeps) { }

  getTools(): ToolDefinition[] {
    return this.buildSkillModeTools();
  }

  async prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    let memoryContext = '';
    if (this.deps.memoryManager) {
      await this.deps.memoryManager.ready();
      if (typeof (this.deps.memoryManager as any).recallForPrompt === 'function') {
        memoryContext = await (this.deps.memoryManager as any).recallForPrompt({
          query: request.userMessage,
          source: request.source,
          maxChars: 2500,
        });
      } else {
        memoryContext = this.deps.memoryManager.buildContext();
      }
    }

    const activeSkill = this.resolveRequestedSkill(request);
    const obsidianContext = request.source
      ? this.createFallbackObsidianContext(request)
      : undefined;
    const generationPlan = request.source && obsidianContext
      ? this.generationStrategyService.resolvePlan({
          userMessage: request.userMessage,
          source: request.source,
          context: obsidianContext,
          profile: request.userProfile,
        })
      : undefined;
    const writingProfile = obsidianContext
      ? this.generationStrategyService.buildWritingProfile(
          obsidianContext,
          request.userProfile,
        )
      : undefined;

    let prompt = '';
    if (request.systemPromptOverride) {
      prompt += `[System Prompt Override]\n${request.systemPromptOverride}\n\n`;
    }
    if (memoryContext) {
      prompt += `${memoryContext}\n\n`;
    }
    prompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;

    // [B] 用户给出短确认/延续性回复（"需要"、"用第二个"等）且存在对话历史时，
    // 剔除自动注入的环境上下文（当前笔记/反链），避免它盖过对话意图把模型带偏。
    // 用户显式选择的上下文与编辑器选区始终保留。
    const isContinuation = this.isContinuationMessage(request.userMessage)
      && (request.priorMessages?.length ?? 0) > 0;
    const promptContextItems = isContinuation
      ? this.stripAmbientContext(request.contextItems)
      : request.contextItems;

    prompt += `[Context: ${this.formatContextItems(promptContextItems)}]\n`;
    // [A] 仅当 prompt 里仍带有自动注入的环境上下文时，附上"以对话为准"的定性说明。
    if (this.hasAmbientContext(promptContextItems)) {
      prompt += `${CONTEXT_DISCLAIMER}\n`;
    }
    prompt += `${this.buildSlashCommandContract()}\n`;
    if (activeSkill) {
      prompt += `[Active Skill: ${activeSkill.skill.name}]\n`;
      prompt += `[Skill Instructions]\n${activeSkill.instructions}\n`;
    }
    if (request.selection) {
      prompt += `[Selected Text: ${request.selection}]\n`;
    }
    if (generationPlan) {
      prompt += formatGenerationPlanBlock(generationPlan, writingProfile);
    }
    if (isFileWriteRequest(request.userMessage)) {
      prompt += '[File Operation Contract]\n';
      prompt += `${FILE_OPERATION_CONTRACT_TEXT}\n`;
    }
    prompt += `User Request: ${request.userMessage}`;

    return {
      prompt,
      tools: this.buildSkillModeTools(activeSkill),
      userRequest: request.userMessage,
      memoryContext,
      activeSkillName: activeSkill?.skill.name,
      allowedToolNames: activeSkill?.tools.map(tool => tool.name),
      requiresFileWrite: isFileWriteRequest(request.userMessage),
      selection: request.selection,
      generationPlan,
      writingProfile,
      systemPromptOverride: request.systemPromptOverride,
      priorMessages: request.priorMessages,
    };
  }

  async query(turn: PreparedChatTurn): Promise<string> {
    const chat = this.deps.provider.startChat(turn.tools, turn.priorMessages);

    let result = await chat.sendMessage(turn.prompt);
    let loopCount = 0;
    const maxLoops = 10;
    const skillScope = this.createSkillScope(turn);
    const fileWriteState = this.createFileWriteState(turn);

    while (result.functionCalls && result.functionCalls.length > 0) {
      loopCount++;
      if (loopCount > maxLoops) break;

      const toolResults = [];
      for (const call of result.functionCalls) {
        const response = await this.executeToolCall(call.name, call.args, skillScope);
        this.recordFileWriteResult(fileWriteState, call.name, response);
        if (this.isApprovalResponse(response)) {
          const approvalMessage = response.message || this.formatApprovalMessage(response);
          await this.retainCompletedTurn(turn, approvalMessage);
          return approvalMessage;
        }

        toolResults.push({
          id: call.id,
          name: call.name,
          response,
        });
      }

      result = await chat.sendMessage(toolResults);
    }

    const finalText = this.resolveFinalText(turn, fileWriteState, result.text);
    const qualityCheckedText = this.applyGenerationQuality(turn, finalText);

    await this.retainCompletedTurn(turn, qualityCheckedText);

    return qualityCheckedText;
  }

  async *queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const chat = this.deps.provider.startChat(turn.tools, turn.priorMessages);

    let loopCount = 0;
    const maxLoops = 10;
    let input: string | { name: string; response: any }[] = turn.prompt;
    let fullResponseText = '';
    let approvalMessage = '';
    const skillScope = this.createSkillScope(turn);
    const fileWriteState = this.createFileWriteState(turn);

    while (loopCount <= maxLoops) {
      this.throwIfAborted(signal);
      const pendingCalls: { id?: string; name: string; args: any }[] = [];

      for await (const event of chat.sendMessageStream(input, signal)) {
        this.throwIfAborted(signal);
        if (event.type === 'tool_call') {
          pendingCalls.push({ id: event.id, name: event.name, args: event.args });
          yield event;
        } else if (event.type === 'text_delta') {
          fullResponseText += event.content;
          yield event;
        } else if (event.type === 'thinking') {
          yield event;
        }
      }

      if (pendingCalls.length === 0) break;

      loopCount++;
      if (loopCount > maxLoops) break;

      const toolResults: { id?: string; name: string; response: any }[] = [];
      for (const call of pendingCalls) {
        this.throwIfAborted(signal);
        const toolResult = await this.executeToolCall(call.name, call.args, skillScope);
        this.recordFileWriteResult(fileWriteState, call.name, toolResult);

        yield { type: 'tool_result' as const, name: call.name, result: toolResult };
        if (this.isApprovalResponse(toolResult)) {
          approvalMessage = toolResult.message || this.formatApprovalMessage(toolResult);
          fullResponseText = '';
          break;
        }

        toolResults.push({ id: call.id, name: call.name, response: toolResult });
      }

      if (approvalMessage) break;

      input = toolResults;
      fullResponseText = '';
    }

    if (!approvalMessage) {
      fullResponseText = this.resolveFinalText(turn, fileWriteState, fullResponseText);
      fullResponseText = this.applyGenerationQuality(turn, fullResponseText);
    }

    await this.retainCompletedTurn(turn, approvalMessage || fullResponseText);

    yield { type: 'done' as const, text: fullResponseText };
  }

  private isApprovalResponse(result: any): result is {
    approval_required: true;
    action?: string;
    target?: string;
    message?: string;
  } {
    return !!result && result.approval_required === true;
  }

  private formatApprovalMessage(result: { action?: string; target?: string }): string {
    const action = result.action || 'perform this action';
    const target = result.target ? `: ${result.target}` : '';
    return `Approval required to ${action}${target}`;
  }

  private createFileWriteState(turn: PreparedChatTurn): FileWriteState {
    return {
      required: turn.requiresFileWrite === true,
      attempted: false,
      succeeded: false,
      lastError: '',
    };
  }

  private recordFileWriteResult(state: FileWriteState, toolName: string, result: any): void {
    if (!state.required || !isFileWriteToolName(toolName)) return;
    state.attempted = true;
    if (isSuccessfulWriteToolResult(result)) {
      state.succeeded = true;
      return;
    }

    const error = getFileWriteError(result);
    if (error) state.lastError = error;
  }

  private resolveFinalText(turn: PreparedChatTurn, state: FileWriteState, modelText: string): string {
    if (!turn.requiresFileWrite) return modelText;
    if (state.succeeded) return modelText;
    return buildFileWriteFailureMessage(state.attempted, state.lastError);
  }

  protected applyGenerationQuality(turn: PreparedChatTurn, modelText: string): string {
    if (!turn.generationPlan) return modelText;
    const evaluation = evaluateGenerationQuality({
      originalText: turn.selection,
      generatedText: modelText,
      plan: turn.generationPlan,
    });
    if (evaluation.ok) return modelText;
    return `Generation quality check failed:\n- ${evaluation.reasons.join('\n- ')}`;
  }

  private formatContextItems(contextItems: ChatContextItem[]): string {
    if (!contextItems?.length) return '';
    return contextItems.map(item => {
      if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`;
      return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
    }).join('\n\n');
  }

  /**
   * [B] 判断用户消息是否为短确认/延续性回复（"需要"、"用第二个"、"继续"等）。
   * 这类回复在延续上一轮对话，而非针对当前打开的文件发起新请求。
   * 限制长度避免误伤——"需要帮我把整篇文章改写成..." 不应被当作纯确认。
   */
  private isContinuationMessage(message: string): boolean {
    const text = (message ?? '').trim();
    if (!text || text.length > 12) return false;
    return CONTINUATION_PATTERNS.some(pattern => pattern.test(text));
  }

  /** [B] 某个上下文项是否为自动注入的环境上下文（当前笔记 / 反链）。 */
  private isAmbientContextItem(item: ChatContextItem): boolean {
    const id = item.id ?? '';
    return AMBIENT_CONTEXT_PREFIXES.some(prefix => id.startsWith(prefix));
  }

  /** [B] 是否存在自动注入的环境上下文。用于决定是否附加 Context 定性说明。 */
  private hasAmbientContext(contextItems: ChatContextItem[]): boolean {
    return (contextItems ?? []).some(item => this.isAmbientContextItem(item));
  }

  /** [B] 剔除自动注入的环境上下文，保留用户显式选择的上下文与选区。 */
  private stripAmbientContext(contextItems: ChatContextItem[]): ChatContextItem[] {
    return (contextItems ?? []).filter(item => !this.isAmbientContextItem(item));
  }

  private buildSlashCommandContract(): string {
    const skillCommands = typeof (this.deps.skillRegistry as any).listCommandEntries === 'function'
      ? (this.deps.skillRegistry as any).listCommandEntries()
      : [];
    const commands = [
      ...LOCAL_SLASH_COMMANDS,
      ...skillCommands.map((entry: any) => ({
        command: entry.command,
        description: entry.description || `Run ${entry.skillName || 'skill'} workflow`,
      })),
    ];
    const unique = new Map<string, string>();
    for (const entry of commands) {
      if (!entry.command || unique.has(entry.command)) continue;
      unique.set(entry.command, entry.description);
    }
    const commandList = Array.from(unique.entries())
      .map(([command, description]) => `- \`${command}\`: ${description}`)
      .join('\n');

    return `[Slash Command Contract]
Only these slash commands exist in this shell:
${commandList}
Do not mention or recommend slash commands that are not listed here.
Do not invent generic commands like \`/do\` or \`/ask\`.
If no listed command fits, suggest a plain-language request instead.
`;
  }

  private createFallbackObsidianContext(request: ChatTurnRequest) {
    if (request.obsidianContext) {
      return request.obsidianContext;
    }

    const activeFileContext = request.contextItems.find((item) => item.type === 'file');
    const path = activeFileContext?.data || '';
    const title = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Current Note';

    return {
      activeNote: path ? { path, title } : null,
      selection: request.selection ? { text: request.selection } : null,
      activeHeading: null,
      frontmatter: {},
      tags: [],
      outgoingLinks: [],
      backlinks: [],
      recentNotes: [],
      explicitScopes: [],
      contextItems: request.contextItems as any,
    };
  }

  private buildSkillModeTools(activeSkill?: { tools: ToolDefinition[] } | null): ToolDefinition[] {
    const tools = activeSkill?.tools?.length
      ? [...activeSkill.tools]
      : [...this.deps.toolRegistry.getAllDefinitions()];

    const skillSummary = this.deps.skillRegistry.getSkillSummaryText();
    const useSkillDesc = skillSummary
      ? `Get detailed instructions for a specific workflow, then use the returned instructions with the existing tools.\n\n${skillSummary}`
      : 'Get detailed instructions for a specific workflow.';

    tools.push({
      name: 'use_skill',
      description: useSkillDesc,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name' },
        },
        required: ['name'],
      },
    });

    return tools;
  }

  private resolveRequestedSkill(request: ChatTurnRequest) {
    const skillName = request.forcedSkillName
      ?? this.deps.skillRegistry.resolveByIntent?.(request.userMessage)?.name;
    return skillName ? this.deps.skillRegistry.activateSkill(skillName) : null;
  }

  protected createSkillScope(turn: PreparedChatTurn): ActiveSkillScope {
    if (!turn.activeSkillName) {
      return { allowedToolNames: null };
    }
    return {
      activeSkillName: turn.activeSkillName,
      allowedToolNames: new Set(turn.allowedToolNames ?? []),
    };
  }

  private async executeToolCall(
    name: string,
    args: any,
    skillScope: ActiveSkillScope,
  ): Promise<any> {
    if (name === 'use_skill') {
      const activation = this.activateSkillRequest(args);
      if (activation.activeSkillName) {
        skillScope.activeSkillName = activation.activeSkillName;
        skillScope.allowedToolNames = new Set(activation.allowedToolNames ?? []);
      }
      return activation.toolResult;
    }

    if (skillScope.allowedToolNames && !skillScope.allowedToolNames.has(name)) {
      return {
        error: `Tool "${name}" is not available for active skill "${skillScope.activeSkillName}"`,
      };
    }

    const executor = this.deps.workspaceEditService && isDirectApplyWorkspaceTool(name)
      ? this.deps.workspaceEditService.executeWorkspaceTool(name, args)
      : this.deps.toolRegistry.execute(name, args);

    return this.withTimeout(executor, 30000, `Tool ${name} execution timed out`);
  }

  private activateSkillRequest(args: any): {
    activeSkillName?: string;
    allowedToolNames?: string[];
    toolResult: any;
  } {
    const skillName = args?.name;
    if (!skillName) {
      return { toolResult: { error: 'Missing skill name' } };
    }

    const activated = this.deps.skillRegistry.activateSkill(skillName);
    if (!activated) {
      return { toolResult: { error: `Skill "${skillName}" not found or disabled` } };
    }

    return {
      activeSkillName: activated.skill?.name ?? skillName,
      allowedToolNames: activated.tools.map(tool => tool.name),
      toolResult: {
        action_required: 'Use the returned instructions immediately with the available tools to complete the user request.',
        instructions: activated.instructions,
        available_tools: activated.tools.map(tool => tool.name),
      },
    };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);

      controller.signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
      });
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      controller.abort();
    }
  }

  private extractUserRequest(prompt: string): string {
    const marker = 'User Request: ';
    const index = prompt.lastIndexOf(marker);
    return index >= 0 ? prompt.slice(index + marker.length) : prompt;
  }

  protected async retainCompletedTurn(turn: PreparedChatTurn, assistantMessage: string): Promise<void> {
    if (!this.deps.memoryManager) return;

    const memoryManager = this.deps.memoryManager as any;
    const userRequest = turn.userRequest || this.extractUserRequest(turn.prompt);
    if (typeof memoryManager.retainTurn === 'function') {
      await memoryManager.retainTurn({
        userMessage: userRequest,
        assistantMessage,
        source: turn.generationPlan?.source || 'shell',
      });
      return;
    }

    await this.deps.memoryManager.recordMessage('user', userRequest);
    await this.deps.memoryManager.recordMessage('model', assistantMessage);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const error = new Error('Stream aborted');
      error.name = 'AbortError';
      throw error;
    }
  }
}
