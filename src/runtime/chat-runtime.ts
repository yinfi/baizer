import { MemoryManager } from '../memory/memory-manager';
import {
  ChatContextItem,
  IModelProvider,
  StreamEvent,
  ToolDefinition,
} from '../models/interfaces';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { PreparedChatTurn, ChatRuntime, ChatTurnRequest } from './runtime-types';

interface ChatRuntimeDeps {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
}

interface ActiveSkillScope {
  activeSkillName?: string;
  allowedToolNames: Set<string> | null;
}

export class DefaultChatRuntime implements ChatRuntime {
  constructor(private deps: ChatRuntimeDeps) { }

  getTools(): ToolDefinition[] {
    return this.buildSkillModeTools();
  }

  async prepareTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    let memoryContext = '';
    if (this.deps.memoryManager) {
      await this.deps.memoryManager.ready();
      memoryContext = this.deps.memoryManager.buildContext();
    }

    const activeSkill = this.resolveRequestedSkill(request);

    let prompt = '';
    if (memoryContext) {
      prompt += `${memoryContext}\n\n`;
    }
    prompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;
    prompt += `[Context: ${this.formatContextItems(request.contextItems)}]\n`;
    if (activeSkill) {
      prompt += `[Active Skill: ${activeSkill.skill.name}]\n`;
      prompt += `[Skill Instructions]\n${activeSkill.instructions}\n`;
    }
    if (request.selection) {
      prompt += `[Selected Text: ${request.selection}]\n`;
    }
    prompt += `User Request: ${request.userMessage}`;

    return {
      prompt,
      tools: this.buildSkillModeTools(activeSkill),
      activeSkillName: activeSkill?.skill.name,
      allowedToolNames: activeSkill?.tools.map(tool => tool.name),
    };
  }

  async query(turn: PreparedChatTurn): Promise<string> {
    const chat = this.deps.memoryManager
      ? this.deps.memoryManager.getOrCreateSession(turn.tools)
      : this.deps.provider.startChat(turn.tools);

    let result = await chat.sendMessage(turn.prompt);
    let loopCount = 0;
    const maxLoops = 10;
    const skillScope = this.createSkillScope(turn);

    while (result.functionCalls && result.functionCalls.length > 0) {
      loopCount++;
      if (loopCount > maxLoops) break;

      const toolResults = [];
      for (const call of result.functionCalls) {
        toolResults.push({
          name: call.name,
          response: await this.executeToolCall(call.name, call.args, skillScope),
        });
      }

      result = await chat.sendMessage(toolResults);
    }

    if (this.deps.memoryManager) {
      const userRequest = this.extractUserRequest(turn.prompt);
      await this.deps.memoryManager.recordMessage('user', userRequest);
      await this.deps.memoryManager.recordMessage('model', result.text);
    }

    return result.text;
  }

  async *queryStream(turn: PreparedChatTurn): AsyncGenerator<StreamEvent, void, unknown> {
    const chat = this.deps.memoryManager
      ? this.deps.memoryManager.getOrCreateSession(turn.tools)
      : this.deps.provider.startChat(turn.tools);

    let loopCount = 0;
    const maxLoops = 10;
    let input: string | { name: string; response: any }[] = turn.prompt;
    let fullResponseText = '';
    const skillScope = this.createSkillScope(turn);

    while (loopCount <= maxLoops) {
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
        }
      }

      if (pendingCalls.length === 0) break;

      loopCount++;
      if (loopCount > maxLoops) break;

      const toolResults: { name: string; response: any }[] = [];
      for (const call of pendingCalls) {
        const toolResult = await this.executeToolCall(call.name, call.args, skillScope);

        yield { type: 'tool_result' as const, name: call.name, result: toolResult };
        toolResults.push({ name: call.name, response: toolResult });
      }

      input = toolResults;
      fullResponseText = '';
    }

    if (this.deps.memoryManager) {
      const userRequest = this.extractUserRequest(turn.prompt);
      await this.deps.memoryManager.recordMessage('user', userRequest);
      await this.deps.memoryManager.recordMessage('model', fullResponseText);
    }

    yield { type: 'done' as const, text: fullResponseText };
  }

  private formatContextItems(contextItems: ChatContextItem[]): string {
    if (!contextItems?.length) return '';
    return contextItems.map(item => {
      if (item.type === 'image') return `[Image: ${item.summary || 'Attached Image'}]`;
      return `[Context (${item.type}): ${item.data}]\n${item.content || ''}`;
    }).join('\n\n');
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

  private createSkillScope(turn: PreparedChatTurn): ActiveSkillScope {
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

    return this.withTimeout(
      this.deps.toolRegistry.execute(name, args),
      30000,
      `Tool ${name} execution timed out`,
    );
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
}
