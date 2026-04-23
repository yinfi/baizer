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

    let prompt = '';
    if (memoryContext) {
      prompt += `${memoryContext}\n\n`;
    }
    prompt += `[Current Time: ${new Date().toLocaleString()} (${new Date().toLocaleDateString(undefined, { weekday: 'long' })})]\n`;
    prompt += `[Context: ${this.formatContextItems(request.contextItems)}]\n`;
    if (request.selection) {
      prompt += `[Selected Text: ${request.selection}]\n`;
    }
    prompt += `User Request: ${request.userMessage}`;

    return {
      prompt,
      tools: this.getTools(),
    };
  }

  async query(turn: PreparedChatTurn): Promise<string> {
    const chat = this.deps.memoryManager
      ? this.deps.memoryManager.getOrCreateSession(turn.tools)
      : this.deps.provider.startChat(turn.tools);

    let result = await chat.sendMessage(turn.prompt);
    let loopCount = 0;
    const maxLoops = 10;

    while (result.functionCalls && result.functionCalls.length > 0) {
      loopCount++;
      if (loopCount > maxLoops) break;

      const toolResults = await Promise.all(result.functionCalls.map(async (call) => {
        if (call.name === 'use_skill') {
          return {
            name: call.name,
            response: await this.executeSkill(call.args),
          };
        }

        return {
          name: call.name,
          response: await this.withTimeout(
            this.deps.toolRegistry.execute(call.name, call.args),
            30000,
            `Tool ${call.name} execution timed out`,
          ),
        };
      }));

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
        let toolResult: any;
        if (call.name === 'use_skill') {
          toolResult = await this.executeSkill(call.args);
        } else {
          toolResult = await this.withTimeout(
            this.deps.toolRegistry.execute(call.name, call.args),
            30000,
            `Tool ${call.name} execution timed out`,
          );
        }

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

  private buildSkillModeTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    tools.push(...this.deps.toolRegistry.getAllDefinitions());

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

  private async executeSkill(args: any): Promise<any> {
    const skillName = args?.name;
    if (!skillName) return { error: 'Missing skill name' };

    const activated = this.deps.skillRegistry.activateSkill(skillName);
    if (!activated) return { error: `Skill "${skillName}" not found or disabled` };

    return {
      action_required: 'Use the returned instructions immediately with the available tools to complete the user request.',
      instructions: activated.instructions,
      available_tools: activated.tools.map(tool => tool.name),
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
