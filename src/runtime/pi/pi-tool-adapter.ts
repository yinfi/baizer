import type { AgentTool, AgentToolResult, ToolExecutionMode as PiToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../../models/interfaces';
import type { SkillRegistry } from '../../skills/skill-registry';
import type { ToolRegistry } from '../../skills/tool-registry';
import type { Tool } from '../../skills/types';
import { isDirectApplyWorkspaceTool } from '../../services/workspace-edit-service';
import type { WorkspaceEditService } from '../../services/workspace-edit-service';
import { asBoolean, prop } from '../../utils/narrow';

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

/**
 * 适配后的 pi 工具。参数与 details 都用 `unknown`/`object` 显式标注：
 * pi 的 `AgentTool<any>` 会把 any 带进参数与返回值，这里在边界处收口，
 * 具体形状由各工具的 schema 与执行结果自行保证。
 */
export type AdaptedPiTool = AgentTool<object, unknown>;

export function inferToolExecutionMode(name: string, tool?: Partial<Tool>): PiToolExecutionMode {
  if (tool?.executionMode) return tool.executionMode;
  if (tool?.risk === 'write' || tool?.risk === 'plugin-control') return 'sequential';
  if (isDirectApplyWorkspaceTool(name)) return 'sequential';
  if (name.includes('plugin') || name === 'execute_plugin_command') return 'sequential';
  if (/^(read|search|query|get|list)_/.test(name)) return 'parallel';
  return 'sequential';
}

/** 工具参数是外部（模型 + pi schema 校验）给的，按字典收下，非对象退化为空参数。 */
function asToolArgs(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function adaptToolDefinitionsToPi(input: AdaptToolDefinitionsInput): AdaptedPiTool[] {
  return input.definitions.map((definition) => {
    const registeredTool = input.toolRegistry.get(definition.name);
    const timeoutMs = registeredTool?.timeoutMs ?? 30000;
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: inferToolExecutionMode(definition.name, registeredTool),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        // 工具返回值形状由各工具自定(ToolRegistry.execute 给出统一的 Record 视图,
        // executeWorkspaceTool 仍是 Promise<any>),当作外部输入,用 unknown + 窄化读取
        // approval_required,不假设字段一定存在。
        const response: unknown = await executeWithTimeout(
          // effectiveSignal = 上游中断 ∪ 本地超时,透传进工具,使网络工具能真正取消在途请求。
          (effectiveSignal) => executeBaizerTool(definition.name, params, input, effectiveSignal),
          timeoutMs,
          `Tool ${definition.name} execution timed out`,
          signal,
        );
        return {
          content: [{ type: 'text', text: stringifyToolResponse(response) }],
          details: { baizerResponse: response },
          terminate: asBoolean(prop(response, 'approval_required')) === true,
        };
      },
    };
  });
}

async function executeBaizerTool(
  name: string,
  params: unknown,
  input: AdaptToolDefinitionsInput,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = asToolArgs(params);
  // B 方案：use_skill 元工具已移除，skill 激活改由 read_skill（普通工具）+ system prompt
  // 的 <available_skills> 清单完成。此处不再有 use_skill 分支。
  // 强制激活时的工具收窄（allowedToolNames）暂留，Stage 2 迁入 PermissionService。
  if (input.skillScope.allowedToolNames && !input.skillScope.allowedToolNames.has(name)) {
    return {
      error: `Tool "${name}" is not available for active skill "${input.skillScope.activeSkillName}"`,
    };
  }

  if (input.workspaceEditService && isDirectApplyWorkspaceTool(name)) {
    // 直接应用写工具是本地 vault 操作(毫秒级),不接 signal,维持原路径。
    return input.workspaceEditService.executeWorkspaceTool(name, args);
  }

  return input.toolRegistry.execute(name, args, signal);
}

function stringifyToolResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

async function executeWithTimeout<T>(
  operation: (effectiveSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  // 组合信号:超时 ∪ 上游中断。任一触发即 abort,透传给工具让它取消在途副作用
  // (如 save_webpage 的 fetch),而非仅让 race 返回错误、请求却在后台跑完。
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let upstreamHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(errorMessage));
    }, timeoutMs);
    if (signal) {
      upstreamHandler = () => {
        controller.abort();
        reject(createAbortError());
      };
      signal.addEventListener('abort', upstreamHandler, { once: true });
    }
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && upstreamHandler) signal.removeEventListener('abort', upstreamHandler);
  }
}

function createAbortError(): Error {
  const error = new Error('Tool execution aborted');
  error.name = 'AbortError';
  return error;
}
