import type { AgentTool, ToolExecutionMode as PiToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../../models/interfaces';
import type { SkillRegistry } from '../../skills/skill-registry';
import type { ToolRegistry } from '../../skills/tool-registry';
import type { Tool } from '../../skills/types';
import { isDirectApplyWorkspaceTool } from '../../services/workspace-edit-service';
import type { WorkspaceEditService } from '../../services/workspace-edit-service';

export interface PiSkillScope {
  activeSkillName?: string;
  allowedToolNames: Set<string> | null;
}

export interface AdaptToolDefinitionsInput {
  definitions: ToolDefinition[];
  toolRegistry: Pick<ToolRegistry, 'get' | 'execute'>;
  skillRegistry?: Pick<SkillRegistry, 'activateSkill'> | null;
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
    const timeoutMs = registeredTool?.timeoutMs ?? 30000;
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: inferToolExecutionMode(definition.name, registeredTool),
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const response = await executeWithTimeout(
          () => executeBaizerTool(definition.name, params, input),
          timeoutMs,
          `Tool ${definition.name} execution timed out`,
          signal,
        );
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
  if (name === 'use_skill') {
    return activateSkillRequest(args, input);
  }

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

function activateSkillRequest(args: any, input: AdaptToolDefinitionsInput): any {
  const skillName = args?.name;
  if (!skillName) {
    return { error: 'Missing skill name' };
  }
  if (!input.skillRegistry) {
    return { error: 'Skill registry is not available' };
  }

  const activated = input.skillRegistry.activateSkill(skillName);
  if (!activated) {
    return { error: `Skill "${skillName}" not found or disabled` };
  }

  input.skillScope.activeSkillName = activated.skill?.name ?? skillName;
  input.skillScope.allowedToolNames = new Set(activated.tools.map(tool => tool.name));

  return {
    action_required: 'Use the returned instructions immediately with the available tools to complete the user request.',
    instructions: activated.instructions,
    available_tools: activated.tools.map(tool => tool.name),
  };
}

function stringifyToolResponse(response: any): string {
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    if (signal) {
      abortHandler = () => reject(createAbortError());
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

function createAbortError(): Error {
  const error = new Error('Tool execution aborted');
  error.name = 'AbortError';
  return error;
}
