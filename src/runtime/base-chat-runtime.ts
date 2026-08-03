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
import { logger } from '../utils/logger';

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
    let mentalModelBlock = '';
    if (this.deps.memoryManager) {
      await this.deps.memoryManager.ready();
      // 两者独立,并行取:recall 受 BM25 词法门控(与 query 相关),
      // Mental Models 无条件注入(高层用户画像,即便与本轮 query 无词法重叠也应在场)。
      [memoryContext, mentalModelBlock] = await Promise.all([
        this.deps.memoryManager.recallForPrompt({
          query: request.userMessage,
          source: request.source,
          maxChars: 2500,
        }),
        this.deps.memoryManager.getMentalModelBlock({ maxChars: 600 }),
      ]);
    }

    const activeSkill = this.resolveRequestedSkill(request);
    const activated = activeSkill
      ? this.deps.skillRegistry.activateSkill(activeSkill.name)
      : null;
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

    // 阶段1:装饰(memory/context/skill/plan/契约)进 systemPrompt(每轮发送、不持久化);
    // 干净的 userMessage 作为 prompt 交给 harness.prompt() 持久化,使跨轮历史保持干净。
    let systemPrompt = '';
    if (request.systemPromptOverride) {
      systemPrompt += `[System Prompt Override]\n${request.systemPromptOverride}\n\n`;
    }
    if (mentalModelBlock) {
      systemPrompt += `${mentalModelBlock}\n\n`;
    }
    if (memoryContext) {
      systemPrompt += `${memoryContext}\n\n`;
    }
    systemPrompt += `[Current Time: ${new Date().toLocaleString('zh-CN')} (${new Date().toLocaleDateString('zh-CN', { weekday: 'long' })})]\n`;

    // [B] 用户给出短确认/延续性回复（"需要"、"用第二个"等）且存在对话历史时，
    // 剔除自动注入的环境上下文（当前笔记/反链），避免它盖过对话意图把模型带偏。
    // 用户显式选择的上下文与编辑器选区始终保留。
    const isContinuation = this.isContinuationMessage(request.userMessage)
      && await this.resolveHasPriorContext(request);
    const promptContextItems = isContinuation
      ? this.stripAmbientContext(request.contextItems)
      : request.contextItems;

    systemPrompt += `[Context: ${this.formatContextItems(promptContextItems)}]\n`;
    // [A] 仅当仍带有自动注入的环境上下文时，附上"以对话为准"的定性说明。
    if (this.hasAmbientContext(promptContextItems)) {
      systemPrompt += `${CONTEXT_DISCLAIMER}\n`;
    }
    systemPrompt += `${this.buildSlashCommandContract()}\n`;
    if (activated) {
      // 强制 / 斜杠激活：直接注入 pi formatSkillInvocation 包装的完整指令。
      systemPrompt += `[Active Skill: ${activated.skillName}]\n`;
      systemPrompt += `[Skill Instructions]\n${activated.instructions}\n`;
    }
    // 无论是否激活，始终注入 pi 原生 skill 清单：模型可随时 read_skill 发现/切换其它
    // skill（意图激活不再收窄工具集，故清单 + read_skill 是渐进式披露的完整入口）。
    const skillList = this.deps.skillRegistry.getSkillSummaryText();
    if (skillList) {
      systemPrompt += `${skillList}\n`;
      // 覆盖 pi 清单里“读取 skill 文件”的原生措辞：本插件的 skill 存放于隐藏目录，
      // 普通文件读取工具够不到，必须用 read_skill(name)（name 取自上面清单）获取完整指令。
      systemPrompt += `[Skill Access] To load a skill's full instructions, call the read_skill tool with the skill's name (e.g. read_skill({"name":"web-search"})). Do not try to open the <location> path with file-reading tools — skill files live in a hidden folder those tools cannot access.\n`;
    }
    if (request.selection) {
      systemPrompt += `[Selected Text: ${request.selection}]\n`;
    }
    if (generationPlan) {
      systemPrompt += formatGenerationPlanBlock(generationPlan, writingProfile);
    }
    if (isFileWriteRequest(request.userMessage)) {
      systemPrompt += '[File Operation Contract]\n';
      systemPrompt += `${FILE_OPERATION_CONTRACT_TEXT}\n`;
    }

    return {
      prompt: request.userMessage,
      systemPrompt,
      tools: this.buildSkillModeTools(activated, activeSkill?.source === 'forced'),
      userRequest: request.userMessage,
      memoryContext,
      activeSkillName: activated?.skillName,
      activeSkillSource: activeSkill?.source,
      // 意图激活不收窄工具集（白名单 null）；仅强制/斜杠激活收窄到该 skill 的工具子集。
      allowedToolNames: activeSkill?.source === 'forced'
        ? activated?.tools.map(tool => tool.name)
        : undefined,
      requiresFileWrite: isFileWriteRequest(request.userMessage),
      selection: request.selection,
      generationPlan,
      writingProfile,
      systemPromptOverride: request.systemPromptOverride,
      conversationId: request.conversationId,
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
  /**
   * 本轮开始时会话是否已有跨轮历史 —— 延续判定的前置条件。
   *
   * 自己向 sessionManager 问,不要求调用方注入。历史存在性是会话的属性,
   * 而 sessionManager 就在 deps 里;让每个入口自己查一遍,只会漏。
   * (曾经就漏过:chat/chatStream 各写一遍相同的查询,而 skill 命令入口忘了,
   * 于是 skill 命令永远拿不到延续检测。)
   *
   * 调用方显式给了值就用它:无 conversationId 的一次性调用(file-back、/edit)
   * 没有会话可查,由调用方判断更准。
   */
  private async resolveHasPriorContext(request: ChatTurnRequest): Promise<boolean> {
    if (typeof request.hasPriorContext === 'boolean') return request.hasPriorContext;

    const sessionManager = this.deps.sessionManager;
    if (!sessionManager || !request.conversationId) return false;

    try {
      return await sessionManager.hasHistory(request.conversationId);
    } catch (error) {
      // 查不到就当没有历史:保留环境上下文是更安全的降级
      // (误剔除会让模型丢掉用户正在看的笔记)。
      logger.warn('Failed to resolve prior history; assuming none', 'BaseChatRuntime');
      void error;
      return false;
    }
  }

  private stripAmbientContext(contextItems: ChatContextItem[]): ChatContextItem[] {
    return (contextItems ?? []).filter(item => !this.isAmbientContextItem(item));
  }

  private buildSlashCommandContract(): string {
    const skillCommands = typeof (this.deps.skillRegistry as any).listCommandEntries === 'function'
      ? (this.deps.skillRegistry as any).listCommandEntries()
      : [];
    const userCommands = typeof this.deps.getUserCommandEntries === 'function'
      ? this.deps.getUserCommandEntries()
      : [];
    const commands = [
      ...LOCAL_SLASH_COMMANDS,
      ...skillCommands.map((entry: any) => ({
        command: entry.command,
        description: entry.description || `Run ${entry.skillName || 'skill'} workflow`,
      })),
      ...userCommands.map((entry) => ({
        command: entry.command,
        description: entry.description || `Run the ${entry.command} command`,
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

  // 收窄工具集时必须始终保留的元能力:read_skill 是渐进式披露的入口——模型靠它拉取
  // 其它 skill 的完整正文、按 SKILL.md 指令切换行为。收窄却丢了它 = 渐进式披露断链,
  // 模型再也读不到/切不到别的 skill。口径与运行中 steering 的 ActiveRunController 一致。
  private static readonly ALWAYS_AVAILABLE_TOOL_NAMES = ['read_skill'];

  private buildSkillModeTools(activated?: { tools: ToolDefinition[] } | null, restrict = false): ToolDefinition[] {
    // B 方案：不再注入 use_skill 元工具。skill 发现走 system prompt 的 <available_skills>
    // 清单 + read_skill 工具。无激活 skill 或意图激活（restrict=false）时给全量集。
    // 只有强制/斜杠激活（forced）才收窄到该 skill 的工具子集。
    if (!restrict || !activated?.tools?.length) {
      return [...this.deps.toolRegistry.getAllDefinitions()];
    }
    // 收窄时补回 read_skill 等元能力(去重)，否则模型被困在当前 skill 里、无法再读其它 skill 指令。
    const tools = [...activated.tools];
    const present = new Set(tools.map(tool => tool.name));
    for (const name of BaseChatRuntime.ALWAYS_AVAILABLE_TOOL_NAMES) {
      if (present.has(name)) continue;
      const def = this.deps.toolRegistry.getDefinition?.(name);
      if (def) tools.push(def);
    }
    return tools;
  }

  private resolveRequestedSkill(request: ChatTurnRequest): { name: string; source: 'forced' | 'intent' } | null {
    if (request.forcedSkillName) {
      return { name: request.forcedSkillName, source: 'forced' };
    }
    const name = this.deps.skillRegistry.resolveByIntent?.(request.userMessage)?.name;
    return name ? { name, source: 'intent' } : null;
  }

  protected createSkillScope(turn: PreparedChatTurn): ActiveSkillScope {
    // 仅强制/斜杠激活收窄工具集（白名单硬门）。意图激活白名单为 null（全量工具），
    // 使模型读到其它 skill 指令后能直接调用其工具——read_skill 是纯文本读取，
    // 无法同步更新白名单，故意图路径不能依赖收窄。
    if (turn.activeSkillSource !== 'forced') {
      return { allowedToolNames: null };
    }
    // 元能力(read_skill)并入白名单:pi-tool-adapter 用 allowedToolNames 做硬门,
    // 只把工具列进 tools 还不够——不在白名单里仍会被拦成 "not available"。
    // 二者必须同步补,否则模型看得到 read_skill 却调不动。
    const allowed = new Set(turn.allowedToolNames ?? []);
    for (const name of BaseChatRuntime.ALWAYS_AVAILABLE_TOOL_NAMES) {
      allowed.add(name);
    }
    return {
      activeSkillName: turn.activeSkillName,
      allowedToolNames: allowed,
    };
  }


  protected async retainCompletedTurn(
    turn: PreparedChatTurn,
    assistantMessage: string,
    toolResults?: Array<{ name: string; result: unknown }>,
  ): Promise<void> {
    // 阶段1:会话持久化由 AgentHarness 完成(prompt() 已把 user/assistant 追加进 session),
    // 此处不再自己落盘。仅保留把本轮原文交给长期记忆(Hindsight)——它与 session 正交。
    const userRequest = turn.userRequest || turn.prompt;

    if (!this.deps.memoryManager) return;

    // fire-and-forget:记忆沉淀走后台(可能含 LLM 提炼),不阻塞对话回合返回。
    // MemoryManager 内部追踪在途任务,设置变更/卸载时经 flush() 排空。
    // toolResults 让"本轮有实际工具动作"的轮次(web clip/写文件/插件操作)也能被沉淀——
    // 否则 hadToolAction 恒 false,这类轮次除非用户原话恰好 durable 才会入库。
    void this.deps.memoryManager.retainTurn({
      userMessage: userRequest,
      assistantMessage,
      source: turn.generationPlan?.source || 'shell',
      ...(toolResults && toolResults.length > 0 ? { toolResults } : {}),
    });
  }
}

