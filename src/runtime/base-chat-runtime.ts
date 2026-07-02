import {
  ChatContextItem,
  StreamEvent,
  ToolDefinition,
} from '../models/interfaces';
import {
  FILE_OPERATION_CONTRACT_TEXT,
  isFileWriteRequest,
} from '../utils/file-operation-contract';
import { evaluateGenerationQuality } from '../services/generation-quality';
import { formatGenerationPlanBlock, GenerationStrategyService } from '../services/generation-strategy-service';
import { PreparedChatTurn, ChatRuntime, ChatRuntimeDeps, ChatTurnRequest } from './runtime-types';

interface ActiveSkillScope {
  activeSkillName?: string;
  allowedToolNames: Set<string> | null;
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
  // 单词级精确确认（不带额外内容）
  /^(ok|okay|yes|yep|yeah|sure|y|proceed)$/i,
  // 动作性延续词：可带后缀说明，如 "go ahead with option 2"、"continue with that"、"do it now"
  /^(go ahead|continue|do it)(\s|$)/i,
  /^(用|选|采用|使用|按|就用|就选|就)\s*(第\s*[一二三四五六七八九十\d]+|这|那|上面|前面|刚才|这个|那个|这样)/,
  /^第\s*[一二三四五六七八九十\d]+\s*(个|种|条|项|方法|方式|选项|步)?$/,
  /^(方法|方式|选项|option)\s*[一二三四五六七八九十\d]+$/i,
];

export abstract class BaseChatRuntime implements ChatRuntime {
  private readonly generationStrategyService = new GenerationStrategyService();

  constructor(protected deps: ChatRuntimeDeps) { }

  getTools(): ToolDefinition[] {
    return this.buildSkillModeTools();
  }

  abstract query(turn: PreparedChatTurn): Promise<string>;

  abstract queryStream(turn: PreparedChatTurn, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;

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
      // 强制 / 斜杠激活：直接注入 pi formatSkillInvocation 包装的完整指令。
      prompt += `[Active Skill: ${activeSkill.skill.name}]\n`;
      prompt += `[Skill Instructions]\n${activeSkill.instructions}\n`;
    } else {
      // 自主发现（B 方案）：注入 pi 原生 skill 清单，模型按需 read_skill 拿完整正文。
      const skillList = this.deps.skillRegistry.getSkillSummaryText();
      if (skillList) {
        prompt += `${skillList}\n`;
        // 覆盖 pi 清单里“读取 skill 文件”的原生措辞：本插件的 skill 存放于隐藏目录，
        // 普通文件读取工具够不到，必须用 read_skill(name)（name 取自上面清单）获取完整指令。
        prompt += `[Skill Access] To load a skill's full instructions, call the read_skill tool with the skill's name (e.g. read_skill({"name":"web-search"})). Do not try to open the <location> path with file-reading tools — skill files live in a hidden folder those tools cannot access.\n`;
      }
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
   * 长度门：中文（含CJK字符）按字符数 ≤12 判断；纯英文按词数 ≤5 判断。
   * 这样 "go ahead with option 2" 等英文延续句也能被正确识别，不会因字符数超标漏掉。
   */
  private isContinuationMessage(message: string): boolean {
    const text = (message ?? '').trim();
    if (!text) return false;
    const hasCJK = /[一-鿿㐀-䶿]/.test(text);
    if (hasCJK) {
      // 中文：字符总长 ≤12
      if (text.length > 12) return false;
    } else {
      // 纯英文/其他：词数 ≤5（空白分割）
      if (text.split(/\s+/).length > 5) return false;
    }
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
    // B 方案：不再注入 use_skill 元工具。skill 发现走 system prompt 的 <available_skills>
    // 清单 + read_skill 工具（read_skill 已注册为核心工具，恒在全量集内）。
    // 强制激活时仍收窄到该 skill 的工具子集（门控 Stage 2 交 PermissionService）。
    return activeSkill?.tools?.length
      ? [...activeSkill.tools]
      : [...this.deps.toolRegistry.getAllDefinitions()];
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

  private extractUserRequest(prompt: string): string {
    const marker = 'User Request: ';
    const index = prompt.lastIndexOf(marker);
    return index >= 0 ? prompt.slice(index + marker.length) : prompt;
  }

  protected async retainCompletedTurn(turn: PreparedChatTurn, assistantMessage: string): Promise<void> {
    const userRequest = turn.userRequest || this.extractUserRequest(turn.prompt);

    // Session 持久化：把本轮 user/assistant 原文落盘到 JSONL，使跨轮上下文跨重启可恢复。
    // 落盘失败不应阻断回答返回，仅记录告警。
    if (this.deps.sessionStore) {
      try {
        await this.deps.sessionStore.appendTurn(userRequest, assistantMessage);
      } catch {
        // SessionStore 内部已记日志；这里吞掉以保证回答正常返回。
      }
    }

    if (!this.deps.memoryManager) return;

    const memoryManager = this.deps.memoryManager as any;
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
}

