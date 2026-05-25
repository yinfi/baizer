import type { AgentTool, ToolExecutionMode as PiToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../../models/interfaces';
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
