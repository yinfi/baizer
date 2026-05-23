import { MemoryManager } from '../memory/memory-manager';
import { IModelProvider } from '../models/interfaces';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { WorkspaceEditService } from '../services/workspace-edit-service';
import { DefaultChatRuntime } from './chat-runtime';

interface CreateChatRuntimeArgs {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  workspaceEditService?: Pick<WorkspaceEditService, 'executeWorkspaceTool'> | null;
}

export function createChatRuntime(args: CreateChatRuntimeArgs) {
  return new DefaultChatRuntime(args);
}
